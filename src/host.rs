//! Effects run on the attached CLI's machine, never an implicit fallback host.
use std::{
    future::Future,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use tokio::{
    fs,
    io::{AsyncRead, AsyncReadExt, AsyncSeekExt},
    process::Command,
    time::{sleep, timeout},
};

use crate::{
    embeddings::{EmbeddingProvider, llama::LlamaProvider},
    history::{HistorySource, codex::CodexHistory},
    protocol::{HostCommand, HostResult, TaskId, WorkerHost, WorkerRef},
    resources::{ResourceBackend, git::GitBackend},
    rex::{BlockId, HostId, RexClient, RexError, SessionId, WindowId, WorkerBinding, WorkerResume},
};

pub const DEFAULT_TIMEOUT_SECONDS: u16 = 15 * 60;

/// One service owns its history connection and warm embedding child.
pub struct Executor {
    history: CodexHistory,
    embeddings: tokio::sync::Mutex<Option<Arc<LlamaProvider>>>,
    state: PathBuf,
    daemon: crate::tailnet::Daemon,
    browser: crate::browser::BrowserHost,
}

impl Executor {
    pub fn new(state: &Path) -> Self {
        Self::with_tailscale(state, crate::tailnet::Daemon::default())
    }

    pub fn with_tailscale(state: &Path, daemon: crate::tailnet::Daemon) -> Self {
        Self {
            history: CodexHistory::new(),
            embeddings: tokio::sync::Mutex::new(None),
            state: state.to_owned(),
            daemon,
            browser: crate::browser::BrowserHost::default(),
        }
    }

    pub fn with_browser(
        mut self,
        runtime: &Path,
        config: Option<crate::browser::BrowserConfig>,
    ) -> Self {
        self.browser = crate::browser::BrowserHost::new(runtime, config);
        self
    }

    pub async fn execute(&self, command: HostCommand) -> HostResult {
        let result = match command {
            HostCommand::AttachmentWrite {
                attachment,
                offset,
                data_base64,
                complete,
            } => {
                crate::attachments::write_on_host(
                    &self.state,
                    attachment,
                    offset,
                    data_base64,
                    complete,
                )
                .await
            }
            HostCommand::Browser { host_id, request } => {
                async {
                    require_local_host(&host_id).await?;
                    let (_owner, cancelled) = tokio::sync::watch::channel(false);
                    Ok(HostResult::Browser {
                        response: self.browser.execute(request, cancelled).await,
                    })
                }
                .await
            }
            HostCommand::MachineSnapshot => crate::machines::observe(&self.daemon)
                .await
                .map(|snapshot| HostResult::MachineSnapshot { snapshot }),
            HostCommand::History { request } => self
                .history
                .request(request)
                .await
                .map(|response| HostResult::History { response }),
            HostCommand::Embed { texts, purpose } => {
                async {
                    let provider = {
                        let mut saved = self.embeddings.lock().await;
                        if saved.is_none() {
                            *saved = Some(Arc::new(LlamaProvider::from_environment(&self.state)?));
                        }
                        saved
                            .as_ref()
                            .cloned()
                            .context("Embedding provider did not initialize")?
                    };
                    Ok(HostResult::Embeddings {
                        batch: provider.embed(&texts, purpose).await?,
                    })
                }
                .await
            }
            command => execute_inner(command).await,
        };
        result.unwrap_or_else(|error| HostResult::Failed {
            message: error.to_string(),
        })
    }

    pub async fn execute_cancelled(
        &self,
        command: HostCommand,
        mut cancelled: tokio::sync::watch::Receiver<bool>,
    ) -> HostResult {
        if let HostCommand::Browser { host_id, request } = &command {
            return match require_local_host(host_id).await {
                Ok(()) => HostResult::Browser {
                    response: self.browser.execute(request.clone(), cancelled).await,
                },
                Err(error) => HostResult::Failed {
                    message: error.to_string(),
                },
            };
        }
        if matches!(&command, HostCommand::Embed { .. }) {
            // Embeddings have no external write to reconcile. Dropping this
            // future releases its place behind background corpus work.
            return tokio::select! {
                biased;
                () = async {
                    loop {
                        if *cancelled.borrow_and_update() { return; }
                        if cancelled.changed().await.is_err() {
                            std::future::pending::<()>().await;
                        }
                    }
                } => HostResult::Failed { message: "History embedding was interrupted".into() },
                result = self.execute(command) => result,
            };
        }
        if let HostCommand::Exec {
            program,
            args,
            cwd,
            timeout_seconds,
        } = &command
            && !crate::sources::messages_read::is_read(program, args)
        {
            if *cancelled.borrow() {
                return HostResult::Process {
                    exit_code: 143,
                    stdout: String::new(),
                    stderr: "Command cancelled before starting.".into(),
                    truncated: false,
                };
            }
            let result = async {
                ensure!(
                    *timeout_seconds > 0 && !program.is_empty() && Path::new(cwd).is_absolute(),
                    "Command needs a program, absolute directory and positive timeout"
                );
                run_process_until(
                    program,
                    args,
                    Path::new(cwd),
                    Duration::from_secs(u64::from(*timeout_seconds)),
                    256 * 1024,
                    async move {
                        loop {
                            if *cancelled.borrow_and_update() {
                                break;
                            }
                            if cancelled.changed().await.is_err() {
                                std::future::pending::<()>().await;
                            }
                        }
                    },
                )
                .await
            }
            .await;
            return result.unwrap_or_else(|error| HostResult::Failed {
                message: error.to_string(),
            });
        }
        // Non-process effects may have already committed an external write.
        // Keep ownership until their real result arrives instead of guessing.
        self.execute(command).await
    }
}

pub async fn execute(command: HostCommand) -> HostResult {
    match execute_inner(command).await {
        Ok(result) => result,
        Err(error) => HostResult::Failed {
            message: error.to_string(),
        },
    }
}

async fn execute_inner(command: HostCommand) -> Result<HostResult> {
    match command {
        HostCommand::AttachmentWrite { .. } => {
            anyhow::bail!("Attachment transfer needs its owning host executor")
        }
        HostCommand::History { .. }
        | HostCommand::Browser { .. }
        | HostCommand::Embed { .. }
        | HostCommand::ReadUsage { .. }
        | HostCommand::MachineSnapshot => {
            anyhow::bail!("This operation requires a service-owned host executor")
        }
        HostCommand::ReloadGuidance => anyhow::bail!("Shared guidance belongs to the coordinator"),
        HostCommand::ProjectGuidance { cwd } => {
            ensure!(
                Path::new(&cwd).is_absolute(),
                "Project guidance requires an absolute directory"
            );
            Ok(HostResult::ProjectGuidance {
                snapshot: crate::instructions::project_snapshot(Path::new(&cwd))?,
            })
        }
        HostCommand::InspectWorker { binding } => {
            let client = RexClient::new(None);
            let identity = client.whoami().await?;
            ensure!(
                identity.host_id == HostId::parse(&binding.host_id)?,
                "Worker belongs to another host"
            );
            Ok(HostResult::WorkerPresence {
                presence: client
                    .worker_presence(&native_binding(&binding)?, &identity.host_id)
                    .await?,
            })
        }
        HostCommand::OnNode { .. }
        | HostCommand::Background { .. }
        | HostCommand::ReadContext { .. }
        | HostCommand::SearchContext { .. } => {
            anyhow::bail!("This operation requires the coordinator's registered host broker")
        }
        HostCommand::ResourceAllocate { request } => {
            require_local_host(&request.host_id).await?;
            Ok(HostResult::Resource {
                report: GitBackend::default().allocate(request).await,
            })
        }
        HostCommand::ResourceInspect { record } => {
            require_local_host(&record.host_id).await?;
            Ok(HostResult::Resource {
                report: GitBackend::default().inspect(*record).await,
            })
        }
        HostCommand::ResourcePlanCleanup { record } => {
            require_local_host(&record.host_id).await?;
            let directory = dirs::data_local_dir()
                .context("No local application data directory")?
                .join("agent/cleanup");
            let directory = directory
                .to_str()
                .context("Cleanup directory must be UTF-8")?;
            Ok(HostResult::Resource {
                report: GitBackend::default().plan_cleanup(*record, directory).await,
            })
        }
        HostCommand::ResourceCollect { record, plan } => {
            require_local_host(&record.host_id).await?;
            Ok(HostResult::Resource {
                report: GitBackend::default().collect(*record, plan).await,
            })
        }
        HostCommand::Exec {
            program,
            args,
            cwd,
            timeout_seconds,
        } => {
            ensure!(timeout_seconds > 0, "Command timeout must be positive");
            ensure!(
                !program.is_empty() && Path::new(&cwd).is_absolute(),
                "Command needs a program and absolute working directory"
            );
            if crate::sources::messages_read::is_read(&program, &args) {
                return crate::rex::source::execute(program, args, cwd, timeout_seconds).await;
            }
            run_process(
                &program,
                &args,
                Path::new(&cwd),
                Duration::from_secs(timeout_seconds.into()),
                256 * 1024,
            )
            .await
        }
        HostCommand::ReadFile {
            path,
            offset,
            limit,
        } => {
            ensure!(
                limit > 0 && limit <= 256 * 1024,
                "Read limit must be between 1 and 262144 bytes"
            );
            let mut file = fs::File::open(path)
                .await
                .context("Could not read the requested file")?;
            file.seek(std::io::SeekFrom::Start(offset.into())).await?;
            let mut contents = Vec::new();
            file.take(u64::from(limit) + 1)
                .read_to_end(&mut contents)
                .await?;
            let truncated = contents.len() > usize::try_from(limit)?;
            contents.truncate(usize::try_from(limit)?);
            Ok(HostResult::File {
                content: String::from_utf8_lossy(&contents).into_owned(),
                truncated,
            })
        }
        HostCommand::WriteFile { path, content } => {
            fs::write(path, content)
                .await
                .context("Could not write the requested file")?;
            Ok(HostResult::Written)
        }
        HostCommand::EditFile { path, old, new } => {
            ensure!(!old.is_empty(), "Edit needs nonempty original text");
            let contents = fs::read_to_string(&path)
                .await
                .context("Could not read the file to edit")?;
            ensure!(
                contents.match_indices(&old).count() == 1,
                "Edit must match exactly one occurrence; read the file again"
            );
            fs::write(path, contents.replacen(&old, &new, 1))
                .await
                .context("Could not save the edit")?;
            Ok(HostResult::Written)
        }
        HostCommand::SpawnWorker {
            host,
            task_id,
            allocation_id,
            title,
            parent,
        } => spawn_worker(&host, &task_id, &allocation_id, &title, parent.as_ref()).await,
        HostCommand::SpawnSubagent {
            host,
            parent,
            task_id,
            agent_id,
            allocation_id,
            title,
        } => {
            let client = RexClient::new(None);
            let identity = client.whoami().await?;
            ensure!(
                identity.host_id == HostId::parse(&parent.host_id)?,
                "Subagent must use its task's host"
            );
            let native = native_binding(&parent)?;
            client
                .inspect_session(&native.session_id)
                .await?
                .verify_binding(&native, &identity.host_id)?;
            let args = worker_args(&host, &task_id, &allocation_id, Some(&agent_id));
            match client
                .create_worker_window(
                    &native.session_id,
                    &title,
                    &host.agent_program,
                    &args,
                    Path::new(&host.cwd),
                )
                .await
            {
                Ok(binding) => {
                    if !confirmed_binding(&client, &binding, &identity.host_id).await {
                        return Ok(HostResult::CreationUncertain {
                            session_id: Some(binding.session_id.to_string()),
                        });
                    }
                    promote(&client, &binding.session_id).await;
                    Ok(HostResult::Spawned {
                        binding: WorkerRef {
                            host_id: identity.host_id.to_string(),
                            session_id: binding.session_id.to_string(),
                            window_id: binding.window_id.to_string(),
                            block_id: binding.block_id.to_string(),
                        },
                    })
                }
                Err(RexError::CreationUncertain { session_id }) => {
                    Ok(HostResult::CreationUncertain {
                        session_id: session_id.map(|id| id.to_string()),
                    })
                }
                Err(error) => Err(error.into()),
            }
        }
        HostCommand::ResumeWorker {
            host,
            binding,
            task_id,
            allocation_id,
        } => resume_bound_worker(host, binding, task_id, allocation_id, None).await,
        HostCommand::ResumeAgentWorker {
            host,
            binding,
            task_id,
            agent_id,
            allocation_id,
        } => resume_bound_worker(host, binding, task_id, allocation_id, Some(agent_id)).await,
    }
}

// Child identity is a distinct wire command: older nodes must reject it before
// effects instead of silently starting a parent with a child's allocation.
async fn resume_bound_worker(
    host: WorkerHost,
    binding: WorkerRef,
    task_id: TaskId,
    allocation_id: String,
    agent_id: Option<String>,
) -> Result<HostResult> {
    let client = RexClient::new(None);
    let native = native_binding(&binding)?;
    let identity = client.whoami().await?;
    ensure!(
        identity.host_id == HostId::parse(&binding.host_id)?,
        "Worker host identity changed"
    );
    let presence = client.worker_presence(&native, &identity.host_id).await?;
    if matches!(presence, crate::protocol::WorkerPresence::MissingSession) {
        anyhow::bail!("The task session was closed; reconcile its allocation before reopening");
    }
    if matches!(presence, crate::protocol::WorkerPresence::MissingTerminal) {
        return match client
            .create_worker_window(
                &native.session_id,
                "Chat",
                &host.agent_program,
                &worker_args(&host, &task_id, &allocation_id, agent_id.as_deref()),
                Path::new(&host.cwd),
            )
            .await
        {
            Ok(restored) if confirmed_binding(&client, &restored, &identity.host_id).await => {
                promote(&client, &restored.session_id).await;
                Ok(HostResult::Spawned {
                    binding: WorkerRef {
                        host_id: binding.host_id,
                        session_id: restored.session_id.to_string(),
                        window_id: restored.window_id.to_string(),
                        block_id: restored.block_id.to_string(),
                    },
                })
            }
            Ok(_) => Ok(HostResult::CreationUncertain {
                session_id: Some(binding.session_id),
            }),
            Err(RexError::CreationUncertain { session_id }) => Ok(HostResult::CreationUncertain {
                session_id: session_id.map(|id| id.to_string()),
            }),
            Err(error) => Err(error.into()),
        };
    }
    // A running client drains new pending inputs itself. An exited pane
    // needs a new execution in this same session, handled by Rex below.
    resume_worker(
        &client,
        &host,
        &task_id,
        &allocation_id,
        &binding,
        agent_id.as_deref(),
    )
    .await
}

async fn require_local_host(expected: &str) -> Result<()> {
    let identity = RexClient::new(None).whoami().await?;
    ensure!(
        identity.host_id == HostId::parse(expected)?,
        "Resource belongs to another host"
    );
    Ok(())
}

fn native_binding(binding: &WorkerRef) -> Result<WorkerBinding> {
    Ok(WorkerBinding {
        session_id: SessionId::parse(&binding.session_id)?,
        window_id: WindowId::parse(&binding.window_id)?,
        block_id: BlockId::parse(&binding.block_id)?,
        revision: 0,
    })
}

fn worker_args(
    host: &WorkerHost,
    task_id: &TaskId,
    allocation_id: &str,
    agent_id: Option<&str>,
) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(launch) = &host.launch {
        for (flag, value) in [
            ("--state-dir", &launch.state_dir),
            ("--runtime", &launch.runtime),
            ("--config", &launch.config),
            ("--instructions", &launch.instructions),
        ] {
            if let Some(value) = value {
                args.extend([flag.into(), value.clone()]);
            }
        }
    }
    if let Some(coordinator) = &host.coordinator {
        args.extend(["--coordinator".into(), coordinator.clone()]);
    }
    args.extend([
        "run-task".into(),
        task_id.to_string(),
        "--allocation-id".into(),
        allocation_id.into(),
    ]);
    if let Some(agent_id) = agent_id {
        args.extend(["--agent-id".into(), agent_id.into()]);
    }
    if let Some(model) = host
        .launch
        .as_ref()
        .and_then(|launch| launch.model.as_ref())
    {
        args.extend(model.cli_args());
    }
    args
}

