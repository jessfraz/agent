use std::{
    env, fs, io,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, ensure};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ts_rs::TS;

pub const WORKFLOW_POLICY: &str = "Find relevant existing task conversations before creating a new one. Continue through them and report the result in the main conversation. Follow-ups and refinements of the same broader effort stay in its existing task, with named child terminals for subwork; create another task only for a separate outcome. Steer workers and child agents promptly with corrections or context for active work; queue only independent later work with mode:follow_up. Use allocate_worktree for new task worktrees so ownership and cleanup are recorded. Keep updates brief and actionable.";

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct GuidanceSource {
    pub path: String,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct GuidanceSnapshot {
    pub text: String,
    pub sources: Vec<GuidanceSource>,
}

pub fn default_path() -> Result<PathBuf> {
    let directory = match env::var_os("CODEX_HOME") {
        Some(path) => PathBuf::from(path),
        None => dirs::home_dir()
            .context("No home directory is available")?
            .join(".codex"),
    };
    Ok(directory.join("AGENTS.md"))
}

/// Only the coordinator supplies shared instructions. Clients supply project
/// guidance separately, without reading private context on the caller's Mac.
pub fn global(path: &Path) -> Result<String> {
    Ok(format!(
        "{}\n\n{WORKFLOW_POLICY}",
        global_snapshot(path)?.text
    ))
}

/// File guidance stays separate from the application's stable workflow policy.
pub fn global_snapshot(path: &Path) -> Result<GuidanceSnapshot> {
    let mut snapshot = GuidanceSnapshot {
        text: String::new(),
        sources: Vec::new(),
    };
    if let Some(contents) = read_optional(path)? {
        snapshot.sources.push(source(path, &contents)?);
        snapshot.text = contents;
    }
    Ok(snapshot)
}

pub fn project(working_directory: &Path) -> Result<String> {
    Ok(project_snapshot(working_directory)?.text)
}

pub fn project_snapshot(working_directory: &Path) -> Result<GuidanceSnapshot> {
    ensure!(
        working_directory.is_absolute(),
        "Project guidance needs an absolute working directory"
    );
    let mut directories: Vec<_> = working_directory.ancestors().collect();
    match directories
        .iter()
        .position(|directory| directory.join(".git").exists())
    {
        Some(index) => directories.truncate(index + 1),
        None => directories.truncate(1),
    }
    let mut sections = Vec::new();
    let mut sources = Vec::new();
    for directory in directories.into_iter().rev() {
        let path = directory.join("AGENTS.md");
        if let Some(contents) = read_optional(&path)? {
            sources.push(source(&path, &contents)?);
            sections.push(format!("# Project instructions\n\n{contents}"));
        }
    }
    Ok(GuidanceSnapshot {
        text: sections.join("\n\n"),
        sources,
    })
}

fn source(path: &Path, contents: &str) -> Result<GuidanceSource> {
    Ok(GuidanceSource {
        path: std::path::absolute(path)?
            .to_str()
            .context("Guidance path is not UTF-8")?
            .to_owned(),
        sha256: format!("{:x}", Sha256::digest(contents.as_bytes())),
    })
}

fn read_optional(path: &Path) -> Result<Option<String>> {
    match fs::read_to_string(path) {
        Ok(contents) => Ok(Some(contents)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error).context("Could not read agent instructions"),
    }
}

#[cfg(test)]
mod tests {
    use crate::instructions::{global, global_snapshot, project, project_snapshot};
    use std::fs;

    #[test]
    fn project_instructions_stop_at_the_repository_and_keep_nested_order() {
        let root = tempfile::tempdir().unwrap();
        let repository = root.path().join("project");
        let nested = repository.join("nested");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir(repository.join(".git")).unwrap();
        fs::write(root.path().join("AGENTS.md"), "Outside project.").unwrap();
        fs::write(repository.join("AGENTS.md"), "Run project checks.").unwrap();
        fs::write(nested.join("AGENTS.md"), "Use nested conventions.").unwrap();
        let instructions = project(&nested).unwrap();
        assert!(
            instructions.find("Run project checks.").unwrap()
                < instructions.find("Use nested conventions.").unwrap()
        );
        assert!(!instructions.contains("Outside project."));
    }

    #[test]
    fn shared_guidance_reloads_without_loading_unversioned_parent_instructions() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let path = root.path().join("global.md");
        fs::write(root.path().join("AGENTS.md"), "Unrelated parent.").unwrap();
        fs::write(&path, "First version.").unwrap();
        assert!(global(&path).unwrap().contains("First version."));
        fs::write(&path, "Second version.").unwrap();
        let updated = global(&path).unwrap();
        assert!(updated.contains("Second version."));
        assert!(!updated.contains("First version."));
        assert!(project(&workspace).unwrap().is_empty());
    }

    #[test]
    fn snapshots_refresh_hashes_and_remove_deleted_guidance() {
        let root = tempfile::tempdir().unwrap();
        let repository = root.path().join("repository");
        fs::create_dir(&repository).unwrap();
        fs::create_dir(repository.join(".git")).unwrap();
        let global = root.path().join("global.md");
        let local = repository.join("AGENTS.md");
        fs::write(&global, "Current global instructions.").unwrap();
        fs::write(&local, "Current project instructions.").unwrap();
        let first = global_snapshot(&global).unwrap();
        let project_first = project_snapshot(&repository).unwrap();
        assert_eq!(first.sources.len(), 1);
        assert_eq!(first.sources[0].path, global.to_str().unwrap());
        assert_eq!(project_first.sources[0].path, local.to_str().unwrap());
        fs::write(&global, "Updated global instructions.").unwrap();
        fs::write(&local, "Updated project instructions.").unwrap();
        let second = global_snapshot(&global).unwrap();
        let project_second = project_snapshot(&repository).unwrap();
        assert_ne!(first.sources[0].sha256, second.sources[0].sha256);
        assert_ne!(
            project_first.sources[0].sha256,
            project_second.sources[0].sha256
        );
        assert_eq!(second.text, "Updated global instructions.");
        assert!(
            project_second
                .text
                .contains("Updated project instructions.")
        );
        fs::remove_file(global).unwrap();
        fs::remove_file(local).unwrap();
        assert!(
            global_snapshot(&root.path().join("global.md"))
                .unwrap()
                .text
                .is_empty()
        );
        let removed = project_snapshot(&repository).unwrap();
        assert!(removed.text.is_empty());
        assert!(removed.sources.is_empty());
    }
}
