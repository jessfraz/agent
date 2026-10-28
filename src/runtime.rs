use std::{
    collections::{HashMap, HashSet},
    fs::{File, OpenOptions},
    os::{fd::AsRawFd, unix::fs::OpenOptionsExt},
    path::Path,
    process::Stdio,
    time::Duration,
};

use crate::protocol::{
    ErrorCode, HostResult, PROTOCOL_VERSION, RuntimeCommand, RuntimeEvent, RuntimeEventKind,
    RuntimeRequest,
};
use anyhow::{Context, Result, ensure};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{broadcast, mpsc, oneshot, watch},
    task::JoinHandle,
    time::timeout,
};

pub const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;

pub struct RuntimeCall {
    pub request_id: u32,
    pub events: mpsc::Receiver<RuntimeEventKind>,
}

#[derive(Clone)]
pub struct RuntimeNotice {
    pub request_id: u32,
    pub event: RuntimeEventKind,
}

pub struct Runtime {
    commands: mpsc::Sender<CommandMessage>,
    alive: watch::Receiver<bool>,
    notices: broadcast::Sender<RuntimeNotice>,
    actor: Option<JoinHandle<Result<()>>>,
}

enum CommandMessage {
    Request {
        command: Box<RuntimeCommand>,
        admitted: oneshot::Sender<Result<RuntimeCall>>,
    },
    Reply {
        request_id: u32,
        call_id: String,
        result: HostResult,
    },
    Detached(u32),
    OAuthCallback {
        request_id: u32,
        target: String,
    },
    WorkerControl {
        request_id: u32,
        command: Box<RuntimeCommand>,
    },
    Shutdown,
}

struct Pending {
    events: Option<mpsc::Sender<RuntimeEventKind>>,
    host_calls: HashSet<String>,
    login: bool,
    worker: bool,
    interruptible: bool,
}