async fn spawn_worker(
    host: &WorkerHost,
    task_id: &TaskId,
    allocation_id: &str,
    title: &str,
    parent: Option<&WorkerRef>,
) -> Result<HostResult> {
    let client = RexClient::new(None);
    let identity = client.whoami().await?;
    ensure!(
        host.host_id
            .as_ref()
            .is_none_or(|id| id == &identity.host_id.to_string()),
        "Worker host differs from this node's native Rex identity"
    );
    let result = if let Some(parent) = parent {
        ensure!(
            identity.host_id == HostId::parse(&parent.host_id)?,
            "The feedback terminal must use its originating host"
        );
        let native = native_binding(parent)?;
        client
            .inspect_session(&native.session_id)
            .await?
            .verify_binding(&native, &identity.host_id)?;
        client
            .create_worker_window(
                &native.session_id,
                title,
                &host.agent_program,
                &worker_args(host, task_id, allocation_id, None),
                Path::new(&host.cwd),
            )
            .await
    } else {
        client
            .create_session(
                title,
                &host.agent_program,
                &worker_args(host, task_id, allocation_id, None),
                Path::new(&host.cwd),
            )
            .await
    };
    match result {
        Ok(binding) => {
            if !confirmed_binding(&client, &binding, &identity.host_id).await {
                return Ok(HostResult::CreationUncertain {
                    session_id: Some(binding.session_id.to_string()),
                });
            }
            promote(&client, &binding.session_id).await;
            Ok(HostResult::Spawned {
                binding: WorkerRef {
                    host_id: identity.host_id.to_string(),
                    session_id: binding.session_id.to_string(),
                    window_id: binding.window_id.to_string(),
                    block_id: binding.block_id.to_string(),
                },
            })
        }
        Err(RexError::CreationUncertain { session_id }) => Ok(HostResult::CreationUncertain {
            session_id: session_id.map(|id| id.to_string()),
        }),
        Err(error) => Err(error.into()),
    }
}

