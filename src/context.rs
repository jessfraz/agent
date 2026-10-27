//! Read-only context paths resolve against canonical coordinator-owned roots.

use std::{
    collections::HashSet,
    path::{Component, Path, PathBuf},
};

use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncSeekExt},
};

use crate::{
    host,
    protocol::{ContextMatch, ContextRepository, HostCommand, HostResult},
};

#[derive(Clone, Default)]
pub struct ContextStore {
    repositories: Vec<ContextRepository>,
}

impl ContextStore {
    pub fn load(roots: &[PathBuf]) -> Result<Self> {
        let mut seen = HashSet::new();
        let mut repositories = Vec::new();
        for root in roots {
            let root = std::fs::canonicalize(root).context("Context repository is unavailable")?;
            ensure!(root.is_dir(), "Context repository must be a directory");
            if !seen.insert(root.clone()) {
                continue;
            }
            let root = root
                .to_str()
                .context("Context repository path must be UTF-8")?
                .to_owned();
            let instructions = match std::fs::read_to_string(Path::new(&root).join("AGENTS.md")) {
                Ok(value) => value,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
                Err(error) => return Err(error).context("Could not read context instructions"),
            };
            repositories.push(ContextRepository {
                id: format!("context-{:x}", Sha256::digest(root.as_bytes())),
                root,
                instructions,
            });
        }
        Ok(Self { repositories })
    }

    pub fn repositories(&self) -> &[ContextRepository] {
        &self.repositories
    }

    fn repository(&self, id: &str) -> Result<&ContextRepository> {
        self.repositories
            .iter()
            .find(|repository| repository.id == id)
            .context("Unknown context repository")
    }

    async fn path(&self, id: &str, relative: &str) -> Result<PathBuf> {
        let root = &self.repository(id)?.root;
        let path = Path::new(relative);
        ensure!(
            !path.is_absolute()
                && path
                    .components()
                    .all(|part| matches!(part, Component::Normal(_))),
            "Context paths must be relative and cannot contain parent traversal"
        );
        let path = fs::canonicalize(Path::new(root).join(path))
            .await
            .context("Context path is unavailable")?;
        ensure!(
            path.starts_with(root),
            "Context path leaves its configured repository"
        );
        Ok(path)
    }

    pub async fn read(
        &self,
        id: &str,
        relative: &str,
        offset: u32,
        limit: u32,
    ) -> Result<HostResult> {
        ensure!(
            (1..=262_144).contains(&limit),
            "Context read limit must be between 1 and 262144 bytes"
        );
        let path = self.path(id, relative).await?;
        // Nonblocking open keeps a FIFO from stalling before its type is known.
        let mut file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(&path)
            .await?;
        ensure!(
            file.metadata().await?.is_file(),
            "Context reads require a regular file"
        );
        file.seek(std::io::SeekFrom::Start(offset.into())).await?;
        let mut bytes = Vec::new();
        file.take(u64::from(limit) + 1)
            .read_to_end(&mut bytes)
            .await?;
        let truncated = bytes.len() > limit as usize;
        bytes.truncate(limit as usize);
        Ok(HostResult::File {
            content: String::from_utf8(bytes).context("Context file is not UTF-8 text")?,
            truncated,
        })
    }

