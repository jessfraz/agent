//! One bounded attachment transfer contract for native, terminal and worker clients.
use std::path::Path;

use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const MAX_ATTACHMENT_BYTES: u32 = 16 * 1024 * 1024;
pub const ATTACHMENT_CHUNK_BYTES: u32 = 64 * 1024;
pub const MAX_ATTACHMENTS: usize = 8;
pub const MAX_ATTACHMENT_NAME_BYTES: usize = 240;

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS, PartialEq, Eq)]
pub struct AttachmentRef {
    pub id: String,
    pub name: String,
    pub media_type: String,
    pub size_bytes: u32,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum AttachmentRequest {
    Upload {
        id: String,
        name: String,
        media_type: String,
        size_bytes: u32,
        offset: u32,
        data_base64: String,
        complete: bool,
    },
    Download {
        id: String,
        offset: u32,
        limit: u32,
    },
    Discard {
        id: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AttachmentResponse {
    Uploaded {
        next_offset: u32,
        attachment: Option<AttachmentRef>,
    },
    Download {
        data_base64: String,
        next_offset: Option<u32>,
    },
    Discarded,
}

/// The caller owns its authenticated transfer connection for the entire file.
pub async fn upload_file<F, Fut>(path: &Path, mut transfer: F) -> Result<AttachmentRef>
where
    F: FnMut(AttachmentRequest) -> Fut + Send,
    Fut: std::future::Future<Output = Result<AttachmentResponse>> + Send,
{
    use tokio::io::AsyncReadExt;
    let file = tokio::fs::File::open(path)
        .await
        .context("Could not open attachment")?;
    ensure!(
        file.metadata().await?.is_file(),
        "Attachments must be regular files"
    );
    let mut bytes = Vec::new();
    file.take(u64::from(MAX_ATTACHMENT_BYTES) + 1)
        .read_to_end(&mut bytes)
        .await?;
    ensure!(
        bytes.len() <= MAX_ATTACHMENT_BYTES as usize,
        "Attachments must be at most 16 MiB"
    );
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .context("Attachment needs a UTF-8 filename")?
        .to_owned();
    let media_type = media_type(path, &bytes).to_owned();
    ensure!(
        name.len() <= MAX_ATTACHMENT_NAME_BYTES,
        "Attachment filename must be at most {MAX_ATTACHMENT_NAME_BYTES} UTF-8 bytes"
    );
    use sha2::{Digest, Sha256};
    let sha256 = hex::encode(Sha256::digest(&bytes));
    let id = uuid::Uuid::new_v4().to_string();
    let size_bytes = u32::try_from(bytes.len())?;
    let mut offset = 0;
    loop {
        let end = (offset + ATTACHMENT_CHUNK_BYTES).min(size_bytes);
        let response = transfer(AttachmentRequest::Upload {
            id: id.clone(),
            name: name.clone(),
            media_type: media_type.clone(),
            size_bytes,
            offset,
            data_base64: STANDARD.encode(&bytes[offset as usize..end as usize]),
            complete: end == size_bytes,
        })
        .await?;
        match response {
            AttachmentResponse::Uploaded {
                next_offset,
                attachment,
            } if next_offset == end => {
                if let Some(attachment) = attachment {
                    ensure!(
                        end == size_bytes
                            && attachment.id == id
                            && attachment.size_bytes == size_bytes
                            && attachment.name == name
                            && attachment.media_type == media_type
                            && attachment.sha256 == sha256,
                        "Attachment receipt does not match the upload"
                    );
                    return Ok(attachment);
                }
                ensure!(
                    end < size_bytes,
                    "Attachment upload completed without a receipt"
                );
                offset = end;
            }
            _ => bail!("The coordinator returned an invalid attachment receipt"),
        }
    }
}

fn media_type(path: &Path, bytes: &[u8]) -> &'static str {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return "image/png";
    }
    if bytes.starts_with(b"\xff\xd8\xff") {
        return "image/jpeg";
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return "image/gif";
    }
    if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        return "image/webp";
    }
    if bytes.starts_with(b"%PDF-") {
        return "application/pdf";
    }
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("txt" | "log") => "text/plain",
        Some("md") => "text/markdown",
        Some("html" | "htm") => "text/html",
        Some("json") => "application/json",
        Some("csv") => "text/csv",
        Some("zip") => "application/zip",
        _ => "application/octet-stream",
    }
}

