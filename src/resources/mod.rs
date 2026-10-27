//! Application-owned resource inventory. Stored data never replaces live checks.

pub mod git;

use crate::protocol::TaskId;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct WorktreeAllocation {
    pub host_id: String,
    pub task_id: TaskId,
    #[ts(type = "string")]
    pub allocation_id: Uuid,
    pub repository: String,
    pub branch: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS, PartialEq, Eq)]
pub struct NativeWorktreeIdentity {
    pub primary: String,
    pub top: String,
    pub common_dir: String,
    pub git_dir: String,
    pub branch: String,
    pub head: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ResourceState {
    Allocating,
    Ready {
        identity: NativeWorktreeIdentity,
    },
    Retiring {
        identity: NativeWorktreeIdentity,
        #[ts(type = "string")]
        plan_id: Uuid,
    },
    Held {
        identity: Option<NativeWorktreeIdentity>,
        reason: String,
    },
    Removed {
        identity: NativeWorktreeIdentity,
    },
    Partial {
        identity: NativeWorktreeIdentity,
        path_absent: bool,
        registry_absent: bool,
        branch_absent: bool,
        reason: String,
    },
}

impl ResourceState {
    pub fn identity(&self) -> Option<&NativeWorktreeIdentity> {
        match self {
            Self::Allocating => None,
            Self::Held { identity, .. } => identity.as_ref(),
            Self::Ready { identity }
            | Self::Retiring { identity, .. }
            | Self::Removed { identity }
            | Self::Partial { identity, .. } => Some(identity),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct ResourceRecord {
    // A worktree allocation owns exactly one resource, so its UUID is the ID.
    #[ts(type = "string")]
    pub id: Uuid,
    pub host_id: String,
    pub task_id: TaskId,
    pub repository: String,
    pub branch: String,
    pub consumers: Vec<TaskId>,
    pub state: ResourceState,
}

impl ResourceRecord {
    pub fn allocating(request: WorktreeAllocation) -> Self {
        Self {
            id: request.allocation_id,
            host_id: request.host_id,
            task_id: request.task_id,
            repository: request.repository,
            branch: request.branch,
            consumers: Vec::new(),
            state: ResourceState::Allocating,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct CleanupPlan {
    #[ts(type = "string")]
    pub id: Uuid,
    #[ts(type = "string")]
    pub resource_id: Uuid,
    pub identity: NativeWorktreeIdentity,
    pub path: String,
    pub fingerprint: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct CleanupReceipt {
    pub status: String,
    pub worktree_removed: bool,
    pub branch_deleted: Option<String>,
    pub primary_worktree: Option<String>,
    pub retained_submodules: Option<String>,
    pub summary: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ResourceReport {
    Observed {
        record: Box<ResourceRecord>,
    },
    Planned {
        record: Box<ResourceRecord>,
        plan: Box<CleanupPlan>,
    },
    Collected {
        record: Box<ResourceRecord>,
        receipt: Option<CleanupReceipt>,
    },
}

#[async_trait::async_trait]
pub trait ResourceBackend: Send + Sync {
    async fn allocate(&self, request: WorktreeAllocation) -> ResourceReport;
    async fn inspect(&self, record: ResourceRecord) -> ResourceReport;
    async fn plan_cleanup(&self, record: ResourceRecord, plan_directory: &str) -> ResourceReport;
    async fn collect(&self, record: ResourceRecord, plan: CleanupPlan) -> ResourceReport;
}
