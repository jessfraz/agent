//! Read-only provider adapters. Checkpoints are candidates: the caller commits
//! them only after admitting every returned event into its durable inbox.

pub mod calendar;
pub mod github;
pub mod google;
pub mod messages;
pub mod messages_read;
pub mod slack;

use std::{
    fmt::Debug,
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail, ensure};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{
    host,
    protocol::{HostResult, SourceRef},
};

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS, PartialEq, Eq)]
pub struct SourceKey {
    pub provider: String,
    pub account: String,
}

/// Opaque to the caller and meaningful only to the matching provider/account.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS, PartialEq, Eq)]
pub struct SourceCheckpoint {
    pub value: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct SourceEvent {
    pub id: String,
    pub version: String,
    pub source: SourceRef,
    pub title: String,
    pub text: String,
}

/// Coverage concerns the adapter's documented polling window, not an archive of
/// everything visible to the account. Excerpts retain a source for deeper reads.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SourceCoverage {
    Complete,
    More,
    Partial { message: String },
    Unavailable { message: String },
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct SourceBatch {
    pub source: SourceKey,
    pub events: Vec<SourceEvent>,
    pub checkpoint: Option<SourceCheckpoint>,
    pub coverage: SourceCoverage,
}

impl SourceBatch {
    fn unavailable(source: SourceKey, message: impl Into<String>) -> Self {
        Self {
            source,
            events: Vec::new(),
            checkpoint: None,
            coverage: SourceCoverage::Unavailable {
                message: message.into(),
            },
        }
    }

