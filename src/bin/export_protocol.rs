use std::{fs, path::PathBuf};

use agent_cli::protocol::{RuntimeEvent, RuntimeRequest};
use anyhow::Result;
use schemars::schema_for;
use ts_rs::TS;

fn main() -> Result<()> {
    let output = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("runtime/src/generated");
    fs::create_dir_all(&output)?;
    RuntimeRequest::export_all_to(&output)?;
    RuntimeEvent::export_all_to(&output)?;
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
