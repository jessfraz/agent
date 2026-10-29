//! Browser handles belong to one conversation, host and live connection.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::Mutex,
    time::timeout,
};
use ts_rs::TS;
use uuid::Uuid;

use crate::runtime::FrameReader;

/// Selects an existing Chrome profile. Pairing credentials arrive through the
/// helper environment and never enter these serialized helper arguments.
#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct BrowserConfig {
    pub user_data_dir: Option<PathBuf>,
    pub profile_dir_name: Option<String>,
    // Optional credential launcher prefix, e.g. ["with-credentials", "browser", "--"].
    // It wraps only the browser helper, so unavailable browser credentials do
    // not prevent the rest of Agent from starting.
    pub credential_command: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct BrowserRequest {
    pub owner_id: Uuid,
    pub session_id: Uuid,
    pub operation_id: String,
    pub action: BrowserAction,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum BrowserAction {
    Status,
    Open {
        url: String,
    },
    NewTab {
        url: String,
    },
    Snapshot {
        tab_id: u32,
    },
    Navigate {
        tab_id: u32,
        url: String,
    },
    Click {
        tab_id: u32,
        element_ref: String,
    },
    Fill {
        tab_id: u32,
        element_ref: String,
        value: String,
    },
    PressKey {
        tab_id: u32,
        key: String,
    },
    WaitFor {
        tab_id: u32,
        text: String,
    },
    HandleDialog {
        tab_id: u32,
        accept: bool,
        prompt_text: Option<String>,
    },
    CloseTab {
        tab_id: u32,
    },
    RetainTab {
        tab_id: u32,
    },
    Release,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct BrowserTab {
    pub id: u32,
    pub url: String,
    pub title: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum BrowserResponse {
    Ready {
        session_id: Uuid,
        tabs: Vec<BrowserTab>,
        output: String,
        is_error: bool,
    },
    Closed {
        session_id: Uuid,
        tabs: Vec<BrowserTab>,
        output: String,
    },
    Disconnected {
        session_id: Uuid,
        message: String,
    },
    Failed {
        session_id: Uuid,
        message: String,
    },
    Uncertain {
        session_id: Uuid,
        message: String,
    },
}

impl BrowserResponse {
    pub fn session_id(&self) -> Uuid {
        match self {
            Self::Ready { session_id, .. }
            | Self::Closed { session_id, .. }
            | Self::Disconnected { session_id, .. }
            | Self::Failed { session_id, .. }
            | Self::Uncertain { session_id, .. } => *session_id,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct BrowserReply {
    pub operation_id: String,
    pub response: BrowserResponse,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum BrowserConnectionState {
    Opening,
    Connected,
    Uncertain,
    Disconnected,
    Released,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct BrowserBinding {
    pub owner_id: Uuid,
    pub host_id: String,
    pub session_id: Uuid,
    pub state: BrowserConnectionState,
    pub pending_operation: Option<String>,
    pub response: Option<BrowserResponse>,
}

struct Process {
    session_id: Uuid,
    child: Child,
    input: Option<ChildStdin>,
    output: FrameReader<BufReader<ChildStdout>>,
}

impl Process {
    fn start(runtime: &Path, config: &BrowserConfig, session_id: Uuid) -> Result<Self> {
        let helper = runtime.with_file_name("browser-host.js");
        ensure!(
            helper.is_file(),
            "Browser runtime is missing; update Agent on this host"
        );
        let mut command = if let Some((program, arguments)) = config
            .credential_command
            .as_deref()
            .and_then(|command| command.split_first())
        {
            let mut command = Command::new(program);
            command.args(arguments).arg("node");
            command
        } else {
            Command::new("node")
        };
        let mut child = command
            .arg(helper)
            .arg(serde_json::to_string(config)?)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            // Closing stdin asks the helper to disconnect its MCP child. Chrome
            // is externally owned and must outlive this process.
            .kill_on_drop(false)
            .spawn()
            .context("Could not start the browser runtime")?;
        let input = child.stdin.take().context("Browser runtime has no input")?;
        let output = child
            .stdout
            .take()
            .context("Browser runtime has no output")?;
        Ok(Self {
            session_id,
            child,
            input: Some(input),
            output: FrameReader::new(BufReader::new(output)),
        })
    }

    async fn exchange(&mut self, request: &BrowserRequest) -> Result<BrowserResponse> {
        let input = self
            .input
            .as_mut()
            .context("Browser connection is closed")?;
        let mut line = serde_json::to_vec(request)?;
        line.push(b'\n');
        input.write_all(&line).await?;
        input.flush().await?;
        let frame = self
            .output
            .next_frame()
            .await?
            .context("Browser runtime disconnected")?;
        let reply: BrowserReply =
            serde_json::from_slice(&frame).context("Invalid browser reply")?;
        ensure!(
            reply.operation_id == request.operation_id
                && reply.response.session_id() == request.session_id,
            "Browser reply belongs to another operation or connection"
        );
        Ok(reply.response)
    }

    async fn close(&mut self) {
        self.input.take();
        if timeout(Duration::from_secs(5), self.child.wait())
            .await
            .is_err()
        {
            if let Some(pid) = self.child.id().and_then(|id| i32::try_from(id).ok()) {
                // The helper handles SIGTERM by closing Pi's stdio transport,
                // which reaps its own MCP process group.
                unsafe {
                    libc::kill(pid, libc::SIGTERM);
                }
            }
            if timeout(Duration::from_secs(5), self.child.wait())
                .await
                .is_err()
            {
                let _ = self.child.kill().await;
            }
        }
    }
}

/// The host service owns connections across chat turns and client detachment.
pub struct BrowserHost {
    runtime: Option<PathBuf>,
    config: Option<BrowserConfig>,
    sessions: Mutex<HashMap<Uuid, Arc<Mutex<Process>>>>,
}

impl Default for BrowserHost {
    fn default() -> Self {
        Self {
            runtime: None,
            config: None,
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

impl BrowserHost {
    pub fn new(runtime: &Path, config: Option<BrowserConfig>) -> Self {
        Self {
            runtime: Some(runtime.to_owned()),
            config,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub async fn execute(
        &self,
        request: BrowserRequest,
        cancelled: tokio::sync::watch::Receiver<bool>,
    ) -> BrowserResponse {
        match self.request(&request, &cancelled).await {
            Ok(response) => response,
            Err(_) => BrowserResponse::Uncertain { session_id: request.session_id,
                message: "The browser did not confirm this operation. Inspect its outcome before repeating it; browser effects are never replayed automatically.".into() },
        }
    }

    async fn request(
        &self,
        request: &BrowserRequest,
        cancelled: &tokio::sync::watch::Receiver<bool>,
    ) -> Result<BrowserResponse> {
        let mut sessions = self.sessions.lock().await;
        if *cancelled.borrow() {
            return Ok(BrowserResponse::Failed {
                session_id: request.session_id,
                message: "Browser operation was interrupted before it started.".into(),
            });
        }
        if matches!(request.action, BrowserAction::Open { .. }) {
            if sessions.contains_key(&request.owner_id) {
                return Ok(BrowserResponse::Failed { session_id: request.session_id,
                    message: "This conversation already owns a browser connection; inspect or release it before opening another.".into() });
            }
            let Some(config) = &self.config else {
                return Ok(BrowserResponse::Failed { session_id: request.session_id,
                    message: "Chrome is not configured on this host. Add a [browser] section to its private Agent configuration and pair the Playwright extension in its existing Chrome profile.".into() });
            };
            let runtime = self
                .runtime
                .as_deref()
                .context("Browser runtime is unavailable")?;
            let process = match Process::start(runtime, config, request.session_id) {
                Ok(process) => process,
                Err(_) => return Ok(BrowserResponse::Failed {
                    session_id: request.session_id,
                    message: "The browser runtime could not start. Build or update Agent on this host before connecting Chrome.".into(),
                }),
            };
            sessions.insert(request.owner_id, Arc::new(Mutex::new(process)));
        }
        let Some(process) = sessions.get(&request.owner_id).cloned() else {
            return Ok(BrowserResponse::Disconnected { session_id: request.session_id,
                message: "This host has no live browser connection for this conversation. Previous tab handles are stale; open a new connection to continue.".into() });
        };
        drop(sessions);
        let mut live = process.lock().await;
        if live.session_id != request.session_id {
            return Ok(BrowserResponse::Disconnected { session_id: request.session_id,
                message: "This browser handle belongs to an older connection; inspect the current conversation's browser state.".into() });
        }
        if *cancelled.borrow() {
            if matches!(request.action, BrowserAction::Open { .. }) {
                // Allocation can finish while an interrupt arrives. No browser
                // action has started, so release the newly allocated helper.
                live.close().await;
                let mut sessions = self.sessions.lock().await;
                if sessions
                    .get(&request.owner_id)
                    .is_some_and(|saved| Arc::ptr_eq(saved, &process))
                {
                    sessions.remove(&request.owner_id);
                }
            }
            return Ok(BrowserResponse::Failed {
                session_id: request.session_id,
                message: "Browser operation was interrupted before it started.".into(),
            });
        }
        let result = timeout(Duration::from_secs(150), live.exchange(request)).await;
        let result = match result {
            Ok(result) => result,
            Err(error) => Err(error.into()),
        };
        let release = match &result {
            Ok(BrowserResponse::Closed { .. } | BrowserResponse::Disconnected { .. }) | Err(_) => {
                true
            }
            Ok(BrowserResponse::Failed { .. }) => {
                matches!(request.action, BrowserAction::Open { .. })
            }
            _ => false,
        };
        if release {
            live.close().await;
            let mut sessions = self.sessions.lock().await;
            if sessions
                .get(&request.owner_id)
                .is_some_and(|saved| Arc::ptr_eq(saved, &process))
            {
                sessions.remove(&request.owner_id);
            }
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::time::Duration;

    use tokio::{
        fs,
        sync::watch,
        time::{sleep, timeout},
    };
    use uuid::Uuid;

    use crate::browser::{
        BrowserAction, BrowserConfig, BrowserHost, BrowserRequest, BrowserResponse,
    };

    const FIXTURE: &str = r#"
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const {user_data_dir: directory} = JSON.parse(process.argv[2]);
writeFileSync(join(directory, 'pid'), String(process.pid));
writeFileSync(join(directory, 'wrapper'), process.env.AGENT_BROWSER_FIXTURE_WRAPPER ?? '');
const input = createInterface({input:process.stdin});
input.on('line', async line => {
  const request = JSON.parse(line);
  appendFileSync(join(directory, 'effects'), request.operation_id + '\n');
  if (request.operation_id === 'held') await new Promise(resolve => setTimeout(resolve, 200));
  if (request.operation_id === 'wrong-receipt') {
    process.stdout.write(JSON.stringify({operation_id:'other-operation',response:{type:'ready',session_id:request.session_id,tabs:[],output:'PRIVATE_FIXTURE_SENTINEL',is_error:false}})+'\n');
    return;
  }
  process.stdout.write(JSON.stringify({operation_id:request.operation_id,response:request.action.type==='release'
    ? {type:'closed',session_id:request.session_id,tabs:[],output:'released'}
    : {type:'ready',session_id:request.session_id,tabs:[],output:request.operation_id,is_error:false}})+'\n');
});
input.on('close', () => { writeFileSync(join(directory, 'closed'), 'closed'); });
"#;

    async fn host(directory: &Path) -> BrowserHost {
        fs::write(directory.join("browser-host.js"), FIXTURE)
            .await
            .unwrap();
        BrowserHost::new(
            &directory.join("bridge.js"),
            Some(BrowserConfig {
                user_data_dir: Some(directory.to_owned()),
                profile_dir_name: None,
                credential_command: None,
            }),
        )
    }

    fn request(
        owner: Uuid,
        session: Uuid,
        operation: &str,
        action: BrowserAction,
    ) -> BrowserRequest {
        BrowserRequest {
            owner_id: owner,
            session_id: session,
            operation_id: operation.into(),
            action,
        }
    }

    async fn wait_for(path: &Path) {
        timeout(Duration::from_secs(3), async {
            while !path.exists() {
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn browser_credentials_wrap_only_the_owned_helper() {
        let directory = tempfile::tempdir().unwrap();
        let mut host = host(directory.path()).await;
        host.config.as_mut().unwrap().credential_command = Some(vec![
            "env".into(),
            "AGENT_BROWSER_FIXTURE_WRAPPER=wrapped".into(),
        ]);
        let owner = Uuid::new_v4();
        let session = Uuid::new_v4();
        let (_stop, cancelled) = watch::channel(false);
        assert!(matches!(
            host.execute(
                request(
                    owner,
                    session,
                    "open",
                    BrowserAction::Open {
                        url: "about:blank".into()
                    }
                ),
                cancelled.clone()
            )
            .await,
            BrowserResponse::Ready { .. }
        ));
        assert_eq!(
            fs::read_to_string(directory.path().join("wrapper"))
                .await
                .unwrap(),
            "wrapped"
        );
        assert!(matches!(
            host.execute(
                request(owner, session, "release", BrowserAction::Release),
                cancelled
            )
            .await,
            BrowserResponse::Closed { .. }
        ));
        wait_for(&directory.path().join("closed")).await;
    }

    #[tokio::test]
    async fn host_retains_connection_and_rejects_stale_handles_without_retargeting() {
        let directory = tempfile::tempdir().unwrap();
        let host = host(directory.path()).await;
        let owner = Uuid::new_v4();
        let session = Uuid::new_v4();
        let (_stop, cancelled) = watch::channel(false);
        assert!(matches!(
            host.execute(
                request(
                    owner,
                    session,
                    "open",
                    BrowserAction::Open {
                        url: "https://example.com".into()
                    }
                ),
                cancelled.clone()
            )
            .await,
            BrowserResponse::Ready { .. }
        ));
        let stale = Uuid::new_v4();
        assert!(
            matches!(host.execute(request(owner, stale, "stale", BrowserAction::Status), cancelled.clone()).await, BrowserResponse::Disconnected { session_id, .. } if session_id == stale)
        );
        assert!(matches!(
            host.execute(
                request(owner, session, "status", BrowserAction::Status),
                cancelled.clone()
            )
            .await,
            BrowserResponse::Ready { .. }
        ));
        assert!(matches!(
            host.execute(
                request(owner, session, "release", BrowserAction::Release),
                cancelled.clone()
            )
            .await,
            BrowserResponse::Closed { .. }
        ));
        assert_eq!(
            fs::read_to_string(directory.path().join("effects"))
                .await
                .unwrap(),
            "open\nstatus\nrelease\n"
        );
        wait_for(&directory.path().join("closed")).await;
        assert!(matches!(
            host.execute(
                request(owner, session, "after-close", BrowserAction::Status),
                cancelled
            )
            .await,
            BrowserResponse::Disconnected { .. }
        ));
    }

    #[tokio::test]
    async fn cancellation_keeps_issued_effect_but_fences_a_call_waiting_for_its_connection() {
        let directory = tempfile::tempdir().unwrap();
        let host = host(directory.path()).await;
        let owner = Uuid::new_v4();
        let session = Uuid::new_v4();
        let (_stop, cancelled) = watch::channel(false);
        let (stop_queued, queued_cancelled) = watch::channel(false);
        let opened = host.execute(
            request(
                owner,
                session,
                "held",
                BrowserAction::Open {
                    url: "https://example.com".into(),
                },
            ),
            cancelled.clone(),
        );
        let queued = async {
            wait_for(&directory.path().join("effects")).await;
            let operation = host.execute(
                request(
                    owner,
                    session,
                    "must-not-start",
                    BrowserAction::NewTab {
                        url: "https://example.com/another".into(),
                    },
                ),
                queued_cancelled,
            );
            let stop = async {
                sleep(Duration::from_millis(20)).await;
                stop_queued.send(true).unwrap();
            };
            let (result, ()) = tokio::join!(operation, stop);
            result
        };
        let (first, second) = tokio::join!(opened, queued);
        assert!(matches!(first, BrowserResponse::Ready { .. }));
        assert!(matches!(second, BrowserResponse::Failed { .. }));
        assert_eq!(
            fs::read_to_string(directory.path().join("effects"))
                .await
                .unwrap(),
            "held\n"
        );
        host.execute(
            request(owner, session, "release", BrowserAction::Release),
            cancelled,
        )
        .await;
    }

    #[tokio::test]
    async fn a_mismatched_receipt_is_uncertain_and_closes_only_its_owned_helper() {
        let directory = tempfile::tempdir().unwrap();
        let host = host(directory.path()).await;
        let owner = Uuid::new_v4();
        let session = Uuid::new_v4();
        let (_stop, cancelled) = watch::channel(false);
        let result = host
            .execute(
                request(
                    owner,
                    session,
                    "wrong-receipt",
                    BrowserAction::Open {
                        url: "https://example.com".into(),
                    },
                ),
                cancelled.clone(),
            )
            .await;
        let BrowserResponse::Uncertain {
            session_id,
            message,
        } = result
        else {
            panic!("An unrelated receipt must not confirm an effect");
        };
        assert_eq!(session_id, session);
        assert!(!message.contains("PRIVATE_FIXTURE_SENTINEL"));
        wait_for(&directory.path().join("closed")).await;
        assert!(matches!(
            host.execute(
                request(owner, session, "inspect", BrowserAction::Status),
                cancelled
            )
            .await,
            BrowserResponse::Disconnected { .. }
        ));
        assert_eq!(
            fs::read_to_string(directory.path().join("effects"))
                .await
                .unwrap(),
            "wrong-receipt\n"
        );
    }

    #[tokio::test]
    async fn dropping_the_host_disconnects_its_helper_through_eof() {
        let directory = tempfile::tempdir().unwrap();
        let host = host(directory.path()).await;
        let (_stop, cancelled) = watch::channel(false);
        let result = host
            .execute(
                request(
                    Uuid::new_v4(),
                    Uuid::new_v4(),
                    "open",
                    BrowserAction::Open {
                        url: "https://example.com".into(),
                    },
                ),
                cancelled,
            )
            .await;
        assert!(matches!(result, BrowserResponse::Ready { .. }));
        let pid: i32 = fs::read_to_string(directory.path().join("pid"))
            .await
            .unwrap()
            .parse()
            .unwrap();
        drop(host);
        wait_for(&directory.path().join("closed")).await;
        timeout(Duration::from_secs(3), async {
            while unsafe { libc::kill(pid, 0) } == 0 {
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }
}