/// Cached copies are private to the execution host. Originals stay on the coordinator.
pub async fn write_on_host(
    state: &Path,
    attachment: AttachmentRef,
    offset: u32,
    data_base64: String,
    complete: bool,
) -> Result<crate::protocol::HostResult> {
    let directory = state.join("attachment-cache");
    tokio::task::spawn_blocking(move || {
        write_chunk(&directory, &attachment, offset, &data_base64, complete)
    })
    .await?
}

fn write_chunk(
    directory: &Path,
    attachment: &AttachmentRef,
    offset: u32,
    data_base64: &str,
    complete: bool,
) -> Result<crate::protocol::HostResult> {
    use sha2::{Digest, Sha256};
    use std::{
        fs,
        io::{Read, Seek, SeekFrom, Write},
        os::unix::fs::{OpenOptionsExt, PermissionsExt},
        time::{Duration, SystemTime},
    };
    ensure!(
        uuid::Uuid::parse_str(&attachment.id).is_ok_and(|id| !id.is_nil()),
        "Invalid attachment ID"
    );
    ensure!(
        !attachment.name.is_empty()
            && attachment.name.len() <= MAX_ATTACHMENT_NAME_BYTES
            && !attachment.name.contains(['/', '\\'])
            && !attachment.name.chars().any(char::is_control)
            && ![".", ".."].contains(&attachment.name.as_str()),
        "Invalid attachment filename"
    );
    ensure!(
        attachment.size_bytes <= MAX_ATTACHMENT_BYTES
            && attachment.sha256.len() == 64
            && attachment
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit()),
        "Invalid attachment receipt"
    );
    ensure!(
        data_base64.len() <= (ATTACHMENT_CHUNK_BYTES as usize).div_ceil(3) * 4,
        "Attachment chunk is too large"
    );
    let bytes = STANDARD
        .decode(data_base64)
        .context("Invalid attachment encoding")?;
    ensure!(
        bytes.len() <= ATTACHMENT_CHUNK_BYTES as usize && STANDARD.encode(&bytes) == data_base64,
        "Invalid attachment encoding"
    );
    let end = offset
        .checked_add(u32::try_from(bytes.len())?)
        .context("Attachment offset overflow")?;
    ensure!(
        end <= attachment.size_bytes && (!complete || end == attachment.size_bytes),
        "Invalid attachment chunk range"
    );
    fs::create_dir_all(directory)?;
    fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(directory.join(".lock"))?;
    fs2::FileExt::lock_exclusive(&lock)?;
    // Only this dedicated cache is collected. No source or coordinator originals live here.
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir()
            || uuid::Uuid::parse_str(&entry.file_name().to_string_lossy()).is_err()
        {
            continue;
        }
        if SystemTime::now()
            .duration_since(entry.metadata()?.modified()?)
            .unwrap_or_default()
            > Duration::from_secs(24 * 60 * 60)
        {
            fs::remove_dir_all(entry.path())?;
        }
    }
    let target = directory.join(&attachment.id);
    let metadata_path = target.join("metadata.json");
    match fs::read(&metadata_path) {
        Ok(bytes) => ensure!(
            serde_json::from_slice::<AttachmentRef>(&bytes)? == *attachment,
            "Attachment identity was reused with different content"
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            ensure!(offset == 0, "Attachment upload must start at offset zero");
            let mut total = 0_u64;
            for entry in fs::read_dir(directory)? {
                let entry = entry?;
                if entry.file_type()?.is_dir() {
                    let bytes = match fs::read(entry.path().join("metadata.json")) {
                        Ok(bytes) => bytes,
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                        Err(error) => return Err(error.into()),
                    };
                    let saved: AttachmentRef = serde_json::from_slice(&bytes)?;
                    total += u64::from(saved.size_bytes) + 4096;
                }
            }
            ensure!(
                total + u64::from(attachment.size_bytes) + 4096 <= 512 * 1024 * 1024,
                "Execution-host attachment cache is full"
            );
            fs::create_dir_all(&target)?;
            fs::set_permissions(&target, fs::Permissions::from_mode(0o700))?;
            let temporary = target.join("metadata.tmp");
            let mut metadata = fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&temporary)?;
            metadata.write_all(&serde_json::to_vec(attachment)?)?;
            metadata.sync_all()?;
            fs::rename(temporary, &metadata_path)?;
        }
        Err(error) => return Err(error.into()),
    }
    let final_path = target.join(format!("file-{}", attachment.name));
    let staged = target.join("content.part");
    let path = if final_path.exists() {
        &final_path
    } else {
        &staged
    };
    let mut file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    let current = file.metadata()?.len();
    ensure!(
        u64::from(offset) <= current,
        "Attachment chunk is out of order"
    );
    file.seek(SeekFrom::Start(u64::from(offset)))?;
    let existing = usize::try_from((current - u64::from(offset)).min(bytes.len() as u64))?;
    if existing > 0 {
        let mut previous = vec![0; existing];
        file.read_exact(&mut previous)?;
        ensure!(
            previous == bytes[..existing],
            "Attachment chunk retry changed its bytes"
        );
    }
    if existing < bytes.len() {
        file.write_all(&bytes[existing..])?;
        file.sync_all()?;
    }
    if complete {
        ensure!(
            file.metadata()?.len() == u64::from(attachment.size_bytes),
            "Attachment size does not match its receipt"
        );
        file.seek(SeekFrom::Start(0))?;
        let mut digest = Sha256::new();
        let mut chunk = [0; 65536];
        loop {
            let count = file.read(&mut chunk)?;
            if count == 0 {
                break;
            }
            digest.update(&chunk[..count]);
        }
        ensure!(
            hex::encode(digest.finalize()) == attachment.sha256,
            "Attachment checksum does not match its receipt"
        );
        if path != &final_path {
            fs::rename(&staged, &final_path)?;
        }
    }
    Ok(crate::protocol::HostResult::AttachmentWritten {
        next_offset: end,
        path: if complete {
            Some(
                final_path
                    .to_str()
                    .context("Attachment cache path is not UTF-8")?
                    .to_owned(),
            )
        } else {
            None
        },
    })
}

