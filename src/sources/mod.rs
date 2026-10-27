//! Read-only provider adapters. Checkpoints are candidates: the caller commits
//! them only after admitting every returned event into its durable inbox.

pub mod calendar;
pub mod github;
pub mod google;
pub mod slack;

use std::{
    fmt::Debug,
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail, ensure};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{
    host,
    protocol::{HostCommand, HostResult, SourceRef},
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
}

#[async_trait::async_trait]
pub trait Source: Debug + Send + Sync {
    fn key(&self) -> SourceKey;
    async fn poll(&self, checkpoint: Option<&SourceCheckpoint>) -> Result<SourceBatch>;
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(tag = "provider", rename_all = "snake_case", deny_unknown_fields)]
pub enum SourceConfig {
    /// Omitted namespaces discovers every configured Google account.
    Google {
        namespaces: Option<Vec<String>>,
    },
    #[serde(rename = "github")]
    GitHub {
        namespaces: Option<Vec<String>>,
    },
    GoogleCalendar {
        namespaces: Option<Vec<String>>,
    },
    /// An authenticated Slack API CLI prefix, optionally through a read-only wrapper.
    Slack {
        command: Vec<String>,
        account: String,
    },
}

pub struct SourceCatalog {
    pub sources: Vec<Box<dyn Source>>,
    pub failures: Vec<SourceBatch>,
}

pub async fn configured(config: &[SourceConfig]) -> SourceCatalog {
    let mut sources: Vec<Box<dyn Source>> = Vec::new();
    let mut failures = Vec::new();
    for entry in config {
        match entry {
            SourceConfig::Google { namespaces } => {
                match google::GoogleSource::discover(namespaces.as_deref()).await {
                    Ok(discovered) => {
                        for source in discovered {
                            sources.push(Box::new(source));
                        }
                    }
                    Err(_) => {
                        let accounts = namespaces
                            .clone()
                            .unwrap_or_else(|| vec!["discovery".into()]);
                        for account in accounts {
                            failures.push(SourceBatch::unavailable(
                                SourceKey {
                                    provider: "google".into(),
                                    account,
                                },
                                "Google account discovery failed; coverage is unknown",
                            ));
                        }
                    }
                }
            }
            SourceConfig::Slack { command, account } => {
                match slack::SlackSource::new(command.clone(), account.clone()) {
                    Ok(source) => sources.push(Box::new(source)),
                    Err(_) => failures.push(SourceBatch::unavailable(
                        SourceKey {
                            provider: "slack".into(),
                            account: account.clone(),
                        },
                        "Slack source configuration is invalid; coverage is unknown",
                    )),
                }
            }
            SourceConfig::GitHub { namespaces } => {
                match github::GitHubSource::discover(namespaces.as_deref()).await {
                    Ok(discovered) => sources.extend(
                        discovered
                            .into_iter()
                            .map(|source| Box::new(source) as Box<dyn Source>),
                    ),
                    Err(_) => {
                        for account in namespaces
                            .clone()
                            .unwrap_or_else(|| vec!["discovery".into()])
                        {
                            failures.push(SourceBatch::unavailable(
                                SourceKey {
                                    provider: "github".into(),
                                    account,
                                },
                                "GitHub account discovery failed; coverage is unknown",
                            ));
                        }
                    }
                }
            }
            SourceConfig::GoogleCalendar { namespaces } => {
                match calendar::CalendarSource::discover(namespaces.as_deref()).await {
                    Ok(discovered) => {
                        for source in discovered {
                            sources.push(Box::new(source));
                        }
                    }
                    Err(_) => {
                        for account in namespaces
                            .clone()
                            .unwrap_or_else(|| vec!["discovery".into()])
                        {
                            failures.push(SourceBatch::unavailable(
                                SourceKey {
                                    provider: "google_calendar".into(),
                                    account,
                                },
                                "Calendar account discovery failed; coverage is unknown",
                            ));
                        }
                    }
                }
            }
        }
    }
    SourceCatalog { sources, failures }
}

pub(crate) struct ReadOutput {
    exit_code: i32,
    stdout: String,
    truncated: bool,
}

pub(crate) async fn read_command(argv: &[String]) -> Result<ReadOutput> {
    let (program, args) = argv
        .split_first()
        .context("Source helper command is empty")?;
    ensure!(!program.is_empty(), "Source helper program is empty");
    match host::execute(HostCommand::Exec {
        program: program.clone(),
        args: args.to_vec(),
        cwd: "/".into(),
        timeout_seconds: 30,
    })
    .await
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
