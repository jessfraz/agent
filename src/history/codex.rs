//! Read-only Codex app-server integration. Native IDs identify threads/items;
//! source files and the Codex state database are never parsed here.

use std::{
    collections::HashMap,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, SystemTime},
};

use anyhow::{Context, Result, bail, ensure};
use async_trait::async_trait;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::{
    fs,
    io::{AsyncBufReadExt, AsyncReadExt, AsyncSeekExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::Mutex,
    time::timeout,
};

use crate::{
    history::{
        HistoryAssetKind, HistoryAssetRef, HistoryGap, HistoryGapCode, HistoryItem, HistoryRequest,
        HistoryResponse, HistorySource, HistoryThread,
    },
    protocol::HistoryRole,
};

const PAGE_BYTES: usize = 500 * 1024;
const ITEM_BYTES: usize = 128 * 1024;
const NATIVE_BYTES: usize = 64 * 1024 * 1024;
const ASSET_BYTES: usize = 128 * 1024;
const SOURCES: &[&str] = &[
    "cli",
    "vscode",
    "exec",
    "appServer",
    "subAgent",
    "subAgentReview",
    "subAgentCompact",
    "subAgentThreadSpawn",
    "subAgentOther",
    "unknown",
];

pub struct CodexHistory {
    program: PathBuf,
    connection: Mutex<Option<Connection>>,
    assets: Mutex<HashMap<(String, String), Asset>>,
    cache: PathBuf,
    codex_home: Option<PathBuf>,
}

impl Default for CodexHistory {
    fn default() -> Self {
        Self::new()
    }
}

impl CodexHistory {
    pub fn new() -> Self {
        Self {
            program: "codex".into(),
            connection: Mutex::new(None),
            assets: Mutex::new(HashMap::new()),
            cache: dirs::cache_dir()
                .map(|path| path.join("agent/history/codex"))
                .unwrap_or_default(),
            codex_home: None,
        }
    }

    async fn rpc<P: Serialize, R: DeserializeOwned>(
        &self,
        method: &'static str,
        params: P,
    ) -> Result<R> {
        let mut slot = self.connection.lock().await;
        if slot.as_ref().is_none_or(|connection| !connection.reusable) {
            *slot = None;
            *slot = Some(Connection::open(&self.program, self.codex_home.as_deref()).await?);
        }
        let connection = slot
            .as_mut()
            .context("Codex history connection is unavailable")?;
        connection.call(method, params).await
    }

    async fn list(&self, archived: bool, cursor: Option<String>) -> Result<HistoryResponse> {
        let page: NativeList = self
            .rpc(
                "thread/list",
                ListParams {
                    archived,
                    cursor: cursor.clone(),
                    limit: 50,
                    sort_key: "created_at",
                    sort_direction: "asc",
                    source_kinds: SOURCES,
                },
            )
            .await?;
        ensure!(
            page.next_cursor
                .as_ref()
                .is_none_or(|next| !next.is_empty() && Some(next) != cursor.as_ref()),
            "Codex repeated a thread-list cursor"
        );
        let threads = page
            .data
            .into_iter()
            .map(|thread| thread.metadata(archived))
            .collect::<Result<Vec<_>>>()?;
        bounded(HistoryResponse::List {
            threads,
            next_cursor: page.next_cursor,
        })
    }

    async fn read(&self, thread_id: String, cursor: Option<String>) -> Result<HistoryResponse> {
        ensure!(!thread_id.is_empty(), "A Codex thread ID is required");
        let metadata: NativeRead = match self
            .rpc(
                "thread/read",
                ReadParams {
                    thread_id: &thread_id,
                    include_turns: false,
                },
            )
            .await
        {
            Ok(value) => value,
            Err(error) => {
                return Ok(gap_response(
                    thread_id,
                    String::new(),
                    classify(&error),
                    "Codex thread metadata could not be read",
                ));
            }
        };
        ensure!(
            metadata.thread.id == thread_id,
            "Codex returned another thread"
        );
        let hint = metadata.thread.metadata(false)?.version;
        let mut position = match cursor {
            Some(cursor) => serde_json::from_str::<ReadCursor>(&cursor)
                .context("Invalid Codex history cursor")?,
            None => ReadCursor {
                thread_id: thread_id.clone(),
                version: hint.clone(),
                mode: if metadata.thread.history_mode == "paginated" {
                    Mode::Items
                } else {
                    Mode::Turns
                },
                native: None,
                offset: 0,
                order: 0,
                page_hash: None,
                incomplete: false,
            },
        };
        ensure!(
            position.thread_id == thread_id,
            "Codex history cursor belongs to another thread"
        );
        let native = loop {
            match self.page(&thread_id, &position).await {
                Ok(page) => break page,
                Err(error)
                    if position.native.is_none()
                        && position.offset == 0
                        && unsupported(&error)
                        && !matches!(position.mode, Mode::Legacy) =>
                {
                    position.mode = match position.mode {
                        Mode::Items => Mode::Turns,
                        Mode::Turns | Mode::Legacy => Mode::Legacy,
                    };
                }
                Err(error) => {
                    return Ok(gap_response(
                        thread_id,
                        hint,
                        classify(&error),
                        "Codex history page could not be read",
                    ));
                }
            }
        };
        ensure!(
            native
                .next
                .as_ref()
                .is_none_or(|next| !next.is_empty() && Some(next) != position.native.as_ref()),
            "Codex repeated a history cursor"
        );
        if position.offset > native.items.len() {
            return Ok(gap_response(
                thread_id,
                hint,
                HistoryGapCode::Changed,
                "Codex history page shrank; reread from its first page",
            ));
        }
        // Validate only the consumed prefix. Appending to a live turn must not
        // force endless restarts; edits to already consumed evidence must.
        let prefix_hash = digest(&serde_json::to_vec(&native.items[..position.offset])?);
        if position
            .page_hash
            .as_ref()
            .is_some_and(|previous| previous != &prefix_hash)
        {
            return Ok(gap_response(
                thread_id,
                hint,
                HistoryGapCode::Changed,
                "Codex history page changed; reread from its first page",
            ));
        }
        let mut items = Vec::new();
        let mut gaps = Vec::new();
        let mut bytes = 2048;
        let mut consumed = position.offset;
        for entry in native.items.iter().skip(position.offset) {
            let (item, mut item_gaps) = self.normalize(&thread_id, entry, position.order).await?;
            let length = item
                .as_ref()
                .map(serde_json::to_vec)
                .transpose()?
                .map_or(0, |value| value.len())
                + serde_json::to_vec(&item_gaps)?.len();
            if bytes + length > PAGE_BYTES - 4096 && (!items.is_empty() || !gaps.is_empty()) {
                break;
            }
            ensure!(
                length < PAGE_BYTES - 4096,
                "A normalized Codex item exceeded the history page budget"
            );
            if let Some(item) = item {
                items.push(item);
            }
            gaps.append(&mut item_gaps);
            position.incomplete |= !gaps.is_empty();
            bytes += length;
            consumed += 1;
            position.order += 1;
        }
        let next_cursor = if consumed < native.items.len() {
            position.offset = consumed;
            position.page_hash = Some(digest(&serde_json::to_vec(&native.items[..consumed])?));
            Some(serde_json::to_string(&position)?)
        } else if let Some(next) = native.next {
            position.native = Some(next);
            position.offset = 0;
            position.page_hash = None;
            Some(serde_json::to_string(&position)?)
        } else {
            None
        };
        let complete = next_cursor.is_none() && !position.incomplete;
        bounded(HistoryResponse::Read {
            thread_id,
            // A later listing sees a stronger/newer hint and schedules another
            // reconciliation without discarding progress through this scan.
            version: position.version,
            items,
            next_cursor,
            gaps,
            complete,
        })
    }

    async fn page(&self, thread_id: &str, cursor: &ReadCursor) -> Result<NativePage> {
        match cursor.mode {
            Mode::Items => {
                let page: NativeItems = self
                    .rpc(
                        "thread/items/list",
                        ItemsParams {
                            thread_id,
                            cursor: cursor.native.as_deref(),
                            limit: 25,
                            sort_direction: "asc",
                        },
                    )
                    .await?;
                Ok(NativePage {
                    items: page.data,
                    next: page.next_cursor,
                })
            }
            Mode::Turns => {
                let page: NativeTurns = self
                    .rpc(
                        "thread/turns/list",
                        TurnsParams {
                            thread_id,
                            cursor: cursor.native.as_deref(),
                            limit: 1,
                            sort_direction: "asc",
                            items_view: "full",
                        },
                    )
                    .await?;
                ensure!(
                    page.data
                        .iter()
                        .all(|turn| turn.items_view.as_deref().is_none_or(|view| view == "full")),
                    "Codex returned summarized history instead of full items"
                );
                Ok(NativePage {
                    items: flatten(page.data),
                    next: page.next_cursor,
                })
            }
            Mode::Legacy => {
                let full: NativeRead = self
                    .rpc(
                        "thread/read",
                        ReadParams {
                            thread_id,
                            include_turns: true,
                        },
                    )
                    .await?;
                ensure!(full.thread.id == thread_id, "Codex returned another thread");
                ensure!(
                    full.thread
                        .turns
                        .iter()
                        .all(|turn| turn.items_view.as_deref().is_none_or(|view| view == "full")),
                    "Codex returned summarized history instead of full items"
                );
                Ok(NativePage {
                    items: flatten(full.thread.turns),
                    next: None,
                })
            }
        }
    }

    async fn normalize(
        &self,
        thread_id: &str,
        entry: &NativeEntry,
        order: u64,
    ) -> Result<(Option<HistoryItem>, Vec<HistoryGap>)> {
        let header: ItemHeader = match serde_json::from_value(entry.item.clone()) {
            Ok(header) => header,
            Err(_) => {
                return Ok((
                    None,
                    vec![gap(
                        HistoryGapCode::Invalid,
                        None,
                        "Native history item has no usable identity",
                    )],
                ));
            }
        };
        if matches!(
            header.kind.as_str(),
            "hookPrompt" | "contextCompaction" | "system" | "developer" | "authentication"
        ) {
            return Ok((None, vec![]));
        }
        let role = match header.kind.as_str() {
            "userMessage" => HistoryRole::User,
            "agentMessage" | "plan" | "enteredReviewMode" | "exitedReviewMode" => {
                HistoryRole::Assistant
            }
            "reasoning" => HistoryRole::Thinking,
            "functionCallOutput"
            | "commandExecution"
            | "fileChange"
            | "mcpToolCall"
            | "dynamicToolCall"
            | "collabAgentToolCall"
            | "subAgentActivity"
            | "webSearch"
            | "imageView"
            | "sleep"
            | "imageGeneration" => HistoryRole::Tool,
            _ => {
                return Ok((
                    None,
                    vec![gap(
                        HistoryGapCode::Unsupported,
                        Some(header.id),
                        "Native history item kind is not supported",
                    )],
                ));
            }
        };
        if header.id.is_empty() || entry.turn_id.is_empty() {
            return Ok((
                None,
                vec![gap(
                    HistoryGapCode::Invalid,
                    None,
                    "Native history item has no usable identity",
                )],
            ));
        }
        let mut data = entry.item.clone();
        if header.kind == "reasoning" {
            remove_encrypted(&mut data);
        }
        let version = digest(&serde_json::to_vec(&data)?);
        let mut gaps = Vec::new();
        let mut assets = Vec::new();
        for candidate in media(&data) {
            let expected_digest = data
                .get("inputImages")
                .and_then(Value::as_array)
                .and_then(|images| {
                    images.iter().find(|image| {
                        image.get("path").and_then(Value::as_str) == Some(candidate.as_str())
                    })
                })
                .and_then(|image| image.get("sha256"))
                .and_then(Value::as_str);
            match self
                .media_asset(thread_id, &header.id, &version, candidate)
                .await
            {
                Ok(asset)
                    if expected_digest
                        .is_some_and(|expected| asset.sha256.as_deref() != Some(expected)) =>
                {
                    self.assets
                        .lock()
                        .await
                        .remove(&(thread_id.to_owned(), asset.path));
                    gaps.push(gap(
                        HistoryGapCode::Changed,
                        Some(header.id.clone()),
                        "A media asset no longer matches its native source digest",
                    ));
                }
                Ok(asset) => assets.push(asset),
                Err(_) => gaps.push(gap(
                    HistoryGapCode::Missing,
                    Some(header.id.clone()),
                    "A referenced media asset is unavailable",
                )),
            }
        }
        let text = excerpt(&item_text(&data), 16 * 1024);
        let bytes = serde_json::to_vec(&data)?;
        if bytes.len() > ITEM_BYTES {
            let path = self.cold(&bytes).await?;
            let asset = self
                .register(
                    thread_id,
                    &header.id,
                    &version,
                    path,
                    HistoryAssetKind::ColdEvidence,
                    "application/json",
                )
                .await?;
            assets.push(asset);
            data = Value::Null;
        }
        let mut hash = Sha256::new();
        hash.update((bytes.len() as u64).to_le_bytes());
        hash.update(&bytes);
        hash.update(serde_json::to_vec(&(
            &entry.turn_id,
            entry.started_at_ms,
            entry.completed_at_ms,
            order,
            assets.iter().map(|asset| &asset.sha256).collect::<Vec<_>>(),
        ))?);
        let version = format!("{:x}", hash.finalize());
        for asset in &mut assets {
            asset.version = version.clone();
        }
        Ok((
            Some(HistoryItem {
                id: header.id,
                turn_id: entry.turn_id.clone(),
                kind: header.kind,
                role,
                text,
                version,
                order,
                timestamp_ms: entry.completed_at_ms.or(entry.started_at_ms),
                data,
                assets,
            }),
            gaps,
        ))
    }

    async fn cold(&self, bytes: &[u8]) -> Result<PathBuf> {
        ensure!(
            self.cache.is_absolute(),
            "Private history cache directory is unavailable"
        );
        fs::create_dir_all(&self.cache).await?;
        ensure!(
            !fs::symlink_metadata(&self.cache)
                .await?
                .file_type()
                .is_symlink(),
            "Private history cache cannot be a symlink"
        );
        fs::set_permissions(&self.cache, std::fs::Permissions::from_mode(0o700)).await?;
        let path = self.cache.join(digest(bytes));
        if fs::symlink_metadata(&path).await.is_ok() {
            let file = fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&path)
                .await?;
            let mut existing = Vec::new();
            file.take(bytes.len() as u64 + 1)
                .read_to_end(&mut existing)
                .await?;
            ensure!(
                digest(&existing) == digest(bytes),
                "Private history asset changed"
            );
            return Ok(path);
        }
        let temporary = TemporaryAsset(self.cache.join(format!(".{}.tmp", uuid::Uuid::new_v4())));
        let mut options = fs::OpenOptions::new();
        options
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW);
        let mut file = options.open(&temporary.0).await?;
        file.write_all(bytes).await?;
        file.sync_all().await?;
        fs::rename(&temporary.0, &path).await?;
        Ok(path)
    }

    async fn media_asset(
        &self,
        thread_id: &str,
        item_id: &str,
        version: &str,
        candidate: String,
    ) -> Result<HistoryAssetRef> {
        if let Some(data) = candidate.strip_prefix("data:") {
            let (kind, encoded) = data
                .split_once(";base64,")
                .context("Unsupported inline media encoding")?;
            let bytes = STANDARD.decode(encoded).context("Invalid inline media")?;
            let path = self.cold(&bytes).await?;
            return self
                .register(
                    thread_id,
                    item_id,
                    version,
                    path,
                    HistoryAssetKind::InlineMedia,
                    kind,
                )
                .await;
        }
        let path = candidate.strip_prefix("file://").unwrap_or(&candidate);
        ensure!(
            !path.contains("://"),
            "Remote media is not downloaded by history import"
        );
        let path = PathBuf::from(path);
        ensure!(path.is_absolute(), "Native media path is not absolute");
        let path = fs::canonicalize(path).await?;
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        ensure!(
            !matches!(
                name,
                "auth.json" | "config.toml" | "accounts.toml" | "AGENTS.md" | "SKILL.md"
            ) && !name.starts_with(".env"),
            "Authentication and instruction files are not history assets"
        );
        self.register(
            thread_id,
            item_id,
            version,
            path,
            HistoryAssetKind::LocalMedia,
            "application/octet-stream",
        )
        .await
    }

    async fn register(
        &self,
        thread_id: &str,
        item_id: &str,
        version: &str,
        path: PathBuf,
        kind: HistoryAssetKind,
        media_type: &str,
    ) -> Result<HistoryAssetRef> {
        let path = fs::canonicalize(path).await?;
        let metadata = fs::metadata(&path).await?;
        ensure!(metadata.is_file(), "History asset is not a regular file");
        let mut file = fs::File::open(&path).await?;
        let mut hash = Sha256::new();
        let mut buffer = [0; 64 * 1024];
        loop {
            let n = file.read(&mut buffer).await?;
            if n == 0 {
                break;
            }
            hash.update(&buffer[..n]);
        }
        let current = file.metadata().await?;
        ensure!(
            current.len() == metadata.len() && current.modified()? == metadata.modified()?,
            "History asset changed while its digest was read"
        );
        let sha256 = format!("{:x}", hash.finalize());
        let locator = path
            .to_str()
            .context("History asset path is not UTF-8")?
            .to_owned();
        self.assets.lock().await.insert(
            (thread_id.to_owned(), locator.clone()),
            Asset {
                path,
                size: metadata.len(),
                modified: metadata.modified()?,
                sha256: sha256.clone(),
            },
        );
        Ok(HistoryAssetRef {
            path: locator,
            item_id: item_id.into(),
            version: version.into(),
            kind,
            media_type: media_type.into(),
            sha256: Some(sha256),
            size: Some(metadata.len()),
        })
    }

    async fn asset(&self, thread_id: String, path: String, offset: u64) -> Result<HistoryResponse> {
        let key = (thread_id.clone(), path.clone());
        if !self.assets.lock().await.contains_key(&key) {
            // Reauthorize from native item references after an adapter restart.
            let mut cursor = None;
            loop {
                let response = self.read(thread_id.clone(), cursor).await?;
                if self.assets.lock().await.contains_key(&key) {
                    break;
                }
                let HistoryResponse::Read { next_cursor, .. } = response else {
                    bail!("Invalid native history response")
                };
                match next_cursor {
                    Some(next) => cursor = Some(next),
                    None => bail!("Asset is not referenced by this Codex thread"),
                }
            }
        }
        let mut assets = self.assets.lock().await;
        let asset = assets
            .get_mut(&key)
            .context("History asset is not authorized")?;
        let mut file = fs::File::open(&asset.path).await?;
        let metadata = file.metadata().await?;
        ensure!(
            metadata.len() == asset.size && metadata.modified()? == asset.modified,
            "History asset changed during import"
        );
        ensure!(
            offset <= asset.size,
            "History asset offset exceeds its size"
        );
        file.seek(std::io::SeekFrom::Start(offset)).await?;
        let mut bytes = Vec::new();
        (&mut file)
            .take(ASSET_BYTES as u64)
            .read_to_end(&mut bytes)
            .await?;
        let current = file.metadata().await?;
        ensure!(
            current.len() == asset.size && current.modified()? == asset.modified,
            "History asset changed while its chunk was read"
        );
        let next = offset
            .checked_add(bytes.len() as u64)
            .context("History asset offset overflow")?;
        bounded(HistoryResponse::Asset {
            path,
            offset,
            data_base64: STANDARD.encode(bytes),
            next_offset: (next < asset.size).then_some(next),
            total_bytes: asset.size,
            sha256: asset.sha256.clone(),
        })
    }
}