    fn with_helper_failure(mut self, failure: Option<HelperFailure>) -> Self {
        if let Some(failure) = failure {
            self.checkpoint = None;
            let message = failure.to_string();
            self.coverage = if self.events.is_empty() {
                SourceCoverage::Unavailable { message }
            } else {
                SourceCoverage::Partial { message }
            };
        }
        self
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum FailureCode {
    Storage,
    Configuration,
    Authentication,
    WrongAccount,
    AuthenticationTimeout,
    BrowserConsentRequired,
    RecoveryExhausted,
    InvalidArguments,
    PolicyDenied,
    Unsupported,
    ProviderFailed,
    Timeout,
    OutcomeUnknown,
    Internal,
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum FailurePhase {
    Validation,
    Authentication,
    Execution,
    Persistence,
    Verification,
    #[serde(other)]
    Unknown,
}

/// Read only closed metadata. Helper messages may contain SQL, paths, secrets
/// or provider bodies and must never become source-status text.
#[derive(Clone, Copy, Debug, Deserialize)]
struct HelperFailure {
    code: FailureCode,
    phase: FailurePhase,
}

impl std::fmt::Display for HelperFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let (kind, action) = match self.code {
            FailureCode::Storage => ("storage", "inspect its local database before retrying"),
            FailureCode::Configuration => {
                ("configuration", "check the scoped helper configuration")
            }
            FailureCode::Authentication
            | FailureCode::AuthenticationTimeout
            | FailureCode::BrowserConsentRequired
            | FailureCode::RecoveryExhausted => {
                ("authentication", "check authentication for this account")
            }
            FailureCode::WrongAccount => (
                "account mismatch",
                "check the configured account before retrying",
            ),
            FailureCode::InvalidArguments => ("arguments", "check the source command arguments"),
            FailureCode::PolicyDenied => {
                ("authorization", "check the helper's configured read access")
            }
            FailureCode::Unsupported => (
                "unsupported operation",
                "check the installed helper version",
            ),
            FailureCode::ProviderFailed => ("provider", "inspect the provider before retrying"),
            FailureCode::Timeout => ("timeout", "check provider availability before retrying"),
            FailureCode::OutcomeUnknown => (
                "unconfirmed outcome",
                "verify the prior operation before retrying",
            ),
            FailureCode::Internal | FailureCode::Unknown => (
                "internal",
                "inspect the helper's diagnostics before retrying",
            ),
        };
        let phase = match self.phase {
            FailurePhase::Validation => "validation",
            FailurePhase::Authentication => "authentication",
            FailurePhase::Execution => "execution",
            FailurePhase::Persistence => "persistence",
            FailurePhase::Verification => "verification",
            FailurePhase::Unknown => "an unknown phase",
        };
        write!(
            formatter,
            "Source helper {kind} failure during {phase}; {action}. Checkpoint retained."
        )
    }
}

impl std::error::Error for HelperFailure {}

fn discovery_failure(error: &anyhow::Error, fallback: &str) -> String {
    error
        .downcast_ref::<HelperFailure>()
        .map_or_else(|| fallback.into(), ToString::to_string)
}

#[async_trait::async_trait]
pub trait Source: Debug + Send + Sync {
    fn key(&self) -> SourceKey;
    async fn poll(&self, checkpoint: Option<&SourceCheckpoint>) -> Result<SourceBatch>;
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "provider", rename_all = "snake_case", deny_unknown_fields)]
pub enum SourceConfig {
    /// Omitted namespaces discovers every configured Google account.
    Google {
        #[serde(default = "source_enabled")]
        enabled: bool,
        namespaces: Option<Vec<String>>,
    },
    #[serde(rename = "github")]
    GitHub {
        #[serde(default = "source_enabled")]
        enabled: bool,
        namespaces: Option<Vec<String>>,
    },
    GoogleCalendar {
        #[serde(default = "source_enabled")]
        enabled: bool,
        namespaces: Option<Vec<String>>,
    },
    Messages {
        #[serde(default = "source_enabled")]
        enabled: bool,
        namespaces: Option<Vec<String>>,
    },
    /// An authenticated Slack API CLI prefix, optionally through a read-only wrapper.
    Slack {
        #[serde(default = "source_enabled")]
        enabled: bool,
        command: Vec<String>,
        account: String,
    },
}

fn source_enabled() -> bool {
    true
}

impl SourceConfig {
    pub fn enabled(&self) -> bool {
        match self {
            Self::Google { enabled, .. }
            | Self::GitHub { enabled, .. }
            | Self::GoogleCalendar { enabled, .. }
            | Self::Messages { enabled, .. }
            | Self::Slack { enabled, .. } => *enabled,
        }
    }
}

pub struct SourceCatalog {
    pub sources: Vec<Box<dyn Source>>,
    pub failures: Vec<SourceBatch>,
}

pub async fn configured(config: &[SourceConfig]) -> SourceCatalog {
    let mut sources: Vec<Box<dyn Source>> = Vec::new();
    let mut failures = Vec::new();
    for entry in config {
        if !entry.enabled() {
            continue;
        }
        match entry {
            SourceConfig::Google { namespaces, .. } => {
                match google::GoogleSource::discover(namespaces.as_deref()).await {
                    Ok(discovered) => {
                        for source in discovered {
                            sources.push(Box::new(source));
                        }
                    }
                    Err(error) => {
                        let accounts = namespaces
                            .clone()
                            .unwrap_or_else(|| vec!["discovery".into()]);
                        for account in accounts {
                            failures.push(SourceBatch::unavailable(
                                SourceKey {
                                    provider: "google".into(),
                                    account,
                                },
                                discovery_failure(
                                    &error,
                                    "Google account discovery failed; coverage is unknown",
                                ),
                            ));
                        }
                    }
                }
            }
            SourceConfig::Slack {
                command, account, ..
            } => match slack::SlackSource::new(command.clone(), account.clone()) {
                Ok(source) => sources.push(Box::new(source)),
                Err(_) => failures.push(SourceBatch::unavailable(
                    SourceKey {
                        provider: "slack".into(),
                        account: account.clone(),
                    },
                    "Slack source configuration is invalid; coverage is unknown",
                )),
            },
            SourceConfig::GitHub { namespaces, .. } => {
                match github::GitHubSource::discover(namespaces.as_deref()).await {
                    Ok(discovered) => sources.extend(
                        discovered
                            .into_iter()
                            .map(|source| Box::new(source) as Box<dyn Source>),
                    ),
                    Err(error) => {
                        for account in namespaces
                            .clone()
                            .unwrap_or_else(|| vec!["discovery".into()])
                        {
                            failures.push(SourceBatch::unavailable(
                                SourceKey {
                                    provider: "github".into(),
                                    account,
                                },
                                discovery_failure(
                                    &error,
                                    "GitHub account discovery failed; coverage is unknown",
                                ),
                            ));
                        }
                    }
                }
            }
            SourceConfig::Messages { namespaces, .. } => {
                match messages::MessagesSource::discover(namespaces.as_deref()).await {
                    Ok(discovered) => sources.extend(
                        discovered
                            .into_iter()
                            .map(|source| Box::new(source) as Box<dyn Source>),
                    ),
                    Err(error) => {
                        for account in namespaces
                            .clone()
                            .unwrap_or_else(|| vec!["discovery".into()])
                        {
                            failures.push(SourceBatch::unavailable(
                                SourceKey {
                                    provider: "messages".into(),
                                    account,
                                },
                                discovery_failure(
                                    &error,
                                    "Messages account discovery failed; coverage is unknown",
                                ),
                            ));
                        }
                    }
                }
            }
            SourceConfig::GoogleCalendar { namespaces, .. } => {
                match calendar::CalendarSource::discover(namespaces.as_deref()).await {
                    Ok(discovered) => {
                        for source in discovered {
                            sources.push(Box::new(source));
                        }
                    }
                    Err(error) => {
                        for account in namespaces
                            .clone()
                            .unwrap_or_else(|| vec!["discovery".into()])
                        {
                            failures.push(SourceBatch::unavailable(
                                SourceKey {
                                    provider: "google_calendar".into(),
                                    account,
                                },
                                discovery_failure(
                                    &error,
                                    "Calendar account discovery failed; coverage is unknown",
                                ),
                            ));
                        }
                    }
                }
            }
        }
    }
    SourceCatalog { sources, failures }
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ReadOutput {
    pub(crate) exit_code: i32,
    pub(crate) stdout: String,
    pub(crate) truncated: bool,
}

impl ReadOutput {
    fn helper_failure(&self) -> Option<HelperFailure> {
        #[derive(Deserialize)]
        #[serde(rename_all = "snake_case")]
        enum Status {
            Error,
            Partial,
            #[serde(other)]
            Other,
        }
        #[derive(Deserialize)]
        struct Envelope {
            status: Status,
            failure: Option<HelperFailure>,
        }
        let envelope: Envelope = serde_json::from_str(&self.stdout).ok()?;
        match envelope.status {
            Status::Error | Status::Partial => envelope.failure,
            Status::Other => None,
        }
    }

    fn check_discovery(&self) -> Result<()> {
        if let Some(failure) = self.helper_failure() {
            return Err(failure.into());
        }
        ensure!(
            self.exit_code == 0 && !self.truncated,
            "Source namespace discovery is unavailable"
        );
        Ok(())
    }

    fn normalize(self, normalize: impl FnOnce(Self) -> SourceBatch) -> SourceBatch {
        let failure = self.helper_failure();
        normalize(self).with_helper_failure(failure)
    }

    fn normalize_result(
        self,
        source: SourceKey,
        normalize: impl FnOnce(Self) -> Result<SourceBatch>,
    ) -> Result<SourceBatch> {
        let failure = self.helper_failure();
        match (normalize(self), failure) {
            (Ok(batch), failure) => Ok(batch.with_helper_failure(failure)),
            (Err(_), Some(failure)) => Ok(SourceBatch::unavailable(source, failure.to_string())),
            (Err(error), None) => Err(error),
        }
    }
}

pub(crate) async fn read_command(argv: &[String]) -> Result<ReadOutput> {
    let (program, args) = argv
        .split_first()
        .context("Source helper command is empty")?;
    ensure!(!program.is_empty(), "Source helper program is empty");
    match host::run_process(
        program,
        args,
        Path::new("/"),
        Duration::from_secs(host::DEFAULT_TIMEOUT_SECONDS.into()),
        crate::runtime::MAX_FRAME_BYTES / 2,
    )
    .await?
    {
        HostResult::Process {
            exit_code,
            stdout,
            truncated,
            ..
        } => Ok(ReadOutput {
            exit_code,
            stdout,
            truncated,
        }),
        HostResult::Failed { message } => bail!(message),
        _ => bail!("Source helper did not return a process result"),
    }
}

fn now_seconds() -> Result<u64> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("System clock precedes the Unix epoch")?
        .as_secs())
}