async fn confirmed_binding(client: &RexClient, binding: &WorkerBinding, host: &HostId) -> bool {
    match client.inspect_session(&binding.session_id).await {
        Ok(view) => view.verify_binding(binding, host).is_ok(),
        Err(_) => false,
    }
}

async fn promote(client: &RexClient, session: &SessionId) {
    if client.promote_session(session).await.is_err() {
        eprintln!("Rex could not update session order; worker is retained.");
    }
}

async fn resume_worker(
    client: &RexClient,
    host: &WorkerHost,
    task_id: &TaskId,
    allocation_id: &str,
    binding: &WorkerRef,
    agent_id: Option<&str>,
) -> Result<HostResult> {
    promote(client, &SessionId::parse(&binding.session_id)?).await;
    match client
        .resume_worker(
            &native_binding(binding)?,
            &host.agent_program,
            &worker_args(host, task_id, allocation_id, agent_id),
            Path::new(&host.cwd),
        )
        .await
    {
        Ok(WorkerResume::Running) => Ok(HostResult::Written),
        Ok(WorkerResume::Pending) => Ok(HostResult::WorkerPresence {
            presence: crate::protocol::WorkerPresence::Pending,
        }),
        Ok(WorkerResume::Started(replacement)) => Ok(HostResult::Spawned {
            binding: WorkerRef {
                host_id: binding.host_id.clone(),
                session_id: replacement.session_id.to_string(),
                window_id: replacement.window_id.to_string(),
                block_id: replacement.block_id.to_string(),
            },
        }),
        Err(RexError::CreationUncertain { session_id }) => Ok(HostResult::CreationUncertain {
            session_id: session_id.map(|id| id.to_string()),
        }),
        Err(error) => Err(error.into()),
    }
}

