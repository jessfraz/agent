//! Read-only Codex-account quota metadata, not this application's allowance.
//! Protocol: https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt

use std::collections::BTreeMap;
use std::fmt;
use std::process::Stdio;
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::io::{
    AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader,
};
use tokio::process::{Child, ChildStderr, Command};
use ts_rs::TS;

const QUERY_TIMEOUT: Duration = Duration::from_secs(25);
const MAX_FRAME_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum UsageSource {
    CodexAccount,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct UsageSnapshot {
    pub source: UsageSource,
    pub email: Option<String>,
    pub plan: Option<String>,
    pub buckets: BTreeMap<String, RateLimitBucket>,
    pub unkeyed_bucket: Option<RateLimitBucket>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitBucket {
    pub limit_id: Option<String>,
    pub limit_name: Option<String>,
    pub plan_type: Option<String>,
    pub primary: Option<RateLimitWindow>,
    pub secondary: Option<RateLimitWindow>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitWindow {
    pub used_percent: Option<f64>,
    #[ts(type = "number | null")]
    pub window_duration_mins: Option<u64>,
    #[ts(type = "number | null")]
    pub resets_at: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum UsageAvailability {
    Available { snapshot: Box<UsageSnapshot> },
    Unavailable { reason: UsageUnavailable },
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum UsageUnavailable {
    UnsupportedProvider,
    NotSignedIn,
    IdentityUnavailable,
    AccountMismatch,
    CodexUnavailable,
    ReadFailed,
}

impl fmt::Display for UsageUnavailable {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(match self {
            Self::UnsupportedProvider => "this provider does not expose account limits",
            Self::NotSignedIn => "no signed-in ChatGPT account",
            Self::IdentityUnavailable => "the ChatGPT account could not be verified",
            Self::AccountMismatch => "Codex is signed into a different ChatGPT account",
            Self::CodexUnavailable => "Codex account limits are unavailable",
            Self::ReadFailed => "the account limits could not be read",
        })
    }
}

/// The coordinator supplies its existing account identity; no login or refresh
/// is requested and a different or unverified Codex account is never accepted.
pub async fn account(expected_email: &str) -> UsageAvailability {
    if expected_email.trim().is_empty() {
        return UsageAvailability::Unavailable {
            reason: UsageUnavailable::IdentityUnavailable,
        };
    }
    match read(Some(expected_email)).await {
        Ok(snapshot) => UsageAvailability::Available {
            snapshot: Box::new(snapshot),
        },
        Err(error) => UsageAvailability::Unavailable {
            reason: match error.downcast_ref::<UsageError>() {
                Some(UsageError::NotSignedIn | UsageError::UnsupportedAccount) => {
                    UsageUnavailable::NotSignedIn
                }
                Some(UsageError::IdentityUnavailable) => UsageUnavailable::IdentityUnavailable,
                Some(UsageError::AccountMismatch) => UsageUnavailable::AccountMismatch,
                Some(UsageError::CodexUnavailable | UsageError::MethodUnavailable(_)) => {
                    UsageUnavailable::CodexUnavailable
                }
                _ => UsageUnavailable::ReadFailed,
            },
        },
    }
}

impl fmt::Display for UsageSnapshot {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&format_snapshot(
            self,
            &ResetContext::local(SystemTime::now()),
        ))
    }
}

/// Codex-style account limits. Unknown metrics stay unknown, and the source is
/// explicit because these are account-wide Codex limits, not an Agent-only cap.
pub fn format_status(usage: &UsageAvailability, now: SystemTime) -> String {
    format_status_in(usage, &ResetContext::local(now))
}

fn format_status_in(usage: &UsageAvailability, context: &ResetContext) -> String {
    match usage {
        UsageAvailability::Available { snapshot } => format_snapshot(snapshot, context),
        UsageAvailability::Unavailable { reason } => format!("Usage: unavailable ({reason})"),
    }
}

fn format_snapshot(snapshot: &UsageSnapshot, context: &ResetContext) -> String {
    let mut heading = "ChatGPT usage (via Codex account)".to_owned();
    if let Some(plan) = snapshot.plan.as_deref().filter(|value| !value.is_empty()) {
        heading.push_str(" · ");
        heading.push_str(&safe_label(plan));
    }
    let mut rows = Vec::new();
    let mut buckets = snapshot.buckets.iter().collect::<Vec<_>>();
    buckets.sort_by_key(|(id, _)| !id.eq_ignore_ascii_case("codex"));
    for (id, bucket) in buckets {
        let name = if id.eq_ignore_ascii_case("codex") {
            None
        } else {
            Some(bucket.limit_name.as_deref().unwrap_or(id))
        };
        bucket_rows(&mut rows, name, bucket, context);
    }
    if let Some(bucket) = &snapshot.unkeyed_bucket {
        bucket_rows(&mut rows, None, bucket, context);
    }
    if rows.is_empty() {
        return heading + "\nLimits: unavailable";
    }
    let width = rows
        .iter()
        .filter(|(_, value)| !value.is_empty())
        .map(|(label, _)| label.chars().count())
        .max()
        .unwrap_or(0);
    for (label, value) in rows {
        heading.push('\n');
        if value.is_empty() {
            heading.push_str(&label);
        } else {
            heading.push_str(&format!("{label:width$}  {value}"));
        }
    }
    heading
}

fn safe_label(value: &str) -> String {
    value
        .chars()
        .filter(|ch| !ch.is_control())
        .take(120)
        .collect()
}

fn bucket_rows(
    rows: &mut Vec<(String, String)>,
    name: Option<&str>,
    bucket: &RateLimitBucket,
    context: &ResetContext,
) {
    let count = usize::from(bucket.primary.is_some()) + usize::from(bucket.secondary.is_some());
    if count == 0 {
        return;
    }
    if let Some(name) = name.filter(|_| count > 1) {
        rows.push((format!("{} limit", safe_label(name)), String::new()));
    }
    for (secondary, window) in [
        (false, bucket.primary.as_ref()),
        (true, bucket.secondary.as_ref()),
    ] {
        let Some(window) = window else {
            continue;
        };
        let label = window_label(window.window_duration_mins, secondary);
        let label = if let Some(name) = name.filter(|_| count == 1) {
            format!("{} {label} limit:", safe_label(name))
        } else {
            format!("{label} limit:")
        };
        let mut value = match window.used_percent.filter(|used| used.is_finite()) {
            Some(used) => {
                let left = (100.0 - used).clamp(0.0, 100.0);
                let filled = ((left / 5.0).round() as usize).min(20);
                format!(
                    "[{}{}] {left:.0}% left",
                    "█".repeat(filled),
                    "░".repeat(20 - filled)
                )
            }
            None => "unavailable".to_owned(),
        };
        if let Some(seconds) = window.resets_at {
            if let Some(reset) = format_reset(seconds, context) {
                value.push_str(&format!(" (resets {reset})"));
            } else {
                value.push_str(" (reset time unavailable)");
            }
        }
        rows.push((label, value));
    }
}

fn window_label(minutes: Option<u64>, secondary: bool) -> &'static str {
    if let Some(minutes) = minutes {
        for (expected, label) in [
            (300, "5h"),
            (1_440, "Daily"),
            (10_080, "Weekly"),
            (43_200, "Monthly"),
            (525_600, "Annual"),
        ] {
            if minutes.abs_diff(expected) <= expected / 20 {
                return label;
            }
        }
    }
    if secondary {
        "Secondary usage"
    } else {
        "Usage"
    }
}

struct ResetTime {
    date: chrono::DateTime<chrono::FixedOffset>,
    zone: String,
}

struct ResetContext {
    now: SystemTime,
    localize: fn(i64) -> Option<ResetTime>,
}
impl ResetContext {
    fn local(now: SystemTime) -> Self {
        Self {
            now,
            localize: local_reset_time,
        }
    }
}

fn local_reset_time(seconds: i64) -> Option<ResetTime> {
    let utc = chrono::DateTime::<chrono::Utc>::from_timestamp(seconds, 0)?;
    let timestamp: libc::time_t = seconds;
    let mut local = std::mem::MaybeUninit::<libc::tm>::uninit();
    // localtime_r initializes the caller-owned tm and applies the system's
    // timezone rules at the reset instant, including daylight transitions.
    let result = unsafe { libc::localtime_r(&timestamp, local.as_mut_ptr()) };
    if result.is_null() {
        return None;
    }
    // A non-null return confirms the complete tm was initialized.
    let local = unsafe { local.assume_init() };
    let offset = chrono::FixedOffset::east_opt(i32::try_from(local.tm_gmtoff).ok()?)?;
    utc.naive_utc()
        .checked_add_signed(chrono::TimeDelta::seconds(i64::from(
            offset.local_minus_utc(),
        )))?;
    let mut zone = [0_u8; 64];
    // strftime owns interpretation of the native tm's timezone metadata.
    let count =
        unsafe { libc::strftime(zone.as_mut_ptr().cast(), zone.len(), c"%Z".as_ptr(), &local) };
    let zone = std::str::from_utf8(&zone[..count])
        .ok()
        .map(safe_label)
        .filter(|zone| !zone.is_empty())
        .unwrap_or_else(|| format!("UTC{offset}"));
    Some(ResetTime {
        date: utc.with_timezone(&offset),
        zone,
    })
}

fn format_reset(seconds: i64, context: &ResetContext) -> Option<String> {
    let local = (context.localize)(seconds)?;
    let reset = if seconds >= 0 {
        UNIX_EPOCH.checked_add(Duration::from_secs(seconds.unsigned_abs()))?
    } else {
        UNIX_EPOCH.checked_sub(Duration::from_secs(seconds.unsigned_abs()))?
    };
    let relative = match reset.duration_since(context.now) {
        Ok(duration) if duration.is_zero() => "now".into(),
        Ok(duration) => format!("in {}", reset_duration(duration)),
        Err(elapsed) => format!("{} ago", reset_duration(elapsed.duration())),
    };
    Some(format!(
        "{} {} · {relative}",
        local.date.format("%b %-d, %Y %H:%M"),
        local.zone
    ))
}

fn reset_duration(duration: Duration) -> String {
    let seconds = duration.as_secs();
    if seconds < 60 {
        return "less than a minute".into();
    }
    let units = if seconds >= 86_400 {
        [
            (seconds / 86_400, "day"),
            (seconds % 86_400 / 3_600, "hour"),
        ]
    } else {
        [(seconds / 3_600, "hour"), (seconds % 3_600 / 60, "minute")]
    };
    units
        .into_iter()
        .filter(|(count, _)| *count > 0)
        .map(|(count, unit)| format!("{count} {unit}{}", if count == 1 { "" } else { "s" }))
        .collect::<Vec<_>>()
        .join(" ")
}

/// All variants are safe to display: no upstream message or stderr is retained.
#[derive(Debug, PartialEq, Eq)]
pub enum UsageError {
    CodexUnavailable,
    Closed,
    Timeout,
    Protocol,
    FrameTooLarge,
    Transport,
    NotSignedIn,
    UnsupportedAccount,
    AccountMismatch,
    IdentityUnavailable,
    MethodUnavailable(&'static str),
    Rejected { method: &'static str, code: i64 },
    Cleanup,
    ReaderStopped,
}

impl fmt::Display for UsageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CodexUnavailable => f.write_str("Codex app-server is unavailable"),
            Self::Closed => f.write_str("Codex app-server closed before replying"),
            Self::Timeout => f.write_str("Codex account quota read timed out"),
            Self::Protocol => f.write_str("Codex returned an unsupported quota response"),
            Self::FrameTooLarge => f.write_str("Codex quota response exceeded the size limit"),
            Self::Transport => f.write_str("Codex app-server transport failed"),
            Self::NotSignedIn => f.write_str("Codex has no signed-in account"),
            Self::UnsupportedAccount => f.write_str("Codex quota requires a ChatGPT account"),
            Self::AccountMismatch => {
                f.write_str("Codex account differs from the app's signed-in account")
            }
            Self::IdentityUnavailable => {
                f.write_str("Codex account identity could not be verified")
            }
            Self::MethodUnavailable(method) => {
                write!(f, "Installed Codex does not support {method}")
            }
            Self::Rejected { method, code } => {
                write!(f, "Codex rejected {method} (RPC code {code})")
            }
            Self::Cleanup => f.write_str("Could not confirm Codex quota-reader exit"),
            Self::ReaderStopped => f.write_str("Codex quota-reader task stopped"),
        }
    }
}
impl std::error::Error for UsageError {}