#[cfg(test)]
mod tests {
    use crate::sources::{ReadOutput, SourceConfig, configured};

    pub(super) const STORAGE_FAILURE: &str = r#"{"status":"error","failure":{"code":"storage","phase":"persistence","message":"private-token /private/database SELECT private_body"}}"#;

    #[test]
    fn helper_failures_use_closed_metadata_and_unknown_codes_cannot_leak_provider_messages() {
        for (code, phase, expected) in [
            (
                "authentication",
                "authentication",
                "Source helper authentication failure during authentication; check authentication for this account. Checkpoint retained.",
            ),
            (
                "private-token-code",
                "private-token-phase",
                "Source helper internal failure during an unknown phase; inspect the helper's diagnostics before retrying. Checkpoint retained.",
            ),
        ] {
            let output = ReadOutput {
                exit_code: 1,
                truncated: false,
                stdout: format!(
                    r#"{{"status":"error","failure":{{"code":"{code}","phase":"{phase}","message":"private-token-message","details":{{"sql":"private SQL"}}}}}}"#
                ),
            };
            let error = output.check_discovery().unwrap_err();
            assert_eq!(
                crate::sources::discovery_failure(&error, "fallback"),
                expected
            );
            assert!(expected.len() < 200);
        }
        let complete = ReadOutput {
            exit_code: 0,
            stdout: r#"{"status":"executed","namespaces":[]}"#.into(),
            truncated: false,
        };
        assert!(complete.check_discovery().is_ok());
    }