struct ProcessGroup(libc::pid_t);
impl ProcessGroup {
    fn terminate(&mut self) {
        if self.0 != 0 {
            // The child remains unreaped until after its process group is
            // terminated, so this group ID cannot identify an unrelated job.
            unsafe {
                libc::kill(-self.0, libc::SIGKILL);
            }
            self.0 = 0;
        }
    }
}
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        self.terminate();
    }
}

async fn captured(mut reader: impl AsyncRead + Unpin, maximum: usize) -> Result<(Vec<u8>, bool)> {
    let mut result = Vec::new();
    let mut buffer = [0_u8; 8192];
    let mut truncated = false;
    loop {
        let length = reader.read(&mut buffer).await?;
        if length == 0 {
            return Ok((result, truncated));
        }
        let retained = length.min(maximum.saturating_sub(result.len()));
        result.extend_from_slice(&buffer[..retained]);
        truncated |= retained != length;
    }
}

async fn exited_unreaped(pid: libc::pid_t) -> Result<()> {
    loop {
        let exited = {
            // WNOWAIT observes exit without releasing the PID/group name.
            // Keep platform siginfo (which is not Send) out of the future.
            let mut information: libc::siginfo_t = unsafe { std::mem::zeroed() };
            let result = unsafe {
                libc::waitid(
                    libc::P_PID,
                    pid.try_into()?,
                    &mut information,
                    libc::WEXITED | libc::WNOWAIT | libc::WNOHANG,
                )
            };
            if result == -1 {
                return Err(std::io::Error::last_os_error().into());
            }
            information.si_signo != 0
        };
        if exited {
            return Ok(());
        }
        sleep(Duration::from_millis(10)).await;
    }
}

