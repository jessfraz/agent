//! Calendar intake through Switchboard's scoped gws CLI. Each complete scan
//! covers one day back and thirty days ahead across the account's calendar list.
//! Native page tokens retain that UTC window; failures never advance it.

use anyhow::{Context, Result, ensure};
use chrono::{DateTime, SecondsFormat};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::{
    protocol::SourceRef,
    sources::{
        ReadOutput, Source, SourceBatch, SourceCheckpoint, SourceCoverage, SourceEvent, SourceKey,
        google::GoogleSource, now_seconds, read_command,
    },
};

const PAGE_SIZE: usize = 25;
const MAX_CALENDARS: usize = 512;
const DAY: u64 = 86_400;

#[derive(Debug)]
pub struct CalendarSource {
    namespace: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Window {
    version: u8,
    account: String,
    since: u64,
    until: u64,
    phase: Phase,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "stage", rename_all = "snake_case", deny_unknown_fields)]
enum Phase {
    Calendars {
        calendars: Vec<String>,
        cursor: Option<String>,
    },
    Events {
        calendars: Vec<String>,
        index: usize,
        cursor: Option<String>,
    },
    Settled,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CalendarParams {
    max_results: usize,
    show_hidden: bool,
    fields: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    page_token: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventParams {
    calendar_id: String,
    time_min: String,
    time_max: String,
    time_zone: String,
    single_events: bool,
    show_deleted: bool,
    max_results: usize,
    max_attendees: usize,
    fields: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    page_token: Option<String>,
}

#[derive(Deserialize)]
struct Envelope<T> {
    namespace: String,
    status: String,
    fields: Option<Fields<T>>,
}
#[derive(Deserialize)]
struct Fields<T> {
    status: String,
    response: Option<Page<T>>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", bound(deserialize = "T: Deserialize<'de>"))]
struct Page<T> {
    kind: String,
    #[serde(default)]
    items: Vec<T>,
    next_page_token: Option<String>,
}
#[derive(Deserialize)]
struct Calendar {
    #[serde(default)]
    id: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Event {
    #[serde(default)]
    id: String,
    etag: Option<String>,
    updated: Option<String>,
    status: Option<String>,
    summary: Option<String>,
    description: Option<String>,
    start: Option<EventTime>,
    end: Option<EventTime>,
    location: Option<String>,
    html_link: Option<String>,
    #[serde(rename = "iCalUID")]
    i_cal_uid: Option<String>,
    recurring_event_id: Option<String>,
    original_start_time: Option<EventTime>,
    organizer: Option<Person>,
    #[serde(default)]
    attendees: Vec<Person>,
    attendees_omitted: Option<bool>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct EventTime {
    date: Option<String>,
    date_time: Option<String>,
    time_zone: Option<String>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Person {
    email: Option<String>,
    display_name: Option<String>,
    response_status: Option<String>,
    #[serde(rename = "self")]
    own: Option<bool>,
}

fn timestamp(seconds: u64) -> Result<String> {
    Ok(DateTime::from_timestamp(i64::try_from(seconds)?, 0)
        .context("Calendar timestamp is out of range")?
        .to_rfc3339_opts(SecondsFormat::Secs, true))
}

fn page<T: DeserializeOwned>(
    output: ReadOutput,
    account: &str,
    kind: &str,
) -> Result<(Page<T>, bool)> {
    ensure!(!output.truncated, "Calendar CLI output was truncated");
    let envelope: Envelope<T> =
        serde_json::from_str(&output.stdout).context("Calendar CLI result is invalid")?;
    ensure!(
        envelope.namespace == account,
        "Calendar CLI returned another account"
    );
    let fields = envelope
        .fields
        .context("Calendar CLI returned no coverage")?;
    let page = fields
        .response
        .context("Calendar CLI returned no native response")?;
    ensure!(
        page.kind == kind,
        "Calendar CLI returned another resource kind"
    );
    let complete = output.exit_code == 0 && envelope.status == "executed" && fields.status == "ok";
    Ok((page, complete))
}

fn valid_cursor(next: &Option<String>, previous: &Option<String>) -> bool {
    next.as_ref()
        .is_none_or(|value| !value.is_empty() && previous.as_ref() != Some(value))
}

impl CalendarSource {
    pub fn new(namespace: String) -> Result<Self> {
        ensure!(
            !namespace.trim().is_empty() && !namespace.contains('\0'),
            "Calendar source needs an explicit namespace"
        );
        Ok(Self { namespace })
    }

    pub async fn discover(selected: Option<&[String]>) -> Result<Vec<Self>> {
        GoogleSource::discover(selected)
            .await?
            .into_iter()
            .map(|source| Self::new(source.key().account))
            .collect()
    }

    fn window(&self, checkpoint: Option<&SourceCheckpoint>, now: u64) -> Result<Window> {
        let saved: Option<Window> = checkpoint
            .map(|checkpoint| serde_json::from_str(&checkpoint.value))
            .transpose()
            .context("Invalid calendar checkpoint")?;
        if let Some(saved) = &saved {
            ensure!(
                saved.version == 1 && saved.account == self.namespace,
                "Calendar checkpoint belongs to another account or version"
            );
        }
        let window = match saved {
            Some(window) if !matches!(window.phase, Phase::Settled) => window,
            _ => Window {
                version: 1,
                account: self.namespace.clone(),
                since: now.saturating_sub(DAY),
                until: now
                    .checked_add(30 * DAY)
                    .context("Calendar window is out of range")?,
                phase: Phase::Calendars {
                    calendars: Vec::new(),
                    cursor: None,
                },
            },
        };
        ensure!(
            window.since < window.until && window.until - window.since <= 31 * DAY,
            "Calendar checkpoint window is invalid"
        );
        match &window.phase {
            Phase::Calendars { calendars, cursor }
            | Phase::Events {
                calendars, cursor, ..
            } => {
                ensure!(
                    calendars.len() <= MAX_CALENDARS
                        && calendars.iter().all(|id| !id.is_empty())
                        && cursor.as_ref().is_none_or(|cursor| !cursor.is_empty()),
                    "Calendar checkpoint cursor is invalid"
                );
                if let Phase::Events { index, .. } = &window.phase {
                    ensure!(
                        *index < calendars.len(),
                        "Calendar checkpoint index is invalid"
                    );
                }
            }
            Phase::Settled => {}
        }
        Ok(window)
    }

    fn command(&self, window: &Window) -> Result<Vec<String>> {
        let (resource, params) = match &window.phase {
            Phase::Calendars { cursor, .. } => ("calendarList", serde_json::to_string(&CalendarParams {
                max_results: PAGE_SIZE, show_hidden: true, fields: "kind,nextPageToken,items(id)".into(), page_token: cursor.clone(),
            })?),
            Phase::Events { calendars, index, cursor } => ("events", serde_json::to_string(&EventParams {
                calendar_id: calendars.get(*index).context("Calendar checkpoint index is invalid")?.clone(),
                time_min: timestamp(window.since)?, time_max: timestamp(window.until)?, time_zone: "UTC".into(),
                single_events: true, show_deleted: true, max_results: PAGE_SIZE, max_attendees: 10,
                fields: "kind,nextPageToken,items(id,etag,updated,status,summary,description,start,end,location,htmlLink,iCalUID,recurringEventId,originalStartTime,organizer,attendees,attendeesOmitted)".into(),
                page_token: cursor.clone(),
            })?),
            Phase::Settled => anyhow::bail!("Calendar scan is already settled"),
        };
        Ok(vec![
            "switchboard".into(),
            "google.cli.read".into(),
            "--ns".into(),
            self.namespace.clone(),
            "--json".into(),
            "--".into(),
            "calendar".into(),
            resource.into(),
            "list".into(),
            "--params".into(),
            params,
        ])
    }

    fn partial(&self, events: Vec<SourceEvent>) -> SourceBatch {
        SourceBatch {
            source: self.key(),
            events,
            checkpoint: None,
            coverage: SourceCoverage::Partial {
                message: "Calendar page coverage is incomplete; checkpoint retained".into(),
            },
        }
    }

    fn advance(&self, window: Window, events: Vec<SourceEvent>) -> Result<SourceBatch> {
        let coverage = if matches!(window.phase, Phase::Settled) {
            SourceCoverage::Complete
        } else {
            SourceCoverage::More
        };
        Ok(SourceBatch {
            source: self.key(),
            events,
            coverage,
            checkpoint: Some(SourceCheckpoint {
                value: serde_json::to_string(&window)?,
            }),
        })
    }

    fn normalize(&self, output: ReadOutput, mut window: Window) -> Result<SourceBatch> {
        match std::mem::replace(&mut window.phase, Phase::Settled) {
            Phase::Calendars {
                mut calendars,
                cursor,
            } => {
                let (page, complete) =
                    match page::<Calendar>(output, &self.namespace, "calendar#calendarList") {
                        Ok(page) => page,
                        Err(_) => {
                            return Ok(SourceBatch::unavailable(
                                self.key(),
                                "Calendar list is unavailable; check scoped CLI access",
                            ));
                        }
                    };
                if !complete
                    || page.items.len() > PAGE_SIZE
                    || page.items.iter().any(|item| item.id.is_empty())
                    || !valid_cursor(&page.next_page_token, &cursor)
                {
                    return Ok(self.partial(Vec::new()));
                }
                for item in page.items {
                    if !calendars.contains(&item.id) {
                        calendars.push(item.id);
                    }
                }
                if calendars.len() > MAX_CALENDARS {
                    return Ok(self.partial(Vec::new()));
                }
                window.phase = if page.next_page_token.is_some() {
                    Phase::Calendars {
                        calendars,
                        cursor: page.next_page_token,
                    }
                } else if calendars.is_empty() {
                    Phase::Settled
                } else {
                    Phase::Events {
                        calendars,
                        index: 0,
                        cursor: None,
                    }
                };
                self.advance(window, Vec::new())
            }
            Phase::Events {
                calendars,
                mut index,
                cursor,
            } => {
                let (page, complete) =
                    match page::<Event>(output, &self.namespace, "calendar#events") {
                        Ok(page) => page,
                        Err(_) => {
                            return Ok(SourceBatch::unavailable(
                                self.key(),
                                "Calendar events are unavailable; check scoped CLI access",
                            ));
                        }
                    };
                let calendar = calendars
                    .get(index)
                    .context("Calendar checkpoint index is invalid")?;
                let mut invalid = page.items.len() > PAGE_SIZE;
                let mut events = Vec::new();
                for mut event in page.items.into_iter().take(PAGE_SIZE) {
                    let version = event
                        .etag
                        .as_ref()
                        .filter(|value| !value.is_empty())
                        .or_else(|| event.updated.as_ref().filter(|value| !value.is_empty()))
                        .cloned();
                    let Some(version) = version.filter(|_| !event.id.is_empty()) else {
                        invalid = true;
                        continue;
                    };
                    let id = serde_json::to_string(&(&self.namespace, calendar, &event.id))?;
                    let title = event
                        .summary
                        .clone()
                        .filter(|value| !value.is_empty())
                        .unwrap_or_else(|| {
                            if event.status.as_deref() == Some("cancelled") {
                                "Cancelled calendar event".into()
                            } else {
                                "Calendar event".into()
                            }
                        });
                    let mut excerpt = event.attendees_omitted == Some(true);
                    if let Some(description) = &mut event.description
                        && description.chars().count() > 4000
                    {
                        *description = description.chars().take(4000).collect();
                        excerpt = true;
                    }
                    let mut text =
                        format!("Calendar: {calendar}\n{}", serde_json::to_string(&event)?);
                    if excerpt {
                        text.push_str("\n[Excerpt; read the original event for full details.]");
                    }
                    events.push(SourceEvent {
                        id: id.clone(),
                        version,
                        source: SourceRef {
                            provider: self.key().provider,
                            account: self.namespace.clone(),
                            thread_id: id,
                        },
                        title,
                        text,
                    });
                }
                if !complete || invalid || !valid_cursor(&page.next_page_token, &cursor) {
                    return Ok(self.partial(events));
                }
                if page.next_page_token.is_none() {
                    index += 1;
                }
                window.phase = if index == calendars.len() {
                    Phase::Settled
                } else {
                    Phase::Events {
                        calendars,
                        index,
                        cursor: page.next_page_token,
                    }
                };
                self.advance(window, events)
            }
            Phase::Settled => anyhow::bail!("Calendar scan is already settled"),
        }
    }
}

#[async_trait::async_trait]
impl Source for CalendarSource {
    fn key(&self) -> SourceKey {
        SourceKey {
            provider: "google_calendar".into(),
            account: self.namespace.clone(),
        }
    }
    async fn poll(&self, checkpoint: Option<&SourceCheckpoint>) -> Result<SourceBatch> {
        let window = self.window(checkpoint, now_seconds()?)?;
        let command = self.command(&window)?;
        match read_command(&command).await {
            Ok(output) => self.normalize(output, window),
            Err(_) => Ok(SourceBatch::unavailable(
                self.key(),
                "Calendar CLI could not run; check scoped provider access",
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::sources::{
        ReadOutput, Source, SourceCheckpoint, SourceCoverage,
        calendar::{CalendarSource, Event, EventParams, Phase, Window},
    };
    use anyhow::Context;

    const NOW: u64 = 1_800_000_000;
    fn source() -> CalendarSource {
        CalendarSource::new("google.fixture".into()).unwrap()
    }
    fn output(body: &str) -> ReadOutput {
        ReadOutput {
            exit_code: 0,
            truncated: false,
            stdout: format!(
                r#"{{"namespace":"google.fixture","status":"executed","fields":{{"status":"ok","response":{body}}}}}"#
            ),
        }
    }
    fn checkpoint(batch: &crate::sources::SourceBatch) -> &SourceCheckpoint {
        batch.checkpoint.as_ref().unwrap()
    }
    fn events_window(source: &CalendarSource) -> Window {
        let batch = source
            .normalize(
                output(
                    r#"{"kind":"calendar#calendarList","items":[{"id":"first"},{"id":"second"}]}"#,
                ),
                source.window(None, NOW).unwrap(),
            )
            .unwrap();
        source.window(Some(checkpoint(&batch)), NOW).unwrap()
    }
    fn params(source: &CalendarSource, window: &Window) -> EventParams {
        serde_json::from_str(source.command(window).unwrap().last().unwrap()).unwrap()
    }

    #[test]
    fn native_pagination_covers_every_calendar_and_freezes_the_window() {
        let source = source();
        let initial = source.window(None, NOW).unwrap();
        let first = source.normalize(output(r#"{"kind":"calendar#calendarList","items":[{"id":"first"}],"nextPageToken":"calendars-next"}"#), initial).unwrap();
        assert_eq!(first.coverage, SourceCoverage::More);
        let saved = source
            .window(Some(checkpoint(&first)), NOW + 10_000)
            .unwrap();
        assert_eq!(saved.since, NOW - 86_400);
        assert!(
            matches!(&saved.phase, Phase::Calendars { cursor: Some(cursor), .. } if cursor == "calendars-next")
        );
        let listed = source
            .normalize(
                output(r#"{"kind":"calendar#calendarList","items":[{"id":"second"}]}"#),
                saved,
            )
            .unwrap();
        let saved = source
            .window(Some(checkpoint(&listed)), NOW + 20_000)
            .unwrap();
        let first_params = params(&source, &saved);
        assert_eq!(first_params.calendar_id, "first");
        assert!(first_params.single_events && first_params.show_deleted);
        assert_eq!(first_params.time_zone, "UTC");
        let page = source.normalize(output(r#"{"kind":"calendar#events","items":[{"id":"one","etag":"version1"}],"nextPageToken":"events-next"}"#), saved).unwrap();
        let saved = source
            .window(Some(checkpoint(&page)), NOW + 30_000)
            .unwrap();
        let next_params = params(&source, &saved);
        assert_eq!(next_params.page_token.as_deref(), Some("events-next"));
        assert_eq!(next_params.time_min, first_params.time_min);
        assert_eq!(next_params.time_max, first_params.time_max);
        let end_first = source
            .normalize(output(r#"{"kind":"calendar#events"}"#), saved)
            .unwrap();
        let saved = source
            .window(Some(checkpoint(&end_first)), NOW + 40_000)
            .unwrap();
        assert_eq!(params(&source, &saved).calendar_id, "second");
        let finished = source
            .normalize(output(r#"{"kind":"calendar#events","items":[]}"#), saved)
            .unwrap();
        assert_eq!(finished.coverage, SourceCoverage::Complete);
        let renewed = source
            .window(Some(checkpoint(&finished)), NOW + 50_000)
            .unwrap();
        assert_eq!(renewed.since, NOW + 50_000 - 86_400);
        assert!(matches!(
            renewed.phase,
            Phase::Calendars { cursor: None, .. }
        ));
    }

    #[test]
    fn native_event_identity_versions_and_all_day_cancellations_remain_distinct() {
        let source = source();
        let body = r#"{"kind":"calendar#events","summary":"Fixture calendar","items":[{"id":"same","etag":"etag1","updated":"2026-01-01T01:00:00Z","status":"cancelled","iCalUID":"shared-uid","start":{"date":"2026-01-02"},"end":{"date":"2026-01-03"}},{"id":"updated-only","updated":"2026-01-01T02:00:00Z"}]}"#;
        let first = source
            .normalize(output(body), events_window(&source))
            .unwrap();
        assert_eq!(first.events[0].version, "etag1");
        assert_eq!(first.events[1].version, "2026-01-01T02:00:00Z");
        assert_eq!(first.events[0].title, "Cancelled calendar event");
        let native: Event =
            serde_json::from_str(first.events[0].text.split_once('\n').unwrap().1).unwrap();
        assert_eq!(native.i_cal_uid.as_deref(), Some("shared-uid"));
        assert_eq!(native.start.unwrap().date.as_deref(), Some("2026-01-02"));
        assert_eq!(native.end.unwrap().date.as_deref(), Some("2026-01-03"));
        let saved = source.window(Some(checkpoint(&first)), NOW).unwrap();
        let second = source.normalize(output(body), saved).unwrap();
        assert_ne!(first.events[0].id, second.events[0].id);
        assert_eq!(first.events[0].source.account, "google.fixture");
        assert_eq!(first.events[0].source.thread_id, first.events[0].id);
    }

    #[test]
    fn calendar_rename_keeps_the_same_event_version_and_wire_payload() {
        let source = source();
        let native = r#"{"kind":"calendar#events","summary":"Original calendar","items":[{"id":"stable-event","etag":"stable-version","summary":"Meeting"}]}"#;
        let before = source
            .normalize(output(native), events_window(&source))
            .unwrap();
        let renamed = native.replace("Original calendar", "Renamed calendar");
        let after = source
            .normalize(output(&renamed), events_window(&source))
            .unwrap();
        assert_eq!(before.events[0].id, after.events[0].id);
        assert_eq!(before.events[0].version, after.events[0].version);
        // SourceJournal admits each version once and rejects changed content.
        assert_eq!(
            serde_json::to_string(&before.events).unwrap(),
            serde_json::to_string(&after.events).unwrap()
        );
    }

    #[test]
    fn partial_and_failed_native_reads_never_advance_but_retain_valid_events() {
        let source = source();
        let body = r#"{"kind":"calendar#events","items":[{"id":"valid","etag":"version"},{"id":"unknown-version"},{"etag":"missing-id"}]}"#;
        let batch = source
            .normalize(output(body), events_window(&source))
            .unwrap();
        assert_eq!(batch.events.len(), 1);
        assert!(matches!(batch.coverage, SourceCoverage::Partial { .. }));
        assert!(batch.checkpoint.is_none());
        let mut failed =
            output(r#"{"kind":"calendar#events","items":[{"id":"valid","etag":"version"}]}"#);
        failed.exit_code = 1;
        let batch = source.normalize(failed, events_window(&source)).unwrap();
        assert_eq!(batch.events.len(), 1);
        assert!(batch.checkpoint.is_none());
        let mut truncated = output(r#"{"kind":"calendar#events"}"#);
        truncated.truncated = true;
        let batch = source.normalize(truncated, events_window(&source)).unwrap();
        assert!(matches!(batch.coverage, SourceCoverage::Unavailable { .. }));
        assert!(batch.checkpoint.is_none());
    }

    #[test]
    fn account_mismatch_and_repeated_native_cursor_cannot_admit_or_skip_work() {
        let source = source();
        let mut other =
            output(r#"{"kind":"calendar#events","items":[{"id":"foreign","etag":"version"}]}"#);
        other.stdout = other.stdout.replace("google.fixture", "google.other");
        let batch = source.normalize(other, events_window(&source)).unwrap();
        assert!(batch.events.is_empty() && batch.checkpoint.is_none());
        let initial = source
            .normalize(
                output(r#"{"kind":"calendar#events","nextPageToken":"next"}"#),
                events_window(&source),
            )
            .unwrap();
        let saved = source.window(Some(checkpoint(&initial)), NOW).unwrap();
        let stuck = source
            .normalize(
                output(r#"{"kind":"calendar#events","nextPageToken":"next"}"#),
                saved,
            )
            .unwrap();
        assert!(matches!(stuck.coverage, SourceCoverage::Partial { .. }));
        assert!(stuck.checkpoint.is_none());
        let other_checkpoint = SourceCheckpoint {
            value: checkpoint(&initial)
                .value
                .replace("google.fixture", "google.other"),
        };
        assert!(source.window(Some(&other_checkpoint), NOW).is_err());
    }

    #[tokio::test]
    #[ignore = "requires installed Switchboard and existing scoped Google calendar sessions"]
    async fn live_cli_reads_every_configured_account_without_printing_events() -> anyhow::Result<()>
    {
        tokio::time::timeout(std::time::Duration::from_secs(120), async {
            let sources = CalendarSource::discover(None).await?;
            anyhow::ensure!(!sources.is_empty(), "No configured Google calendar accounts");
            let count = sources.len();
            for (index, source) in sources.into_iter().enumerate() {
                let mut saved = None;
                let mut events = 0;
                let mut complete = false;
                for page in 1..=64 {
                    let batch = source.poll(saved.as_ref()).await?;
                    events += batch.events.len();
                    anyhow::ensure!(matches!(batch.coverage, SourceCoverage::More | SourceCoverage::Complete),
                        "Calendar account {} has a coverage gap", index + 1);
                    saved = batch.checkpoint;
                    if batch.coverage == SourceCoverage::Complete {
                        eprintln!("Calendar account {}/{}: {} native pages, {} event versions, complete scoped window", index + 1, count, page, events);
                        complete = true;
                        break;
                    }
                }
                anyhow::ensure!(complete, "Calendar scan exceeded its bounded page budget");
            }
            Ok(())
        }).await.context("Live calendar read exceeded its two-minute limit")?
    }
}
