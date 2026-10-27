//! One polling loop over provider traits; Pi owns event admission and checkpoints.
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context, Result, bail};
use tokio::{
    io::{AsyncWriteExt, BufReader},
    time::{sleep, timeout},
};

use crate::{
    config::ClientConfig,
    models::ModelSelection,
    protocol::{RuntimeCommand, RuntimeEventKind, SourceState},
    runtime::FrameReader,
    service,
    sources::{self, SourceBatch, SourceCoverage},
};

pub struct ContextBundle {
    pub model: ModelSelection,
    pub cwd: String,
}

/// Source failures remain visible in durable coverage, and never stop other
/// accounts or turn a partial read into an empty successful result.
pub async fn run(directory: PathBuf, config: ClientConfig, context: ContextBundle) -> Result<()> {
    let interval = Duration::from_secs(config.poll_interval_seconds.max(10));
    let mut last_collection = None;
    while service::connect(&directory).await.is_err() {
        sleep(Duration::from_millis(25)).await;
    }
    loop {
        if last_collection
            .is_none_or(|last: std::time::Instant| last.elapsed() >= Duration::from_secs(300))
        {
            if let Ok(identity) = crate::rex::RexClient::new(None).whoami().await {
                let _ = call(
                    &directory,
                    RuntimeCommand::CollectResources {
                        host_id: identity.host_id.to_string(),
                    },
                )
                .await;
            }
            last_collection = Some(std::time::Instant::now());
        }
        match cycle(&directory, &config, &context).await {
            Ok(()) => {}
            Err(_) => eprintln!(
                "Background source check could not complete; saved checkpoints are retained."
            ),
        }
        sleep(interval).await;
    }
}

pub async fn cycle(directory: &Path, config: &ClientConfig, context: &ContextBundle) -> Result<()> {
    let events = call(directory, RuntimeCommand::SourceStates).await?;
    let mut states = events
        .into_iter()
        .find_map(|event| match event {
            RuntimeEventKind::Sources { sources } => Some(sources),
            _ => None,
        })
        .context("Coordinator returned no source checkpoint state")?;
    // Rediscover configured accounts on every check instead of freezing a
    // second copy of Switchboard's namespace registry at startup.
    let catalog = sources::configured(&config.sources).await;
    for batch in catalog.failures {
        let expected_checkpoint = states
            .iter()
            .find(|state| state.source == batch.source)
            .and_then(|state| state.checkpoint.clone());
        call(
            directory,
            RuntimeCommand::IngestSource {
                batch,
                expected_checkpoint,
            },
        )
        .await?;
    }
    for source in catalog.sources {
        let key = source.key();
        for _ in 0..4 {
            let checkpoint = states
                .iter()
                .find(|state| state.source == key)
                .and_then(|state| state.checkpoint.as_ref());
            let expected_checkpoint = checkpoint.cloned();
            let batch = match source.poll(checkpoint).await {
                Ok(batch) => batch,
                Err(_) => SourceBatch {
                    source: key.clone(),
                    events: Vec::new(),
                    checkpoint: None,
                    coverage: SourceCoverage::Unavailable {
                        message: "Source read failed; coverage is unknown".into(),
                    },
                },
            };
            let more = batch.coverage == SourceCoverage::More;
            let events = call(
                directory,
                RuntimeCommand::IngestSource {
                    batch,
                    expected_checkpoint,
                },
            )
            .await?;
            let admitted = events
                .into_iter()
                .find_map(|event| match event {
                    RuntimeEventKind::SourceAdmitted { state, .. } => Some(state),
                    _ => None,
                })
                .context("Source events were not acknowledged; checkpoint is retained")?;
            update_state(&mut states, admitted);
            if !more {
                break;
            }
        }
    }
    // The runtime checks the selected provider only when admitted work needs
    // a model turn. ChatGPT status cannot gate other providers.
    call(
        directory,
        RuntimeCommand::TriageSources {
            instructions: String::new(),
            model: context.model.clone(),
            cwd: context.cwd.clone(),
            hosts: Vec::new(),
        },
    )
    .await?;
    Ok(())
}

fn update_state(states: &mut Vec<SourceState>, state: SourceState) {
    match states
        .iter_mut()
        .find(|previous| previous.source == state.source)
    {
        Some(previous) => *previous = state,
        None => states.push(state),
    }
}

/// Intake submits work to the owner; it never becomes an execution fallback.
async fn call(directory: &Path, command: RuntimeCommand) -> Result<Vec<RuntimeEventKind>> {
    let stream = timeout(Duration::from_secs(5), service::connect(directory)).await??;
    let (reader, mut writer) = stream.into_split();
    let mut reader = FrameReader::new(BufReader::new(reader));
    write(&mut writer, &command).await?;
    let mut events = Vec::new();
    loop {
        let frame = reader
            .next_frame()
            .await?
            .context("Coordinator closed the background check")?;
        let event: RuntimeEventKind = serde_json::from_slice(&frame)?;
        match event {
            RuntimeEventKind::HostCall { .. } => {
                bail!("Coordinator delegated an owned effect to source intake")
            }
            RuntimeEventKind::Failure { message, .. } => bail!(message),
            RuntimeEventKind::Done => return Ok(events),
            other => events.push(other),
        }
    }
}

async fn write(writer: &mut (impl AsyncWriteExt + Unpin), command: &RuntimeCommand) -> Result<()> {
    let mut frame = serde_json::to_vec(command)?;
    frame.push(b'\n');
    writer.write_all(&frame).await?;
    writer.flush().await?;
    Ok(())
}