pub(crate) async fn run_process(
    program: &str,
    args: &[String],
    cwd: &Path,
    deadline: Duration,
    output_limit: usize,
) -> Result<HostResult> {
    run_process_until(
        program,
        args,
        cwd,
        deadline,
        output_limit,
        std::future::pending(),
    )
    .await
}

/// Cancellation retains the same group ownership, reaping and pipe draining as
/// timeout. Dropping the future also kills the group through its owned guard.
pub(crate) async fn run_process_until(
    program: &str,
    args: &[String],
    cwd: &Path,
    deadline: Duration,
    output_limit: usize,
    cancelled: impl Future<Output = ()>,
) -> Result<HostResult> {
    let mut child = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true)
        .spawn()
        .context("Could not start the command")?;
    let mut group = ProcessGroup(
        child
            .id()
            .context("Command has no process identity")?
            .try_into()?,
    );
    let stdout = child
        .stdout
        .take()
        .context("Command output pipe is unavailable")?;
    let stderr = child
        .stderr
        .take()
        .context("Command error pipe is unavailable")?;
    let mut output = tokio::spawn(captured(stdout, output_limit));
    let mut errors = tokio::spawn(captured(stderr, output_limit));
    let finished = tokio::select! {
        result = timeout(deadline, exited_unreaped(group.0)) => Some(result),
        _ = cancelled => None,
    };
    group.terminate();
    let status = timeout(Duration::from_secs(3), child.wait())
        .await
        .context("Command exit could not be confirmed")??;
    let capture = timeout(Duration::from_secs(3), async {
        Ok::<_, anyhow::Error>(((&mut output).await??, (&mut errors).await??))
    })
    .await;
    let ((stdout, out_cut), (stderr, err_cut)) = match capture {
        Ok(result) => result?,
        Err(_) => {
            output.abort();
            errors.abort();
            anyhow::bail!("Command output did not close after exit");
        }
    };
    let mut stderr = String::from_utf8_lossy(&stderr).into_owned();
    let exit_code = match finished {
        Some(Ok(result)) => {
            result?;
            status.code().unwrap_or(128)
        }
        Some(Err(_)) => {
            stderr.push_str("\nCommand timed out and its process group was stopped.");
            124
        }
        None => {
            stderr.push_str("\nCommand cancelled and its process group was stopped.");
            143
        }
    };
    Ok(HostResult::Process {
        exit_code,
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr,
        truncated: out_cut || err_cut,
    })
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde::Deserialize;
    use tokio::{net::TcpStream, sync::oneshot, time::timeout};

    use crate::{
        host::{execute, run_process, run_process_until},
        protocol::{HostCommand, HostResult},
    };

    #[tokio::test]
    async fn interrupt_releases_embedding_waiting_behind_the_owned_provider() {
        let directory = tempfile::tempdir().unwrap();
        let executor = std::sync::Arc::new(crate::host::Executor::new(directory.path()));
        let held = executor.embeddings.lock().await;
        let (cancel, cancelled) = tokio::sync::watch::channel(false);
        let running = std::sync::Arc::clone(&executor);
        let operation = tokio::spawn(async move {
            running
                .execute_cancelled(
                    HostCommand::Embed {
                        texts: vec!["Retained context".into()],
                        purpose: crate::embeddings::EmbeddingPurpose::Query,
                    },
                    cancelled,
                )
                .await
        });
        cancel.send(true).unwrap();
        let result = timeout(Duration::from_secs(2), operation)
            .await
            .expect("Cancellation must not wait for the held embedding provider")
            .unwrap();
        assert!(
            matches!(result, HostResult::Failed { message } if message == "History embedding was interrupted")
        );
        assert!(
            held.is_none(),
            "Cancellation must not initialize another embedding provider"
        );
    }

    #[tokio::test]
    async fn source_capture_preserves_literal_arguments_and_nonzero_status() {
        let literal = "$(literal);*.chat";
        let result = run_process(
            "node",
            &[
                "--eval".into(),
                "process.stdout.write(process.argv[1]); process.stderr.write('diagnostic'); process.exitCode=7".into(),
                literal.into(),
            ],
            std::path::Path::new("/"),
            Duration::from_secs(5),
            1024,
        )
        .await
        .unwrap();
        let HostResult::Process {
            exit_code,
            stdout,
            stderr,
            truncated,
        } = result
        else {
            panic!("Expected captured native process");
        };
        assert_eq!(exit_code, 7);
        assert_eq!(stdout, literal);
        assert_eq!(stderr, "diagnostic");
        assert!(!truncated);
    }

    #[tokio::test]
    async fn cancelled_source_capture_kills_descendants_reaps_the_child_and_drains_output() {
        #[derive(Deserialize)]
        struct Fixture {
            pid: i32,
            port: u16,
        }
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("child.json");
        let script = r#"
const {spawn} = require('node:child_process');
const {writeFileSync} = require('node:fs');
const descendant = spawn(process.execPath, ['--eval', `
  const server = require('node:net').createServer();
  server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port)));
`], {stdio:['ignore','pipe','ignore']});
descendant.stdout.once('data', (data) => {
  process.stdout.write('ready', () => {
    writeFileSync(process.argv[1], JSON.stringify({pid:process.pid,port:Number(data.toString())}));
  });
});
setInterval(() => {}, 1000);
"#;
        let (stop, cancelled) = oneshot::channel();
        let cwd = directory.path().to_owned();
        let args = vec![
            "--eval".into(),
            script.into(),
            marker.to_string_lossy().into_owned(),
        ];
        let running = tokio::spawn(async move {
            run_process_until(
                "node",
                &args,
                &cwd,
                Duration::from_secs(900),
                2 * 1024 * 1024,
                async move {
                    let _ = cancelled.await;
                },
            )
            .await
        });
        let fixture: Fixture = timeout(Duration::from_secs(5), async {
            loop {
                if let Ok(contents) = tokio::fs::read(&marker).await
                    && let Ok(fixture) = serde_json::from_slice(&contents)
                {
                    break fixture;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("Native descendant must be listening before cancellation");
        assert!(
            TcpStream::connect(("127.0.0.1", fixture.port))
                .await
                .is_ok()
        );
        stop.send(()).unwrap();
        let result = timeout(Duration::from_secs(5), running)
            .await
            .expect("Cancellation must complete cleanup")
            .unwrap()
            .unwrap();
        let HostResult::Process {
            exit_code,
            stdout,
            stderr,
            truncated,
        } = result
        else {
            panic!("Expected cancelled native process");
        };
        assert_eq!(exit_code, 143);
        assert_eq!(stdout, "ready");
        assert!(stderr.contains("cancelled"));
        assert!(!truncated);
        assert_eq!(
            unsafe { libc::kill(fixture.pid, 0) },
            -1,
            "The direct child must be reaped before the result is returned"
        );
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
        // Reaping the direct child does not wait for its orphaned descendant.
        // Group SIGKILL can still be completing socket teardown on another CPU.
        timeout(Duration::from_secs(5), async {
            while TcpStream::connect(("127.0.0.1", fixture.port))
                .await
                .is_ok()
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("The cancelled descendant must release its listening socket");
    }

    #[tokio::test]
    async fn runs_literal_arguments_and_retains_real_exit_status() {
        let result = execute(HostCommand::Exec {
            program: "/bin/sh".into(),
            args: vec![
                "-c".into(),
                "printf '%s' \"$1\"; printf failure >&2; exit 7".into(),
                "fixture".into(),
                "$(literal)".into(),
            ],
            cwd: "/".into(),
            timeout_seconds: 2,
        })
        .await;
        let HostResult::Process {
            exit_code,
            stdout,
            stderr,
            truncated,
        } = result
        else {
            panic!("Expected process result");
        };
        assert_eq!(exit_code, 7);
        assert_eq!(stdout, "$(literal)");
        assert_eq!(stderr, "failure");
        assert!(!truncated);
    }

    #[tokio::test]
    async fn ordinary_commands_accept_fifteen_minutes_and_the_positive_wire_domain() {
        for timeout_seconds in [900, u16::MAX] {
            let result = execute(HostCommand::Exec {
                program: "node".into(),
                args: vec!["--eval".into(), "process.stdout.write('ready\\n')".into()],
                cwd: "/".into(),
                timeout_seconds,
            })
            .await;
            assert!(
                matches!(result,HostResult::Process {exit_code:0,stdout,..} if stdout=="ready\n"),
                "A quick command should accept timeout {timeout_seconds}"
            );
        }
        assert!(matches!(
            execute(HostCommand::Exec {
                program: "node".into(),
                args: vec![],
                cwd: "/".into(),
                timeout_seconds: 0
            })
            .await,
            HostResult::Failed { .. }
        ));
    }

    #[tokio::test]
    async fn edits_require_one_exact_match_and_read_is_bounded() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("text").to_string_lossy().into_owned();
        assert!(matches!(
            execute(HostCommand::WriteFile {
                path: path.clone(),
                content: "alpha beta alpha".into()
            })
            .await,
            HostResult::Written
        ));
        assert!(matches!(
            execute(HostCommand::EditFile {
                path: path.clone(),
                old: "alpha".into(),
                new: "changed".into()
            })
            .await,
            HostResult::Failed { .. }
        ));
        assert!(matches!(
            execute(HostCommand::EditFile {
                path: path.clone(),
                old: "beta".into(),
                new: "gamma".into()
            })
            .await,
            HostResult::Written
        ));
        let HostResult::File { content, truncated } = execute(HostCommand::ReadFile {
            path,
            offset: 6,
            limit: 5,
        })
        .await
        else {
            panic!("Expected file contents");
        };
        assert_eq!(content, "gamma");
        assert!(truncated);
    }

    #[tokio::test]
    async fn command_timeout_is_an_explicit_result() {
        let result = execute(HostCommand::Exec {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), "sleep 30".into()],
            cwd: "/".into(),
            timeout_seconds: 1,
        })
        .await;
        let HostResult::Process {
            exit_code, stderr, ..
        } = result
        else {
            panic!("Expected timed-out process");
        };
        assert_eq!(exit_code, 124);
        assert!(stderr.contains("timed out"));
    }
}
