use std::{fs, os::unix::fs::DirBuilderExt, path::PathBuf};

use anyhow::{Context, Result};

pub fn directory(explicit: Option<PathBuf>) -> Result<PathBuf> {
    let directory = match explicit {
        Some(directory) => directory,
        None => dirs::data_local_dir()
            .context("No application data directory is available")?
            .join("agent"),
    };
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&directory)
        .context("Could not create the private agent state directory")?;
    use std::os::unix::fs::PermissionsExt;
    anyhow::ensure!(
        fs::metadata(&directory)?.permissions().mode() & 0o077 == 0,
        "The agent state directory must be private (mode 0700)"
    );
    Ok(directory)
}