impl Runtime {
    pub fn start(script: &Path, state: &Path) -> Result<Self> {
        ensure!(
            script.is_file(),
            "Pi runtime is not built; build the runtime first"
        );
        let guard = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(state.join("writer.lock"))?;
        fs2::FileExt::try_lock_exclusive(&guard)
            .context("Another agent process owns this state directory")?;
        let lock_fd = guard.as_raw_fd();
        let mut command = Command::new("node");
        command
            .arg("--no-warnings")
            .arg(script)
            .arg(state)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        // Pi retains this open-file description after exec. Killing its Rust
        // supervisor cannot release ownership while the real writer survives.
        unsafe {
            command.pre_exec(move || {
                if libc::fcntl(lock_fd, libc::F_SETFD, 0) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command.spawn().context("Could not start the Pi runtime")?;
        let stdin = child
            .stdin
            .take()
            .context("Runtime input pipe is unavailable")?;
        let stdout = child
            .stdout
            .take()
            .context("Runtime output pipe is unavailable")?;
        let (commands, incoming) = mpsc::channel(64);
        let (life, alive) = watch::channel(true);
        let (notices, _) = broadcast::channel(64);
        let notifications = notices.clone();
        let actor = tokio::spawn(async move {
            let result = run_actor(
                child,
                stdin,
                BufReader::new(stdout),
                incoming,
                guard,
                notifications,
            )
            .await;
            let _ = life.send(false);
            result
        });
        Ok(Self {
            commands,
            alive,
            notices,
            actor: Some(actor),
        })
    }

    pub async fn request(&self, command: RuntimeCommand) -> Result<RuntimeCall> {
        ensure!(
            !matches!(
                command,
                RuntimeCommand::HostReply { .. }
                    | RuntimeCommand::OAuthCallback { .. }
                    | RuntimeCommand::Watch
                    | RuntimeCommand::ConnectWorker { .. }
                    | RuntimeCommand::WorkerInput { .. }
                    | RuntimeCommand::DetachWorker
            ),
            "Transport control commands do not create Pi requests"
        );
        let (admitted, receiver) = oneshot::channel();
        self.commands
            .send(CommandMessage::Request {
                command: Box::new(command),
                admitted,
            })
            .await
            .context("Pi runtime is closed")?;
        receiver
            .await
            .context("Pi runtime closed during admission")?
    }

    pub async fn reply(&self, request_id: u32, call_id: String, result: HostResult) -> Result<()> {
        self.commands
            .send(CommandMessage::Reply {
                request_id,
                call_id,
                result,
            })
            .await
            .context("Pi runtime is closed")
    }

    pub async fn detach(&self, request_id: u32) {
        let _ = self
            .commands
            .send(CommandMessage::Detached(request_id))
            .await;
    }

    pub async fn worker_control(&self, request_id: u32, command: RuntimeCommand) -> Result<()> {
        ensure!(
            matches!(
                command,
                RuntimeCommand::WorkerInput { .. }
                    | RuntimeCommand::DetachWorker
                    | RuntimeCommand::Interrupt
            ),
            "Invalid worker control"
        );
        self.commands
            .send(CommandMessage::WorkerControl {
                request_id,
                command: Box::new(command),
            })
            .await
            .context("Pi runtime is closed")
    }

    pub async fn callback(&self, request_id: u32, target: String) -> Result<()> {
        self.commands
            .send(CommandMessage::OAuthCallback { request_id, target })
            .await
            .context("Pi runtime is closed")
    }

    pub async fn stopped(&self) {
        let mut alive = self.alive.clone();
        loop {
            if !*alive.borrow_and_update() {
                break;
            }
            if alive.changed().await.is_err() {
                break;
            }
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<RuntimeNotice> {
        self.notices.subscribe()
    }

    pub async fn close(mut self) -> Result<()> {
        let _ = self.commands.send(CommandMessage::Shutdown).await;
        match self.actor.take() {
            Some(actor) => actor.await.context("Pi runtime owner stopped")?,
            None => Ok(()),
        }
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        // Do not abort the actor: it owns the lock until the child really exits.
        let _ = self.commands.try_send(CommandMessage::Shutdown);
    }
}

async fn send(stdin: &mut ChildStdin, request: RuntimeRequest) -> Result<()> {
    let mut bytes = serde_json::to_vec(&request)?;
    ensure!(
        bytes.len() <= MAX_FRAME_BYTES,
        "Runtime request exceeds its size limit"
    );
    bytes.push(b'\n');
    timeout(Duration::from_secs(10), stdin.write_all(&bytes))
        .await
        .context("Pi runtime stopped reading commands")?
        .context("Could not write to Pi runtime")
}

async fn reject_host_calls(stdin: &mut ChildStdin, id: u32, pending: &mut Pending) -> Result<()> {
    pending.events.take();
    if pending.worker {
        pending.worker = false;
        send(
            stdin,
            RuntimeRequest {
                version: PROTOCOL_VERSION,
                id,
                command: RuntimeCommand::DetachWorker,
            },
        )
        .await?;
    }
    for call_id in pending.host_calls.drain() {
        send(
            stdin,
            RuntimeRequest {
                version: PROTOCOL_VERSION,
                id,
                command: RuntimeCommand::HostReply {
                    call_id,
                    result: HostResult::Failed {
                        message:
                            "The execution client disconnected; no command ran on a fallback host."
                                .into(),
                    },
                },
            },
        )
        .await?;
    }
    Ok(())
}

async fn run_actor<R: AsyncBufRead + Unpin>(
    mut child: Child,
    mut stdin: ChildStdin,
    output: R,
    mut commands: mpsc::Receiver<CommandMessage>,
    _writer_guard: File,
    notices: broadcast::Sender<RuntimeNotice>,
) -> Result<()> {
    let mut output = FrameReader::new(output);
    let mut next_id = 1_u32;
    let mut pending: HashMap<u32, Pending> = HashMap::new();
    let result: Result<()> = async {
        loop {
            tokio::select! {
                message = commands.recv() => match message {
                    Some(CommandMessage::Request { command, admitted }) => {
                        let command = *command;
                        let login = matches!(command, RuntimeCommand::Login);
                        let worker = matches!(command, RuntimeCommand::RunTask { interactive: Some(true), .. });
                        let interruptible = worker || matches!(command, RuntimeCommand::Chat { .. });
                        let id = next_id;
                        next_id = id.checked_add(1).context("Runtime request IDs exhausted")?;
                        let (sender, events) = mpsc::channel(64);
                        send(&mut stdin, RuntimeRequest { version: PROTOCOL_VERSION, id, command }).await?;
                        pending.insert(id, Pending { events: Some(sender), host_calls: HashSet::new(), login, worker, interruptible });
                        if admitted.send(Ok(RuntimeCall { request_id: id, events })).is_err()
                            && let Some(call) = pending.get_mut(&id) {
                            reject_host_calls(&mut stdin, id, call).await?;
                        }
                    }
                    Some(CommandMessage::Reply { request_id, call_id, result }) => {
                        if let Some(call) = pending.get_mut(&request_id)
                            && call.host_calls.remove(&call_id) {
                            send(&mut stdin, RuntimeRequest { version: PROTOCOL_VERSION, id: request_id,
                                command: RuntimeCommand::HostReply { call_id, result } }).await?;
                        }
                    }
                    Some(CommandMessage::Detached(id)) => {
                        if let Some(call) = pending.get_mut(&id) {
                            reject_host_calls(&mut stdin, id, call).await?;
                        }
                    }
                    Some(CommandMessage::OAuthCallback { request_id, target }) => {
                        if pending.get(&request_id).is_some_and(|request| request.login) {
                            send(&mut stdin, RuntimeRequest { version: PROTOCOL_VERSION, id: request_id,
                                command: RuntimeCommand::OAuthCallback { target } }).await?;
                        }
                    }
                    Some(CommandMessage::WorkerControl { request_id, command }) => {
                        if pending.get(&request_id).is_some_and(|request| request.events.is_some() &&
                            (request.worker || (request.interruptible && matches!(*command, RuntimeCommand::Interrupt)))) {
                            send(&mut stdin, RuntimeRequest { version: PROTOCOL_VERSION, id: request_id, command: *command }).await?;
                        }
                    }
                    Some(CommandMessage::Shutdown) | None => break Ok(()),
                },
                frame = output.next_frame() => {
                    let bytes = frame?.context("Pi runtime exited")?;
                    let frame: RuntimeEvent = serde_json::from_slice(&bytes)
                        .context("Pi runtime returned an invalid event")?;
                    ensure!(frame.version == PROTOCOL_VERSION, "Pi runtime protocol mismatch");
                    let call = pending.get_mut(&frame.id).with_context(|| {
                        let event = match &frame.event {
                            RuntimeEventKind::Failure { code, .. } => format!("failure {code:?}"),
                            RuntimeEventKind::Notice { .. } => "notice".into(),
                            RuntimeEventKind::HostCall { .. } => "host call".into(),
                            RuntimeEventKind::HostCancel { .. } => "host cancellation".into(),
                            RuntimeEventKind::InputRejected { .. } => "rejected input".into(),
                            RuntimeEventKind::Interrupted => "interruption".into(),
                            RuntimeEventKind::ImportProgress { .. } => "import progress".into(),
                            RuntimeEventKind::Activity { .. } => "activity".into(),
                            RuntimeEventKind::Done => "completion".into(),
                            _ => "event".into(),
                        };
                        format!("Pi returned {event} for unknown request ID {}", frame.id)
                    })?;
                    if matches!(frame.event, RuntimeEventKind::Notice { .. }) {
                        let _ = notices.send(RuntimeNotice { request_id: frame.id, event: frame.event.clone() });
                    }
                    if let RuntimeEventKind::HostCall { call_id, .. } = &frame.event {
                        ensure!(call.host_calls.insert(call_id.clone()), "Pi reused an active host call ID");
                    }
                    let done = matches!(frame.event, RuntimeEventKind::Done);
                    let detached = call.events.as_ref().is_none_or(|sender| sender.try_send(frame.event).is_err());
                    if detached { reject_host_calls(&mut stdin, frame.id, call).await?; }
                    if done { pending.remove(&frame.id); }
                }
            }
        }
    }.await;
    for call in pending.into_values() {
        if let Some(sender) = call.events {
            let _ = sender.try_send(RuntimeEventKind::Failure {
                code: ErrorCode::Internal,
                message: "The coordinator runtime stopped; saved work is retained.".into(),
            });
            let _ = sender.try_send(RuntimeEventKind::Done);
        }
    }
    drop(stdin);
    let reaped = match timeout(Duration::from_secs(5), child.wait()).await {
        Ok(status) => status.context("Could not confirm Pi exit"),
        Err(_) => {
            child.kill().await.context("Could not stop Pi")?;
            child.wait().await.context("Could not confirm Pi exit")
        }
    };
    reaped?;
    result
}

/// Framing state stays with the owner. Cancelling a select branch cannot
/// discard bytes already consumed from a partial JSON line.
pub struct FrameReader<R> {
    reader: R,
    frame: Vec<u8>,
}

impl<R: AsyncBufRead + Unpin> FrameReader<R> {
    pub fn new(reader: R) -> Self {
        Self {
            reader,
            frame: Vec::new(),
        }
    }

    pub async fn next_frame(&mut self) -> Result<Option<Vec<u8>>> {
        loop {
            let bytes = self.reader.fill_buf().await?;
            if bytes.is_empty() {
                ensure!(self.frame.is_empty(), "Incomplete protocol frame");
                return Ok(None);
            }
            let count = bytes
                .iter()
                .position(|byte| *byte == b'\n')
                .map_or(bytes.len(), |position| position + 1);
            ensure!(
                self.frame.len() + count <= MAX_FRAME_BYTES,
                "Protocol frame exceeds its size limit"
            );
            let complete = bytes[count - 1] == b'\n';
            self.frame.extend_from_slice(&bytes[..count]);
            self.reader.consume(count);
            if complete {
                return Ok(Some(std::mem::take(&mut self.frame)));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::runtime::{FrameReader, MAX_FRAME_BYTES};
    use std::time::Duration;
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::time::timeout;

    #[tokio::test]
    async fn partial_frame_survives_select_cancellation() {
        let (reader, mut writer) = tokio::io::duplex(64);
        let mut reader = FrameReader::new(BufReader::new(reader));
        writer.write_all(b"{\"version\":").await.unwrap();
        assert!(
            timeout(Duration::from_millis(20), reader.next_frame())
                .await
                .is_err()
        );
        writer.write_all(b"1}\n").await.unwrap();
        assert_eq!(
            reader.next_frame().await.unwrap().unwrap(),
            b"{\"version\":1}\n"
        );
    }

    #[tokio::test]
    async fn framing_rejects_oversized_and_incomplete_input() {
        let oversized = vec![b'x'; MAX_FRAME_BYTES + 1];
        assert!(
            FrameReader::new(oversized.as_slice())
                .next_frame()
                .await
                .is_err()
        );
        assert!(
            FrameReader::new(b"incomplete".as_slice())
                .next_frame()
                .await
                .is_err()
        );
        assert!(
            FrameReader::new(b"".as_slice())
                .next_frame()
                .await
                .unwrap()
                .is_none()
        );
    }
}