#[async_trait]
impl HistorySource for CodexHistory {
    async fn request(&self, request: HistoryRequest) -> Result<HistoryResponse> {
        match request {
            HistoryRequest::List { archived, cursor } => self.list(archived, cursor).await,
            HistoryRequest::Read { thread_id, cursor } => self.read(thread_id, cursor).await,
            HistoryRequest::Asset {
                thread_id,
                path,
                offset,
            } => self.asset(thread_id, path, offset).await,
        }
    }
}

#[derive(Clone)]
struct Asset {
    path: PathBuf,
    size: u64,
    modified: SystemTime,
    sha256: String,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Mode {
    Items,
    Turns,
    Legacy,
}
#[derive(Deserialize, Serialize)]
struct ReadCursor {
    thread_id: String,
    version: String,
    mode: Mode,
    native: Option<String>,
    offset: usize,
    order: u64,
    page_hash: Option<String>,
    #[serde(default)]
    incomplete: bool,
}
struct TemporaryAsset(PathBuf);
impl Drop for TemporaryAsset {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeThread {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    preview: String,
    cwd: String,
    created_at: i64,
    updated_at: i64,
    #[serde(default)]
    path: Option<PathBuf>,
    #[serde(default)]
    forked_from_id: Option<String>,
    #[serde(default)]
    parent_thread_id: Option<String>,
    #[serde(default)]
    history_mode: String,
    #[serde(default)]
    turns: Vec<NativeTurn>,
}
impl NativeThread {
    fn metadata(&self, archived: bool) -> Result<HistoryThread> {
        ensure!(!self.id.is_empty(), "Codex returned an empty thread ID");
        let title = self
            .name
            .clone()
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| self.preview.clone());
        let fingerprint = self
            .path
            .as_ref()
            .and_then(|path| std::fs::metadata(path).ok())
            .and_then(|metadata| {
                metadata
                    .modified()
                    .ok()
                    .and_then(|modified| modified.duration_since(SystemTime::UNIX_EPOCH).ok())
                    .map(|modified| (metadata.len(), modified.as_secs(), modified.subsec_nanos()))
            });
        let version = digest(&serde_json::to_vec(&(
            &self.id,
            &title,
            &self.cwd,
            self.updated_at,
            &self.forked_from_id,
            &self.parent_thread_id,
            &self.path,
            fingerprint,
        ))?);
        Ok(HistoryThread {
            id: self.id.clone(),
            title,
            cwd: self.cwd.clone(),
            created_at: self.created_at,
            updated_at: self.updated_at,
            forked_from_id: self.forked_from_id.clone(),
            parent_thread_id: self.parent_thread_id.clone(),
            version,
            version_reliable: fingerprint.is_some(),
            archived,
        })
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeList {
    data: Vec<NativeThread>,
    next_cursor: Option<String>,
}
#[derive(Deserialize)]
struct NativeRead {
    thread: NativeThread,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeTurn {
    id: String,
    items: Vec<Value>,
    #[serde(default)]
    items_view: Option<String>,
    #[serde(default)]
    started_at: Option<i64>,
    #[serde(default)]
    completed_at: Option<i64>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeEntry {
    turn_id: String,
    item: Value,
    #[serde(default)]
    started_at_ms: Option<i64>,
    #[serde(default)]
    completed_at_ms: Option<i64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeItems {
    data: Vec<NativeEntry>,
    next_cursor: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeTurns {
    data: Vec<NativeTurn>,
    next_cursor: Option<String>,
}
struct NativePage {
    items: Vec<NativeEntry>,
    next: Option<String>,
}
#[derive(Deserialize)]
struct ItemHeader {
    id: String,
    #[serde(rename = "type")]
    kind: String,
}
fn flatten(turns: Vec<NativeTurn>) -> Vec<NativeEntry> {
    turns
        .into_iter()
        .flat_map(|turn| {
            turn.items.into_iter().map(move |item| NativeEntry {
                turn_id: turn.id.clone(),
                item,
                started_at_ms: turn.started_at.and_then(|value| value.checked_mul(1000)),
                completed_at_ms: turn.completed_at.and_then(|value| value.checked_mul(1000)),
            })
        })
        .collect()
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn excerpt(text: &str, maximum: usize) -> String {
    let end = text
        .char_indices()
        .map(|(index, _)| index)
        .take_while(|index| *index <= maximum)
        .last()
        .unwrap_or(0);
    if text.len() <= maximum {
        text.into()
    } else {
        text[..end].into()
    }
}
fn bounded(response: HistoryResponse) -> Result<HistoryResponse> {
    ensure!(
        serde_json::to_vec(&response)?.len() <= PAGE_BYTES,
        "History response exceeded its transport budget"
    );
    Ok(response)
}
fn gap(code: HistoryGapCode, item_id: Option<String>, message: &str) -> HistoryGap {
    HistoryGap {
        code,
        item_id,
        message: message.into(),
    }
}
fn gap_response(
    thread_id: String,
    version: String,
    code: HistoryGapCode,
    message: &str,
) -> HistoryResponse {
    HistoryResponse::Read {
        thread_id,
        version,
        items: vec![],
        next_cursor: None,
        gaps: vec![gap(code, None, message)],
        complete: false,
    }
}
fn remove_encrypted(value: &mut Value) {
    match value {
        Value::Object(object) => {
            for key in [
                "encrypted_content",
                "encryptedContent",
                "encryptedReasoning",
            ] {
                object.remove(key);
            }
            for value in object.values_mut() {
                remove_encrypted(value);
            }
        }
        Value::Array(values) => {
            for value in values {
                remove_encrypted(value);
            }
        }
        _ => {}
    }
}
fn item_text(value: &Value) -> String {
    let mut text = Vec::new();
    for key in ["text", "command", "aggregatedOutput", "review"] {
        if let Some(value) = value.get(key).and_then(Value::as_str) {
            text.push(value.to_owned());
        }
    }
    for key in ["summary", "content", "contentItems"] {
        if let Some(values) = value.get(key).and_then(Value::as_array) {
            for value in values {
                if let Some(value) = value
                    .as_str()
                    .or_else(|| value.get("text").and_then(Value::as_str))
                {
                    text.push(value.into());
                }
            }
        }
    }
    if text.is_empty() {
        for key in ["output", "result", "arguments"] {
            if let Some(value) = value.get(key) {
                text.push(
                    value
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| value.to_string()),
                );
            }
        }
    }
    text.join("\n")
}
fn media(value: &Value) -> Vec<String> {
    let mut paths = Vec::new();
    let kind = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if kind == "imageView"
        && let Some(path) = value.get("path").and_then(Value::as_str)
    {
        paths.push(path.into());
    }
    if kind == "imageGeneration" {
        if let Some(path) = value.get("savedPath").and_then(Value::as_str) {
            paths.push(path.into());
        }
        if let Some(data) = value
            .get("result")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            paths.push(format!("data:image/png;base64,{data}"));
        }
        if let Some(images) = value.get("inputImages").and_then(Value::as_array) {
            for image in images {
                if let Some(path) = image.get("path").and_then(Value::as_str) {
                    paths.push(path.into());
                }
            }
        }
    }
    if value.get("fileId").is_some() {
        paths.push("unavailable-native-file-id".into());
    }
    for key in ["content", "contentItems"] {
        if let Some(values) = value.get(key).and_then(Value::as_array) {
            for value in values {
                let kind = value
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let field = match kind {
                    "localImage" | "localAudio" => Some("path"),
                    "image" | "audio" => Some("url"),
                    "inputImage" => Some("imageUrl"),
                    "inputAudio" => Some("audioUrl"),
                    _ => None,
                };
                if let Some(path) = field.and_then(|key| value.get(key)).and_then(Value::as_str) {
                    paths.push(path.into());
                } else if value.get("fileId").is_some() {
                    paths.push("unavailable-native-file-id".into());
                }
            }
        }
    }
    if let Some(blocks) = value
        .get("result")
        .and_then(|result| result.get("content"))
        .and_then(Value::as_array)
    {
        media_blocks(blocks, &mut paths);
    }
    if let Some(blocks) = value.get("output").and_then(Value::as_array) {
        media_blocks(blocks, &mut paths);
    }
    paths
}
fn media_blocks(blocks: &[Value], paths: &mut Vec<String>) {
    for block in blocks {
        let kind = block
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match kind {
            "image" | "audio" => {
                if let (Some(data), Some(mime)) = (
                    block.get("data").and_then(Value::as_str),
                    block.get("mimeType").and_then(Value::as_str),
                ) {
                    paths.push(format!("data:{mime};base64,{data}"));
                }
            }
            "input_image" | "input_audio" => {
                if let Some(path) = block
                    .get("image_url")
                    .or_else(|| block.get("audio_url"))
                    .and_then(Value::as_str)
                {
                    paths.push(path.into());
                }
            }
            "resource_link" => {
                if let Some(path) = block.get("uri").and_then(Value::as_str) {
                    paths.push(path.into());
                }
            }
            "resource" => {
                if let Some(resource) = block.get("resource")
                    && let (Some(data), Some(mime)) = (
                        resource.get("blob").and_then(Value::as_str),
                        resource.get("mimeType").and_then(Value::as_str),
                    )
                {
                    paths.push(format!("data:{mime};base64,{data}"));
                }
            }
            _ => {}
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ListParams {
    archived: bool,
    cursor: Option<String>,
    limit: u32,
    sort_key: &'static str,
    sort_direction: &'static str,
    source_kinds: &'static [&'static str],
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadParams<'a> {
    thread_id: &'a str,
    include_turns: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ItemsParams<'a> {
    thread_id: &'a str,
    cursor: Option<&'a str>,
    limit: u32,
    sort_direction: &'static str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TurnsParams<'a> {
    thread_id: &'a str,
    cursor: Option<&'a str>,
    limit: u32,
    sort_direction: &'static str,
    items_view: &'static str,
}

struct Connection {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    next_id: u64,
    reusable: bool,
}
impl Drop for Connection {
    fn drop(&mut self) {
        if let Some(pid) = self.child.id().and_then(|pid| i32::try_from(pid).ok()) {
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
    }
}
#[derive(Serialize)]
struct RpcRequest<P> {
    id: u64,
    method: &'static str,
    params: P,
}
#[derive(Deserialize)]
struct RpcEnvelope {
    id: Option<Value>,
    result: Option<Value>,
    error: Option<RpcError>,
    method: Option<String>,
}
#[derive(Debug, Deserialize)]
struct RpcError {
    code: i64,
    message: String,
}
impl std::fmt::Display for RpcError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(out, "Codex history request failed ({})", self.code)
    }
}
impl std::error::Error for RpcError {}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Initialize {
    client_info: ClientInfo,
    capabilities: Capabilities,
}
#[derive(Serialize)]
struct ClientInfo {
    name: &'static str,
    title: &'static str,
    version: &'static str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Capabilities {
    experimental_api: bool,
    explicit_gateway_oauth: bool,
}
#[derive(Serialize)]
struct Initialized {
    method: &'static str,
}

impl Connection {
    async fn open(program: &Path, home: Option<&Path>) -> Result<Self> {
        let mut command = Command::new(program);
        command
            .args(["app-server", "--listen", "stdio://"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .process_group(0)
            .kill_on_drop(true);
        if let Some(home) = home {
            command.env("CODEX_HOME", home);
        }
        let mut child = command
            .spawn()
            .context("Could not start the installed Codex history reader")?;
        let input = child
            .stdin
            .take()
            .context("Codex history input is unavailable")?;
        let output = BufReader::new(
            child
                .stdout
                .take()
                .context("Codex history output is unavailable")?,
        );
        let mut connection = Self {
            child,
            input,
            output,
            next_id: 1,
            reusable: true,
        };
        let _: Value = connection
            .call(
                "initialize",
                Initialize {
                    client_info: ClientInfo {
                        name: "agent_history",
                        title: "Agent history reader",
                        version: env!("CARGO_PKG_VERSION"),
                    },
                    capabilities: Capabilities {
                        experimental_api: true,
                        explicit_gateway_oauth: true,
                    },
                },
            )
            .await?;
        connection
            .write(&Initialized {
                method: "initialized",
            })
            .await?;
        Ok(connection)
    }
    async fn write(&mut self, value: &impl Serialize) -> Result<()> {
        let mut bytes = serde_json::to_vec(value)?;
        bytes.push(b'\n');
        self.input.write_all(&bytes).await?;
        self.input.flush().await?;
        Ok(())
    }
    async fn call<P: Serialize, R: DeserializeOwned>(
        &mut self,
        method: &'static str,
        params: P,
    ) -> Result<R> {
        let id = self.next_id;
        self.next_id = self
            .next_id
            .checked_add(1)
            .context("Codex request IDs exhausted")?;
        self.reusable = false;
        self.write(&RpcRequest { id, method, params }).await?;
        timeout(Duration::from_secs(900), async {
            loop {
                let mut bytes = Vec::new();
                loop {
                    let available = self.output.fill_buf().await?;
                    ensure!(!available.is_empty(), "Codex history connection closed");
                    let length = available
                        .iter()
                        .position(|byte| *byte == b'\n')
                        .map_or(available.len(), |n| n + 1);
                    ensure!(
                        bytes.len() + length <= NATIVE_BYTES,
                        "Codex native history response exceeded its bounded reader"
                    );
                    bytes.extend_from_slice(&available[..length]);
                    self.output.consume(length);
                    if bytes.last() == Some(&b'\n') {
                        break;
                    }
                }
                let envelope: RpcEnvelope =
                    serde_json::from_slice(&bytes).context("Invalid Codex history RPC response")?;
                if envelope.method.is_some() {
                    ensure!(
                        envelope.id.is_none(),
                        "Codex history unexpectedly requested an interactive action"
                    );
                    continue;
                }
                if envelope.id.as_ref().and_then(Value::as_u64) != Some(id) {
                    continue;
                }
                self.reusable = true;
                if let Some(error) = envelope.error {
                    return Err(anyhow::Error::new(error));
                }
                return serde_json::from_value(
                    envelope
                        .result
                        .context("Codex history response has no result")?,
                )
                .context("Codex history response shape is unsupported");
            }
        })
        .await
        .context("Codex history read exceeded its command deadline")?
    }
}
fn unsupported(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<RpcError>()
        .is_some_and(|error| error.code == -32601)
}
fn classify(error: &anyhow::Error) -> HistoryGapCode {
    if unsupported(error) {
        HistoryGapCode::Unsupported
    } else if error.downcast_ref::<RpcError>().is_some_and(|error| {
        error.message.contains("no rollout") || error.message.contains("not found")
    }) {
        HistoryGapCode::Missing
    } else if error.to_string().contains("bounded reader") {
        HistoryGapCode::Oversized
    } else {
        HistoryGapCode::Unavailable
    }
}

#[cfg(test)]
mod tests {
    use std::{
        os::unix::fs::PermissionsExt,
        path::{Path, PathBuf},
        sync::Arc,
        time::Duration,
    };

    use base64::{Engine, engine::general_purpose::STANDARD};
    use serde::Deserialize;
    use serde_json::Value;

    use crate::{
        history::{
            HistoryGapCode, HistoryRequest, HistoryResponse, HistorySource,
            codex::{CodexHistory, NativeEntry, NativeThread, PAGE_BYTES, digest},
        },
        protocol::HistoryRole,
    };

    const THREAD: &str = r#"{"id":"thread-a","sessionId":"shared-root","name":"Shipping fix","preview":"Saved request","cwd":"/","createdAt":1,"updatedAt":2,"forkedFromId":"fork-parent","parentThreadId":"worker-parent","historyMode":"legacy","turns":[]}"#;

    fn history(directory: &Path, program: PathBuf) -> CodexHistory {
        let mut source = CodexHistory::new();
        source.program = program;
        source.cache = directory.join("private-cache");
        source
    }

    fn fixture(directory: &Path, native: &Value) -> CodexHistory {
        std::fs::write(
            directory.join("native.json"),
            serde_json::to_vec(native).unwrap(),
        )
        .unwrap();
        let node = std::process::Command::new("node")
            .args(["--print", "process.execPath"])
            .output()
            .unwrap();
        assert!(node.status.success());
        let node = String::from_utf8(node.stdout).unwrap();
        let program = directory.join("codex-fixture");
        std::fs::write(&program, format!("#!{}\n{}", node.trim(), r#"
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const dir=path.dirname(process.argv[1]);
const send=(id,result)=>process.stdout.write(JSON.stringify({id,result})+'\n');
const fail=(id,code,message)=>process.stdout.write(JSON.stringify({id,error:{code,message}})+'\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
  const r=JSON.parse(line),p=r.params||{};
  const data=JSON.parse(fs.readFileSync(path.join(dir,'native.json')));
  fs.appendFileSync(path.join(dir,'calls'),JSON.stringify({method:r.method,pid:process.pid})+'\n');
  if(r.method==='initialized') return;
  process.stdout.write(JSON.stringify({method:'history/fixture',params:{}})+'\n');
  if(r.method==='initialize') return send(r.id,{codexHome:dir});
  if(r.method==='thread/list') {
    if(p.sourceKinds.length!==10||!p.sourceKinds.includes('subAgentThreadSpawn')||p.sortKey!=='created_at')return fail(r.id,-32602,'incomplete enumeration');
    const done=()=>send(r.id,{data:data.threads,nextCursor:null});
    if(fs.existsSync(path.join(dir,'block')))setTimeout(done,2000);else done();return;
  }
  if(r.method==='thread/read') {
    const t=data.threads.find(t=>t.id===p.threadId);
    if(!t)return fail(r.id,-32600,'no rollout found');
    return send(r.id,{thread:{...t,turns:p.includeTurns?data.turns:[]}});
  }
  if(r.method==='thread/turns/list') {
    if(data.unsupportedTurns)return fail(r.id,-32601,'unsupported');
    if(p.itemsView!=='full'||p.sortDirection!=='asc')return fail(r.id,-32602,'summary would lose evidence');
    return send(r.id,{data:data.turns,nextCursor:null});
  }
  return fail(r.id,-32601,'unknown method');
});
"#)).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        history(directory, program)
    }

    fn provider_fixture(items: Vec<Value>) -> Value {
        #[derive(serde::Serialize)]
        struct Turn {
            id: &'static str,
            items: Vec<Value>,
            #[serde(rename = "itemsView")]
            items_view: &'static str,
        }
        #[derive(serde::Serialize)]
        struct Native {
            threads: Vec<Value>,
            turns: Vec<Turn>,
        }
        serde_json::to_value(Native {
            threads: vec![serde_json::from_str(THREAD).unwrap()],
            turns: vec![Turn {
                id: "turn-a",
                items,
                items_view: "full",
            }],
        })
        .unwrap()
    }

    #[tokio::test]
    async fn native_item_shapes_preserve_identity_roles_versions_and_inert_evidence() {
        let directory = tempfile::tempdir().unwrap();
        let source = history(directory.path(), "unavailable-codex-fixture".into());
        let native: NativeThread = serde_json::from_str(THREAD).unwrap();
        let metadata = native.metadata(true).unwrap();
        assert!(!metadata.version_reliable);
        assert_eq!(metadata.id, "thread-a");
        assert_eq!(metadata.forked_from_id.as_deref(), Some("fork-parent"));
        assert_eq!(metadata.parent_thread_id.as_deref(), Some("worker-parent"));
        assert!(metadata.archived);
        for (raw, expected) in [
            (
                r#"{"id":"user-a","type":"userMessage","content":[{"type":"text","text":"Check the package"}]}"#,
                HistoryRole::User,
            ),
            (
                r#"{"id":"assistant-a","type":"agentMessage","text":"The package is ready"}"#,
                HistoryRole::Assistant,
            ),
            (
                r#"{"id":"tool-a","type":"commandExecution","command":"inspect package","aggregatedOutput":"verified","exitCode":0}"#,
                HistoryRole::Tool,
            ),
            (
                r#"{"id":"reason-a","type":"reasoning","summary":["Check the evidence"],"encryptedContent":"excluded-state"}"#,
                HistoryRole::Thinking,
            ),
        ] {
            let entry = NativeEntry {
                turn_id: "turn-a".into(),
                item: serde_json::from_str(raw).unwrap(),
                started_at_ms: Some(1000),
                completed_at_ms: Some(2000),
            };
            let (item, gaps) = source.normalize("thread-a", &entry, 7).await.unwrap();
            assert!(gaps.is_empty());
            let item = item.unwrap();
            assert_eq!(
                std::mem::discriminant(&item.role),
                std::mem::discriminant(&expected)
            );
            assert_eq!(item.order, 7);
            assert_eq!(item.timestamp_ms, Some(2000));
            assert!(
                !serde_json::to_string(&item)
                    .unwrap()
                    .contains("excluded-state")
            );
            let (replayed, _) = source.normalize("thread-a", &entry, 7).await.unwrap();
            assert_eq!(item.version, replayed.unwrap().version);
        }
        let excluded = NativeEntry {
            turn_id: "turn-a".into(),
            item: serde_json::from_str(
                r#"{"id":"hook-a","type":"hookPrompt","fragments":[{"text":"Old instructions"}]}"#,
            )
            .unwrap(),
            started_at_ms: None,
            completed_at_ms: None,
        };
        assert!(
            source
                .normalize("thread-a", &excluded, 0)
                .await
                .unwrap()
                .0
                .is_none()
        );
    }

    #[tokio::test]
    async fn large_native_evidence_is_private_chunked_and_authorized_to_its_thread() {
        #[derive(serde::Serialize)]
        struct Tool {
            id: &'static str,
            #[serde(rename = "type")]
            kind: &'static str,
            command: &'static str,
            #[serde(rename = "aggregatedOutput")]
            output: String,
        }
        let directory = tempfile::tempdir().unwrap();
        let source = history(directory.path(), "unavailable-codex-fixture".into());
        let data = serde_json::to_value(Tool {
            id: "tool-a",
            kind: "commandExecution",
            command: "inspect package",
            output: "evidence ".repeat(50000),
        })
        .unwrap();
        let entry = NativeEntry {
            turn_id: "turn-a".into(),
            item: data.clone(),
            started_at_ms: None,
            completed_at_ms: None,
        };
        let (item, gaps) = source.normalize("thread-a", &entry, 0).await.unwrap();
        assert!(gaps.is_empty());
        let item = item.unwrap();
        assert!(item.data.is_null());
        assert!(item.text.len() <= 16384);
        let path = item.assets[0].path.clone();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let mut all = Vec::new();
        let mut offset = 0;
        loop {
            let response = source
                .request(HistoryRequest::Asset {
                    thread_id: "thread-a".into(),
                    path: path.clone(),
                    offset,
                })
                .await
                .unwrap();
            assert!(serde_json::to_vec(&response).unwrap().len() <= PAGE_BYTES);
            let HistoryResponse::Asset {
                data_base64,
                next_offset,
                sha256,
                ..
            } = response
            else {
                panic!("Expected asset")
            };
            all.extend(STANDARD.decode(data_base64).unwrap());
            assert_eq!(sha256, digest(&serde_json::to_vec(&data).unwrap()));
            match next_offset {
                Some(next) => offset = next,
                None => break,
            }
        }
        assert_eq!(serde_json::from_slice::<Value>(&all).unwrap(), data);
        assert!(
            source
                .request(HistoryRequest::Asset {
                    thread_id: "another-thread".into(),
                    path,
                    offset: 0
                })
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn native_rpc_pages_reuse_one_child_and_replay_bounded_offsets_without_loss() {
        #[derive(serde::Serialize)]
        struct Message {
            id: String,
            #[serde(rename = "type")]
            kind: &'static str,
            text: String,
        }
        let directory = tempfile::tempdir().unwrap();
        let items = (0..80)
            .map(|n| {
                serde_json::to_value(Message {
                    id: format!("message-{n}"),
                    kind: "agentMessage",
                    text: "Evidence ".repeat(1200),
                })
                .unwrap()
            })
            .collect();
        let source = fixture(directory.path(), &provider_fixture(items));
        let HistoryResponse::List { threads, .. } = source
            .request(HistoryRequest::List {
                archived: true,
                cursor: None,
            })
            .await
            .unwrap()
        else {
            panic!("Expected listing")
        };
        assert_eq!(threads[0].id, "thread-a");
        assert!(threads[0].archived);
        let mut cursor = None;
        let mut ids = Vec::new();
        let mut pages = 0;
        loop {
            let response = source
                .request(HistoryRequest::Read {
                    thread_id: "thread-a".into(),
                    cursor,
                })
                .await
                .unwrap();
            assert!(serde_json::to_vec(&response).unwrap().len() <= PAGE_BYTES);
            let HistoryResponse::Read {
                items,
                next_cursor,
                gaps,
                complete,
                ..
            } = response
            else {
                panic!("Expected history")
            };
            assert!(gaps.is_empty());
            ids.extend(items.into_iter().map(|item| item.id));
            pages += 1;
            match next_cursor {
                Some(next) => {
                    assert!(!complete);
                    cursor = Some(next)
                }
                None => {
                    assert!(complete);
                    break;
                }
            }
        }
        assert!(pages > 1);
        assert_eq!(
            ids,
            (0..80).map(|n| format!("message-{n}")).collect::<Vec<_>>()
        );
        #[derive(Deserialize)]
        struct Call {
            pid: u32,
        }
        let calls = std::fs::read_to_string(directory.path().join("calls"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Call>(line).unwrap().pid)
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(calls.len(), 1);
        let missing = source
            .request(HistoryRequest::Read {
                thread_id: "missing".into(),
                cursor: None,
            })
            .await
            .unwrap();
        assert!(
            matches!(missing,HistoryResponse::Read{complete:false,gaps,..} if matches!(gaps[0].code,HistoryGapCode::Missing))
        );
    }

    #[tokio::test]
    async fn cancelled_rpc_discards_the_partial_stream_before_reconnecting() {
        let directory = tempfile::tempdir().unwrap();
        let source = Arc::new(fixture(directory.path(), &provider_fixture(vec![])));
        std::fs::write(directory.path().join("block"), b"block").unwrap();
        let task = {
            let source = Arc::clone(&source);
            tokio::spawn(async move {
                source
                    .request(HistoryRequest::List {
                        archived: false,
                        cursor: None,
                    })
                    .await
            })
        };
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if std::fs::read_to_string(directory.path().join("calls"))
                    .is_ok_and(|calls| calls.contains("thread/list"))
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        std::fs::remove_file(directory.path().join("block")).unwrap();
        source
            .request(HistoryRequest::List {
                archived: false,
                cursor: None,
            })
            .await
            .unwrap();
        #[derive(Deserialize)]
        struct Call {
            pid: u32,
        }
        let pids = std::fs::read_to_string(directory.path().join("calls"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Call>(line).unwrap().pid)
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(pids.len(), 2);
    }

    #[tokio::test]
    async fn missing_native_media_and_unknown_items_remain_explicit_gaps() {
        let directory = tempfile::tempdir().unwrap();
        let source = history(directory.path(), "unavailable-codex-fixture".into());
        for raw in [
            r#"{"id":"image-a","type":"userMessage","content":[{"type":"image","fileId":"native-file"}]}"#,
            r#"{"id":"future-a","type":"futureNativeItem"}"#,
        ] {
            let entry = NativeEntry {
                turn_id: "turn-a".into(),
                item: serde_json::from_str(raw).unwrap(),
                started_at_ms: None,
                completed_at_ms: None,
            };
            let (_, gaps) = source.normalize("thread-a", &entry, 0).await.unwrap();
            assert_eq!(gaps.len(), 1);
        }
    }

    #[tokio::test]
    async fn media_aliases_cannot_read_authentication_files_and_changed_assets_are_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let source = history(directory.path(), "unavailable-codex-fixture".into());
        let auth = directory.path().join("auth.json");
        std::fs::write(&auth, b"synthetic private state").unwrap();
        let alias = directory.path().join("image.png");
        std::os::unix::fs::symlink(&auth, &alias).unwrap();
        assert!(
            source
                .media_asset(
                    "thread-a",
                    "image-a",
                    "revision-a",
                    alias.to_str().unwrap().into()
                )
                .await
                .is_err()
        );
        assert!(source.assets.lock().await.is_empty());
        let path = source.cold(b"original evidence").await.unwrap();
        let asset = source
            .register(
                "thread-a",
                "tool-a",
                "revision-a",
                path.clone(),
                crate::history::HistoryAssetKind::ColdEvidence,
                "application/json",
            )
            .await
            .unwrap();
        std::fs::write(path, b"changed").unwrap();
        assert!(
            source
                .asset("thread-a".into(), asset.path, 0)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn an_earlier_page_gap_cannot_become_a_complete_terminal_page() {
        #[derive(serde::Serialize)]
        struct Message {
            id: String,
            #[serde(rename = "type")]
            kind: &'static str,
            text: String,
        }
        let mut items = vec![
            serde_json::from_str(r#"{"id":"future-a","type":"unsupportedFutureItem"}"#).unwrap(),
        ];
        items.extend((0..60).map(|n| {
            serde_json::to_value(Message {
                id: format!("message-{n}"),
                kind: "agentMessage",
                text: "Evidence ".repeat(1200),
            })
            .unwrap()
        }));
        let directory = tempfile::tempdir().unwrap();
        let source = fixture(directory.path(), &provider_fixture(items));
        let mut cursor = None;
        let mut count = 0;
        let mut total_gaps = 0;
        loop {
            let HistoryResponse::Read {
                items,
                next_cursor,
                gaps,
                complete,
                ..
            } = source.read("thread-a".into(), cursor).await.unwrap()
            else {
                panic!("Expected history")
            };
            count += items.len();
            total_gaps += gaps.len();
            assert!(!complete);
            match next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        assert_eq!(count, 60);
        assert_eq!(total_gaps, 1);
    }

    #[tokio::test]
    async fn native_locator_detects_same_second_changes_and_live_append_preserves_prefix_progress()
    {
        #[derive(serde::Serialize)]
        struct Message {
            id: String,
            #[serde(rename = "type")]
            kind: &'static str,
            text: String,
        }
        let directory = tempfile::tempdir().unwrap();
        let locator = directory.path().join("native-locator");
        std::fs::write(&locator, b"first native state").unwrap();
        let mut native = provider_fixture(
            (0..60)
                .map(|n| {
                    serde_json::to_value(Message {
                        id: format!("message-{n}"),
                        kind: "agentMessage",
                        text: "Evidence ".repeat(1200),
                    })
                    .unwrap()
                })
                .collect(),
        );
        native
            .get_mut("threads")
            .unwrap()
            .as_array_mut()
            .unwrap()
            .first_mut()
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert(
                "path".into(),
                Value::String(locator.to_str().unwrap().into()),
            );
        let source = fixture(directory.path(), &native);
        let HistoryResponse::List { threads, .. } = source.list(false, None).await.unwrap() else {
            panic!("Expected listing")
        };
        let first_hint = threads[0].version.clone();
        assert!(threads[0].version_reliable);
        let HistoryResponse::Read {
            items, next_cursor, ..
        } = source.read("thread-a".into(), None).await.unwrap()
        else {
            panic!("Expected history")
        };
        let mut ids = items.into_iter().map(|item| item.id).collect::<Vec<_>>();
        assert!(next_cursor.is_some());
        let appended = serde_json::to_value(Message {
            id: "message-60".into(),
            kind: "agentMessage",
            text: "New evidence".into(),
        })
        .unwrap();
        native
            .get_mut("turns")
            .unwrap()
            .as_array_mut()
            .unwrap()
            .first_mut()
            .unwrap()
            .get_mut("items")
            .unwrap()
            .as_array_mut()
            .unwrap()
            .push(appended);
        std::fs::write(
            &locator,
            b"a longer native state in the same timestamp second",
        )
        .unwrap();
        std::fs::write(
            directory.path().join("native.json"),
            serde_json::to_vec(&native).unwrap(),
        )
        .unwrap();
        let HistoryResponse::List { threads, .. } = source.list(false, None).await.unwrap() else {
            panic!("Expected listing")
        };
        assert_eq!(threads[0].updated_at, 2);
        assert!(threads[0].version_reliable);
        assert_ne!(threads[0].version, first_hint);
        let mut cursor = next_cursor;
        loop {
            let HistoryResponse::Read {
                items,
                next_cursor,
                gaps,
                complete,
                version,
                ..
            } = source.read("thread-a".into(), cursor).await.unwrap()
            else {
                panic!("Expected history")
            };
            assert!(gaps.is_empty());
            assert_eq!(version, first_hint);
            ids.extend(items.into_iter().map(|item| item.id));
            match next_cursor {
                Some(next) => cursor = Some(next),
                None => {
                    assert!(complete);
                    break;
                }
            }
        }
        assert_eq!(
            ids,
            (0..61).map(|n| format!("message-{n}")).collect::<Vec<_>>()
        );
        std::fs::remove_file(&locator).unwrap();
        let HistoryResponse::List { threads, .. } = source.list(false, None).await.unwrap() else {
            panic!("Expected listing")
        };
        assert!(!threads[0].version_reliable);
        let unavailable_hint = threads[0].version.clone();
        let HistoryResponse::List { threads, .. } = source.list(false, None).await.unwrap() else {
            panic!("Expected listing")
        };
        assert!(!threads[0].version_reliable);
        assert_eq!(
            threads[0].version, unavailable_hint,
            "Unavailable fingerprints remain deterministic, with reliability explicit"
        );
    }

    #[tokio::test]
    async fn a_modified_consumed_prefix_requires_a_reread_instead_of_mixing_pages() {
        #[derive(serde::Serialize)]
        struct Message {
            id: String,
            #[serde(rename = "type")]
            kind: &'static str,
            text: String,
        }
        let directory = tempfile::tempdir().unwrap();
        let mut native = provider_fixture(
            (0..60)
                .map(|n| {
                    serde_json::to_value(Message {
                        id: format!("message-{n}"),
                        kind: "agentMessage",
                        text: "Evidence ".repeat(1200),
                    })
                    .unwrap()
                })
                .collect(),
        );
        let source = fixture(directory.path(), &native);
        let HistoryResponse::Read { next_cursor, .. } =
            source.read("thread-a".into(), None).await.unwrap()
        else {
            panic!("Expected history")
        };
        assert!(next_cursor.is_some());
        let first_cursor = next_cursor.clone();
        native
            .get_mut("turns")
            .unwrap()
            .as_array_mut()
            .unwrap()
            .first_mut()
            .unwrap()
            .get_mut("items")
            .unwrap()
            .as_array_mut()
            .unwrap()[0] = serde_json::to_value(Message {
            id: "message-0".into(),
            kind: "agentMessage",
            text: "Revised consumed evidence".into(),
        })
        .unwrap();
        std::fs::write(
            directory.path().join("native.json"),
            serde_json::to_vec(&native).unwrap(),
        )
        .unwrap();
        let HistoryResponse::Read {
            items,
            gaps,
            complete,
            next_cursor,
            ..
        } = source.read("thread-a".into(), next_cursor).await.unwrap()
        else {
            panic!("Expected history")
        };
        assert!(items.is_empty());
        assert!(!complete);
        assert!(next_cursor.is_none());
        assert!(matches!(gaps[0].code, HistoryGapCode::Changed));
        native
            .get_mut("turns")
            .unwrap()
            .as_array_mut()
            .unwrap()
            .first_mut()
            .unwrap()
            .get_mut("items")
            .unwrap()
            .as_array_mut()
            .unwrap()
            .clear();
        std::fs::write(
            directory.path().join("native.json"),
            serde_json::to_vec(&native).unwrap(),
        )
        .unwrap();
        let HistoryResponse::Read {
            items,
            gaps,
            complete,
            next_cursor,
            ..
        } = source.read("thread-a".into(), first_cursor).await.unwrap()
        else {
            panic!("Expected history")
        };
        assert!(items.is_empty());
        assert!(!complete);
        assert!(next_cursor.is_none());
        assert!(matches!(gaps[0].code, HistoryGapCode::Changed));
    }

    #[tokio::test]
    #[ignore = "requires the installed Codex CLI; uses only an isolated synthetic CODEX_HOME, no model or conversation actions"]
    async fn installed_codex_reads_active_archived_subagent_history_by_native_id() {
        #[derive(serde::Serialize)]
        struct Line<T> {
            timestamp: &'static str,
            #[serde(rename = "type")]
            kind: &'static str,
            payload: T,
        }
        #[derive(serde::Serialize)]
        struct Meta<'a> {
            id: &'a str,
            session_id: &'a str,
            forked_from_id: Option<&'a str>,
            parent_thread_id: Option<&'a str>,
            timestamp: &'static str,
            cwd: &'static str,
            originator: &'static str,
            cli_version: &'static str,
            source: Value,
            model_provider: &'static str,
        }
        #[derive(serde::Serialize)]
        struct User {
            #[serde(rename = "type")]
            kind: &'static str,
            message: &'static str,
            images: Vec<String>,
            local_images: Vec<String>,
            text_elements: Vec<Value>,
        }
        let directory = tempfile::tempdir().unwrap();
        let first = uuid::Uuid::new_v4().to_string();
        let second = uuid::Uuid::new_v4().to_string();
        for (id, archived) in [(&first, false), (&second, true)] {
            let folder = directory.path().join(if archived {
                "archived_sessions"
            } else {
                "sessions/2026/01/02"
            });
            std::fs::create_dir_all(&folder).unwrap();
            let source = if archived {
                serde_json::from_str(&format!(r#"{{"subagent":{{"thread_spawn":{{"parent_thread_id":"{first}","depth":1}}}}}}"#)).unwrap()
            } else {
                Value::String("cli".into())
            };
            let meta = Meta {
                id,
                session_id: &first,
                forked_from_id: archived.then_some(first.as_str()),
                parent_thread_id: archived.then_some(first.as_str()),
                timestamp: "2026-01-02T12:00:00Z",
                cwd: "/",
                originator: "synthetic-history-test",
                cli_version: "0.0.0",
                source,
                model_provider: "openai",
            };
            let mut text = serde_json::to_string(&Line {
                timestamp: "2026-01-02T12:00:00Z",
                kind: "session_meta",
                payload: meta,
            })
            .unwrap();
            text.push('\n');
            text.push_str(
                &serde_json::to_string(&Line {
                    timestamp: "2026-01-02T12:00:01Z",
                    kind: "event_msg",
                    payload: User {
                        kind: "user_message",
                        message: "Synthetic package question",
                        images: vec![],
                        local_images: vec![],
                        text_elements: vec![],
                    },
                })
                .unwrap(),
            );
            text.push('\n');
            std::fs::write(
                folder.join(format!("rollout-2026-01-02T12-00-00-{id}.jsonl")),
                text,
            )
            .unwrap();
        }
        let mut source = history(directory.path(), "codex".into());
        source.codex_home = Some(directory.path().to_owned());
        for (id, archived) in [(&first, false), (&second, true)] {
            let mut cursor = None;
            let mut found = false;
            loop {
                let HistoryResponse::List {
                    threads,
                    next_cursor,
                } = source
                    .request(HistoryRequest::List { archived, cursor })
                    .await
                    .unwrap()
                else {
                    panic!("Expected listing")
                };
                if let Some(thread) = threads.iter().find(|thread| thread.id == *id) {
                    found = true;
                    if archived {
                        assert_eq!(thread.parent_thread_id.as_deref(), Some(first.as_str()));
                    }
                }
                match next_cursor {
                    Some(next) => cursor = Some(next),
                    None => break,
                }
            }
            assert!(
                found,
                "Native thread list must include the requested source/archive kind"
            );
            let HistoryResponse::Read {
                thread_id,
                items,
                gaps,
                complete,
                ..
            } = source
                .request(HistoryRequest::Read {
                    thread_id: id.clone(),
                    cursor: None,
                })
                .await
                .unwrap()
            else {
                panic!("Expected transcript")
            };
            assert_eq!(thread_id, *id);
            assert!(gaps.is_empty(), "{gaps:?}");
            assert!(complete);
            assert!(
                items
                    .iter()
                    .any(|item| item.text.contains("Synthetic package question")),
                "Native full history must retain the user message"
            );
        }
    }
}
