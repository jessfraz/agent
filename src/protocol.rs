use crate::embeddings::{EmbeddingBatch, EmbeddingPurpose};
use crate::feedback::{FeedbackBundle, FeedbackContext, FeedbackReceipt};
use crate::history::{HistoryGap, HistoryItem, HistoryRequest, HistoryResponse, HistoryThread};
use crate::instructions::{GuidanceSnapshot, GuidanceSource};
use crate::machines::MachineSnapshot;
use crate::models::{ModelProvider, ModelSelection, Reasoning};
use crate::resources::{CleanupPlan, ResourceRecord, ResourceReport, WorktreeAllocation};
use crate::sources::{SourceBatch, SourceCheckpoint, SourceConfig, SourceCoverage, SourceKey};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct ContextRepository {
    pub id: String,
    pub root: String,
    pub instructions: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct CoordinatorSettings {
    pub model: ModelSelection,
    pub instructions: String,
    pub context_repositories: Vec<ContextRepository>,
    pub sources: Vec<SourceConfig>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS, Default)]
pub struct WorkerCapabilities {
    #[serde(default)]
    pub resume_agent: bool,
    #[serde(default)]
    pub browser: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct AgentNode {
    pub host_id: String,
    pub name: String,
    pub rex_server: Option<String>,
    pub agent_program: String,
    pub home_directory: String,
    pub coordinator: Option<String>,
    pub launch: WorkerLaunch,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub capabilities: Option<WorkerCapabilities>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine: Option<MachineSnapshot>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct CoordinatorBootstrap {
    pub settings: CoordinatorSettings,
    pub node: Option<AgentNode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub background: Option<crate::background::BackgroundSettings>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, JsonSchema, TS)]
pub struct TaskId(#[ts(type = "string")] Uuid);

impl Serialize for TaskId {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for TaskId {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::try_from(Uuid::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

impl TaskId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for TaskId {
    fn default() -> Self {
        Self::new()
    }
}

impl TryFrom<Uuid> for TaskId {
    type Error = &'static str;
    fn try_from(value: Uuid) -> Result<Self, Self::Error> {
        if value.is_nil() {
            Err("Task ID cannot be nil")
        } else {
            Ok(Self(value))
        }
    }
}

impl From<TaskId> for Uuid {
    fn from(value: TaskId) -> Self {
        value.0
    }
}

impl std::fmt::Display for TaskId {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(output)
    }
}

impl std::str::FromStr for TaskId {
    type Err = anyhow::Error;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::try_from(Uuid::parse_str(value)?).map_err(anyhow::Error::msg)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct AccountIdentity {
    pub issuer: String,
    pub subject: String,
    pub email: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum AuthStatus {
    SignedOut,
    Connected {
        account: AccountIdentity,
        #[ts(type = "number")]
        expires_at: u64,
    },
    NeedsSignIn {
        account: Option<AccountIdentity>,
    },
}

#[derive(
    Clone,
    Copy,
    Debug,
    Default,
    Deserialize,
    Serialize,
    JsonSchema,
    TS,
    clap::ValueEnum,
    PartialEq,
    Eq,
)]
#[serde(rename_all = "snake_case")]
pub enum FastMode {
    #[default]
    Toggle,
    On,
    Off,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ConversationChange {
    SetSelection {
        model: ModelSelection,
    },
    SetModel {
        provider: Option<ModelProvider>,
        model_id: String,
    },
    SetReasoning {
        reasoning: Option<Reasoning>,
    },
    SetFast {
        mode: FastMode,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct ModelOption {
    pub provider: ModelProvider,
    pub model_id: String,
    pub name: String,
    pub reasoning: Vec<Reasoning>,
    pub fast: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct ConversationSettings {
    pub conversation_id: String,
    pub task_id: Option<TaskId>,
    pub agent_id: Option<String>,
    pub model: ModelSelection,
    pub catalog: Vec<ModelOption>,
}

/// Saved conversation identity and metadata; listing never starts execution.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct SavedConversation {
    pub conversation_id: String,
    pub title: String,
    #[ts(type = "number | null")]
    pub updated_at: Option<i64>,
    pub task_id: Option<TaskId>,
    pub agent_id: Option<String>,
    pub host: Option<String>,
    pub source_thread_id: Option<String>,
}

/// Used only when an idle chief starts a new turn; active work keeps its context.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct MainInputContext {
    pub instructions: String,
    pub origin_host_id: Option<String>,
    pub cwd: String,
    pub hosts: Vec<WorkerHost>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct RuntimeRequest {
    pub version: u32,
    pub id: u32,
    pub command: RuntimeCommand,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RuntimeCommand {
    Attachment {
        request: crate::attachments::AttachmentRequest,
    },
    RunBackground {
        settings: crate::background::BackgroundSettings,
    },
    SyncJobs {
        jobs: Vec<crate::jobs::ScheduledJob>,
    },
    JobStatus,
    ListJobs,
    ReadJob {
        job_id: crate::jobs::JobId,
    },
    RunJob {
        job_id: crate::jobs::JobId,
        schedule_id: Option<crate::jobs::ScheduleId>,
        request_id: String,
    },
    ConfigureCoordinator {
        bootstrap: CoordinatorBootstrap,
    },
    RegisterNode {
        node: AgentNode,
    },
    SetConnectedNodes {
        host_ids: Vec<String>,
    },
    Environment {
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        telemetry: bool,
    },
    ConnectWorker {
        node: AgentNode,
    },
    Watch,
    SourceStates,
    IngestSource {
        batch: SourceBatch,
        expected_checkpoint: Option<SourceCheckpoint>,
    },
    #[serde(rename = "oauth_callback")]
    OAuthCallback {
        target: String,
    },
    TriageSources {
        instructions: String,
        model: ModelSelection,
        cwd: String,
        hosts: Vec<WorkerHost>,
    },
    Login,
    Status,
    Usage {
        provider: crate::models::ModelProvider,
    },
    AttachMain,
    /// Long-lived, read-only observation of the existing root conversation.
    ObserveMain {
        input_ids: Vec<String>,
    },
    /// Owner-independent admission using Pi's durable request identity.
    MainInput {
        input_id: String,
        input: String,
        mode: InputMode,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        context: Option<MainInputContext>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        attachments: Option<Vec<crate::attachments::AttachmentRef>>,
    },
    MainInterrupt,
    MainFeedback {
        description: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        attachments: Option<Vec<crate::attachments::AttachmentRef>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        input_id: Option<String>,
    },
    /// Native clients share the authenticated local/tailnet transport.
    Native {
        request: crate::native::NativeRequest,
    },
    DetachMain,
    ConversationSettings {
        task_id: Option<TaskId>,
        agent_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        conversation_id: Option<String>,
        change: Option<ConversationChange>,
        #[serde(default)]
        catalog: bool,
    },
    Logout,
    Chat {
        input: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        input_id: Option<String>,
        instructions: String,
        model: Option<ModelSelection>,
        origin_host_id: Option<String>,
        cwd: String,
        hosts: Vec<WorkerHost>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        attachments: Option<Vec<crate::attachments::AttachmentRef>>,
    },
    SearchTasks {
        query: String,
    },
    ListTasks,
    ListConversations {
        query: String,
        cursor: Option<String>,
        limit: u32,
    },
    /// Observe a saved conversation without claiming its execution.
    AttachConversation {
        conversation_id: String,
        #[serde(default)]
        input_ids: Vec<String>,
    },
    DetachConversation,
    /// Admit input independently of any observing terminal's lifetime.
    ConversationInput {
        conversation_id: String,
        input_id: String,
        input: String,
        mode: InputMode,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        context: Option<MainInputContext>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        attachments: Option<Vec<crate::attachments::AttachmentRef>>,
    },
    ConversationInterrupt {
        conversation_id: String,
    },
    ListResources,
    CollectResources {
        host_id: String,
    },
    ReadTask {
        task_id: TaskId,
    },
    ReadHistory {
        task_id: Option<TaskId>,
        agent_id: Option<String>,
        cursor: Option<String>,
    },
    Feedback {
        description: String,
        context: FeedbackContext,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        input_id: Option<String>,
    },
    ReadFeedback {
        id: Option<String>,
    },
    ImportCodex {
        hosts: Vec<String>,
    },
    ImportStatus,
    SearchHistory {
        query: String,
        limit: u32,
        #[serde(default)]
        mode: SearchMode,
    },
    ReadConversation {
        conversation_id: String,
        cursor: Option<String>,
    },
    OpenConversation {
        conversation_id: String,
        host: Option<String>,
    },
    RevokeAllocation {
        task_id: TaskId,
        allocation_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        agent_id: Option<String>,
    },
    RunTask {
        task_id: TaskId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        agent_id: Option<String>,
        allocation_id: String,
        binding: WorkerRef,
        instructions: String,
        model: ModelSelection,
        cwd: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        interactive: Option<bool>,
    },
    WorkerInput {
        input_id: String,
        input: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        attachments: Option<Vec<crate::attachments::AttachmentRef>>,
    },
    SubmitInput {
        input_id: String,
        input: String,
        mode: InputMode,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        attachments: Option<Vec<crate::attachments::AttachmentRef>>,
    },
    DetachWorker,
    Interrupt,
    HostReply {
        call_id: String,
        result: HostResult,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct WorkerHost {
    #[serde(default)]
    pub host_id: Option<String>,
    pub name: String,
    pub rex_server: Option<String>,
    pub coordinator: Option<String>,
    pub cwd: String,
    pub agent_program: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub launch: Option<WorkerLaunch>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct WorkerLaunch {
    pub state_dir: Option<String>,
    pub runtime: Option<String>,
    pub config: Option<String>,
    pub instructions: Option<String>,
    #[serde(default)]
    pub model: Option<ModelSelection>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct SourceRef {
    pub provider: String,
    pub account: String,
    pub thread_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct DelegationCandidate {
    pub conversation_id: String,
    pub task_id: Option<TaskId>,
    pub score: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DelegationSelection {
    Considered,
    Reuse {
        task_id: TaskId,
        conversation_id: String,
    },
    Adopt {
        task_id: TaskId,
        conversation_id: String,
    },
    Create {
        task_id: TaskId,
        conversation_id: String,
        reason: Option<String>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct DelegationDecision {
    pub actor_conversation_id: String,
    pub tool_call_id: String,
    pub query: Option<String>,
    pub candidates: Vec<DelegationCandidate>,
    pub gaps: Vec<String>,
    pub selection: DelegationSelection,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub input_mode: Option<InputMode>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct WorkerRef {
    pub host_id: String,
    pub session_id: String,
    pub window_id: String,
    pub block_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum WorkerState {
    Unassigned,
    Allocating {
        allocation_id: String,
        host: WorkerHost,
    },
    Bound {
        allocation_id: String,
        host: WorkerHost,
        binding: WorkerRef,
    },
    Resuming {
        allocation_id: String,
        host: WorkerHost,
        binding: WorkerRef,
    },
    ResumeUncertain {
        allocation_id: String,
        host: WorkerHost,
        binding: WorkerRef,
    },
    Uncertain {
        allocation_id: String,
        host: WorkerHost,
        session_id: Option<String>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum AllocationOperation {
    Create,
    Resume,
    Reconcile,
    Revoke,
    Reopen,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AllocationResult {
    Pending,
    Written,
    Spawned { binding: WorkerRef },
    Presence { presence: WorkerPresence },
    CreationUncertain { session_id: Option<String> },
    Failed { message: String },
    Rejected,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct AllocationDecision {
    pub task_id: TaskId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub agent_id: Option<String>,
    pub operation: AllocationOperation,
    pub previous: WorkerState,
    pub current: WorkerState,
    pub result: AllocationResult,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum TaskState {
    Open,
    Waiting {
        actor: String,
        next_check: Option<String>,
    },
    Resolved {
        evidence: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct TaskRecord {
    pub id: TaskId,
    pub conversation_id: String,
    pub title: String,
    pub outcome: String,
    pub summary: String,
    #[serde(default)]
    pub model: Option<ModelSelection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub scheduled_run: Option<crate::background::JobRunReceipt>,
    pub state: TaskState,
    pub worker: WorkerState,
    pub sources: Vec<SourceRef>,
    pub pending: Vec<TaskInput>,
    pub agents: Vec<TaskAgentRecord>,
    #[ts(type = "number")]
    pub updated_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct TaskAgentRecord {
    pub id: String,
    pub conversation_id: String,
    pub title: String,
    pub outcome: String,
    pub summary: String,
    #[serde(default)]
    pub model: Option<ModelSelection>,
    pub state: TaskAgentState,
    pub worker: WorkerState,
    pub pending: Vec<TaskInput>,
    #[ts(type = "number")]
    pub updated_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum TaskAgentState {
    Open,
    Done,
    Failed { reason: String },
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct TaskInput {
    pub id: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mode: Option<InputMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub attachments: Option<Vec<crate::attachments::AttachmentRef>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct TaskOutcome {
    pub task_id: TaskId,
    pub conversation_id: String,
    pub entry_id: Option<String>,
    pub tool_call_id: Option<String>,
    pub summary: String,
    pub sources: Vec<SourceRef>,
    pub state: TaskOutcomeState,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum TaskOutcomeState {
    Progress,
    Waiting {
        actor: String,
        next_check: Option<String>,
    },
    Resolved {
        evidence: String,
    },
    Failed {
        reason: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct SourceState {
    pub source: SourceKey,
    pub checkpoint: Option<SourceCheckpoint>,
    pub coverage: SourceCoverage,
    #[ts(type = "number")]
    pub checked_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HostCommand {
    AttachmentWrite {
        attachment: crate::attachments::AttachmentRef,
        offset: u32,
        data_base64: String,
        complete: bool,
    },
    Browser {
        host_id: String,
        request: crate::browser::BrowserRequest,
    },
    Background {
        request: crate::background::BackgroundRequest,
    },
    MachineSnapshot,
    ReadUsage {
        expected_email: String,
    },
    ReloadGuidance,
    ProjectGuidance {
        cwd: String,
    },
    History {
        request: HistoryRequest,
    },
    Embed {
        texts: Vec<String>,
        purpose: EmbeddingPurpose,
    },
    InspectWorker {
        binding: WorkerRef,
    },
    OnNode {
        host_id: String,
        command: Box<HostCommand>,
    },
    ReadContext {
        repository_id: String,
        path: String,
        offset: u32,
        limit: u32,
    },
    SearchContext {
        repository_id: String,
        path: Option<String>,
        query: String,
        limit: u32,
    },
    ResourceAllocate {
        request: WorktreeAllocation,
    },
    ResourceInspect {
        record: Box<ResourceRecord>,
    },
    ResourcePlanCleanup {
        record: Box<ResourceRecord>,
    },
    ResourceCollect {
        record: Box<ResourceRecord>,
        plan: CleanupPlan,
    },
    Exec {
        program: String,
        args: Vec<String>,
        cwd: String,
        timeout_seconds: u16,
    },
    ReadFile {
        path: String,
        offset: u32,
        limit: u32,
    },
    WriteFile {
        path: String,
        content: String,
    },
    EditFile {
        path: String,
        old: String,
        new: String,
    },
    SpawnWorker {
        host: WorkerHost,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        parent: Option<WorkerRef>,
        task_id: TaskId,
        allocation_id: String,
        title: String,
    },
    SpawnSubagent {
        host: WorkerHost,
        parent: WorkerRef,
        task_id: TaskId,
        agent_id: String,
        allocation_id: String,
        title: String,
    },
    ResumeWorker {
        host: WorkerHost,
        binding: WorkerRef,
        task_id: TaskId,
        allocation_id: String,
    },
    ResumeAgentWorker {
        host: WorkerHost,
        binding: WorkerRef,
        task_id: TaskId,
        agent_id: String,
        allocation_id: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HostResult {
    AttachmentWritten {
        next_offset: u32,
        path: Option<String>,
    },
    Browser {
        response: crate::browser::BrowserResponse,
    },
    Background {
        response: crate::background::BackgroundResponse,
    },
    MachineSnapshot {
        snapshot: MachineSnapshot,
    },
    Usage {
        usage: crate::usage::UsageAvailability,
    },
    SharedGuidance {
        global: GuidanceSnapshot,
        workflow_policy: String,
        context_repositories: Vec<ContextRepository>,
        context_sources: Vec<GuidanceSource>,
    },
    ProjectGuidance {
        snapshot: GuidanceSnapshot,
    },
    History {
        response: HistoryResponse,
    },
    Embeddings {
        batch: EmbeddingBatch,
    },
    WorkerPresence {
        presence: WorkerPresence,
    },
    ContextMatches {
        matches: Vec<ContextMatch>,
        truncated: bool,
    },
    Resource {
        report: ResourceReport,
    },
    Process {
        exit_code: i32,
        stdout: String,
        stderr: String,
        truncated: bool,
    },
    File {
        content: String,
        truncated: bool,
    },
    Written,
    Spawned {
        binding: WorkerRef,
    },
    CreationUncertain {
        session_id: Option<String>,
    },
    Failed {
        message: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct ContextMatch {
    pub path: String,
    pub line: u32,
    pub text: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct RuntimeEvent {
    pub version: u32,
    pub id: u32,
    pub event: RuntimeEventKind,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RuntimeEventKind {
    Attachment {
        response: crate::attachments::AttachmentResponse,
    },
    JobRun {
        run: crate::background::JobRunReceipt,
    },
    JobsSynced {
        report: crate::background::JobSyncReport,
    },
    JobStatus {
        status: crate::background::BackgroundStatus,
    },
    ScheduledJobs {
        jobs: Vec<crate::background::ScheduledJobStatus>,
    },
    ScheduledJob {
        job: crate::background::ScheduledJobStatus,
    },
    Usage {
        usage: crate::usage::UsageAvailability,
    },
    FeedbackReady {
        receipt: FeedbackReceipt,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        input_id: Option<String>,
    },
    Feedback {
        bundle: Box<FeedbackBundle>,
    },
    ImportProgress {
        progress: ImportProgress,
    },
    SavedMatches {
        matches: Vec<SavedMatch>,
        gaps: Vec<String>,
    },
    Conversations {
        items: Vec<SavedConversation>,
        next_cursor: Option<String>,
    },
    Configured,
    NodeRegistered {
        host_id: String,
    },
    WorkerReady {
        connection_id: String,
    },
    Environment {
        settings: CoordinatorSettings,
        nodes: Vec<AgentNode>,
        online_host_ids: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        unavailable_host_ids: Option<Vec<String>>,
    },
    Resources {
        resources: Vec<ResourceRecord>,
    },
    Sources {
        sources: Vec<SourceState>,
    },
    SourceAdmitted {
        new_events: u32,
        checkpoint_advanced: bool,
        state: SourceState,
    },
    Notice {
        task_id: Option<TaskId>,
        text: String,
    },
    HostCall {
        call_id: String,
        command: Box<HostCommand>,
    },
    Tasks {
        tasks: Vec<TaskRecord>,
    },
    Task {
        task: Box<TaskRecord>,
        history: String,
    },
    AuthorizationUrl {
        url: String,
    },
    AuthStatus {
        status: AuthStatus,
    },
    ConversationSettings {
        settings: ConversationSettings,
    },
    MainReady {
        conversation_id: String,
        model: ModelSelection,
        cwd: String,
    },
    ConversationReady {
        conversation: SavedConversation,
        model: ModelSelection,
        cwd: String,
        working: bool,
    },
    ConversationState {
        working: bool,
    },
    Answer {
        conversation_id: String,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        entry_id: Option<String>,
    },
    History {
        conversation_id: String,
        messages: Vec<HistoryMessage>,
        next_cursor: Option<String>,
        // The final frame in this page, even when the worker stays open.
        #[serde(default)]
        page_complete: bool,
    },
    TaskReady {
        conversation_id: String,
        title: String,
    },
    WorkerIdle,
    InputRejected {
        input_id: String,
        message: String,
    },
    InputAccepted {
        input_id: String,
    },
    /// The native submission has been placed into the conversation transcript.
    InputPlaced {
        input_id: String,
        entry_id: String,
    },
    TextDelta {
        text: String,
    },
    Activity {
        activity: ModelActivity,
    },
    Message {
        message: HistoryMessage,
    },
    Interrupted,
    HostCancel {
        call_id: String,
    },
    Failure {
        code: ErrorCode,
        message: String,
    },
    Done,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct HistoryMessage {
    pub entry_id: String,
    pub role: HistoryRole,
    pub text: String,
    pub continuation: bool,
    #[serde(default)]
    pub final_chunk: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tool: Option<ToolHistory>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub attachments: Option<Vec<crate::attachments::AttachmentRef>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS, PartialEq, Eq)]
pub struct ToolHistory {
    pub call_id: String,
    pub name: String,
    pub status: ToolStatus,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, TS, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolStatus {
    Running,
    Finished,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum HistoryRole {
    User,
    /// Assistant text whose source did not identify a semantic phase.
    Assistant,
    Commentary,
    PartialAnswer,
    Final,
    Notice,
    Thinking,
    Tool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, TS, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InputMode {
    Steer,
    FollowUp,
}

#[derive(
    Clone,
    Copy,
    Debug,
    Default,
    PartialEq,
    Eq,
    Deserialize,
    Serialize,
    JsonSchema,
    TS,
    clap::ValueEnum,
)]
#[serde(rename_all = "snake_case")]
pub enum SearchMode {
    #[default]
    Semantic,
    Keyword,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum HistoryProvider {
    Codex,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct ImportedConversation {
    pub source: HistoryProvider,
    pub thread: HistoryThread,
    pub conversation_id: String,
    pub adopted_task_id: Option<TaskId>,
    pub complete: bool,
    pub gaps: Vec<HistoryGap>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct HistoryImportBatch {
    pub host_id: String,
    pub thread: HistoryThread,
    pub items: Vec<HistoryItem>,
    pub next_cursor: Option<String>,
    pub gaps: Vec<HistoryGap>,
    pub complete: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub source_exhausted: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub retry_pages: Option<Vec<HistoryRetryPage>>,
}

/// An opaque native page locator and the unresolved asset items on that page.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct HistoryRetryPage {
    pub cursor: Option<String>,
    pub gaps: Vec<HistoryGap>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct HistoryImportReceipt {
    pub conversation: ImportedConversation,
    pub added_items: u32,
    pub existing_items: u32,
    pub entry_ids: Vec<String>,
    pub watermark: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ImportPhase {
    Discovering,
    Importing,
    Indexing,
    Complete,
    Partial,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct ImportProgress {
    pub phase: ImportPhase,
    pub host_id: Option<String>,
    pub threads_seen: u32,
    pub threads_imported: u32,
    pub threads_unchanged: u32,
    pub items_added: u32,
    pub items_unchanged: u32,
    pub assets_saved: u32,
    pub gap_count: u32,
    pub gaps: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct SavedMatch {
    pub conversation_id: String,
    pub title: String,
    pub excerpt: String,
    pub entry_ids: Vec<String>,
    pub score: f64,
    pub task_id: Option<TaskId>,
    pub imported: Option<ImportedConversation>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum WorkerPresence {
    Pending,
    Present { running: bool },
    MissingSession,
    MissingTerminal,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ModelActivity {
    Thinking { text: String },
    ToolStarted { call_id: String, name: String },
    ToolFinished { call_id: String, name: String },
    Compaction { active: bool, failed: bool },
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidRequest,
    AuthenticationRequired,
    AuthenticationFailed,
    ProviderUnavailable,
    CoordinatorUnavailable,
    StorageUnavailable,
    Internal,
}

#[cfg(test)]
mod tests {
    use crate::protocol::{
        HistoryMessage, HistoryRole, RuntimeCommand, RuntimeEventKind, SearchMode, ToolHistory,
        ToolStatus,
    };

    #[test]
    fn history_page_completion_is_additive_for_older_wire_messages() {
        let old: RuntimeEventKind = serde_json::from_str(
            r#"{"type":"history","conversation_id":"saved","messages":[],"next_cursor":null}"#,
        )
        .unwrap();
        assert!(matches!(
            old,
            RuntimeEventKind::History {
                page_complete: false,
                ..
            }
        ));
        let complete = RuntimeEventKind::History {
            conversation_id: "saved".into(),
            messages: vec![],
            next_cursor: None,
            page_complete: true,
        };
        let round_trip: RuntimeEventKind =
            serde_json::from_slice(&serde_json::to_vec(&complete).unwrap()).unwrap();
        assert!(matches!(
            round_trip,
            RuntimeEventKind::History {
                page_complete: true,
                ..
            }
        ));
    }

    #[test]
    fn existing_environment_reads_do_not_request_machine_probes() {
        let command: RuntimeCommand = serde_json::from_str(r#"{"type":"environment"}"#).unwrap();
        assert!(matches!(
            command,
            RuntimeCommand::Environment { telemetry: false }
        ));
        assert_eq!(
            serde_json::to_string(&command).unwrap(),
            r#"{"type":"environment"}"#
        );
        let command: RuntimeCommand =
            serde_json::from_str(r#"{"type":"environment","telemetry":true}"#).unwrap();
        assert!(matches!(
            command,
            RuntimeCommand::Environment { telemetry: true }
        ));
    }

    #[test]
    fn old_history_without_tool_metadata_and_new_tool_identity_share_the_wire_contract() {
        let legacy: HistoryMessage = serde_json::from_str(
            r#"{"entry_id":"saved","role":"assistant","text":"Older response","continuation":false}"#,
        ).unwrap();
        assert!(matches!(legacy.role, HistoryRole::Assistant));
        assert!(legacy.tool.is_none());
        assert!(!legacy.final_chunk);
        let message = HistoryMessage {
            attachments: None,
            entry_id: "result".into(),
            role: HistoryRole::Tool,
            text: "check failed".into(),
            continuation: false,
            final_chunk: true,
            tool: Some(ToolHistory {
                call_id: "native-call".into(),
                name: "check".into(),
                status: ToolStatus::Failed,
            }),
        };
        let decoded: HistoryMessage =
            serde_json::from_slice(&serde_json::to_vec(&message).unwrap()).unwrap();
        assert_eq!(decoded.tool, message.tool);
        assert!(matches!(decoded.role, HistoryRole::Tool));
        assert!(decoded.final_chunk);
        let legacy_answer: RuntimeEventKind = serde_json::from_str(
            r#"{"type":"answer","conversation_id":"main","text":"Older answer"}"#,
        )
        .unwrap();
        assert!(matches!(
            legacy_answer,
            RuntimeEventKind::Answer { entry_id: None, .. }
        ));
        let answer = RuntimeEventKind::Answer {
            conversation_id: "main".into(),
            text: "Stored answer".into(),
            entry_id: Some("native-entry".into()),
        };
        let decoded: RuntimeEventKind =
            serde_json::from_slice(&serde_json::to_vec(&answer).unwrap()).unwrap();
        assert!(
            matches!(decoded, RuntimeEventKind::Answer { entry_id: Some(entry_id), .. } if entry_id == "native-entry")
        );
    }

    #[test]
    fn history_search_mode_defaults_and_rejects_unknown_values() {
        let command: RuntimeCommand =
            serde_json::from_str(r#"{"type":"search_history","query":"saved context","limit":8}"#)
                .unwrap();
        assert!(matches!(
            command,
            RuntimeCommand::SearchHistory {
                mode: SearchMode::Semantic,
                ..
            }
        ));
        let command: RuntimeCommand = serde_json::from_str(
            r#"{"type":"search_history","query":"ERR_FIXTURE","limit":8,"mode":"keyword"}"#,
        )
        .unwrap();
        assert!(matches!(
            command,
            RuntimeCommand::SearchHistory {
                mode: SearchMode::Keyword,
                ..
            }
        ));
        assert!(
            serde_json::from_str::<RuntimeCommand>(
                r#"{"type":"search_history","query":"saved context","limit":8,"mode":"unknown"}"#,
            )
            .is_err()
        );
    }
}
