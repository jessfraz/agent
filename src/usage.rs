//! Read-only Codex-account quota metadata, not this application's allowance.
//! Protocol: https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt

use std::collections::BTreeMap;
use std::fmt;
use std::process::Stdio;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::io::{
    AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader,
};
use tokio::process::{Child, ChildStderr, Command};

const QUERY_TIMEOUT: Duration = Duration::from_secs(25);
const MAX_FRAME_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UsageSource {
    CodexAccount,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct UsageSnapshot {
    pub source: UsageSource,
    pub email: Option<String>,
    pub plan: Option<String>,
    pub buckets: BTreeMap<String, RateLimitBucket>,
    pub unkeyed_bucket: Option<RateLimitBucket>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitBucket {
    pub limit_id: Option<String>,
    pub limit_name: Option<String>,
    pub plan_type: Option<String>,
    pub primary: Option<RateLimitWindow>,
    pub secondary: Option<RateLimitWindow>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitWindow {
    pub used_percent: Option<f64>,
    pub window_duration_mins: Option<u64>,
    pub resets_at: Option<i64>,
}

impl fmt::Display for UsageSnapshot {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(
            f,
            "via Codex account: {} ({})",
            self.email.as_deref().unwrap_or("email unavailable"),
            self.plan.as_deref().unwrap_or("plan unavailable")
        )?;
        writeln!(f, "Per-app remaining cap: unavailable")?;
        for (id, bucket) in &self.buckets {
            display_bucket(f, id, bucket)?;
        }
        if let Some(bucket) = &self.unkeyed_bucket {
            display_bucket(f, "legacy bucket (ID unavailable)", bucket)?;
        }
        if self.buckets.is_empty() && self.unkeyed_bucket.is_none() {
            writeln!(f, "Account quota windows: unavailable")?;
        }
        Ok(())
    }
}

fn display_bucket(f: &mut fmt::Formatter<'_>, name: &str, bucket: &RateLimitBucket) -> fmt::Result {
    write!(f, "{name}: ")?;
    display_window(f, "primary", bucket.primary.as_ref())?;
    write!(f, "; ")?;
    display_window(f, "secondary", bucket.secondary.as_ref())?;
    writeln!(f)
}

fn display_window(
    f: &mut fmt::Formatter<'_>,
    name: &str,
    window: Option<&RateLimitWindow>,
) -> fmt::Result {
    write!(f, "{name} ")?;
    let Some(window) = window else {
        return write!(f, "unavailable");
    };
    if let Some(used) = window.used_percent {
        write!(f, "{:.0}% remaining", (100.0 - used).clamp(0.0, 100.0))?;
    } else {
        write!(f, "usage unavailable")?;
    }
    if let Some(minutes) = window.window_duration_mins {
        write!(f, "/{minutes}m")?;
    }
    if let Some(reset) = window.resets_at {
        write!(f, ", reset {reset}")?;
    }
    Ok(())
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
#[derive(Deserialize)]
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
#[derive(Deserialize)]
struct AccountResult {
    account: Option<Account>,
}
#[derive(Deserialize)]
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
#[derive(Deserialize)]
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
    if let (Some(expected), Some(actual)) = (expected, email.as_deref())
        && !expected.eq_ignore_ascii_case(actual)
    {
        return Err(UsageError::AccountMismatch);
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
        assert!(display.contains("Per-app remaining cap: unavailable"));
        assert!(display.contains("75% remaining"));
        assert!(!display.contains("0% remaining"));
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
        let snapshot = query(
            &mut BufReader::new(input.as_bytes()),
            &mut Vec::new(),
            Some("reader@example.invalid"),
        )
        .await
        .unwrap();
        assert!(snapshot.email.is_none());
        assert!(snapshot.plan.is_none());
        assert!(snapshot.buckets.is_empty());
        assert!(snapshot.unkeyed_bucket.is_none());
        assert!(
            snapshot
                .to_string()
                .contains("Account quota windows: unavailable")
        );
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
