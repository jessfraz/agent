//! Typed Rex CLI boundary. No routing policy and no automatic mutation retries.
//! Native schemas are discovered per server with `rex api describe`.

use std::fmt;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use uuid::Uuid;

const CALL_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_OUTPUT_BYTES: u64 = 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum RexError {
    InvalidInput,
    InvalidId,
    Unavailable,
    ReadFailed,
    InvalidResponse,
    BindingMismatch,
    CreationUncertain { session_id: Option<SessionId> },
}
impl fmt::Display for RexError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidInput => f.write_str("Invalid Rex worker request"),
            Self::InvalidId => f.write_str("Invalid Rex resource identifier"),
            Self::Unavailable => f.write_str("Rex CLI is unavailable"),
            Self::ReadFailed => f.write_str("Rex read failed or timed out"),
            Self::InvalidResponse => f.write_str("Rex returned an unsupported response"),
            Self::BindingMismatch => f.write_str("Rex session does not match its recorded worker binding"),
            Self::CreationUncertain { .. } => f.write_str("Rex session creation is uncertain; reconcile the original allocation before retrying"),
        }
    }
}
impl std::error::Error for RexError {}

macro_rules! native_id {
    ($name:ident, $prefix:literal) => {
        #[derive(Clone, Debug, PartialEq, Eq, Hash, Deserialize, Serialize)]
        #[serde(try_from = "String", into = "String")]
        pub struct $name(String);
        impl $name {
            pub fn parse(value: &str) -> Result<Self, RexError> {
                let uuid = value.strip_prefix($prefix).ok_or(RexError::InvalidId)?;
                let uuid = Uuid::parse_str(uuid).map_err(|_| RexError::InvalidId)?;
                if uuid.is_nil() {
                    return Err(RexError::InvalidId);
                }
                Ok(Self(format!("{}{}", $prefix, uuid)))
            }
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
        impl TryFrom<String> for $name {
            type Error = RexError;
            fn try_from(value: String) -> Result<Self, Self::Error> {
                Self::parse(&value)
            }
        }
        impl From<$name> for String {
            fn from(value: $name) -> Self {
                value.0
            }
        }
        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}
native_id!(SessionId, "session:");
native_id!(BlockId, "block:");
native_id!(WindowId, "window:");
native_id!(HostId, "");

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RexIdentity {
    pub host_id: HostId,
    pub instance_id: Uuid,
    pub rex_version: String,
    pub endpoint: Option<String>,
    pub tailscale: Option<RexTailnet>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RexTailnet {
    pub dns_name: Option<String>,
    pub https: Option<RexHttps>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RexHttps {
    pub state: String,
    pub url: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SessionSummary {
    pub session_id: SessionId,
    pub label: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WorkerBinding {
    pub session_id: SessionId,
    pub window_id: WindowId,
    pub block_id: BlockId,
    pub revision: u64,
}

pub enum WorkerResume {
    Running,
    Started(WorkerBinding),
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SessionView {
    pub session_id: SessionId,
    pub revision: u64,
    pub label: Option<String>,
    #[serde(default, deserialize_with = "nullable_vec")]
    pub windows: Vec<WindowView>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WindowView {
    pub window_id: Option<WindowId>,
    #[serde(deserialize_with = "nullable_vec")]
    pub layers: Vec<LayerView>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct LayerView {
    #[serde(deserialize_with = "nullable_vec")]
    pub blocks: Vec<BlockView>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct BlockView {
    pub block_id: Option<BlockId>,
    pub host_id: Option<HostId>,
    pub flavor: Option<String>,
    pub label: Option<String>,
}
impl SessionView {
    pub fn verify_binding(&self, binding: &WorkerBinding, host: &HostId) -> Result<(), RexError> {
        if self.session_id != binding.session_id {
            return Err(RexError::BindingMismatch);
        }
        let matches = self
            .windows
            .iter()
            .filter(|window| window.window_id.as_ref() == Some(&binding.window_id))
            .flat_map(|window| &window.layers)
            .flat_map(|layer| &layer.blocks)
            .filter(|block| block.block_id.as_ref() == Some(&binding.block_id))
            .any(|block| {
                block.host_id.as_ref() == Some(host)
                    && block.flavor.as_deref() == Some("com.superlogical.terminal.shell")
            });
        if matches {
            Ok(())
        } else {
            Err(RexError::BindingMismatch)
        }
    }
}

#[derive(Clone, Debug)]
pub struct RexClient {
    server: Option<String>,
}
impl RexClient {
    pub fn new(server: Option<String>) -> Self {
        Self { server }
    }

    pub async fn whoami(&self) -> Result<RexIdentity, RexError> {
        let output = self
            .run(vec!["whoami".to_owned(), "--json".to_owned()])
            .await
            .map_err(read_failure)?;
        decode(&output)
    }

    pub async fn list_sessions(&self) -> Result<Vec<SessionSummary>, RexError> {
        let output = self
            .api("session.list", &Empty {})
            .await
            .map_err(read_failure)?;
        let result: SessionList = decode(&output)?;
        Ok(result.sessions)
    }

    pub async fn create_worker_window(
        &self,
        session: &SessionId,
        title: &str,
        program: &str,
        args: &[String],
        cwd: &Path,
    ) -> Result<WorkerBinding, RexError> {
        let request = CreateRequest::worker(title, program, args, cwd)?;
        let [mut window] = request.initial_windows;
        window.layout.block.label = title.to_owned();
        let receipt = self
            .api(
                "session.new_window",
                &NewWindowRequest {
                    session_id: session.clone(),
                    window_label: title.to_owned(),
                    layout: window.layout,
                    focus: false,
                },
            )
            .await
            .map_err(|_| RexError::CreationUncertain {
                session_id: Some(session.clone()),
            })?;
        let window: CreatedWindow =
            serde_json::from_slice(&receipt).map_err(|_| RexError::CreationUncertain {
                session_id: Some(session.clone()),
            })?;
        let [block] = window.block_ids.as_slice() else {
            return Err(RexError::CreationUncertain {
                session_id: Some(session.clone()),
            });
        };
        Ok(WorkerBinding {
            session_id: session.clone(),
            window_id: window.window_id,
            block_id: block.clone(),
            revision: window.revision,
        })
    }

    pub async fn promote_session(&self, session: &SessionId) -> Result<(), RexError> {
        let sessions = self.list_sessions().await?;
        if sessions
            .first()
            .is_some_and(|first| first.session_id == *session)
        {
            return Ok(());
        }
        let before = sessions
            .iter()
            .find(|other| other.session_id != *session)
            .map(|other| other.session_id.clone());
        self.api(
            "session.move",
            &MoveSession {
                session_id: session.clone(),
                before_session_id: before,
            },
        )
        .await
        .map_err(read_failure)?;
        Ok(())
    }

    pub async fn inspect_session(&self, session: &SessionId) -> Result<SessionView, RexError> {
        let output = self
            .api(
                "session.view",
                &SessionRequest {
                    session_id: session.clone(),
                },
            )
            .await
            .map_err(read_failure)?;
        let view: SessionView = decode(&output)?;
        if view.session_id != *session {
            return Err(RexError::BindingMismatch);
        }
        Ok(view)
    }

    /// One native create attempt. Lost or malformed receipts never authorize a retry.
    pub async fn create_session(
        &self,
        title: &str,
        program: &str,
        args: &[String],
        cwd: &Path,
    ) -> Result<WorkerBinding, RexError> {
        let request = CreateRequest::worker(title, program, args, cwd)?;
        let output = self
            .api("session.create", &request)
            .await
            .map_err(|error| match error {
                CallFailure::Unavailable => RexError::Unavailable,
                CallFailure::InvalidInput => RexError::InvalidInput,
                _ => RexError::CreationUncertain { session_id: None },
            })?;
        decode_creation(&output)
    }

    /// Reuse the task session after its previous execution has exited.
    pub async fn resume_worker(
        &self,
        binding: &WorkerBinding,
        program: &str,
        args: &[String],
        cwd: &Path,
    ) -> Result<WorkerResume, RexError> {
        let process_request = ProcessRequest {
            session_id: binding.session_id.clone(),
            block_id: binding.block_id.clone(),
            args: Empty {},
        };
        for attempt in 0..20 {
            let process: TerminalProcess = decode(
                &self
                    .api("com.superlogical.terminal.process", &process_request)
                    .await
                    .map_err(read_failure)?,
            )?;
            if process.child.is_none() {
                break;
            }
            if attempt == 19 {
                return Ok(WorkerResume::Running);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let request = CreateRequest::worker("Worker", program, args, cwd)?;
        let [window] = request.initial_windows;
        let receipt = self
            .api(
                "session.new_window",
                &NewWindowRequest {
                    session_id: binding.session_id.clone(),
                    window_label: window.window_label,
                    layout: window.layout,
                    focus: false,
                },
            )
            .await
            .map_err(|_| RexError::CreationUncertain {
                session_id: Some(binding.session_id.clone()),
            })?;
        let window: CreatedWindow =
            serde_json::from_slice(&receipt).map_err(|_| RexError::CreationUncertain {
                session_id: Some(binding.session_id.clone()),
            })?;
        let [block] = window.block_ids.as_slice() else {
            return Err(RexError::CreationUncertain {
                session_id: Some(binding.session_id.clone()),
            });
        };
        let replacement = WorkerBinding {
            session_id: binding.session_id.clone(),
            window_id: window.window_id,
            block_id: block.clone(),
            revision: window.revision,
        };
        // Once creation succeeded, every later failure must retain uncertainty
        // about this same session rather than authorize another allocation.
        let verified = async {
            let identity = self.whoami().await?;
            self.inspect_session(&replacement.session_id)
                .await?
                .verify_binding(&replacement, &identity.host_id)
        }
        .await;
        if verified.is_err() {
            return Err(RexError::CreationUncertain {
                session_id: Some(binding.session_id.clone()),
            });
        }
        // Its history remains in Pi. Close only the exact exited pane recorded
        // for this task, after a replacement exists in the same session.
        let cleanup = async {
            let process: TerminalProcess = decode(
                &self
                    .api("com.superlogical.terminal.process", &process_request)
                    .await
                    .map_err(read_failure)?,
            )?;
            if process.child.is_none() {
                self.api(
                    "block.close",
                    &BlockRequest {
                        session_id: binding.session_id.clone(),
                        block_id: binding.block_id.clone(),
                    },
                )
                .await
                .map_err(read_failure)?;
                let view = self.inspect_session(&binding.session_id).await?;
                if view
                    .windows
                    .iter()
                    .flat_map(|window| &window.layers)
                    .flat_map(|layer| &layer.blocks)
                    .any(|block| block.block_id.as_ref() == Some(&binding.block_id))
                {
                    return Err(RexError::BindingMismatch);
                }
            }
            Ok::<_, RexError>(())
        }
        .await;
        if cleanup.is_err() {
            eprintln!("Previous Rex worker pane remains; its replacement is running.");
        }
        Ok(WorkerResume::Started(replacement))
    }

    async fn api<T: Serialize>(&self, method: &str, request: &T) -> Result<Vec<u8>, CallFailure> {
        let payload = serde_json::to_string(request).map_err(|_| CallFailure::InvalidInput)?;
        self.run(vec![
            "api".to_owned(),
            "call".to_owned(),
            method.to_owned(),
            payload,
        ])
        .await
    }

    fn command(&self, args: &[String]) -> Result<Command, CallFailure> {
        if self
            .server
            .as_ref()
            .is_some_and(|server| server.is_empty() || server.contains('\0'))
        {
            return Err(CallFailure::InvalidInput);
        }
        let mut command = Command::new("rex");
        command.args(["--autostart=false", "--timeout", "8s"]);
        if let Some(server) = &self.server {
            command.arg("--server").arg(server);
        }
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .env_remove("REX_SESSION")
            .env_remove("REX_BLOCK")
            .env_remove("REX_CLIENT")
            .kill_on_drop(true);
        Ok(command)
    }

    async fn run(&self, args: Vec<String>) -> Result<Vec<u8>, CallFailure> {
        let mut command = self.command(&args)?;
        let mut child = command.spawn().map_err(|_| CallFailure::Unavailable)?;
        let result = tokio::time::timeout(CALL_TIMEOUT, async {
            let stdout = child.stdout.take().ok_or(CallFailure::Failed)?;
            let mut bytes = Vec::new();
            stdout
                .take(MAX_OUTPUT_BYTES + 1)
                .read_to_end(&mut bytes)
                .await
                .map_err(|_| CallFailure::Failed)?;
            if bytes.len() as u64 > MAX_OUTPUT_BYTES {
                return Err(CallFailure::Failed);
            }
            let status = child.wait().await.map_err(|_| CallFailure::Failed)?;
            if !status.success() {
                return Err(CallFailure::Failed);
            }
            Ok(bytes)
        })
        .await
        .map_err(|_| CallFailure::Failed)
        .and_then(std::convert::identity);
        // This only stops the owned CLI client, never a Rex server or remote worker.
        let _ = child.start_kill();
        if !matches!(
            tokio::time::timeout(Duration::from_secs(2), child.wait()).await,
            Ok(Ok(_))
        ) {
            return Err(CallFailure::Failed);
        }
        result
    }
}
#[derive(Debug)]
enum CallFailure {
    Unavailable,
    InvalidInput,
    Failed,
}
fn read_failure(error: CallFailure) -> RexError {
    match error {
        CallFailure::Unavailable => RexError::Unavailable,
        CallFailure::InvalidInput => RexError::InvalidInput,
        CallFailure::Failed => RexError::ReadFailed,
    }
}
fn decode<T: DeserializeOwned>(output: &[u8]) -> Result<T, RexError> {
    serde_json::from_slice(output).map_err(|_| RexError::InvalidResponse)
}
fn nullable_vec<'de, D, T>(deserializer: D) -> Result<Vec<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Option::<Vec<T>>::deserialize(deserializer)?.unwrap_or_default())
}
#[derive(Serialize)]
struct Empty {}
#[derive(Deserialize)]
struct SessionList {
    #[serde(deserialize_with = "nullable_vec")]
    sessions: Vec<SessionSummary>,
}
#[derive(Serialize)]
struct SessionRequest {
    session_id: SessionId,
}

#[derive(Serialize)]
struct ProcessRequest {
    session_id: SessionId,
    block_id: BlockId,
    args: Empty,
}
#[derive(Deserialize)]
struct TerminalProcess {
    child: Option<TerminalChild>,
}
#[derive(Deserialize)]
struct TerminalChild {
    #[serde(rename = "pid")]
    _pid: u32,
}
#[derive(Serialize)]
struct BlockRequest {
    session_id: SessionId,
    block_id: BlockId,
}
#[derive(Serialize)]
struct NewWindowRequest {
    session_id: SessionId,
    window_label: String,
    layout: SingleBlock,
    focus: bool,
}
#[derive(Serialize)]
struct MoveSession {
    session_id: SessionId,
    before_session_id: Option<SessionId>,
}

#[derive(Deserialize, Serialize)]
struct CreateRequest {
    label: String,
    initial_windows: [InitialWindow; 1],
}
impl CreateRequest {
    fn worker(title: &str, program: &str, args: &[String], cwd: &Path) -> Result<Self, RexError> {
        let cwd = cwd
            .to_str()
            .filter(|_| cwd.is_absolute())
            .ok_or(RexError::InvalidInput)?;
        if title.trim().is_empty()
            || title.chars().count() > 128
            || title.chars().any(char::is_control)
            || program.is_empty()
            || program.contains('\0')
            || cwd.contains('\0')
            || args.iter().any(|arg| arg.contains('\0'))
        {
            return Err(RexError::InvalidInput);
        }
        let command = std::iter::once(program.to_owned())
            .chain(args.iter().cloned())
            .collect();
        Ok(Self {
            label: title.to_owned(),
            initial_windows: [InitialWindow {
                window_label: "Worker".to_owned(),
                layout: SingleBlock {
                    block: WorkerBlock {
                        flavor: TerminalFlavor::Shell,
                        label: "Worker".to_owned(),
                        options: TerminalOptions {
                            shell: DirectShell::None,
                            command,
                            cwd: cwd.to_owned(),
                            path_prepend: std::env::var_os("PATH")
                                .map(|path| {
                                    std::env::split_paths(&path)
                                        .map(|directory| {
                                            directory
                                                .into_os_string()
                                                .into_string()
                                                .map_err(|_| RexError::InvalidInput)
                                        })
                                        .collect::<Result<Vec<_>, _>>()
                                })
                                .transpose()?
                                .unwrap_or_default(),
                            exit: ExitPolicy {
                                on_completion: false,
                            },
                        },
                    },
                },
            }],
        })
    }
}
#[derive(Deserialize, Serialize)]
struct InitialWindow {
    window_label: String,
    layout: SingleBlock,
}
#[derive(Deserialize, Serialize)]
struct SingleBlock {
    block: WorkerBlock,
}
#[derive(Deserialize, Serialize)]
struct WorkerBlock {
    flavor: TerminalFlavor,
    label: String,
    options: TerminalOptions,
}
#[derive(Deserialize, Serialize)]
enum TerminalFlavor {
    #[serde(rename = "com.superlogical.terminal.shell")]
    Shell,
}
#[derive(Deserialize, Serialize)]
enum DirectShell {
    #[serde(rename = "none")]
    None,
}
#[derive(Deserialize, Serialize)]
struct TerminalOptions {
    shell: DirectShell,
    command: Vec<String>,
    cwd: String,
    path_prepend: Vec<String>,
    exit: ExitPolicy,
}
#[derive(Deserialize, Serialize)]
struct ExitPolicy {
    on_completion: bool,
}
#[derive(Deserialize)]
struct CreatedHeader {
    session_id: SessionId,
}
#[derive(Deserialize)]
struct CreatedSession {
    session_id: SessionId,
    initial_windows: Vec<CreatedWindow>,
}
#[derive(Deserialize)]
struct CreatedWindow {
    window_id: WindowId,
    block_ids: Vec<BlockId>,
    revision: u64,
}
fn decode_creation(output: &[u8]) -> Result<WorkerBinding, RexError> {
    let receipt: CreatedSession =
        serde_json::from_slice(output).map_err(|_| RexError::CreationUncertain {
            session_id: serde_json::from_slice::<CreatedHeader>(output)
                .ok()
                .map(|header| header.session_id),
        })?;
    let session_id = receipt.session_id;
    let [window] = receipt.initial_windows.as_slice() else {
        return Err(RexError::CreationUncertain {
            session_id: Some(session_id),
        });
    };
    let [block] = window.block_ids.as_slice() else {
        return Err(RexError::CreationUncertain {
            session_id: Some(session_id),
        });
    };
    Ok(WorkerBinding {
        session_id,
        window_id: window.window_id.clone(),
        block_id: block.clone(),
        revision: window.revision,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    const SESSION: &str = "session:11111111-1111-4111-8111-111111111111";
    const WINDOW: &str = "window:22222222-2222-4222-8222-222222222222";
    const BLOCK: &str = "block:33333333-3333-4333-8333-333333333333";
    const HOST: &str = "44444444-4444-4444-8444-444444444444";

    #[test]
    fn validates_native_id_kinds_and_rejects_nil_or_malformed_ids() {
        assert!(SessionId::parse(SESSION).is_ok());
        assert!(BlockId::parse(SESSION).is_err());
        assert!(SessionId::parse("session:not-an-id").is_err());
        assert!(HostId::parse("00000000-0000-0000-0000-000000000000").is_err());
        assert!(
            serde_json::from_str::<SessionId>(r#""block:33333333-3333-4333-8333-333333333333""#)
                .is_err()
        );
    }

    #[test]
    fn worker_request_roundtrip_preserves_literal_argv_and_one_direct_worker() {
        let args = vec![
            "a b".to_owned(),
            "$(not-a-shell)".to_owned(),
            "; literal".to_owned(),
        ];
        let request = CreateRequest::worker(
            "Synthetic task",
            "/tool/agent",
            &args,
            Path::new("/workspace/project"),
        )
        .unwrap();
        let bytes = serde_json::to_vec(&request).unwrap();
        let decoded: CreateRequest = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(decoded.initial_windows.len(), 1);
        let worker = &decoded.initial_windows[0].layout.block;
        assert_eq!(worker.label, "Worker");
        assert!(matches!(worker.options.shell, DirectShell::None));
        assert_eq!(
            worker.options.command,
            [vec!["/tool/agent".to_owned()], args].concat()
        );
        assert_eq!(worker.options.cwd, "/workspace/project");
        assert_eq!(
            worker.options.path_prepend,
            std::env::split_paths(&std::env::var_os("PATH").unwrap())
                .map(|path| path.into_os_string().into_string().unwrap())
                .collect::<Vec<_>>()
        );
        assert!(!worker.options.exit.on_completion);
        assert!(CreateRequest::worker("Task", "tool", &[], Path::new("relative")).is_err());
    }

    #[test]
    fn creation_receipt_preserves_known_identity_when_result_is_uncertain() {
        let valid = format!(
            r#"{{"session_id":"{SESSION}","initial_windows":[{{"window_id":"{WINDOW}","block_ids":["{BLOCK}"],"revision":1}}]}}"#
        );
        let binding = decode_creation(valid.as_bytes()).unwrap();
        assert_eq!(binding.block_id.as_str(), BLOCK);
        let partial = format!(r#"{{"session_id":"{SESSION}","initial_windows":[]}}"#);
        assert_eq!(
            decode_creation(partial.as_bytes()).unwrap_err(),
            RexError::CreationUncertain {
                session_id: Some(SessionId::parse(SESSION).unwrap()),
            }
        );
        assert_eq!(
            decode_creation(b"not json").unwrap_err(),
            RexError::CreationUncertain { session_id: None }
        );
    }

    #[test]
    fn verifies_session_window_block_and_host_not_only_a_mutable_title() {
        let receipt = format!(
            r#"{{"session_id":"{SESSION}","initial_windows":[{{"window_id":"{WINDOW}","block_ids":["{BLOCK}"],"revision":1}}]}}"#
        );
        let binding = decode_creation(receipt.as_bytes()).unwrap();
        let view = format!(
            r#"{{"session_id":"{SESSION}","revision":2,"label":"Renamed","windows":[{{"window_id":"{WINDOW}","layers":[{{"blocks":[{{"block_id":"{BLOCK}","host_id":"{HOST}","flavor":"com.superlogical.terminal.shell","label":"Worker"}}]}}]}}]}}"#
        );
        let view: SessionView = decode(view.as_bytes()).unwrap();
        assert!(
            view.verify_binding(&binding, &HostId::parse(HOST).unwrap())
                .is_ok()
        );
        let other = HostId::parse("55555555-5555-4555-8555-555555555555").unwrap();
        assert_eq!(
            view.verify_binding(&binding, &other),
            Err(RexError::BindingMismatch)
        );
        assert!(
            decode::<SessionList>(br#"{"sessions":null}"#)
                .unwrap()
                .sessions
                .is_empty()
        );
        assert!(decode::<SessionList>(b"{}").is_err());
    }

    #[test]
    fn cli_argv_disables_autostart_and_scopes_server_without_shell_interpolation() {
        let client = RexClient::new(Some("https://worker.example.invalid".to_owned()));
        let command = client
            .command(&["whoami".to_owned(), "--json".to_owned()])
            .unwrap();
        let args: Vec<_> = command
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            [
                "--autostart=false",
                "--timeout",
                "8s",
                "--server",
                "https://worker.example.invalid",
                "whoami",
                "--json"
            ]
        );
    }

    #[derive(Deserialize)]
    struct NativeWindows {
        windows: Vec<NamedWindow>,
    }
    #[derive(Deserialize)]
    struct NamedWindow {
        window_id: WindowId,
        label: String,
    }
    #[derive(Deserialize)]
    struct NativeProcess {
        child: Option<TerminalChild>,
        last_exit: Option<NativeExit>,
    }
    #[derive(Deserialize)]
    struct NativeExit {
        exit_code: i32,
    }

    async fn assert_native_output(
        client: &RexClient,
        binding: &WorkerBinding,
        marker: &str,
    ) -> anyhow::Result<()> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let process: NativeProcess = decode(
                &client
                    .api(
                        "com.superlogical.terminal.process",
                        &ProcessRequest {
                            session_id: binding.session_id.clone(),
                            block_id: binding.block_id.clone(),
                            args: Empty {},
                        },
                    )
                    .await
                    .map_err(read_failure)?,
            )?;
            if process.child.is_none()
                && let Some(exit) = process.last_exit
            {
                anyhow::ensure!(
                    exit.exit_code == 0,
                    "Native marker process did not exit successfully"
                );
                break;
            }
            anyhow::ensure!(
                tokio::time::Instant::now() < deadline,
                "Native marker process did not finish"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let output = client
            .run(vec![
                "capture".to_owned(),
                "-s".to_owned(),
                binding.session_id.to_string(),
                "-b".to_owned(),
                binding.block_id.to_string(),
                "--trim".to_owned(),
                "--unwrap".to_owned(),
            ])
            .await
            .map_err(read_failure)?;
        anyhow::ensure!(
            String::from_utf8(output)?.contains(marker),
            "Native terminal did not show the marker"
        );
        Ok(())
    }

    async fn close_test_session(client: &RexClient, session: &SessionId) -> anyhow::Result<()> {
        // One exact native kill, followed by independent state readback even if its reply was lost.
        let killed = client
            .run(vec!["kill".to_owned(), session.to_string()])
            .await;
        let absent = !client
            .list_sessions()
            .await?
            .iter()
            .any(|item| item.session_id == *session);
        anyhow::ensure!(absent, "The test-created Rex session remains after cleanup");
        if killed.is_err() {
            eprintln!(
                "Native kill reply was unavailable; independent listing verified test-session removal."
            );
        }
        Ok(())
    }

    /// Opt-in only: creates and removes one synthetic session on the selected running Rex server.
    /// Set AGENT_TEST_REX_SERVER for a remote server; omit it for the local server.
    #[tokio::test]
    #[ignore = "requires a running Rex server; creates and removes one synthetic session"]
    async fn live_native_rex_worker_contract() -> anyhow::Result<()> {
        let client = RexClient::new(std::env::var("AGENT_TEST_REX_SERVER").ok());
        let identity = client.whoami().await?;
        let before = client.list_sessions().await?;
        let title = format!("agent-rex-contract-{}", Uuid::new_v4());
        let marker = "agent-rex-contract-marker";
        let args = vec![format!("{marker}\n")];
        let binding = match client
            .create_session(&title, "/usr/bin/printf", &args, Path::new("/tmp"))
            .await
        {
            Ok(binding) => binding,
            Err(error) => {
                // Reconcile this unique test label without issuing a second create.
                let candidates: Vec<_> = client
                    .list_sessions()
                    .await?
                    .into_iter()
                    .filter(|item| {
                        item.label == title
                            && !before.iter().any(|old| old.session_id == item.session_id)
                    })
                    .collect();
                anyhow::ensure!(
                    candidates.len() <= 1,
                    "Could not identify the single test allocation for cleanup"
                );
                if let Some(created) = candidates.first() {
                    close_test_session(&client, &created.session_id).await?;
                }
                return Err(error.into());
            }
        };
        let result = tokio::time::timeout(Duration::from_secs(120), async {
            let view = client.inspect_session(&binding.session_id).await?;
            view.verify_binding(&binding, &identity.host_id)?;
            anyhow::ensure!(
                view.label.as_deref() == Some(&title),
                "Native task session label changed"
            );
            assert_native_output(&client, &binding, marker).await?;

            let review = client
                .create_worker_window(
                    &binding.session_id,
                    "Review",
                    "/usr/bin/printf",
                    &args,
                    Path::new("/tmp"),
                )
                .await?;
            anyhow::ensure!(
                review.session_id == binding.session_id
                    && review.window_id != binding.window_id
                    && review.block_id != binding.block_id,
                "The task agent did not get a separate terminal in the same session"
            );
            let view = client.inspect_session(&binding.session_id).await?;
            view.verify_binding(&binding, &identity.host_id)?;
            view.verify_binding(&review, &identity.host_id)?;
            anyhow::ensure!(
                view.windows.len() == 2,
                "Expected one parent and one agent window"
            );
            let labels: NativeWindows = decode(
                &client
                    .run(vec![
                        "window".to_owned(),
                        "ls".to_owned(),
                        "-s".to_owned(),
                        binding.session_id.to_string(),
                        "--json".to_owned(),
                    ])
                    .await
                    .map_err(read_failure)?,
            )?;
            anyhow::ensure!(
                labels
                    .windows
                    .iter()
                    .any(|window| window.window_id == binding.window_id && window.label == "Worker")
                    && labels
                        .windows
                        .iter()
                        .any(|window| window.window_id == review.window_id
                            && window.label == "Review"),
                "Native window labels do not identify their work"
            );
            anyhow::ensure!(
                view.windows
                    .iter()
                    .flat_map(|window| &window.layers)
                    .flat_map(|layer| &layer.blocks)
                    .any(|block| block.block_id.as_ref() == Some(&review.block_id)
                        && block.label.as_deref() == Some("Review")),
                "Native agent terminal label is missing"
            );
            assert_native_output(&client, &review, marker).await?;

            let resumed = match client
                .resume_worker(&binding, "/usr/bin/printf", &args, Path::new("/tmp"))
                .await?
            {
                WorkerResume::Started(resumed) => resumed,
                WorkerResume::Running => {
                    anyhow::bail!("An exited parent was incorrectly reported as running")
                }
            };
            anyhow::ensure!(
                resumed.session_id == binding.session_id && resumed.block_id != binding.block_id,
                "Parent resume allocated a different task session"
            );
            let view = client.inspect_session(&binding.session_id).await?;
            view.verify_binding(&resumed, &identity.host_id)?;
            view.verify_binding(&review, &identity.host_id)?;
            anyhow::ensure!(
                view.windows.len() == 2
                    && !view
                        .windows
                        .iter()
                        .flat_map(|window| &window.layers)
                        .flat_map(|layer| &layer.blocks)
                        .any(|block| block.block_id.as_ref() == Some(&binding.block_id)),
                "Parent resume left its exited owned terminal behind"
            );
            assert_native_output(&client, &resumed, marker).await?;

            client
                .api(
                    "session.move",
                    &MoveSession {
                        session_id: binding.session_id.clone(),
                        before_session_id: None,
                    },
                )
                .await
                .map_err(read_failure)?;
            client.promote_session(&binding.session_id).await?;
            let sessions = client.list_sessions().await?;
            anyhow::ensure!(
                sessions
                    .first()
                    .is_some_and(|session| session.session_id == binding.session_id),
                "Promoted task is not first in the native sidebar"
            );
            anyhow::ensure!(
                sessions
                    .iter()
                    .filter(|session| session.label == title)
                    .count()
                    == 1,
                "Native task session was duplicated"
            );
            Ok::<_, anyhow::Error>(())
        })
        .await;
        let cleanup = close_test_session(&client, &binding.session_id).await;
        cleanup?;
        result
            .map_err(|_| anyhow::anyhow!("Native Rex contract exceeded its two-minute limit"))??;
        eprintln!(
            "Native Rex contract verified: three successful marker processes, two named windows in one session, parent reuse, sidebar promotion, and independent cleanup readback."
        );
        Ok(())
    }
}
