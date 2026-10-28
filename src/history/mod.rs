//! Inert, checkpointed history reads. Importing history never starts work.

pub mod codex;

use anyhow::Result;
use async_trait::async_trait;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::protocol::HistoryRole;

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HistoryRequest {
    List {
        archived: bool,
        cursor: Option<String>,
    },
    Read {
        thread_id: String,
        cursor: Option<String>,
    },
    Asset {
        thread_id: String,
        path: String,
        #[ts(type = "number")]
        offset: u64,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct HistoryThread {
    pub id: String,
    pub title: String,
    pub cwd: String,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
    pub forked_from_id: Option<String>,
    pub parent_thread_id: Option<String>,
    pub version: String,
    #[serde(default)]
    pub version_reliable: bool,
    pub archived: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum HistoryAssetKind {
    LocalMedia,
    InlineMedia,
    ColdEvidence,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct HistoryAssetRef {
    pub path: String,
    pub item_id: String,
    pub version: String,
    pub kind: HistoryAssetKind,
    pub media_type: String,
    pub sha256: Option<String>,
    #[ts(type = "number | null")]
    pub size: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct HistoryItem {
    pub id: String,
    pub turn_id: String,
    pub kind: String,
    pub role: HistoryRole,
    pub text: String,
    pub version: String,
    #[ts(type = "number")]
    pub order: u64,
    #[ts(type = "number | null")]
    pub timestamp_ms: Option<i64>,
    // Native evidence only. This field contributes no model messages.
    #[ts(type = "unknown")]
    pub data: serde_json::Value,
    pub assets: Vec<HistoryAssetRef>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum HistoryGapCode {
    Missing,
    Unsupported,
    Oversized,
    Unavailable,
    Changed,
    Invalid,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct HistoryGap {
    pub code: HistoryGapCode,
    pub item_id: Option<String>,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HistoryResponse {
    List {
        threads: Vec<HistoryThread>,
        next_cursor: Option<String>,
    },
    Read {
        thread_id: String,
        version: String,
        items: Vec<HistoryItem>,
        next_cursor: Option<String>,
        gaps: Vec<HistoryGap>,
        complete: bool,
    },
    Asset {
        path: String,
        #[ts(type = "number")]
        offset: u64,
        data_base64: String,
        #[ts(type = "number | null")]
        next_offset: Option<u64>,
        #[ts(type = "number")]
        total_bytes: u64,
        sha256: String,
    },
}

#[async_trait]
pub trait HistorySource: Send + Sync {
    async fn request(&self, request: HistoryRequest) -> Result<HistoryResponse>;
}
