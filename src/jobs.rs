//! Git-managed job definitions and pure calendar planning. Pi owns all timers.

use std::{
    collections::BTreeSet,
    fmt, fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail, ensure};
use chrono::{DateTime, Duration, LocalResult, NaiveDateTime, TimeZone, Utc};
use chrono_tz::Tz;
use rrule::{Frequency, RRule, RRuleSet, Unvalidated};
use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};
use ts_rs::TS;

use crate::models::{ModelProvider, ModelSelection, Reasoning};

const MAX_JOB_BYTES: u64 = 262_144;
const MAX_PROMPT_BYTES: usize = 65_536 - 1_024;
const MAX_OCCURRENCES: usize = 100_000;

macro_rules! string_type {
    ($name:ident, $validate:ident) => {
        #[derive(Clone, Debug, Serialize, JsonSchema, TS, PartialEq, Eq, PartialOrd, Ord)]
        pub struct $name(String);

        impl $name {
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl TryFrom<String> for $name {
            type Error = anyhow::Error;
            fn try_from(value: String) -> Result<Self> {
                $validate(&value)?;
                Ok(Self(value))
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
                self.0.fmt(output)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(
                deserializer: D,
            ) -> std::result::Result<Self, D::Error> {
                Self::try_from(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
            }
        }
    };
}

string_type!(JobId, validate_id);
string_type!(ScheduleId, validate_id);
string_type!(TimezoneId, validate_timezone);

fn validate_id(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty()
            && value.len() <= 128
            && !value
                .chars()
                .any(|character| character.is_whitespace() || character.is_control()),
        "Job and schedule IDs must contain 1 to 128 bytes without whitespace or control characters"
    );
    Ok(())
}

fn validate_timezone(value: &str) -> Result<()> {
    value.parse::<Tz>().context("Unknown IANA timezone")?;
    Ok(())
}

/// An absolute instant that has the same exact representation in Rust and JS.
#[derive(Clone, Copy, Debug, Serialize, JsonSchema, TS, PartialEq, Eq, PartialOrd, Ord)]
pub struct UtcMillis(#[ts(type = "number")] i64);

impl UtcMillis {
    pub fn new(value: i64) -> Result<Self> {
        ensure!(
            (0..=9_007_199_254_740_991).contains(&value)
                && DateTime::<Utc>::from_timestamp_millis(value).is_some(),
            "Timestamp must be a nonnegative, representable epoch millisecond"
        );
        Ok(Self(value))
    }

    pub fn get(self) -> i64 {
        self.0
    }

    pub fn now() -> Result<Self> {
        Self::new(i64::try_from(
            SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis(),
        )?)
    }

    fn datetime(self) -> Result<DateTime<Utc>> {
        DateTime::from_timestamp_millis(self.0).context("Timestamp is outside the calendar range")
    }
}

impl TryFrom<i64> for UtcMillis {
    type Error = anyhow::Error;
    fn try_from(value: i64) -> Result<Self> {
        Self::new(value)
    }
}

impl From<UtcMillis> for i64 {
    fn from(value: UtcMillis) -> Self {
        value.get()
    }
}

impl<'de> Deserialize<'de> for UtcMillis {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        Self::new(i64::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

/// Canonical DTSTART/RRULE properties, with an explicit timezone and anchor.
#[derive(Clone, Debug, Serialize, JsonSchema, TS, PartialEq, Eq)]
pub struct Recurrence(String);

impl Recurrence {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn calendar(&self) -> Result<Calendar> {
        Calendar::parse(&self.0)
    }
}

impl TryFrom<String> for Recurrence {
    type Error = anyhow::Error;
    fn try_from(value: String) -> Result<Self> {
        let calendar = Calendar::parse(&value)?;
        Ok(Self(format!(
            "DTSTART;TZID={}:{}\nRRULE:{}",
            calendar.timezone,
            calendar.start.format("%Y%m%dT%H%M%S"),
            calendar.rule
        )))
    }
}

impl<'de> Deserialize<'de> for Recurrence {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        Self::try_from(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct JobSchedule {
    pub id: ScheduleId,
    pub recurrence: Recurrence,
    pub focus: Option<String>,
    pub prompt: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ScheduledJob {
    pub id: JobId,
    pub title: String,
    pub prompt: String,
    pub model: ModelSelection,
    pub timezone: TimezoneId,
    pub schedules: Vec<JobSchedule>,
    pub revision: String,
    pub cwd: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct OccurrencePlan {
    pub due: Option<UtcMillis>,
    pub next: Option<UtcMillis>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct JobFile {
    id: JobId,
    title: Option<String>,
    prompt: String,
    model: String,
    #[serde(default)]
    provider: ModelProvider,
    reasoning_effort: Option<Reasoning>,
    #[serde(default)]
    fast: bool,
    timezone: TimezoneId,
    #[serde(default = "enabled")]
    enabled: bool,
    schedules: Vec<JobSchedule>,
}

fn enabled() -> bool {
    true
}

struct Calendar {
    start: NaiveDateTime,
    timezone: Tz,
    rule: RRule,
}

impl Calendar {
    fn parse(value: &str) -> Result<Self> {
        let lines: Vec<_> = value
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect();
        let properties = match lines.as_slice() {
            ["BEGIN:VEVENT", start, rule, "END:VEVENT"] => [*start, *rule],
            [start, rule] => [*start, *rule],
            _ => bail!(
                "A job recurrence must contain exactly DTSTART and RRULE, optionally wrapped in VEVENT"
            ),
        };
        let start_property = properties[0]
            .strip_prefix("DTSTART")
            .context("Recurrence must begin with DTSTART")?;
        let (timezone, date) = if let Some(date) = start_property
            .strip_prefix(':')
            .and_then(|date| date.strip_suffix('Z'))
        {
            (Tz::UTC, date)
        } else {
            let (zone, date) = start_property
                .strip_prefix(";TZID=")
                .and_then(|value| value.split_once(':'))
                .context("DTSTART needs a named TZID or a UTC Z suffix")?;
            (
                zone.parse::<Tz>().context("Unknown DTSTART timezone")?,
                date,
            )
        };
        let start = NaiveDateTime::parse_from_str(date, "%Y%m%dT%H%M%S")
            .context("DTSTART must be a complete local date and time")?;
        ensure!(
            timezone.from_local_datetime(&start).earliest().is_some(),
            "DTSTART is a nonexistent local time"
        );
        let rule_text = properties[1]
            .strip_prefix("RRULE:")
            .context("DTSTART must be followed by RRULE")?;
        let mut fields = BTreeSet::new();
        for property in rule_text.split(';') {
            let (field, _) = property.split_once('=').context("Invalid RRULE field")?;
            ensure!(
                matches!(
                    field,
                    "FREQ" | "INTERVAL" | "BYDAY" | "BYHOUR" | "BYMINUTE" | "BYSECOND" | "WKST"
                ),
                "Unsupported job RRULE field {field}"
            );
            ensure!(fields.insert(field), "Duplicate RRULE field {field}");
        }
        let rule = rule_text
            .parse::<RRule<Unvalidated>>()?
            .validate(start.and_utc().with_timezone(&rrule::Tz::UTC))?;
        ensure!(
            matches!(
                rule.get_freq(),
                Frequency::Hourly | Frequency::Daily | Frequency::Weekly
            ),
            "Job recurrence frequency must be HOURLY, DAILY or WEEKLY"
        );
        let first = RRuleSet::new(start.and_utc().with_timezone(&rrule::Tz::UTC))
            .rrule(rule.clone())
            .all(1);
        ensure!(
            first
                .dates
                .first()
                .is_some_and(|date| date.naive_utc() == start),
            "DTSTART does not match RRULE filters; choose the intended aligned anchor explicitly"
        );
        Ok(Self {
            start,
            timezone,
            rule,
        })
    }

    fn check_timezone(&self, timezone: &TimezoneId) -> Result<()> {
        ensure!(
            self.timezone.name() == timezone.as_str(),
            "Job timezone and DTSTART TZID must match"
        );
        Ok(())
    }

    fn occurrences(&self, after: UtcMillis) -> Result<impl Iterator<Item = DateTime<rrule::Tz>>> {
        // Move by whole recurrence periods, retaining the original phase and
        // two preceding periods for BYDAY expansions and timezone transitions.
        let reference = after
            .datetime()?
            .with_timezone(&self.timezone)
            .naive_local();
        let elapsed = reference.signed_duration_since(self.start);
        let interval = i64::from(self.rule.get_interval());
        let (periods, span) = match self.rule.get_freq() {
            Frequency::Hourly => (
                elapsed.num_hours() / interval,
                Duration::try_hours(interval),
            ),
            Frequency::Daily => (elapsed.num_days() / interval, Duration::try_days(interval)),
            Frequency::Weekly => (
                elapsed.num_weeks() / interval,
                Duration::try_weeks(interval),
            ),
            _ => bail!("Unsupported job recurrence frequency"),
        };
        let periods = periods.saturating_sub(2).max(0);
        let offset = span
            .context("Recurrence interval is too large")?
            .checked_mul(i32::try_from(periods)?)
            .context("Recurrence is outside the calendar range")?;
        let start = self
            .start
            .checked_add_signed(offset)
            .context("Recurrence is outside the calendar range")?;
        Ok(
            RRuleSet::new(start.and_utc().with_timezone(&rrule::Tz::UTC))
                .rrule(self.rule.clone())
                .limit()
                .into_iter(),
        )
    }

    fn resolve(&self, civil: DateTime<rrule::Tz>) -> Result<Option<UtcMillis>> {
        // rrule 0.14 shifts gaps when expanding named zones. Expanding civil
        // times first keeps recurrence math upstream while implementing RFC
        // timezone semantics here: skip gaps, choose the first folded instant.
        let instant = match self.timezone.from_local_datetime(&civil.naive_utc()) {
            LocalResult::None => return Ok(None),
            LocalResult::Single(date) => date,
            LocalResult::Ambiguous(first, second) => first.min(second),
        };
        Ok(Some(UtcMillis::new(instant.timestamp_millis())?))
    }
}

/// Read a complete, deterministic snapshot. A failed read never means deletion.
pub fn load(directories: &[PathBuf]) -> Result<Vec<ScheduledJob>> {
    let mut files = Vec::new();
    for directory in directories {
        ensure!(
            directory.is_dir(),
            "Scheduled job directory is unavailable: {}",
            directory.display()
        );
        for entry in fs::read_dir(directory).context("Could not list scheduled jobs")? {
            let path = entry?.path();
            if path
                .extension()
                .is_some_and(|extension| extension == "toml")
            {
                ensure!(path.is_file(), "Scheduled job TOML is not a regular file");
                files.push(path);
            }
        }
    }
    files.sort();
    let mut ids = BTreeSet::new();
    let mut jobs = Vec::new();
    for file in files {
        ensure!(
            fs::metadata(&file)?.len() <= MAX_JOB_BYTES,
            "Scheduled job file is too large"
        );
        let raw: JobFile =
            toml::from_str(&fs::read_to_string(&file).context("Could not read scheduled job")?)
                .with_context(|| format!("Invalid scheduled job at {}", file.display()))?;
        ensure!(
            ids.insert(raw.id.clone()),
            "Duplicate scheduled job ID {}",
            raw.id
        );
        ensure!(
            !raw.prompt.trim().is_empty(),
            "A scheduled job prompt is required"
        );
        ensure!(
            !raw.schedules.is_empty(),
            "A scheduled job needs at least one schedule"
        );
        let mut schedules = raw.schedules;
        schedules.sort_by(|left, right| left.id.cmp(&right.id));
        let mut schedule_ids = BTreeSet::new();
        for schedule in &schedules {
            ensure!(
                schedule_ids.insert(schedule.id.clone()),
                "Duplicate schedule ID {}",
                schedule.id
            );
            schedule
                .recurrence
                .calendar()?
                .check_timezone(&raw.timezone)?;
            ensure!(
                raw.prompt.len()
                    + schedule.prompt.as_ref().map_or(0, String::len)
                    + schedule.focus.as_ref().map_or(0, String::len)
                    <= MAX_PROMPT_BYTES,
                "Combined job and schedule prompt exceeds the task input limit"
            );
        }
        let model = ModelSelection {
            provider: raw.provider,
            model_id: raw.model,
            reasoning: raw.reasoning_effort,
            fast: raw.fast,
        };
        model.validate()?;
        let mut job = ScheduledJob {
            title: raw
                .title
                .unwrap_or_else(|| raw.id.as_str().replace('-', " ")),
            id: raw.id,
            prompt: raw.prompt,
            model,
            timezone: raw.timezone,
            schedules,
            revision: String::new(),
            cwd: working_directory(&file)?,
        };
        ensure!(
            !job.title.trim().is_empty(),
            "A scheduled job title is required"
        );
        job.revision = hex::encode(Sha256::digest(serde_json::to_vec(&job)?));
        if raw.enabled {
            jobs.push(job);
        }
    }
    jobs.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(jobs)
}

fn working_directory(file: &Path) -> Result<String> {
    let parent = file
        .parent()
        .context("Scheduled job has no directory")?
        .canonicalize()?;
    let root = parent
        .ancestors()
        .find(|directory| directory.join(".git").exists())
        .unwrap_or(&parent);
    Ok(root
        .to_str()
        .context("Job directory must be UTF-8")?
        .to_owned())
}

/// Coalesce missed occurrences after the durable cursor; activation is future-only.
pub fn plan(
    schedule: &JobSchedule,
    timezone: &TimezoneId,
    after: Option<UtcMillis>,
    now: UtcMillis,
) -> Result<OccurrencePlan> {
    let calendar = schedule.recurrence.calendar()?;
    calendar.check_timezone(timezone)?;
    let floor = after.unwrap_or(now);
    let mut due = None;
    for civil in calendar.occurrences(floor)?.take(MAX_OCCURRENCES) {
        let Some(instant) = calendar.resolve(civil)? else {
            continue;
        };
        if instant <= floor {
            continue;
        }
        if instant <= now {
            due = Some(instant);
        } else {
            return Ok(OccurrencePlan {
                due,
                next: Some(instant),
            });
        }
    }
    bail!("Job recurrence exceeded the bounded occurrence search")
}

pub fn preview(
    schedule: &JobSchedule,
    timezone: &TimezoneId,
    after: UtcMillis,
    count: usize,
) -> Result<Vec<UtcMillis>> {
    ensure!(
        (1..=100).contains(&count),
        "Preview count must be between 1 and 100"
    );
    let calendar = schedule.recurrence.calendar()?;
    calendar.check_timezone(timezone)?;
    let mut dates = Vec::with_capacity(count);
    for civil in calendar.occurrences(after)?.take(MAX_OCCURRENCES) {
        let Some(instant) = calendar.resolve(civil)? else {
            continue;
        };
        if instant <= after {
            continue;
        }
        dates.push(instant);
        if dates.len() == count {
            return Ok(dates);
        }
    }
    bail!("Job recurrence exceeded the bounded occurrence search")
}

#[cfg(test)]
mod tests {
    use std::fs;

    use chrono::DateTime;
    use tempfile::tempdir;

    use crate::jobs::{
        JobId, JobSchedule, Recurrence, ScheduledJob, TimezoneId, UtcMillis, load, plan, preview,
    };

    fn instant(value: &str) -> UtcMillis {
        UtcMillis::new(
            DateTime::parse_from_rfc3339(value)
                .unwrap()
                .timestamp_millis(),
        )
        .unwrap()
    }

    fn recurrence(start: &str, zone: &str, rule: &str) -> String {
        format!("BEGIN:VEVENT\nDTSTART;TZID={zone}:{start}\nRRULE:{rule}\nEND:VEVENT")
    }

    fn definition(recurrence: &str, timezone: &str) -> String {
        format!(
            "id = \"daily-review\"\nprompt = \"Review changes and continue related tasks.\"\nmodel = \"fixture\"\nreasoning_effort = \"medium\"\ntimezone = \"{timezone}\"\n\n[[schedules]]\nid = \"morning\"\nrecurrence = \"\"\"\n{recurrence}\n\"\"\"\n"
        )
    }

    fn parsed(start: &str, timezone: &str, rule: &str) -> ScheduledJob {
        let directory = tempdir().unwrap();
        fs::write(
            directory.path().join("review.toml"),
            definition(&recurrence(start, timezone, rule), timezone),
        )
        .unwrap();
        load(&[directory.path().to_owned()]).unwrap().remove(0)
    }

    #[test]
    fn real_toml_normalizes_model_and_preserves_schedule_focus() {
        let directory = tempdir().unwrap();
        let mut contents = definition(
            &recurrence(
                "20261102T090000",
                "Europe/London",
                "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
            ),
            "Europe/London",
        );
        contents.push_str(
            "focus = \"Prepare evidence\"\nprompt = \"Return findings to the owning task.\"\n",
        );
        fs::write(directory.path().join("review.toml"), contents).unwrap();
        let job = load(&[directory.path().to_owned()]).unwrap().remove(0);
        assert_eq!(job.model.model_id, "fixture");
        assert_eq!(job.model.reasoning.unwrap().as_str(), "medium");
        assert_eq!(job.schedules[0].focus.as_deref(), Some("Prepare evidence"));
        assert_eq!(
            job.schedules[0].prompt.as_deref(),
            Some("Return findings to the owning task.")
        );
        let restored: ScheduledJob =
            serde_json::from_slice(&serde_json::to_vec(&job).unwrap()).unwrap();
        assert_eq!(restored.revision, job.revision);
        assert_eq!(
            preview(
                &restored.schedules[0],
                &restored.timezone,
                instant("2026-11-01T00:00:00Z"),
                1
            )
            .unwrap(),
            [instant("2026-11-02T09:00:00Z")]
        );
    }

    #[test]
    fn activation_is_future_only_and_recovery_coalesces_the_latest_missed_occurrence() {
        let job = parsed(
            "20261102T090000",
            "Europe/London",
            "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
        );
        let now = instant("2026-11-05T12:00:00Z");
        let activation = plan(&job.schedules[0], &job.timezone, None, now).unwrap();
        assert_eq!(activation.due, None);
        assert_eq!(activation.next, Some(instant("2026-11-06T09:00:00Z")));
        let recovery = plan(
            &job.schedules[0],
            &job.timezone,
            Some(instant("2026-11-02T09:00:00Z")),
            now,
        )
        .unwrap();
        assert_eq!(recovery.due, Some(instant("2026-11-05T09:00:00Z")));
        assert_eq!(recovery.next, activation.next);
        let boundary = plan(
            &job.schedules[0],
            &job.timezone,
            Some(instant("2026-11-05T09:00:00Z")),
            instant("2026-11-06T09:00:00Z"),
        )
        .unwrap();
        assert_eq!(boundary.due, Some(instant("2026-11-06T09:00:00Z")));
        let backwards = plan(
            &job.schedules[0],
            &job.timezone,
            recovery.due,
            instant("2026-11-03T12:00:00Z"),
        )
        .unwrap();
        assert_eq!(backwards.due, None);
        assert_eq!(backwards.next, activation.next);
    }

    #[test]
    fn daily_recurrences_skip_the_dst_gap_and_choose_the_first_fold() {
        let spring = parsed(
            "20260307T023000",
            "America/New_York",
            "FREQ=DAILY;BYHOUR=2;BYMINUTE=30;BYSECOND=0",
        );
        assert_eq!(
            preview(
                &spring.schedules[0],
                &spring.timezone,
                instant("2026-03-06T00:00:00Z"),
                3
            )
            .unwrap(),
            [
                instant("2026-03-07T07:30:00Z"),
                instant("2026-03-09T06:30:00Z"),
                instant("2026-03-10T06:30:00Z")
            ]
        );
        let autumn = parsed(
            "20261031T013000",
            "America/New_York",
            "FREQ=DAILY;BYHOUR=1;BYMINUTE=30;BYSECOND=0",
        );
        assert_eq!(
            preview(
                &autumn.schedules[0],
                &autumn.timezone,
                instant("2026-10-30T00:00:00Z"),
                3
            )
            .unwrap(),
            [
                instant("2026-10-31T05:30:00Z"),
                instant("2026-11-01T05:30:00Z"),
                instant("2026-11-02T06:30:00Z")
            ]
        );
    }

    #[test]
    fn hourly_intervals_keep_the_civil_anchor_across_dst_and_long_gaps() {
        let job = parsed(
            "20260306T090000",
            "America/New_York",
            "FREQ=HOURLY;INTERVAL=72;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
        );
        assert_eq!(
            preview(
                &job.schedules[0],
                &job.timezone,
                instant("2026-03-05T00:00:00Z"),
                3
            )
            .unwrap(),
            [
                instant("2026-03-06T14:00:00Z"),
                instant("2026-03-09T13:00:00Z"),
                instant("2026-03-12T13:00:00Z")
            ]
        );
        let future = preview(
            &job.schedules[0],
            &job.timezone,
            instant("2050-03-01T00:00:00Z"),
            2,
        )
        .unwrap();
        assert!(future[0] > instant("2050-03-01T00:00:00Z"));
        assert_eq!(future[1].get() - future[0].get(), 72 * 60 * 60 * 1000);
    }

    #[test]
    fn weekly_filters_and_multiple_daily_times_use_the_real_rrule_consumer() {
        let weekly = parsed(
            "20261102T090000",
            "Europe/London",
            "FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
        );
        assert_eq!(
            preview(
                &weekly.schedules[0],
                &weekly.timezone,
                instant("2026-11-01T00:00:00Z"),
                3
            )
            .unwrap(),
            [
                instant("2026-11-02T09:00:00Z"),
                instant("2026-11-04T09:00:00Z"),
                instant("2026-11-09T09:00:00Z")
            ]
        );
        let daily = parsed(
            "20261102T130000",
            "Europe/London",
            "FREQ=DAILY;BYHOUR=9,13,17;BYMINUTE=0;BYSECOND=0",
        );
        assert_eq!(
            preview(
                &daily.schedules[0],
                &daily.timezone,
                instant("2026-11-02T12:00:00Z"),
                3
            )
            .unwrap(),
            [
                instant("2026-11-02T13:00:00Z"),
                instant("2026-11-02T17:00:00Z"),
                instant("2026-11-03T09:00:00Z")
            ]
        );
    }

    #[test]
    fn moved_files_and_reordered_schedules_preserve_semantic_revision() {
        let directory = tempdir().unwrap();
        let original = definition(
            &recurrence(
                "20261102T090000",
                "Europe/London",
                "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
            ),
            "Europe/London",
        );
        let second = format!(
            "\n[[schedules]]\nid = \"evening\"\nrecurrence = {:?}\n",
            recurrence(
                "20261102T170000",
                "Europe/London",
                "FREQ=DAILY;BYHOUR=17;BYMINUTE=0;BYSECOND=0"
            )
        );
        let path = directory.path().join("review.toml");
        fs::write(&path, original.clone() + &second).unwrap();
        let first = load(&[directory.path().to_owned()]).unwrap().remove(0);
        let (header, morning) = original.split_once("[[schedules]]").unwrap();
        fs::write(&path, format!("{header}{second}\n[[schedules]]{morning}")).unwrap();
        fs::rename(&path, directory.path().join("renamed.toml")).unwrap();
        let reordered = load(&[directory.path().to_owned()]).unwrap().remove(0);
        assert_eq!(first.revision, reordered.revision);
        assert_eq!(first.id, reordered.id);
    }

    #[test]
    fn duplicate_ids_missing_roots_and_disabled_definitions_have_explicit_results() {
        let directory = tempdir().unwrap();
        let contents = definition(
            &recurrence("20261102T090000", "Europe/London", "FREQ=DAILY"),
            "Europe/London",
        );
        fs::write(directory.path().join("a.toml"), &contents).unwrap();
        fs::write(directory.path().join("b.toml"), &contents).unwrap();
        assert!(
            format!("{:#}", load(&[directory.path().to_owned()]).unwrap_err())
                .contains("Duplicate scheduled job ID")
        );
        fs::remove_file(directory.path().join("b.toml")).unwrap();
        fs::write(
            directory.path().join("a.toml"),
            contents.replacen("id =", "enabled = false\nid =", 1),
        )
        .unwrap();
        assert!(load(&[directory.path().to_owned()]).unwrap().is_empty());
        assert!(load(&[directory.path().join("missing")]).is_err());
    }

    #[test]
    fn duplicate_schedule_ids_and_oversized_composed_inputs_fail_before_sync() {
        let directory = tempdir().unwrap();
        let rule = recurrence("20261102T090000", "Europe/London", "FREQ=DAILY");
        let original = definition(&rule, "Europe/London");
        let path = directory.path().join("review.toml");
        fs::write(
            &path,
            format!("{original}\n[[schedules]]\nid = \"morning\"\nrecurrence = {rule:?}\n"),
        )
        .unwrap();
        assert!(
            format!("{:#}", load(&[directory.path().to_owned()]).unwrap_err())
                .contains("Duplicate schedule ID")
        );
        fs::write(
            &path,
            original.replace(
                "Review changes and continue related tasks.",
                &"é".repeat(33_000),
            ),
        )
        .unwrap();
        assert!(
            format!("{:#}", load(&[directory.path().to_owned()]).unwrap_err())
                .contains("task input limit")
        );
    }

    #[test]
    fn invalid_anchors_zones_rules_and_wire_values_are_rejected() {
        assert!(
            Recurrence::try_from(recurrence(
                "20261102T132420",
                "Europe/London",
                "FREQ=HOURLY;INTERVAL=4;BYMINUTE=0;BYSECOND=0"
            ))
            .unwrap_err()
            .to_string()
            .contains("aligned anchor")
        );
        assert!(
            Recurrence::try_from(recurrence(
                "20261102T090000",
                "Europe/London",
                "FREQ=MINUTELY"
            ))
            .is_err()
        );
        assert!(
            Recurrence::try_from(recurrence(
                "20261102T090000",
                "Europe/London",
                "FREQ=DAILY;COUNT=3"
            ))
            .is_err()
        );
        assert!(
            Recurrence::try_from("DTSTART:20261102T090000\nRRULE:FREQ=DAILY".to_owned()).is_err()
        );
        assert!(TimezoneId::try_from("Local".to_owned()).is_err());
        assert!(JobId::try_from(" Daily Review ".to_owned()).is_err());
        assert!(JobId::try_from("Daily_Review.v2".to_owned()).is_ok());
        assert!(serde_json::from_str::<UtcMillis>("9007199254740992").is_err());
        assert!(serde_json::from_str::<UtcMillis>("-1").is_err());
        assert!(
            serde_json::from_str::<JobSchedule>(
                r#"{"id":"bad","recurrence":"invalid","focus":null,"prompt":null}"#
            )
            .is_err()
        );
        let job = parsed("20261102T090000", "Europe/London", "FREQ=DAILY");
        assert!(
            plan(
                &job.schedules[0],
                &TimezoneId::try_from("UTC".to_owned()).unwrap(),
                None,
                instant("2026-11-01T00:00:00Z")
            )
            .is_err()
        );
    }
}
