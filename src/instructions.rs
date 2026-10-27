use std::{
    env, fs, io,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};

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
        "{}\n\nFind relevant existing task conversations before creating a new one. Continue through them and report the result in the main conversation. Use allocate_worktree for new task worktrees so ownership and cleanup are recorded. Keep updates brief and actionable.",
        read_optional(path)?.unwrap_or_default()
    ))
}

pub fn project(working_directory: &Path) -> Result<String> {
    let mut directories: Vec<_> = working_directory.ancestors().collect();
    match directories
        .iter()
        .position(|directory| directory.join(".git").exists())
    {
        Some(index) => directories.truncate(index + 1),
        None => directories.truncate(1),
    }
    let mut sections = Vec::new();
    for directory in directories.into_iter().rev() {
        if let Some(contents) = read_optional(&directory.join("AGENTS.md"))? {
            sections.push(format!("# Project instructions\n\n{contents}"));
        }
    }
    Ok(sections.join("\n\n"))
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
    use crate::instructions::{global, project};
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
}
