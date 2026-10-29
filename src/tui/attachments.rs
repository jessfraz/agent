//! Local composer staging. Only uploaded attachment references cross the wire.
use crate::attachments::{AttachmentRef, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ComposerFile {
    pub path: PathBuf,
    pub name: String,
    pub size_bytes: u32,
}

impl ComposerFile {
    pub fn read_metadata(path: PathBuf) -> Result<Self> {
        let metadata = path.metadata().context("Could not inspect attachment")?;
        ensure!(metadata.is_file(), "Attachments must be regular files");
        ensure!(
            metadata.len() <= u64::from(MAX_ATTACHMENT_BYTES),
            "Attachments must be at most 16 MiB"
        );
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .context("Attachment needs a UTF-8 filename")?
            .to_owned();
        ensure!(
            !name.chars().any(char::is_control),
            "Attachment filenames cannot contain control characters"
        );
        Ok(Self {
            path,
            name,
            size_bytes: u32::try_from(metadata.len())?,
        })
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ComposerInput {
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<ComposerFile>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<AttachmentRef>,
}

impl ComposerInput {
    pub fn append(&mut self, input: Self) {
        if !input.text.is_empty() {
            if !self.text.is_empty() {
                self.text.push('\n');
            }
            self.text.push_str(&input.text);
        }
        self.files.extend(input.files);
        self.attachments.extend(input.attachments);
    }
    pub fn is_empty(&self) -> bool {
        self.text.is_empty() && self.files.is_empty() && self.attachments.is_empty()
    }
    pub fn attachment_count(&self) -> usize {
        self.files.len() + self.attachments.len()
    }
}

impl From<String> for ComposerInput {
    fn from(text: String) -> Self {
        Self {
            text,
            ..Self::default()
        }
    }
}

impl From<&str> for ComposerInput {
    fn from(text: &str) -> Self {
        text.to_owned().into()
    }
}

/// A complete shell-quoted path paste can be a drop. Mixed prose, missing files,
/// directories and unfinished quoting remain ordinary pasted text.
pub(super) fn dropped_files(text: &str, directory: &Path) -> Result<Option<Vec<ComposerFile>>> {
    let Some(words) = shell_paths(text) else {
        return Ok(None);
    };
    if words.is_empty()
        || words.iter().any(|word| {
            !(Path::new(word).is_absolute()
                || word.starts_with("./")
                || word.starts_with("../")
                || word.starts_with("~/"))
        })
    {
        return Ok(None);
    }
    ensure!(words.len() <= MAX_ATTACHMENTS, "Attach at most 8 files");
    let mut files = Vec::with_capacity(words.len());
    for word in words {
        let path = if let Some(rest) = word.strip_prefix("~/") {
            let Some(home) = dirs::home_dir() else {
                return Ok(None);
            };
            home.join(rest)
        } else {
            directory.join(word)
        };
        if !path.metadata().is_ok_and(|metadata| metadata.is_file()) {
            return Ok(None);
        }
        files.push(ComposerFile::read_metadata(path)?);
    }
    Ok(Some(files))
}

fn shell_paths(text: &str) -> Option<Vec<String>> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    let mut started = false;
    let mut chars = text.trim().chars().peekable();
    while let Some(character) = chars.next() {
        match (quote, character) {
            (Some('\''), '\'') | (Some('"'), '"') => quote = None,
            (Some('\''), character) => word.push(character),
            (Some('"'), '\\') => {
                if chars
                    .peek()
                    .is_some_and(|next| matches!(next, '$' | '`' | '"' | '\\' | '\n'))
                {
                    let next = chars.next()?;
                    if next != '\n' {
                        word.push(next);
                    }
                } else {
                    word.push('\\');
                }
            }
            (_, '\\') => {
                started = true;
                let next = chars.next()?;
                if next != '\n' {
                    word.push(next);
                }
            }
            (Some('"'), character) => word.push(character),
            (None, '\'' | '"') => {
                quote = Some(character);
                started = true;
            }
            (None, character) if character.is_whitespace() => {
                if started {
                    words.push(std::mem::take(&mut word));
                    started = false;
                }
            }
            (None, '$' | '`' | ';' | '|' | '&' | '<' | '>' | '(' | ')' | '*' | '?' | '[' | ']') => {
                return None;
            }
            (_, character) => {
                started = true;
                word.push(character);
            }
        }
    }
    if quote.is_some() {
        return None;
    }
    if started {
        words.push(word);
    }
    Some(words)
}

#[cfg(test)]
mod tests {
    use crate::tui::attachments::dropped_files;

    #[test]
    fn complete_drops_accept_shell_escaped_paths_without_running_a_shell() {
        let directory = tempfile::tempdir().unwrap();
        let first = directory.path().join("report's draft.png");
        let second = directory.path().join("other image.txt");
        std::fs::write(&first, b"first").unwrap();
        std::fs::write(&second, b"second").unwrap();
        let quoted = format!(
            "'{}' {} ",
            first.display().to_string().replace('\'', "'\\''"),
            second.display().to_string().replace(' ', "\\ ")
        );
        let files = dropped_files(&quoted, directory.path()).unwrap().unwrap();
        assert_eq!(files[0].path, first);
        assert_eq!(files[1].path, second);
        assert_eq!(files[0].size_bytes, 5);
        let double_quoted = format!("\"{}\"", second.display());
        assert_eq!(
            dropped_files(&double_quoted, directory.path())
                .unwrap()
                .unwrap()[0]
                .path,
            second
        );
    }

    #[test]
    fn prose_missing_files_directories_and_unfinished_quotes_remain_text() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("example.txt");
        std::fs::write(&file, b"data").unwrap();
        for paste in [
            format!("Please review {}", file.display()),
            format!("{}; printf surprise", file.display()),
            format!("'{}", file.display()),
            directory.path().display().to_string(),
            directory.path().join("missing.png").display().to_string(),
            "Ordinary\nmultiline **Markdown** and shell \\ text".into(),
        ] {
            assert!(dropped_files(&paste, directory.path()).unwrap().is_none());
        }
    }

    #[test]
    fn explicit_drops_observe_the_shared_attachment_limits() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("large.txt");
        std::fs::File::create(&file)
            .unwrap()
            .set_len(u64::from(crate::attachments::MAX_ATTACHMENT_BYTES) + 1)
            .unwrap();
        assert!(dropped_files(&file.display().to_string(), directory.path()).is_err());
        let too_many =
            std::iter::repeat_n("/example/file", crate::attachments::MAX_ATTACHMENTS + 1)
                .collect::<Vec<_>>()
                .join(" ");
        assert!(dropped_files(&too_many, directory.path()).is_err());
    }
}
