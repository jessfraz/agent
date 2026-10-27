//! Indexed Slack-message intake through a configured read-only helper. Search
//! is not a complete workspace archive or private-thread read. Calendar windows
//! overlap by three days to tolerate indexing delay and account time zones.

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};

use crate::{
    protocol::SourceRef,
    sources::{
        ReadOutput, Source, SourceBatch, SourceCheckpoint, SourceCoverage, SourceEvent, SourceKey,
        now_seconds, read_command,
    },
};

#[derive(Debug)]
pub struct SlackSource {
    command: Vec<String>,
    account: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct Window {
    account: String,
    since_day: u64,
    until_day: u64,
    page: u32,
}

#[derive(Deserialize)]
struct Response {
    ok: bool,
    messages: Option<Messages>,
}
#[derive(Deserialize)]
struct Messages {
    matches: Vec<Message>,
    paging: Paging,
}
#[derive(Deserialize)]
struct Paging {
    page: u32,
    pages: u32,
}
#[derive(Deserialize)]
struct Message {
    #[serde(default)]
    ts: String,
    #[serde(default)]
    thread_ts: Option<String>,
    #[serde(default)]
    text: String,
    channel: Channel,
    edited: Option<Edited>,
}
#[derive(Deserialize)]
struct Channel {
    id: String,
    #[serde(default)]
    name: String,
}
#[derive(Deserialize)]
struct Edited {
    ts: String,
}

impl SlackSource {
    pub fn new(command: Vec<String>, account: String) -> Result<Self> {
        ensure!(
            command.first().is_some_and(|program| !program.is_empty()),
            "Slack source needs a read-only helper command"
        );
        ensure!(
            !account.is_empty(),
            "Slack source needs an explicit account"
        );
        Ok(Self { command, account })
    }

    fn window(&self, checkpoint: Option<&SourceCheckpoint>, now: u64) -> Result<Window> {
        let day = now / 86_400;
        let mut window = match checkpoint {
            Some(checkpoint) => serde_json::from_str(&checkpoint.value)
                .context("Invalid Slack source checkpoint")?,
            None => Window {
                account: self.account.clone(),
                since_day: day.saturating_sub(3),
                until_day: 0,
                page: 1,
            },
        };
        ensure!(
            window.account == self.account,
            "Slack checkpoint belongs to another account"
        );
        if window.until_day == 0 {
            window.until_day = day.saturating_add(2);
        }
        ensure!(
            window.since_day < window.until_day && (1..=100).contains(&window.page),
            "Slack checkpoint window is invalid"
        );
        Ok(window)
    }

    fn normalize(&self, output: ReadOutput, mut window: Window) -> SourceBatch {
        let key = self.key();
        if output.truncated {
            return SourceBatch::unavailable(
                key,
                "Slack helper output was truncated; checkpoint retained",
            );
        }
        let Ok(response) = serde_json::from_str::<Response>(&output.stdout) else {
            return SourceBatch::unavailable(
                key,
                "Slack helper returned no valid result; check read-only authorization",
            );
        };
        let Some(messages) = response.messages else {
            return SourceBatch::unavailable(
                key,
                "Slack returned no message coverage; check read-only authorization",
            );
        };
        let mut invalid = false;
        let events = messages
            .matches
            .into_iter()
            .filter_map(|message| {
                if message.ts.is_empty() || message.channel.id.is_empty() {
                    invalid = true;
                    return None;
                }
                let id = format!("{}:{}", message.channel.id, message.ts);
                let thread_id = format!(
                    "{}:{}",
                    message.channel.id,
                    message.thread_ts.as_deref().unwrap_or(&message.ts)
                );
                let channel = if message.channel.name.is_empty() {
                    &message.channel.id
                } else {
                    &message.channel.name
                };
                Some(SourceEvent {
                    id,
                    version: message.edited.map_or(message.ts, |edited| edited.ts),
                    source: SourceRef {
                        provider: key.provider.clone(),
                        account: key.account.clone(),
                        thread_id,
                    },
                    title: format!("Slack: {channel}"),
                    text: message.text,
                })
            })
            .collect();
        let mut batch = SourceBatch {
            source: key,
            events,
            checkpoint: None,
            coverage: SourceCoverage::Partial {
                message: "Slack search coverage is incomplete; checkpoint retained".into(),
            },
        };
        if !response.ok || output.exit_code != 0 || invalid || messages.paging.page != window.page {
            return batch;
        }
        if messages.paging.pages > window.page {
            if window.page == 100 {
                return batch;
            }
            window.page += 1;
            batch.coverage = SourceCoverage::More;
        } else {
            // Keep overlap relative to the window being completed, not the time
            // its last page arrived, so a slow multi-day scan cannot skip ahead.
            window.since_day = window.until_day.saturating_sub(5);
            window.until_day = 0;
            window.page = 1;
            batch.coverage = SourceCoverage::Complete;
        }
        if let Ok(value) = serde_json::to_string(&window) {
            batch.checkpoint = Some(SourceCheckpoint { value });
        }
        batch
    }
}

#[async_trait::async_trait]
impl Source for SlackSource {
    fn key(&self) -> SourceKey {
        SourceKey {
            provider: "slack".into(),
            account: self.account.clone(),
        }
    }