    pub async fn search(
        &self,
        id: &str,
        relative: Option<&str>,
        query: &str,
        limit: u32,
    ) -> Result<HostResult> {
        ensure!(
            !query.trim().is_empty() && query.len() <= 1024 && (1..=100).contains(&limit),
            "Context search needs a query and a limit between 1 and 100"
        );
        let repository = self.repository(id)?;
        let selected = match relative {
            Some(path) => self.path(id, path).await?,
            None => PathBuf::from(&repository.root),
        };
        let inventory = host::execute(HostCommand::Exec {
            program: "git".into(),
            args: vec![
                "ls-files".into(),
                "--cached".into(),
                "--others".into(),
                "--exclude-standard".into(),
                "--deduplicate".into(),
                "-z".into(),
            ],
            cwd: repository.root.clone(),
            timeout_seconds: 15,
        })
        .await;
        let HostResult::Process {
            exit_code: 0,
            stdout,
            mut truncated,
            ..
        } = inventory
        else {
            anyhow::bail!("Context file inventory is unavailable");
        };
        let needle = query.to_lowercase();
        let mut matches = Vec::new();
        for (index, relative) in stdout
            .split('\0')
            .filter(|path| !path.is_empty())
            .enumerate()
        {
            if index == 2048 {
                truncated = true;
                break;
            }
            let Ok(path) = self.path(id, relative).await else {
                continue;
            };
            if !path.starts_with(&selected) {
                continue;
            }
            let metadata = fs::metadata(&path).await?;
            if !metadata.is_file() {
                continue;
            }
            if metadata.len() > 262_144 {
                truncated = true;
                continue;
            }
            let Ok(HostResult::File {
                content: contents,
                truncated: was_truncated,
            }) = self.read(id, relative, 0, 262_144).await
            else {
                continue;
            };
            truncated |= was_truncated;
            if contents.contains('\0') {
                continue;
            }
            for (line, text) in contents.lines().enumerate() {
                if text.to_lowercase().contains(&needle) {
                    if matches.len() == limit as usize {
                        truncated = true;
                        break;
                    }
                    matches.push(ContextMatch {
                        path: relative.into(),
                        line: (line + 1).try_into()?,
                        text: text.chars().take(2000).collect(),
                    });
                }
            }
            if matches.len() == limit as usize {
                truncated = true;
                break;
            }
        }
        Ok(HostResult::ContextMatches { matches, truncated })
    }
}

#[cfg(test)]
mod tests {
    use crate::{context::ContextStore, protocol::HostResult};
    use std::{fs, os::unix::fs::symlink, process::Command};

    #[tokio::test]
    async fn context_reads_are_bounded_and_cannot_leave_the_registered_root() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("context");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("AGENTS.md"), "Use existing providers.").unwrap();
        fs::write(root.join("facts.md"), "alpha beta gamma").unwrap();
        fs::write(directory.path().join("outside"), "private").unwrap();
        symlink(directory.path().join("outside"), root.join("escape")).unwrap();
        let store = ContextStore::load(&[root.clone(), root.clone()]).unwrap();
        assert_eq!(store.repositories().len(), 1);
        let repository = &store.repositories()[0];
        assert_eq!(repository.instructions, "Use existing providers.");
        assert!(
            matches!(store.read(&repository.id,"facts.md",6,4).await.unwrap(),HostResult::File{content,truncated:true} if content=="beta")
        );
        for path in ["../outside", "/etc/passwd", "escape", ""] {
            assert!(
                store.read(&repository.id, path, 0, 30).await.is_err(),
                "{path}"
            );
        }
        assert!(store.read("unknown", "facts.md", 0, 30).await.is_err());
        assert!(store.read(&repository.id, "facts.md", 0, 0).await.is_err());
        assert!(
            store
                .read(&repository.id, "facts.md", 0, 262145)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn search_uses_git_inventory_and_preserves_relative_paths_and_coverage() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        assert!(
            Command::new("git")
                .args(["init", "--quiet"])
                .current_dir(root)
                .status()
                .unwrap()
                .success()
        );
        fs::create_dir(root.join("facts")).unwrap();
        fs::write(
            root.join("facts/items.md"),
            "Battery interval\nBATTERY supplier\n",
        )
        .unwrap();
        fs::write(root.join(".gitignore"), "ignored.md\n").unwrap();
        fs::write(root.join("ignored.md"), "battery must not appear").unwrap();
        let store = ContextStore::load(&[root.to_owned()]).unwrap();
        let id = &store.repositories()[0].id;
        let HostResult::ContextMatches { matches, truncated } = store
            .search(id, Some("facts"), "battery", 10)
            .await
            .unwrap()
        else {
            panic!("Expected matches")
        };
        assert!(!truncated);
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].path, "facts/items.md");
        assert_eq!(matches[0].line, 1);
        let HostResult::ContextMatches { matches, truncated } =
            store.search(id, None, "battery", 1).await.unwrap()
        else {
            panic!("Expected bounded matches")
        };
        assert!(truncated);
        assert_eq!(matches.len(), 1);
        assert!(store.search(id, Some("../"), "battery", 10).await.is_err());
    }
}
