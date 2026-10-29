//! Typed background work; Pi owns every timer and durable execution checkpoint.
use anyhow::{Context, Result, ensure};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{
    jobs::{self, JobSchedule, OccurrencePlan, ScheduledJob, TimezoneId, UtcMillis},
    protocol::SourceState,
    sources::{SourceBatch, SourceCheckpoint, SourceConfig},
};

/// The service owns this transport until shutdown. Timer callbacks must never
/// retain a chat connection or execute on a fallback host after disconnect.
pub async fn run(
    runtime: std::sync::Arc<crate::runtime::Runtime>,
    broker: std::sync::Arc<crate::broker::Broker>,
    settings: BackgroundSettings,
) -> Result<()> {
    use crate::protocol::{RuntimeCommand, RuntimeEventKind};
    let mut call = runtime
        .request(RuntimeCommand::RunBackground { settings })
        .await?;
    let mut effects = tokio::task::JoinSet::new();
    let result = loop {
        tokio::select! {
            event = call.events.recv() => match event.context("Background transport closed")? {
                RuntimeEventKind::HostCall { call_id, command } => {
                    let broker = broker.clone();
                    effects.spawn(async move { (call_id, broker.execute(*command).await) });
                }
                RuntimeEventKind::Done => break Ok(()),
                RuntimeEventKind::Failure { message, .. } => break Err(anyhow::anyhow!(message)),
                _ => {}
            },
            effect = effects.join_next(), if !effects.is_empty() => {
                let (id, result) = effect.context("Background effect queue closed")??;
                runtime.reply(call.request_id, id, result).await?;
            }
            _ = runtime.stopped() => break Ok(()),
        }
    };
    effects.abort_all();
    while effects.join_next().await.is_some() {}
    runtime.detach(call.request_id).await;
    result
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct BackgroundSettings {
    pub poll_interval_seconds: u32,
    pub sources: bool,
    pub jobs: Option<Vec<ScheduledJob>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BackgroundCadence {
    Interval {
        seconds: u32,
    },
    Calendar {
        schedule: JobSchedule,
        timezone: TimezoneId,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BackgroundRequest {
    Plan {
        cadence: BackgroundCadence,
        after: Option<UtcMillis>,
        now: UtcMillis,
    },
    PollSources {
        sources: Vec<SourceConfig>,
        states: Vec<SourceState>,
        cursor: Option<SourcePollCursor>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct SourceRead {
    pub batch: SourceBatch,
    pub expected_checkpoint: Option<SourceCheckpoint>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct SourcePollCursor {
    pub source: crate::sources::SourceKey,
    pub page: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BackgroundResponse {
    Plan {
        plan: OccurrencePlan,
    },
    Sources {
        reads: Vec<SourceRead>,
        cursor: Option<SourcePollCursor>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct ScheduledOccurrence {
    pub id: String,
    pub job: ScheduledJob,
    pub schedule_id: jobs::ScheduleId,
    pub scheduled_at: UtcMillis,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct JobSyncReport {
    pub added: u32,
    pub updated: u32,
    pub removed: u32,
    pub unchanged: u32,
}

/// Durable admission of one requested run, independent of its execution result.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS, PartialEq, Eq)]
pub struct JobRunReceipt {
    pub request_id: String,
    pub task_id: crate::protocol::TaskId,
    pub job_id: jobs::JobId,
    pub schedule_id: jobs::ScheduleId,
    pub revision: String,
    pub admitted_at: UtcMillis,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BackgroundTriggerKey {
    Builtin {
        name: BuiltinTrigger,
    },
    Job {
        job_id: jobs::JobId,
        schedule_id: jobs::ScheduleId,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum BuiltinTrigger {
    Sources,
    Resources,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BackgroundWork {
    Sources,
    Resources,
    Job {
        occurrence: Box<ScheduledOccurrence>,
    },
    ManualJob {
        occurrence: Box<ScheduledOccurrence>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BackgroundTaskInput {
    Trigger {
        key: BackgroundTriggerKey,
        generation: u32,
        cadence: BackgroundCadence,
        job: Option<Box<ScheduledJob>>,
    },
    Work {
        key: BackgroundTriggerKey,
        work: BackgroundWork,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum BackgroundCheckpoint {
    Tick { cursor: Option<UtcMillis> },
    Execute { attempt: u32 },
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct BackgroundError {
    pub key: BackgroundTriggerKey,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct BackgroundStatus {
    pub jobs: u32,
    pub triggers: u32,
    pub pending: u32,
    pub errors: Vec<BackgroundError>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct JobScheduleStatus {
    pub schedule_id: jobs::ScheduleId,
    pub next_at: Option<UtcMillis>,
    pub last_at: Option<UtcMillis>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct ScheduledJobStatus {
    pub job: ScheduledJob,
    pub schedules: Vec<JobScheduleStatus>,
}

pub async fn execute(request: BackgroundRequest) -> Result<BackgroundResponse> {
    match request {
        BackgroundRequest::Plan {
            cadence,
            after,
            now,
        } => {
            let plan = match cadence {
                BackgroundCadence::Interval { seconds } => interval(seconds, after, now)?,
                BackgroundCadence::Calendar { schedule, timezone } => {
                    jobs::plan(&schedule, &timezone, after, now)?
                }
            };
            Ok(BackgroundResponse::Plan { plan })
        }
        BackgroundRequest::PollSources {
            sources,
            states,
            cursor,
        } => {
            let (reads, cursor) = crate::intake::poll(&sources, &states, cursor).await?;
            Ok(BackgroundResponse::Sources { reads, cursor })
        }
    }
}

fn interval(seconds: u32, after: Option<UtcMillis>, now: UtcMillis) -> Result<OccurrencePlan> {
    ensure!(seconds > 0, "Background intervals must be positive");
    let every = i64::from(seconds) * 1000;
    let next = after
        .map_or(now.get(), |previous| previous.get().max(now.get()))
        .checked_add(every)
        .context("Background deadline overflow")?;
    // Intervals coalesce overdue work and retain fixed-delay source polling.
    let due = after
        .is_none_or(|previous| previous.get() <= now.get())
        .then_some(now);
    Ok(OccurrencePlan {
        due,
        next: Some(UtcMillis::new(next)?),
    })
}
