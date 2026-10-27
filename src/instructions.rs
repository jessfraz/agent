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

pub fn load(global: &Path, working_directory: &Path) -> Result<String> {
    load_with_context(global, working_directory, &[])
}

pub fn load_with_context(
    global: &Path,
    working_directory: &Path,
    repositories: &[PathBuf],
) -> Result<String> {
    let mut sections = Vec::new();
    if let Some(contents) = read_optional(global)? {
        sections.push(format!("# User instructions\n\n{contents}"));
    }
    let mut directories = Vec::new();
    for directory in working_directory.ancestors() {
        directories.push(directory);
        if directory.join(".git").exists() {
            break;
        }
    }
    if !directories
        .last()
        .is_some_and(|directory| directory.join(".git").exists())
    {
        directories.truncate(1);
    }
    for repository in repositories {
        anyhow::ensure!(
            repository.is_dir(),
            "Context repository is unavailable: {}",
            repository.display()
        );
        let path = repository.join("AGENTS.md");
        let contents = if path == global
            || directories
                .iter()
                .any(|directory| directory.join("AGENTS.md") == path)
        {
            None
        } else {
            read_optional(&path)?
        };
        sections.push(format!("# Context repository: {}\n\nResolve this repository's relative paths against {}.\n\n{}",
            repository.display(), repository.display(), contents.unwrap_or_default()));
    }
    for directory in directories.into_iter().rev() {
        let path = directory.join("AGENTS.md");
        if path != global
            && let Some(contents) = read_optional(&path)?
        {
            sections.push(format!("# Project instructions\n\n{contents}"));
        }
    }
    sections.push(
        "Find relevant existing task conversations before creating a new one. \
         Continue through them and report the result in the main conversation. \
         Use allocate_worktree for new task worktrees so ownership and cleanup are recorded. \
         Keep updates brief and actionable."
            .into(),
    );
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
    use crate::instructions::{load, load_with_context};
    use std::fs;

    #[test]
    fn loads_global_and_scoped_project_instructions_in_order() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let nested = project.join("nested");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir(project.join(".git")).unwrap();
        let global = root.path().join("global.md");
        fs::write(&global, "Use brief answers.").unwrap();
        fs::write(root.path().join("AGENTS.md"), "Outside project.").unwrap();
        fs::write(project.join("AGENTS.md"), "Run project checks.").unwrap();
        fs::write(nested.join("AGENTS.md"), "Use nested conventions.").unwrap();
        let instructions = load(&global, &nested).unwrap();
        assert!(
            instructions.find("Use brief answers.").unwrap()
                < instructions.find("Run project checks.").unwrap()
        );
        assert!(
            instructions.find("Run project checks.").unwrap()
                < instructions.find("Use nested conventions.").unwrap()
        );
        assert!(!instructions.contains("Outside project."));
    }

    #[test]
    fn reloads_instructions_and_limits_unversioned_directories() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let global = root.path().join("global.md");
        fs::write(root.path().join("AGENTS.md"), "Unrelated parent.").unwrap();
        fs::write(&global, "First version.").unwrap();
        assert!(
            load(&global, &workspace)
                .unwrap()
                .contains("First version.")
        );
        fs::write(&global, "Second version.").unwrap();
        let updated = load(&global, &workspace).unwrap();
        assert!(updated.contains("Second version."));
        assert!(!updated.contains("First version."));
        assert!(!updated.contains("Unrelated parent."));
    }

    #[test]
    fn context_repositories_supply_scoped_instructions_without_changing_the_task_directory() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let context = root.path().join("context-repository");
        fs::create_dir(&project).unwrap();
        fs::create_dir(&context).unwrap();
        fs::create_dir(project.join(".git")).unwrap();
        let global = root.path().join("global.md");
        fs::write(&global, "Keep answers brief.").unwrap();
        fs::write(
            context.join("AGENTS.md"),
            "Read relevant context facts and use existing provider tools.",
        )
        .unwrap();
        fs::write(project.join("AGENTS.md"), "Run this project's tests.").unwrap();
        let before = std::env::current_dir().unwrap();
        let prompt = load_with_context(&global, &project, std::slice::from_ref(&context)).unwrap();
        assert_eq!(std::env::current_dir().unwrap(), before);
        assert!(prompt.contains(context.to_str().unwrap()));
        assert!(
            prompt.find("Keep answers brief.").unwrap()
                < prompt.find("Read relevant context facts").unwrap()
        );
        assert!(
            prompt.find("Read relevant context facts").unwrap()
                < prompt.find("Run this project's tests.").unwrap()
        );
        assert!(
            load_with_context(&global, &project, &[root.path().join("missing-context")]).is_err()
        );
    }
}
