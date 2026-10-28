use std::{fs, path::PathBuf};

use agent_cli::protocol::{
    HistoryImportBatch, HistoryImportReceipt, RuntimeEvent, RuntimeRequest, TaskOutcome,
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
    TaskOutcome::export_all(&config)?;
    HistoryImportBatch::export_all(&config)?;
    HistoryImportReceipt::export_all(&config)?;
    fs::write(
        output.join("request.schema.json"),
        serde_json::to_string_pretty(&schema_for!(RuntimeRequest))?,
    )?;
    fs::write(
        output.join("event.schema.json"),
        serde_json::to_string_pretty(&schema_for!(RuntimeEvent))?,
    )?;
    Ok(())
}
