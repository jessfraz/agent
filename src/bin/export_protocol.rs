#[path = "export_protocol/swift.rs"]
mod swift;
use std::{fs, path::PathBuf};

use agent_cli::protocol::{
    AllocationDecision, DelegationDecision, HistoryImportBatch, HistoryImportReceipt, RuntimeEvent,
    RuntimeRequest, TaskOutcome,
};
use anyhow::Result;
use schemars::schema_for;
use ts_rs::{Config, TS};

fn main() -> Result<()> {
    let output = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("runtime/src/generated");
    fs::create_dir_all(&output)?;
    let config = Config::from_env().with_out_dir(&output);
    RuntimeRequest::export_all(&config)?;
    RuntimeEvent::export_all(&config)?;
    agent_cli::background::BackgroundTaskInput::export_all(&config)?;
    agent_cli::background::BackgroundCheckpoint::export_all(&config)?;
    TaskOutcome::export_all(&config)?;
    DelegationDecision::export_all(&config)?;
    AllocationDecision::export_all(&config)?;
    HistoryImportBatch::export_all(&config)?;
    HistoryImportReceipt::export_all(&config)?;
    agent_cli::browser::BrowserRequest::export_all(&config)?;
    agent_cli::browser::BrowserReply::export_all(&config)?;
    agent_cli::browser::BrowserConfig::export_all(&config)?;
    agent_cli::browser::BrowserBinding::export_all(&config)?;
    fs::write(
        output.join("browser.schema.json"),
        serde_json::to_string_pretty(&schema_for!(agent_cli::browser::BrowserRequest))?,
    )?;
    fs::write(
        output.join("request.schema.json"),
        serde_json::to_string_pretty(&schema_for!(RuntimeRequest))?,
    )?;
    fs::write(
        output.join("event.schema.json"),
        serde_json::to_string_pretty(&schema_for!(RuntimeEvent))?,
    )?;
    let native =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("ios/Sources/AgentCore/Generated.swift");
    fs::create_dir_all(
        native
            .parent()
            .ok_or_else(|| anyhow::anyhow!("Missing native directory"))?,
    )?;
    fs::write(
        native,
        swift::generate(&[
            serde_json::to_value(schema_for!(agent_cli::native::NativeCommand))?,
            serde_json::to_value(schema_for!(agent_cli::native::NativeEvent))?,
        ])?,
    )?;
    let fixtures =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("ios/Tests/AgentCoreTests/Fixtures");
    fs::create_dir_all(&fixtures)?;
    let schema = serde_json::to_value(schema_for!(agent_cli::native::NativeEvent))?;
    let events = swift::samples(&schema, &schema)?
        .into_iter()
        .map(|value| {
            let event: agent_cli::native::NativeEvent = serde_json::from_value(value)?;
            serde_json::to_string(&event)
        })
        .collect::<std::result::Result<Vec<_>, serde_json::Error>>()?;
    fs::write(fixtures.join("events.ndjson"), events.join("\n") + "\n")?;
    let schema = serde_json::to_value(schema_for!(agent_cli::native::NativeCommand))?;
    let commands = swift::samples(&schema, &schema)?
        .into_iter()
        .map(|value| {
            let command: agent_cli::native::NativeCommand = serde_json::from_value(value)?;
            serde_json::to_string(&command)
        })
        .collect::<std::result::Result<Vec<_>, serde_json::Error>>()?;
    fs::write(fixtures.join("commands.ndjson"), commands.join("\n") + "\n")?;
    Ok(())
}