/// Uses Codex's own supported auth. Never reads or exports credential files.
pub async fn read(expected_email: Option<&str>) -> anyhow::Result<UsageSnapshot> {
    let expected_email = expected_email.map(str::to_owned);
    // The owned reader still terminates/reaps its child if a client drops its wait.
    tokio::spawn(async move { read_owned(expected_email.as_deref()).await })
        .await
        .map_err(|_| UsageError::ReaderStopped)?
}

async fn read_owned(expected_email: Option<&str>) -> anyhow::Result<UsageSnapshot> {
    let mut child = Command::new("codex")
        .args(["app-server", "--listen", "stdio://"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| UsageError::CodexUnavailable)?;
    let diagnostics = child
        .stderr
        .take()
        .map(|stderr| tokio::spawn(drain_stderr(stderr)));
    let result = tokio::time::timeout(QUERY_TIMEOUT, query_child(&mut child, expected_email))
        .await
        .map_err(|_| UsageError::Timeout)
        .and_then(std::convert::identity);
    // Terminate and reap on success, failure and timeout alike.
    let _ = child.start_kill();
    let reaped = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
    let category = if let Some(mut task) = diagnostics {
        match tokio::time::timeout(Duration::from_secs(1), &mut task).await {
            Ok(Ok(category)) => category,
            _ => {
                task.abort();
                let _ = task.await;
                "stderr unavailable"
            }
        }
    } else {
        "stderr unavailable"
    };
    if !matches!(reaped, Ok(Ok(_))) {
        return Err(UsageError::Cleanup.into());
    }
    result.map_err(|error| {
        let description = format!("{error}; {category}");
        anyhow::Error::new(error).context(description)
    })
}

async fn drain_stderr(mut stderr: ChildStderr) -> &'static str {
    // Fixed memory; drain but never retain credential-bearing diagnostic text.
    let mut buffer = [0_u8; 1024];
    let mut category = "stderr empty";
    loop {
        match stderr.read(&mut buffer).await {
            Ok(0) => return category,
            Ok(_) => category = "stderr suppressed",
            Err(_) => return "stderr unavailable",
        }
    }
}