    #[tokio::test]
    async fn source_commands_capture_native_pages_beyond_the_model_output_budget_and_report_their_own_limit()
     {
        use crate::{
            host,
            protocol::{HostCommand, HostResult},
            runtime::MAX_FRAME_BYTES,
            sources::read_command,
        };
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("native-output");
        std::fs::write(&path, vec![b'x'; 512 * 1024]).unwrap();
        let command = vec![
            "node".into(),
            "--eval".into(),
            "process.stdout.write(require('node:fs').readFileSync(process.argv[1]))".into(),
            path.to_str().unwrap().into(),
        ];
        let source = read_command(&command).await.unwrap();
        assert_eq!(source.exit_code, 0);
        assert!(!source.truncated);
        assert_eq!(source.stdout.len(), 512 * 1024);
        let interactive = host::execute(HostCommand::Exec {
            program: command[0].clone(),
            args: command[1..].to_vec(),
            cwd: "/".into(),
            timeout_seconds: 900,
        })
        .await;
        assert!(
            matches!(interactive,HostResult::Process {exit_code:0,stdout,truncated:true,..} if stdout.len()==256*1024)
        );
        std::fs::write(&path, vec![b'x'; MAX_FRAME_BYTES / 2 + 1]).unwrap();
        let source = read_command(&command).await.unwrap();
        assert!(source.truncated);
        assert_eq!(source.stdout.len(), MAX_FRAME_BYTES / 2);
    }

    #[tokio::test]
    async fn disabled_sources_skip_discovery_and_account_setup() {
        let sources = vec![
            SourceConfig::Google {
                enabled: false,
                namespaces: Some(vec!["not-configured".into()]),
            },
            SourceConfig::GoogleCalendar {
                enabled: false,
                namespaces: Some(vec!["not-configured".into()]),
            },
            SourceConfig::GitHub {
                enabled: false,
                namespaces: Some(vec!["not-configured".into()]),
            },
            SourceConfig::Messages {
                enabled: false,
                namespaces: Some(vec!["not-configured".into()]),
            },
            SourceConfig::Slack {
                enabled: false,
                command: Vec::new(),
                account: String::new(),
            },
        ];
        let catalog = configured(&sources).await;
        assert!(catalog.sources.is_empty());
        assert!(catalog.failures.is_empty());
        let invalid_enabled = configured(&[SourceConfig::Slack {
            enabled: true,
            command: Vec::new(),
            account: String::new(),
        }])
        .await;
        assert_eq!(invalid_enabled.failures.len(), 1);
    }
}