#[cfg(test)]
mod tests {
    use crate::attachments::{
        ATTACHMENT_CHUNK_BYTES, AttachmentRef, AttachmentRequest, AttachmentResponse,
        MAX_ATTACHMENT_BYTES, upload_file, write_chunk,
    };
    use crate::protocol::HostResult;
    use base64::{Engine, engine::general_purpose::STANDARD};
    use sha2::{Digest, Sha256};
    use std::{fs, os::unix::fs::PermissionsExt};

    fn reference(bytes: &[u8]) -> AttachmentRef {
        AttachmentRef {
            id: uuid::Uuid::new_v4().to_string(),
            name: "metadata.json".into(),
            media_type: "application/json".into(),
            size_bytes: bytes.len().try_into().unwrap(),
            sha256: hex::encode(Sha256::digest(bytes)),
        }
    }

    #[tokio::test]
    async fn fixed_sha256_receipt_survives_upload_and_durable_cache_replay() {
        let source = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let path = source.path().join("receipt.txt");
        let bytes = b"286";
        let expected = "00328ce57bbc14b33bd6695bc8eb32cdf2fb5f3a7d89ec14a42825e15d39df60";
        fs::write(&path, bytes).unwrap();
        let receipt = upload_file(&path, |request| {
            let AttachmentRequest::Upload {
                id,
                name,
                media_type,
                size_bytes,
                offset,
                data_base64,
                complete,
            } = request
            else {
                panic!("Unexpected request")
            };
            assert_eq!(STANDARD.decode(&data_base64).unwrap(), bytes);
            assert!(complete);
            let attachment = AttachmentRef {
                id,
                name,
                media_type,
                size_bytes,
                sha256: expected.into(),
            };
            let HostResult::AttachmentWritten {
                next_offset,
                path: Some(stored),
            } = write_chunk(cache.path(), &attachment, offset, &data_base64, complete).unwrap()
            else {
                panic!("Missing durable attachment")
            };
            assert_eq!(fs::read(stored).unwrap(), bytes);
            std::future::ready(Ok(AttachmentResponse::Uploaded {
                next_offset,
                attachment: Some(attachment),
            }))
        })
        .await
        .unwrap();
        assert_eq!(receipt.sha256, expected);
        let saved: AttachmentRef = serde_json::from_slice(
            &fs::read(cache.path().join(&receipt.id).join("metadata.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(saved, receipt);
        write_chunk(cache.path(), &saved, 0, &STANDARD.encode(bytes), true).unwrap();
    }

    #[tokio::test]
    async fn shared_uploader_streams_bounded_chunks_and_verifies_the_final_receipt() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("report.md");
        let bytes = vec![b'x'; ATTACHMENT_CHUNK_BYTES as usize + 7];
        fs::write(&path, &bytes).unwrap();
        let expected_hash = hex::encode(Sha256::digest(&bytes));
        let mut received = Vec::new();
        let receipt = upload_file(&path, |request| {
            let AttachmentRequest::Upload {
                id,
                name,
                media_type,
                size_bytes,
                offset,
                data_base64,
                complete,
            } = request
            else {
                panic!("Unexpected request")
            };
            assert_eq!(offset as usize, received.len());
            let chunk = STANDARD.decode(data_base64).unwrap();
            assert!(chunk.len() <= ATTACHMENT_CHUNK_BYTES as usize);
            received.extend_from_slice(&chunk);
            let attachment = complete.then(|| AttachmentRef {
                id,
                name,
                media_type,
                size_bytes,
                sha256: expected_hash.clone(),
            });
            std::future::ready(Ok(AttachmentResponse::Uploaded {
                next_offset: received.len().try_into().unwrap(),
                attachment,
            }))
        })
        .await
        .unwrap();
        assert_eq!(received, bytes);
        assert_eq!(receipt.media_type, "text/markdown");
        assert!(
            upload_file(&path, |_| async {
                Ok(AttachmentResponse::Uploaded {
                    next_offset: 0,
                    attachment: None,
                })
            })
            .await
            .is_err()
        );
        fs::File::create(&path)
            .unwrap()
            .set_len(u64::from(MAX_ATTACHMENT_BYTES) + 1)
            .unwrap();
        assert!(
            upload_file(&path, |_| async {
                panic!("Oversized files must never be transferred")
            })
            .await
            .is_err()
        );
    }

    #[test]
    fn host_cache_replays_partial_chunks_preserves_metadata_and_rejects_changed_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let bytes = b"deterministic attachment";
        let receipt = reference(bytes);
        let first = STANDARD.encode(&bytes[..5]);
        write_chunk(directory.path(), &receipt, 0, &first, false).unwrap();
        // A process can stop mid-chunk. Retrying compares the persisted prefix
        // before extending it; the receipt becomes usable only after hashing.
        let result =
            write_chunk(directory.path(), &receipt, 0, &STANDARD.encode(bytes), true).unwrap();
        let HostResult::AttachmentWritten {
            next_offset,
            path: Some(path),
        } = result
        else {
            panic!("Missing final path")
        };
        assert_eq!(next_offset as usize, bytes.len());
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(directory.path()).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let saved: AttachmentRef = serde_json::from_slice(
            &fs::read(directory.path().join(&receipt.id).join("metadata.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(saved, receipt);
        write_chunk(directory.path(), &receipt, 0, &STANDARD.encode(bytes), true).unwrap();
        assert!(
            write_chunk(
                directory.path(),
                &receipt,
                0,
                &STANDARD.encode(b"changed"),
                false
            )
            .is_err()
        );
        let mut changed = receipt.clone();
        changed.name = "other.json".into();
        assert!(write_chunk(directory.path(), &changed, 0, &first, false).is_err());
        let mut invalid = reference(bytes);
        invalid.name = "../escape".into();
        assert!(write_chunk(directory.path(), &invalid, 0, &first, false).is_err());
        let fresh = reference(bytes);
        assert!(write_chunk(directory.path(), &fresh, 2, &first, false).is_err());
        assert!(write_chunk(directory.path(), &fresh, 0, "YQ", false).is_err());
    }

    #[test]
    fn host_cache_reserves_unwritten_uploads_and_requires_the_original_checksum() {
        let directory = tempfile::tempdir().unwrap();
        let mut wrong = reference(b"hello");
        wrong.sha256 = "0".repeat(64);
        assert!(
            write_chunk(
                directory.path(),
                &wrong,
                0,
                &STANDARD.encode(b"hello"),
                true
            )
            .is_err()
        );
        assert!(
            !directory
                .path()
                .join(&wrong.id)
                .join("file-metadata.json")
                .exists()
        );
        let mut accepted = 0;
        for _ in 0..33 {
            let mut receipt = reference(&[]);
            receipt.size_bytes = MAX_ATTACHMENT_BYTES;
            if write_chunk(directory.path(), &receipt, 0, "", false).is_ok() {
                accepted += 1;
            }
        }
        assert_eq!(
            accepted, 31,
            "Quota reserves declared bytes before chunks arrive"
        );
    }
}