async fn query_child(
    child: &mut Child,
    expected: Option<&str>,
) -> Result<UsageSnapshot, UsageError> {
    let mut writer = child.stdin.take().ok_or(UsageError::Transport)?;
    let mut reader = BufReader::new(child.stdout.take().ok_or(UsageError::Transport)?);
    query(&mut reader, &mut writer, expected).await
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
enum Method {
    #[serde(rename = "initialize")]
    Initialize,
    #[serde(rename = "account/read")]
    Account,
    #[serde(rename = "account/rateLimits/read")]
    RateLimits,
}
impl Method {
    fn name(self) -> &'static str {
        match self {
            Self::Initialize => "initialize",
            Self::Account => "account/read",
            Self::RateLimits => "account/rateLimits/read",
        }
    }
}
#[derive(Deserialize, Serialize)]
struct Request<P> {
    id: u32,
    method: Method,
    params: P,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct InitializeParams {
    client_info: ClientInfo,
}
#[derive(Deserialize, Serialize)]
struct ClientInfo {
    name: String,
    title: String,
    version: String,
}
#[derive(Deserialize, Serialize)]
struct InitializeResult {
    #[serde(rename = "userAgent")]
    _user_agent: String,
}
#[derive(Deserialize, Serialize)]
struct EmptyParams {}
#[derive(Deserialize, Serialize)]
struct Initialized {
    method: InitializedMethod,
    params: EmptyParams,
}
#[derive(Deserialize, Serialize)]
enum InitializedMethod {
    #[serde(rename = "initialized")]
    Initialized,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountParams {
    refresh_token: bool,
}
#[derive(Deserialize, Serialize)]
struct AccountResult {
    account: Option<Account>,
}
#[derive(Deserialize, Serialize)]
#[serde(tag = "type")]
enum Account {
    #[serde(rename = "chatgpt")]
    Chatgpt {
        email: Option<String>,
        #[serde(rename = "planType")]
        plan: Option<String>,
    },
    #[serde(other)]
    Unsupported,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RateLimitsResult {
    rate_limits: Option<RateLimitBucket>,
    rate_limits_by_limit_id: Option<BTreeMap<String, RateLimitBucket>>,
}
// Raw JSON is confined to the dynamic RPC-envelope boundary.
#[derive(Deserialize)]
struct Envelope {
    id: Option<u32>,
    method: Option<String>,
    result: Option<serde_json::Value>,
    error: Option<RpcError>,
}
#[derive(Deserialize)]
struct RpcError {
    code: i64,
}

async fn query<R: AsyncBufRead + Unpin, W: AsyncWrite + Unpin>(
    reader: &mut R,
    writer: &mut W,
    expected: Option<&str>,
) -> Result<UsageSnapshot, UsageError> {
    send(
        writer,
        &Request {
            id: 1,
            method: Method::Initialize,
            params: InitializeParams {
                client_info: ClientInfo {
                    name: "agent_usage".to_owned(),
                    title: "Agent Codex account quota".to_owned(),
                    version: env!("CARGO_PKG_VERSION").to_owned(),
                },
            },
        },
    )
    .await?;
    let _: InitializeResult = response(reader, 1, Method::Initialize).await?;
    send(
        writer,
        &Initialized {
            method: InitializedMethod::Initialized,
            params: EmptyParams {},
        },
    )
    .await?;
    send(
        writer,
        &Request {
            id: 2,
            method: Method::Account,
            params: AccountParams {
                refresh_token: false,
            },
        },
    )
    .await?;
    let account: AccountResult = response(reader, 2, Method::Account).await?;
    let Account::Chatgpt { email, plan } = account.account.ok_or(UsageError::NotSignedIn)? else {
        return Err(UsageError::UnsupportedAccount);
    };
    if let Some(expected) = expected {
        let actual = email
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or(UsageError::IdentityUnavailable)?;
        if expected.trim().is_empty() {
            return Err(UsageError::IdentityUnavailable);
        }
        if !expected.eq_ignore_ascii_case(actual) {
            return Err(UsageError::AccountMismatch);
        }
    }
    send(
        writer,
        &Request {
            id: 3,
            method: Method::RateLimits,
            params: EmptyParams {},
        },
    )
    .await?;
    let limits: RateLimitsResult = response(reader, 3, Method::RateLimits).await?;
    let mut unkeyed_bucket = None;
    let buckets = if let Some(buckets) = limits.rate_limits_by_limit_id {
        buckets
    } else if let Some(bucket) = limits.rate_limits {
        if let Some(id) = bucket.limit_id.clone() {
            BTreeMap::from([(id, bucket)])
        } else {
            unkeyed_bucket = Some(bucket);
            BTreeMap::new()
        }
    } else {
        BTreeMap::new()
    };
    Ok(UsageSnapshot {
        source: UsageSource::CodexAccount,
        email,
        plan,
        buckets,
        unkeyed_bucket,
    })
}

async fn send<W: AsyncWrite + Unpin, T: Serialize>(
    writer: &mut W,
    value: &T,
) -> Result<(), UsageError> {
    let mut bytes = serde_json::to_vec(value).map_err(|_| UsageError::Protocol)?;
    bytes.push(b'\n');
    writer
        .write_all(&bytes)
        .await
        .map_err(|_| UsageError::Transport)?;
    writer.flush().await.map_err(|_| UsageError::Transport)
}
async fn response<R: AsyncBufRead + Unpin, T: DeserializeOwned>(
    reader: &mut R,
    id: u32,
    method: Method,
) -> Result<T, UsageError> {
    loop {
        let bytes = frame(reader).await?;
        let envelope: Envelope =
            serde_json::from_slice(&bytes).map_err(|_| UsageError::Protocol)?;
        if envelope.id.is_none() && envelope.method.is_some() {
            continue;
        }
        if envelope.id != Some(id) || envelope.method.is_some() {
            return Err(UsageError::Protocol);
        }
        if let Some(error) = envelope.error {
            if envelope.result.is_some() {
                return Err(UsageError::Protocol);
            }
            return Err(if error.code == -32601 {
                UsageError::MethodUnavailable(method.name())
            } else {
                UsageError::Rejected {
                    method: method.name(),
                    code: error.code,
                }
            });
        }
        let payload = envelope.result.ok_or(UsageError::Protocol)?;
        return serde_json::from_value(payload).map_err(|_| UsageError::Protocol);
    }
}
async fn frame<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<Vec<u8>, UsageError> {
    let mut frame = Vec::new();
    loop {
        let bytes = reader.fill_buf().await.map_err(|_| UsageError::Transport)?;
        if bytes.is_empty() {
            return Err(UsageError::Closed);
        }
        let length = bytes
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(bytes.len(), |position| position + 1);
        if frame.len() + length > MAX_FRAME_BYTES {
            return Err(UsageError::FrameTooLarge);
        }
        let complete = bytes[length - 1] == b'\n';
        frame.extend_from_slice(&bytes[..length]);
        reader.consume(length);
        if complete {
            return Ok(frame);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixed_time(seconds: i64, east: i32, zone: &str) -> Option<ResetTime> {
        let utc = chrono::DateTime::<chrono::Utc>::from_timestamp(seconds, 0)?;
        let offset = chrono::FixedOffset::east_opt(east)?;
        utc.naive_utc()
            .checked_add_signed(chrono::TimeDelta::seconds(i64::from(east)))?;
        Some(ResetTime {
            date: utc.with_timezone(&offset),
            zone: zone.into(),
        })
    }
    fn utc(seconds: i64) -> Option<ResetTime> {
        fixed_time(seconds, 0, "UTC")
    }
    fn stamp(value: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(value)
            .unwrap()
            .timestamp()
    }
    fn instant(value: &str) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(stamp(value).try_into().unwrap())
    }
    fn pacific(seconds: i64) -> Option<ResetTime> {
        let transition = stamp("2026-11-01T09:00:00Z");
        if seconds < transition {
            fixed_time(seconds, -7 * 3_600, "PDT")
        } else {
            fixed_time(seconds, -8 * 3_600, "PST")
        }
    }
    fn usage_reset(resets_at: Option<i64>) -> UsageAvailability {
        UsageAvailability::Available {
            snapshot: Box::new(UsageSnapshot {
                source: UsageSource::CodexAccount,
                email: None,
                plan: None,
                buckets: BTreeMap::new(),
                unkeyed_bucket: Some(RateLimitBucket {
                    limit_id: None,
                    limit_name: None,
                    plan_type: None,
                    primary: Some(RateLimitWindow {
                        used_percent: Some(50.0),
                        window_duration_mins: Some(300),
                        resets_at,
                    }),
                    secondary: None,
                }),
            }),
        }
    }

    const ACCOUNT: &str = r#"{"type":"chatgpt","email":"reader@example.invalid","planType":"pro"}"#;
    fn replies(account: &str, limits: &str) -> String {
        format!(
            "{{\"id\":1,\"result\":{{\"userAgent\":\"synthetic-codex\"}}}}\n{{\"method\":\"account/updated\",\"params\":{{}}}}\n{{\"id\":2,\"result\":{{\"account\":{account}}}}}\n{{\"id\":3,\"result\":{limits}}}\n"
        )
    }

    #[tokio::test]
    async fn reads_multiple_buckets_and_emits_only_read_only_protocol() {
        let limits = r#"{"rateLimits":{"limitId":"old","primary":{"usedPercent":99}},"rateLimitsByLimitId":{"codex":{"limitId":"codex","primary":{"usedPercent":25,"windowDurationMins":300,"resetsAt":1900000000},"secondary":null},"extra":{"limitId":"extra","primary":{"usedPercent":null,"windowDurationMins":null,"resetsAt":null}}}}"#;
        let input = replies(ACCOUNT, limits);
        let mut reader = BufReader::new(input.as_bytes());
        let mut sent = Vec::new();
        let snapshot = query(&mut reader, &mut sent, Some("READER@example.invalid"))
            .await
            .unwrap();
        assert!(matches!(snapshot.source, UsageSource::CodexAccount));
        assert_eq!(snapshot.plan.as_deref(), Some("pro"));
        assert_eq!(snapshot.buckets.len(), 2);
        assert!(!snapshot.buckets.contains_key("old"));
        let primary = snapshot.buckets["codex"].primary.as_ref().unwrap();
        assert_eq!(primary.used_percent, Some(25.0));
        assert_eq!(primary.window_duration_mins, Some(300));
        assert_eq!(primary.resets_at, Some(1_900_000_000));
        assert!(snapshot.buckets["codex"].secondary.is_none());
        assert!(
            snapshot.buckets["extra"]
                .primary
                .as_ref()
                .unwrap()
                .used_percent
                .is_none()
        );
        let messages: Vec<&[u8]> = sent
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .collect();
        assert_eq!(messages.len(), 4);
        let init: Request<InitializeParams> = serde_json::from_slice(messages[0]).unwrap();
        assert_eq!(init.method, Method::Initialize);
        assert_eq!(init.params.client_info.name, "agent_usage");
        let _: Initialized = serde_json::from_slice(messages[1]).unwrap();
        let account: Request<AccountParams> = serde_json::from_slice(messages[2]).unwrap();
        assert_eq!(account.method, Method::Account);
        assert!(!account.params.refresh_token);
        let quota: Request<EmptyParams> = serde_json::from_slice(messages[3]).unwrap();
        assert_eq!(quota.method, Method::RateLimits);
        let display = snapshot.to_string();
        assert!(display.contains("via Codex account"));
        assert!(display.contains("[███████████████░░░░░] 75% left"));
        assert!(!display.contains("0% left"));
    }

    #[tokio::test]
    async fn legacy_without_id_is_preserved_without_inventing_a_bucket_id() {
        let input = replies(ACCOUNT, r#"{"rateLimits":{"primary":{"usedPercent":12}}}"#);
        let snapshot = query(&mut BufReader::new(input.as_bytes()), &mut Vec::new(), None)
            .await
            .unwrap();
        assert!(snapshot.buckets.is_empty());
        let window = snapshot.unkeyed_bucket.unwrap().primary.unwrap();
        assert_eq!(window.used_percent, Some(12.0));
        assert!(window.resets_at.is_none());
        assert!(window.window_duration_mins.is_none());
    }

    #[tokio::test]
    async fn unavailable_metrics_stay_unavailable_and_present_map_is_authoritative() {
        let input = replies(
            r#"{"type":"chatgpt","email":null,"planType":null}"#,
            r#"{"rateLimits":{"limitId":"stale"},"rateLimitsByLimitId":{}}"#,
        );
        let snapshot = query(&mut BufReader::new(input.as_bytes()), &mut Vec::new(), None)
            .await
            .unwrap();
        assert!(snapshot.email.is_none());
        assert!(snapshot.plan.is_none());
        assert!(snapshot.buckets.is_empty());
        assert!(snapshot.unkeyed_bucket.is_none());
        assert!(snapshot.to_string().contains("Limits: unavailable"));
    }

    #[tokio::test]
    async fn mismatch_fails_before_quota_request_and_does_not_disclose_accounts() {
        let input = replies(ACCOUNT, "{}");
        let mut sent = Vec::new();
        let error = query(
            &mut BufReader::new(input.as_bytes()),
            &mut sent,
            Some("other@example.invalid"),
        )
        .await
        .unwrap_err();
        assert_eq!(error, UsageError::AccountMismatch);
        assert!(!error.to_string().contains('@'));
        assert_eq!(sent.iter().filter(|byte| **byte == b'\n').count(), 3);
    }

    #[tokio::test]
    async fn an_unverified_account_stops_the_real_duplex_reader_before_the_quota_call() {
        #[derive(Serialize)]
        struct Reply<T> {
            id: u32,
            result: T,
        }
        let (client, server) = tokio::io::duplex(256);
        let (read, mut write) = tokio::io::split(client);
        let mut reader = BufReader::new(read);
        let server = tokio::spawn(async move {
            let (read, mut write) = tokio::io::split(server);
            let mut reader = BufReader::new(read);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let init: Request<InitializeParams> = serde_json::from_str(&line).unwrap();
            assert_eq!(init.method, Method::Initialize);
            send(
                &mut write,
                &Reply {
                    id: init.id,
                    result: InitializeResult {
                        _user_agent: "fixture".into(),
                    },
                },
            )
            .await
            .unwrap();
            line.clear();
            reader.read_line(&mut line).await.unwrap();
            let _: Initialized = serde_json::from_str(&line).unwrap();
            line.clear();
            reader.read_line(&mut line).await.unwrap();
            let account: Request<AccountParams> = serde_json::from_str(&line).unwrap();
            assert_eq!(account.method, Method::Account);
            assert!(!account.params.refresh_token);
            send(
                &mut write,
                &Reply {
                    id: account.id,
                    result: AccountResult {
                        account: Some(Account::Chatgpt {
                            email: None,
                            plan: Some("pro".into()),
                        }),
                    },
                },
            )
            .await
            .unwrap();
            line.clear();
            assert_eq!(
                reader.read_line(&mut line).await.unwrap(),
                0,
                "An unknown identity must not reach account/rateLimits/read"
            );
        });
        assert_eq!(
            query(&mut reader, &mut write, Some("reader@example.invalid"))
                .await
                .unwrap_err(),
            UsageError::IdentityUnavailable
        );
        drop(write);
        drop(reader);
        server.await.unwrap();
    }

    #[test]
    fn quota_resets_include_full_dates_and_relative_time() {
        let now = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let usage = UsageAvailability::Available {
            snapshot: Box::new(UsageSnapshot {
                source: UsageSource::CodexAccount,
                email: None,
                plan: None,
                buckets: BTreeMap::new(),
                unkeyed_bucket: Some(RateLimitBucket {
                    limit_id: None,
                    limit_name: None,
                    plan_type: None,
                    primary: Some(RateLimitWindow {
                        used_percent: Some(50.0),
                        window_duration_mins: Some(300),
                        resets_at: Some(1_700_000_000 + 5 * 86_400 + 4 * 3_600),
                    }),
                    secondary: None,
                }),
            }),
        };
        let text = format_status(&usage, now);
        assert!(text.contains("2023"), "{text}");
        assert!(text.contains("· in 5 days 4 hours)"), "{text}");
    }

    #[test]
    fn status_renders_remaining_bars_window_labels_and_local_resets_without_account_details() {
        let mut snapshot = UsageSnapshot {
            source: UsageSource::CodexAccount,
            email: Some("reader@example.invalid".into()),
            plan: Some("pro".into()),
            buckets: BTreeMap::new(),
            unkeyed_bucket: None,
        };
        snapshot.buckets.insert(
            "codex".into(),
            RateLimitBucket {
                limit_id: Some("codex".into()),
                limit_name: None,
                plan_type: None,
                primary: Some(RateLimitWindow {
                    used_percent: Some(25.0),
                    window_duration_mins: Some(300),
                    resets_at: Some(3_600),
                }),
                secondary: Some(RateLimitWindow {
                    used_percent: Some(60.0),
                    window_duration_mins: Some(10_080),
                    resets_at: Some(90_000),
                }),
            },
        );
        let text = format_status_in(
            &UsageAvailability::Available {
                snapshot: Box::new(snapshot),
            },
            &ResetContext {
                now: UNIX_EPOCH,
                localize: utc,
            },
        );
        assert_eq!(
            text,
            "ChatGPT usage (via Codex account) · pro\n5h limit:      [███████████████░░░░░] 75% left (resets Jan 1, 1970 01:00 UTC · in 1 hour)\nWeekly limit:  [████████░░░░░░░░░░░░] 40% left (resets Jan 2, 1970 01:00 UTC · in 1 day 1 hour)"
        );
        assert!(!text.contains('@'));
    }

    #[test]
    fn status_uses_the_reset_instants_local_zone_and_absolute_countdown_across_daylight_change() {
        let context = ResetContext {
            now: instant("2026-10-28T16:00:00Z"),
            localize: pacific,
        };
        let text = format_status_in(&usage_reset(Some(stamp("2026-11-02T20:00:00Z"))), &context);
        assert!(
            text.contains("Nov 2, 2026 12:00 PST · in 5 days 4 hours"),
            "{text}"
        );
        assert!(!text.contains("PDT"));
        let context = ResetContext {
            now: instant("2026-11-01T08:30:00Z"),
            localize: pacific,
        };
        let text = format_status_in(&usage_reset(Some(stamp("2026-11-01T09:30:00Z"))), &context);
        assert!(text.contains("Nov 1, 2026 01:30 PST · in 1 hour"), "{text}");
    }

    #[test]
    fn status_shows_local_calendar_date_hours_and_minutes() {
        let context = ResetContext {
            now: instant("2026-10-29T00:00:00Z"),
            localize: pacific,
        };
        let text = format_status_in(&usage_reset(Some(stamp("2026-10-29T01:05:00Z"))), &context);
        assert!(
            text.contains("Oct 28, 2026 18:05 PDT · in 1 hour 5 minutes"),
            "{text}"
        );
        let text = format_status_in(&usage_reset(Some(stamp("2026-10-29T23:59:59Z"))), &context);
        assert!(text.contains("in 23 hours 59 minutes"), "{text}");
    }

    #[test]
    fn status_distinguishes_now_elapsed_and_unknown_reset_times() {
        let context = ResetContext {
            now: instant("2026-10-29T00:00:00Z"),
            localize: pacific,
        };
        let now = stamp("2026-10-29T00:00:00Z");
        let current = format_status_in(&usage_reset(Some(now)), &context);
        assert!(current.contains("· now)"), "{current}");
        let past = format_status_in(&usage_reset(Some(now - 125)), &context);
        assert!(past.contains("· 2 minutes ago)"), "{past}");
        let soon = format_status_in(&usage_reset(Some(now + 1)), &context);
        assert!(soon.contains("· in less than a minute)"), "{soon}");
        let missing = format_status_in(&usage_reset(None), &context);
        assert!(!missing.contains("resets"));
        let invalid = format_status_in(&usage_reset(Some(i64::MAX)), &context);
        assert!(invalid.contains("reset time unavailable"));
        assert!(!invalid.contains("· now"));
        assert!(!invalid.contains("0 minutes"));
    }

    #[test]
    fn public_status_formatter_uses_the_system_local_timezone() {
        let reset = stamp("2026-10-29T01:05:00Z");
        let local = local_reset_time(reset).unwrap();
        let text = format_status(
            &usage_reset(Some(reset)),
            UNIX_EPOCH + Duration::from_secs((reset - 3_600).try_into().unwrap()),
        );
        assert!(
            text.contains(&local.date.format("%b %-d, %Y %H:%M").to_string()),
            "{text}"
        );
        assert!(
            text.contains(&format!(" {} · in 1 hour", local.zone)),
            "{text}"
        );
    }

    #[test]
    fn unknown_metrics_and_unsupported_durations_never_become_zero_remaining() {
        let bucket = RateLimitBucket {
            limit_id: None,
            limit_name: None,
            plan_type: None,
            primary: Some(RateLimitWindow {
                used_percent: None,
                window_duration_mins: Some(60),
                resets_at: None,
            }),
            secondary: Some(RateLimitWindow {
                used_percent: Some(f64::NAN),
                window_duration_mins: None,
                resets_at: None,
            }),
        };
        let mut rows = Vec::new();
        bucket_rows(
            &mut rows,
            None,
            &bucket,
            &ResetContext {
                now: UNIX_EPOCH,
                localize: utc,
            },
        );
        assert_eq!(
            rows,
            [
                ("Usage limit:".into(), "unavailable".into()),
                ("Secondary usage limit:".into(), "unavailable".into())
            ]
        );
        assert_eq!(window_label(Some(285), false), "5h");
        assert_eq!(window_label(Some(316), false), "Usage");
        assert_eq!(window_label(Some(u64::MAX), true), "Secondary usage");
        assert_eq!(
            format_reset(
                i64::MAX,
                &ResetContext {
                    now: UNIX_EPOCH,
                    localize: utc
                }
            ),
            None
        );
        let unknown = format_status(
            &UsageAvailability::Unavailable {
                reason: UsageUnavailable::AccountMismatch,
            },
            UNIX_EPOCH,
        );
        assert!(unknown.contains("different ChatGPT account"));
        assert!(!unknown.contains("0%"));
    }

    #[tokio::test]
    async fn signed_out_and_other_auth_modes_do_not_request_quota() {
        for (account, expected) in [
            ("null", UsageError::NotSignedIn),
            (r#"{"type":"apiKey"}"#, UsageError::UnsupportedAccount),
        ] {
            let input = replies(account, "{}");
            let mut sent = Vec::new();
            let error = query(&mut BufReader::new(input.as_bytes()), &mut sent, None)
                .await
                .unwrap_err();
            assert_eq!(error, expected);
            assert_eq!(sent.iter().filter(|byte| **byte == b'\n').count(), 3);
        }
    }

    #[tokio::test]
    async fn unsupported_methods_have_typed_sanitized_errors() {
        let input = b"{\"id\":3,\"error\":{\"code\":-32601,\"message\":\"private diagnostic\",\"data\":\"secret\"}}\n";
        let error =
            response::<_, RateLimitsResult>(&mut BufReader::new(&input[..]), 3, Method::RateLimits)
                .await
                .err()
                .unwrap();
        assert_eq!(
            error,
            UsageError::MethodUnavailable("account/rateLimits/read")
        );
        assert!(!error.to_string().contains("private"));
        assert!(!error.to_string().contains("secret"));
    }

    #[tokio::test]
    async fn rejects_server_requests_and_bounded_frames() {
        let request =
            b"{\"id\":3,\"method\":\"account/chatgptAuthTokens/refresh\",\"params\":{}}\n";
        assert_eq!(
            response::<_, RateLimitsResult>(
                &mut BufReader::new(&request[..]),
                3,
                Method::RateLimits
            )
            .await
            .err()
            .unwrap(),
            UsageError::Protocol
        );
        let oversized = vec![b'x'; MAX_FRAME_BYTES + 1];
        assert_eq!(
            frame(&mut BufReader::new(&oversized[..]))
                .await
                .unwrap_err(),
            UsageError::FrameTooLarge
        );
    }
}