    async fn poll(&self, checkpoint: Option<&SourceCheckpoint>) -> Result<SourceBatch> {
        let window = self.window(checkpoint, now_seconds()?)?;
        let mut args = self.command.clone();
        args.extend([
            "--timeout-seconds".into(),
            "25".into(),
            "search.messages".into(),
            format!(
                "query=after:{} before:{}",
                utc_date(window.since_day)?,
                utc_date(window.until_day)?
            ),
            "sort=timestamp".into(),
            "sort_dir=asc".into(),
            "count=25".into(),
            format!("page={}", window.page),
        ]);
        Ok(match read_command(&args).await {
            Ok(output) => self.normalize(output, window),
            Err(_) => SourceBatch::unavailable(
                self.key(),
                "Slack helper could not run; check read-only authorization",
            ),
        })
    }
}

fn utc_date(day: u64) -> Result<String> {
    let seconds: libc::time_t = day
        .checked_mul(86_400)
        .context("Slack checkpoint date is too large")?
        .try_into()?;
    let mut date: libc::tm = unsafe { std::mem::zeroed() };
    // gmtime_r writes only this owned tm and does not use a shared date buffer.
    ensure!(
        !unsafe { libc::gmtime_r(&seconds, &mut date) }.is_null(),
        "Slack checkpoint date is invalid"
    );
    Ok(format!(
        "{:04}-{:02}-{:02}",
        date.tm_year + 1900,
        date.tm_mon + 1,
        date.tm_mday
    ))
}

#[cfg(test)]
mod tests {
    use crate::sources::{
        ReadOutput, SourceCoverage,
        slack::{SlackSource, utc_date},
    };

    const RESPONSE: &str = r#"{"ok":true,"messages":{"matches":[{"ts":"1700000000.000001","thread_ts":"1699999999.000002","text":"Review the board","channel":{"id":"CEXAMPLE","name":"engineering"}}],"paging":{"page":1,"pages":2}}}"#;
    fn source() -> SlackSource {
        SlackSource::new(vec!["slack-read".into()], "workspace-example".into()).unwrap()
    }
    fn output(text: &str) -> ReadOutput {
        ReadOutput {
            exit_code: 0,
            stdout: text.into(),
            truncated: false,
        }
    }

    #[test]
    fn native_search_preserves_identity_and_frozen_page_window() {
        let source = source();
        let batch = source.normalize(
            output(RESPONSE),
            source.window(None, 1_700_000_000).unwrap(),
        );
        assert_eq!(batch.coverage, SourceCoverage::More);
        assert_eq!(batch.events[0].id, "CEXAMPLE:1700000000.000001");
        assert_eq!(
            batch.events[0].source.thread_id,
            "CEXAMPLE:1699999999.000002"
        );
        let next = source
            .window(batch.checkpoint.as_ref(), 1_710_000_000)
            .unwrap();
        assert_eq!(next.page, 2);
        assert_eq!(next.until_day, 1_700_000_000 / 86_400 + 2);
        assert!(
            SlackSource::new(vec!["slack-read".into()], "other-example".into())
                .unwrap()
                .window(batch.checkpoint.as_ref(), 1_700_000_000)
                .is_err()
        );
    }

    #[test]
    fn completion_keeps_overlap_and_failure_does_not_advance() {
        let source = source();
        let complete = RESPONSE.replace("\"pages\":2", "\"pages\":1");
        let batch = source.normalize(
            output(&complete),
            source.window(None, 1_700_000_000).unwrap(),
        );
        assert_eq!(batch.coverage, SourceCoverage::Complete);
        let next = source
            .window(batch.checkpoint.as_ref(), 1_710_000_000)
            .unwrap();
        assert_eq!(next.since_day, 1_700_000_000 / 86_400 - 3);
        let failed = source.normalize(
            output(&RESPONSE.replace("\"ok\":true", "\"ok\":false")),
            source.window(None, 1_700_000_000).unwrap(),
        );
        assert_eq!(failed.events.len(), 1);
        assert!(matches!(failed.coverage, SourceCoverage::Partial { .. }));
        assert!(failed.checkpoint.is_none());
    }

    #[test]
    fn unavailable_auth_is_not_an_empty_success() {
        let source = source();
        let batch = source.normalize(
            output(r#"{"ok":false,"error":"token_expired"}"#),
            source.window(None, 1_700_000_000).unwrap(),
        );
        assert!(matches!(batch.coverage, SourceCoverage::Unavailable { .. }));
        assert!(batch.checkpoint.is_none());
    }

    #[test]
    fn calendar_query_dates_use_utc_without_local_timezone_state() {
        assert_eq!(utc_date(0).unwrap(), "1970-01-01");
        assert_eq!(utc_date(1_700_000_000 / 86_400).unwrap(), "2023-11-14");
        assert_eq!(utc_date(19_782).unwrap(), "2024-02-29");
    }
}
