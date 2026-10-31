use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    os::{fd::AsRawFd, unix::fs::OpenOptionsExt},
    path::Path,
    process::Stdio,
    sync::Mutex,
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

mod diagnostics;
use crate::runtime::diagnostics::{Diagnostics, Event as DiagnosticEvent, HostTiming, Trace};

pub const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub(crate) enum ShutdownSignal {
    Sigint,
    Sigterm,
}

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
    shutdown: watch::Sender<bool>,
    service_diagnostics: Mutex<Diagnostics>,
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
}

struct ActorControl {
    commands: mpsc::Receiver<CommandMessage>,
    shutdown: watch::Receiver<bool>,
}

#[derive(Clone, Copy)]
enum RuntimeView {
    Main,
    Conversation,
}
impl RuntimeView {
    fn command(self) -> RuntimeCommand {
        match self {
            Self::Main => RuntimeCommand::DetachMain,
            Self::Conversation => RuntimeCommand::DetachConversation,
        }
    }
}

struct Pending {
    events: Option<mpsc::Sender<RuntimeEventKind>>,
    host_calls: HashMap<String, HostTiming>,
    trace: Trace,
    login: bool,
    worker: bool,
    view: Option<RuntimeView>,
    interruptible: bool,
}

impl Runtime {
    pub fn start(script: &Path, state: &Path) -> Result<Self> {
        Self::start_with_notifications(script, state, None)
    }

    pub fn start_with_notifications(
        script: &Path,
        state: &Path,
        apns: Option<&crate::notifications::ApnsConfig>,
    ) -> Result<Self> {
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
        // This is a local child bootstrap, never a public command or shared
        // setting. Workers and ad-hoc runtimes must not inherit this capability.
        command.env_remove("AGENT_APNS_CONFIG");
        if let Some(config) = apns {
            config.validate()?;
            command.env("AGENT_APNS_CONFIG", serde_json::to_string(config)?);
        }
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
        let (shutdown, stopping) = watch::channel(false);
        let (notices, _) = broadcast::channel(64);
        let notifications = notices.clone();
        let diagnostics = Diagnostics::start(state);
        let service_diagnostics = Mutex::new(diagnostics.fork());
        let actor = tokio::spawn(async move {
            let result = run_actor(
                child,
                stdin,
                BufReader::new(stdout),
                ActorControl {
                    commands: incoming,
                    shutdown: stopping,
                },
                guard,
                notifications,
                diagnostics,
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
            shutdown,
            service_diagnostics,
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
                    | RuntimeCommand::SubmitInput { .. }
                    | RuntimeCommand::DetachWorker
                    | RuntimeCommand::DetachMain
                    | RuntimeCommand::DetachConversation
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
                    | RuntimeCommand::SubmitInput { .. }
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

    pub(crate) fn record_shutdown(&self, signal: ShutdownSignal) {
        if let Ok(mut diagnostics) = self.service_diagnostics.lock() {
            diagnostics.record(
                0,
                &Trace::unowned(),
                DiagnosticEvent::ServiceShutdown { signal },
            );
        }
    }

    pub(crate) fn record_peer_rejected(&self, peer: std::net::SocketAddr, reason: &str) {
        if let Ok(mut diagnostics) = self.service_diagnostics.lock() {
            diagnostics.record(
                0,
                &Trace::unowned(),
                DiagnosticEvent::PeerRejected {
                    peer,
                    reason: reason
                        .chars()
                        .filter(|character| !character.is_control())
                        .take(256)
                        .collect(),
                },
            );
        }
    }

    pub async fn close(mut self) -> Result<()> {
        let _ = self.shutdown.send(true);
        match self.actor.take() {
            Some(actor) => actor.await.context("Pi runtime owner stopped")?,
            None => Ok(()),
        }
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        // Do not abort the actor: it owns the lock until the child really exits.
        let _ = self.shutdown.send(true);
    }
}

enum WriteCompletion {
    Admission {
        admitted: oneshot::Sender<Result<RuntimeCall>>,
        call: RuntimeCall,
    },
    Control,
    Effect,
}
struct PendingWrite {
    id: u32,
    bytes: Vec<u8>,
    offset: usize,
    kind: Option<String>,
    trace: Trace,
    completion: WriteCompletion,
    backpressure_at: Option<tokio::time::Instant>,
}
impl PendingWrite {
    fn new(request: RuntimeRequest, trace: Trace, completion: WriteCompletion) -> Result<Self> {
        let mut bytes = serde_json::to_vec(&request)?;
        ensure!(
            bytes.len() <= MAX_FRAME_BYTES,
            "Runtime request exceeds its size limit"
        );
        let kind = diagnostics::command_kind(&bytes);
        bytes.push(b'\n');
        Ok(Self {
            id: request.id,
            bytes,
            offset: 0,
            kind,
            trace,
            completion,
            backpressure_at: Some(tokio::time::Instant::now() + Duration::from_secs(10)),
        })
    }
    fn context(&self) -> String {
        format!(
            "Pi command request {} ({}; bytes {}/{})",
            self.id,
            self.kind.as_deref().unwrap_or("unknown"),
            self.offset,
            self.bytes.len()
        )
    }
}

fn reject_host_calls(id: u32, pending: &mut Pending, diagnostics: &mut Diagnostics) {
    if pending.events.take().is_some() {
        diagnostics.record(id, &pending.trace, DiagnosticEvent::Detached);
    }
}

// Disconnected controls remain in their existing request state until the pipe
// has room. Materialize one frame, not an unbounded second output queue.
fn disconnected_write(
    pending: &mut HashMap<u32, Pending>,
    diagnostics: &mut Diagnostics,
) -> Result<Option<PendingWrite>> {
    for (id, call) in pending.iter_mut().filter(|(_, call)| call.events.is_none()) {
        let command = if call.worker {
            call.worker = false;
            RuntimeCommand::DetachWorker
        } else if let Some(view) = call.view.take() {
            view.command()
        } else if let Some(call_id) = call.host_calls.keys().next().cloned() {
            let result = HostResult::Failed {
                message: "The execution client disconnected; no command ran on a fallback host."
                    .into(),
            };
            if let Some(timing) = call.host_calls.remove(&call_id) {
                diagnostics.record(*id, &call.trace, timing.reply(&call_id, &result));
            }
            RuntimeCommand::HostReply { call_id, result }
        } else {
            continue;
        };
        return PendingWrite::new(
            RuntimeRequest {
                version: PROTOCOL_VERSION,
                id: *id,
                command,
            },
            call.trace.clone(),
            WriteCompletion::Effect,
        )
        .map(Some);
    }
    Ok(None)
}

async fn run_actor<R: AsyncBufRead + Unpin>(
    mut child: Child,
    mut stdin: ChildStdin,
    output: R,
    control: ActorControl,
    _writer_guard: File,
    notices: broadcast::Sender<RuntimeNotice>,
    mut diagnostics: Diagnostics,
) -> Result<()> {
    let ActorControl {
        mut commands,
        mut shutdown,
    } = control;
    let mut output = FrameReader::new(output);
    let mut next_id = 1_u32;
    let mut pending: HashMap<u32, Pending> = HashMap::new();
    // The bounded command channel is the queue. Exactly one encoded frame owns
    // its byte offset; cancelling a select branch never rewrites its prefix.
    let mut outgoing: Option<PendingWrite> = None;
    let result: Result<()> = async {
        loop {
            if *shutdown.borrow() { break Ok(()); }
            if outgoing.is_none() { outgoing = disconnected_write(&mut pending, &mut diagnostics)?; }
            let backpressure = outgoing.as_ref().and_then(|frame| frame.backpressure_at);
            tokio::select! {
                _ = shutdown.changed() => break Ok(()),
                written = async {
                    match outgoing.as_ref() {
                        Some(frame) => stdin.write(&frame.bytes[frame.offset..]).await,
                        None => std::future::pending().await,
                    }
                } => {
                    let frame = outgoing.as_mut().context("No Pi command owns the write result")?;
                    let count = written.with_context(|| format!("Could not write {}", frame.context()))?;
                    ensure!(count > 0, "Pi input closed while writing {}", frame.context());
                    frame.offset += count;
                    if frame.offset == frame.bytes.len() {
                        let frame = outgoing.take().context("Completed Pi command is unavailable")?;
                        if !matches!(frame.completion, WriteCompletion::Effect)
                            && let Some(command) = frame.kind {
                            diagnostics.record(frame.id, &frame.trace, DiagnosticEvent::CommandSent { command });
                        }
                        if let WriteCompletion::Admission { admitted, call } = frame.completion
                            && admitted.send(Ok(call)).is_err()
                            && let Some(call) = pending.get_mut(&frame.id) {
                            reject_host_calls(frame.id, call, &mut diagnostics);
                        }
                    }
                },
                _ = async {
                    match backpressure {
                        Some(deadline) => tokio::time::sleep_until(deadline).await,
                        None => std::future::pending().await,
                    }
                } => {
                    if let Some(frame) = outgoing.as_mut() {
                        frame.backpressure_at = None;
                        diagnostics.record(frame.id, &frame.trace, DiagnosticEvent::WriteBackpressure {
                            command: frame.kind.clone(), written_bytes: frame.offset, frame_bytes: frame.bytes.len(),
                        });
                    }
                },
                message = commands.recv(), if outgoing.is_none() => match message {
                    Some(CommandMessage::Request { command, admitted }) => {
                        let command = *command;
                        let login = matches!(command, RuntimeCommand::Login);
                        let worker = matches!(command, RuntimeCommand::RunTask { interactive: Some(true), .. });
                        let view = match command {
                            RuntimeCommand::AttachMain | RuntimeCommand::ObserveMain { .. } => Some(RuntimeView::Main),
                            RuntimeCommand::AttachConversation { .. } => Some(RuntimeView::Conversation),
                            _ => None,
                        };
                        let interruptible = worker || view.is_some() || matches!(command, RuntimeCommand::Chat { .. });
                        let id = next_id;
                        next_id = id.checked_add(1).context("Runtime request IDs exhausted")?;
                        let (sender, events) = mpsc::channel(64);
                        let trace = Trace::new(&command);
                        diagnostics.record(id, &trace, DiagnosticEvent::RequestReceived);
                        if let Some(event) = trace.input(&command) { diagnostics.record(id, &trace, event); }
                        outgoing = Some(PendingWrite::new(RuntimeRequest { version: PROTOCOL_VERSION, id, command }, trace.clone(),
                            WriteCompletion::Admission { admitted, call: RuntimeCall { request_id: id, events } })?);
                        pending.insert(id, Pending { events: Some(sender), host_calls: HashMap::new(), trace, login, worker, view, interruptible });
                    }
                    Some(CommandMessage::Reply { request_id, call_id, result }) => {
                        if let Some(call) = pending.get_mut(&request_id)
                            && let Some(timing) = call.host_calls.remove(&call_id) {
                            diagnostics.record(request_id, &call.trace, timing.reply(&call_id, &result));
                            outgoing = Some(PendingWrite::new(RuntimeRequest { version: PROTOCOL_VERSION, id: request_id,
                                command: RuntimeCommand::HostReply { call_id, result } }, call.trace.clone(), WriteCompletion::Effect)?);
                        }
                    }
                    Some(CommandMessage::Detached(id)) => {
                        if let Some(call) = pending.get_mut(&id) {
                            reject_host_calls(id, call, &mut diagnostics);
                        }
                    }
                    Some(CommandMessage::OAuthCallback { request_id, target }) => {
                        if let Some(call) = pending.get(&request_id).filter(|request| request.login) {
                            outgoing = Some(PendingWrite::new(RuntimeRequest { version: PROTOCOL_VERSION, id: request_id,
                                command: RuntimeCommand::OAuthCallback { target } }, call.trace.clone(), WriteCompletion::Effect)?);
                        }
                    }
                    Some(CommandMessage::WorkerControl { request_id, command }) => {
                        let request = pending.get(&request_id);
                        let unowned = Trace::unowned();
                        let trace = request.map_or(&unowned, |request| &request.trace);
                        if let Some(event) = trace.input(&command) { diagnostics.record(request_id, trace, event); }
                        if request.is_some_and(|request| request.events.is_some() && (request.worker || (request.interruptible && matches!(*command,
                                RuntimeCommand::Interrupt | RuntimeCommand::SubmitInput { .. })))) {
                            outgoing = Some(PendingWrite::new(RuntimeRequest { version: PROTOCOL_VERSION, id: request_id,
                                command: *command }, trace.clone(), WriteCompletion::Control)?);
                        } else { diagnostics.record(request_id, trace, DiagnosticEvent::ControlIgnored); }
                    }
                    None => break Ok(()),
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
                        let timing = HostTiming::new(&bytes);
                        diagnostics.record(frame.id, &call.trace, timing.received(call_id));
                        ensure!(call.host_calls.insert(call_id.clone(), timing).is_none(), "Pi reused an active host call ID");
                    }
                    if let RuntimeEventKind::HostCancel { call_id } = &frame.event {
                        diagnostics.record(frame.id, &call.trace, HostTiming::cancel(call_id, call.host_calls.get(call_id)));
                    }
                    for event in call.trace.observe(&frame.event).into_iter().flatten() { diagnostics.record(frame.id, &call.trace, event); }
                    let done = matches!(frame.event, RuntimeEventKind::Done);
                    let detached = call.events.as_ref().is_none_or(|sender| sender.try_send(frame.event).is_err());
                    if detached { reject_host_calls(frame.id, call, &mut diagnostics); }
                    if done { pending.remove(&frame.id); }
                }
            }
        }
    }.await;
    for (id, call) in pending {
        diagnostics.record(
            id,
            &call.trace,
            DiagnosticEvent::RuntimeStopped {
                code: ErrorCode::Internal,
            },
        );
        if let Some(sender) = call.events {
            let _ = sender.try_send(RuntimeEventKind::Failure {
                code: ErrorCode::Internal,
                message: "The coordinator runtime stopped; saved work is retained.".into(),
            });
            let _ = sender.try_send(RuntimeEventKind::Done);
        }
    }
    drop(outgoing);
    drop(commands);
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

/// Decode client events without echoing value-bearing serde errors or payloads.
pub fn decode_coordinator_event(frame: &[u8]) -> Result<RuntimeEventKind> {
    serde_json::from_slice(frame).map_err(|error| {
        let category = match error.classify() {
            serde_json::error::Category::Io => "I/O",
            serde_json::error::Category::Syntax => "JSON syntax",
            serde_json::error::Category::Data => "event schema",
            serde_json::error::Category::Eof => "incomplete JSON",
        };
        anyhow::anyhow!(
            "Coordinator returned an invalid event ({category}; {} bytes at {}:{}). Reopen beep-boop chat after an update; saved work is retained.",
            frame.len(), error.line(), error.column(),
        )
    })
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
                if !self.frame.is_empty() {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::UnexpectedEof,
                        "Incomplete protocol frame",
                    )
                    .into());
                }
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
    async fn native_duplex_backpressure_keeps_stdout_readable_during_a_partial_command_write() {
        use crate::{
            protocol::{RuntimeCommand, RuntimeEventKind},
            runtime::Runtime,
        };
        use std::sync::Arc;
        let state = tempfile::tempdir().unwrap();
        let script = state.path().join("duplex.mjs");
        std::fs::write(&script, r#"
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
let input='', paused=false, first,backpressureOwner;const order=[];
const emit=(id,event,done)=>process.stdout.write(JSON.stringify({version:1,id,event})+'\n',done);
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{
 input+=chunk;
 if(first!==undefined&&!paused&&!input.includes('\n')){
  paused=true;process.stdin.pause();
  emit(backpressureOwner,{type:'notice',task_id:null,text:'n'.repeat(1024*1024)},()=>process.stdin.resume());
 }
 while(input.includes('\n')){
  const end=input.indexOf('\n'),{id,command}=JSON.parse(input.slice(0,end));input=input.slice(end+1);
  order.push(command.type);writeFileSync(join(process.argv[2],'wire-order.json'),JSON.stringify(order));
  if(first===undefined){first=id;backpressureOwner=id;emit(id,{type:'configured'});}
  else if(command.type==='status'){
   backpressureOwner=id;paused=false;emit(id,{type:'configured'});
   emit(id,{type:'host_call',call_id:'large-result',command:{type:'exec',program:'fixture',args:[],cwd:'/',timeout_seconds:10}});
  }else if(command.type==='host_reply'){
   if(command.call_id!=='large-result'||command.result.type!=='process'||command.result.stdout!=='z'.repeat(2*1024*1024))throw Error('Host reply frame changed');
   emit(id,{type:'configured'});emit(id,{type:'done'});
  }
  else {
   if(command.type!=='chat'||command.input!=='x'.repeat(2*1024*1024))throw Error('Command framing changed');
   emit(id,{type:'answer',conversation_id:'1',text:command.input_id});emit(id,{type:'done'});emit(first,{type:'done'});
  }
 }
});
"#).unwrap();
        let runtime = Arc::new(Runtime::start(&script, state.path()).unwrap());
        let mut first = runtime.request(RuntimeCommand::Status).await.unwrap();
        assert!(matches!(
            first.events.recv().await,
            Some(RuntimeEventKind::Configured)
        ));
        let owner = runtime.clone();
        let submission = tokio::spawn(async move {
            owner
                .request(RuntimeCommand::Chat {
                    attachments: None,
                    input: "x".repeat(2 * 1024 * 1024),
                    input_id: Some("large-input".into()),
                    instructions: String::new(),
                    model: None,
                    origin_host_id: None,
                    cwd: "/".into(),
                    hosts: vec![],
                })
                .await
        });
        let observed = timeout(Duration::from_secs(2), first.events.recv()).await;
        if observed.is_err() {
            submission.abort();
        }
        let following = if observed.is_ok() {
            let mut call = runtime.request(RuntimeCommand::Status).await.unwrap();
            Some(timeout(Duration::from_secs(3), async {
                assert!(matches!(call.events.recv().await, Some(RuntimeEventKind::Configured)));
                let call_id = match call.events.recv().await { Some(RuntimeEventKind::HostCall { call_id, .. }) => call_id,
                    _ => panic!("The native owner did not request its host result") };
                runtime.reply(call.request_id, call_id, crate::protocol::HostResult::Process {
                    exit_code: 0, stdout: "z".repeat(2 * 1024 * 1024), stderr: String::new(), truncated: false,
                }).await.unwrap();
                assert!(matches!(call.events.recv().await, Some(RuntimeEventKind::Notice { text, .. }) if text.len() == 1024 * 1024));
                (call.events.recv().await, call.events.recv().await)
            }).await)
        } else {
            None
        };
        let submitted = submission.await;
        let completed = match submitted {
            Ok(Ok(mut call)) => Some(
                timeout(Duration::from_secs(2), async {
                    (call.events.recv().await, call.events.recv().await)
                })
                .await,
            ),
            _ => None,
        };
        let runtime = match Arc::try_unwrap(runtime) {
            Ok(runtime) => runtime,
            Err(_) => panic!("Submission retained runtime ownership"),
        };
        runtime.close().await.unwrap_or_else(|error| {
            assert!(observed.is_err(), "Unexpected transport failure: {error:#}");
        });
        assert!(
            matches!(observed, Ok(Some(RuntimeEventKind::Notice { text, .. })) if text.len() == 1024 * 1024),
            "Runtime stopped reading stdout while the child waited to drain it before reading more stdin"
        );
        assert!(
            matches!(completed, Some(Ok((Some(RuntimeEventKind::Answer { text, .. }), Some(RuntimeEventKind::Done)))) if text == "large-input")
        );
        assert!(matches!(
            following,
            Some(Ok((
                Some(RuntimeEventKind::Configured),
                Some(RuntimeEventKind::Done)
            )))
        ));
        let order: Vec<String> =
            serde_json::from_slice(&std::fs::read(state.path().join("wire-order.json")).unwrap())
                .unwrap();
        assert_eq!(order, ["status", "chat", "status", "host_reply"]);
    }

    #[tokio::test]
    async fn canceled_partial_admission_finishes_its_frame_and_rejects_unowned_host_calls() {
        use crate::{
            protocol::{RuntimeCommand, RuntimeEventKind},
            runtime::Runtime,
        };
        use std::sync::Arc;
        let state = tempfile::tempdir().unwrap();
        let script = state.path().join("cancel.mjs");
        std::fs::write(&script, r#"
import {existsSync} from 'node:fs';
import {join} from 'node:path';
let input='',first,paused=false;
const emit=(id,event)=>process.stdout.write(JSON.stringify({version:1,id,event})+'\n');
process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{
 input+=chunk;
 if(first!==undefined&&!paused&&!input.includes('\n')){
  paused=true;process.stdin.pause();
  // The marker is durable; filesystem notifications can be lost or coalesced.
  const waiting=setInterval(()=>{
   if(!existsSync(join(process.argv[2],'release')))return;
   clearInterval(waiting);
   emit(first,{type:'notice',task_id:null,text:'release marker consumed'});
   process.stdin.resume();
  },5);
  emit(first,{type:'notice',task_id:null,text:'partial command is waiting'});
 }
 while(input.includes('\n')){
  const end=input.indexOf('\n'),{id,command}=JSON.parse(input.slice(0,end));input=input.slice(end+1);
  if(first===undefined){first=id;emit(id,{type:'configured'});}
  else if(command.type==='chat'){
   if(command.input!=='x'.repeat(2*1024*1024))throw Error('Canceled command frame changed');
   emit(id,{type:'host_call',call_id:'unowned-host',command:{type:'machine_snapshot'}});
  }else{
   if(command.type!=='host_reply'||command.call_id!=='unowned-host'||command.result.type!=='failed')throw Error('Unowned host effect was not rejected');
   emit(first,{type:'notice',task_id:null,text:'unowned host effect rejected'});emit(id,{type:'done'});emit(first,{type:'done'});
  }
 }
});
"#).unwrap();
        let runtime = Arc::new(Runtime::start(&script, state.path()).unwrap());
        let mut first = runtime.request(RuntimeCommand::Status).await.unwrap();
        assert!(matches!(
            first.events.recv().await,
            Some(RuntimeEventKind::Configured)
        ));
        let owner = runtime.clone();
        let submission = tokio::spawn(async move {
            owner
                .request(RuntimeCommand::Chat {
                    attachments: None,
                    input: "x".repeat(2 * 1024 * 1024),
                    input_id: Some("canceled-input".into()),
                    instructions: String::new(),
                    model: None,
                    origin_host_id: None,
                    cwd: "/".into(),
                    hosts: vec![],
                })
                .await
        });
        assert!(
            matches!(timeout(Duration::from_secs(2), first.events.recv()).await.unwrap(),
            Some(RuntimeEventKind::Notice { text, .. }) if text == "partial command is waiting")
        );
        let log = state.path().join("diagnostics/runtime.jsonl");
        timeout(Duration::from_secs(12), async {
            loop {
                let text = std::fs::read_to_string(&log).unwrap_or_default();
                let complete = text.rsplit_once('\n').map_or("", |(complete, _)| complete);
                let records = complete.lines().map(serde_json::from_str::<crate::runtime::diagnostics::Record>)
                    .collect::<Result<Vec<_>, _>>().unwrap();
                let blocked = records.iter().filter(|record| matches!(record.event,
                    crate::runtime::diagnostics::Event::WriteBackpressure { .. })).collect::<Vec<_>>();
                if let Some(record) = blocked.first() {
                    assert_eq!(blocked.len(), 1);
                    assert_eq!(record.request_id, 2);
                    assert!(matches!(&record.event, crate::runtime::diagnostics::Event::WriteBackpressure {
                        command: Some(command), written_bytes, frame_bytes,
                    } if command == "chat" && *written_bytes > 0 && written_bytes < frame_bytes && *frame_bytes <= MAX_FRAME_BYTES + 1));
                    assert!(!text.contains("xxxx"), "Backpressure diagnostics cannot retain command content");
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }).await.expect("Backpressure must be reported while the child stays alive, without ending the runtime");
        submission.abort();
        assert!(matches!(submission.await, Err(error) if error.is_cancelled()));
        std::fs::write(state.path().join("release"), "Complete the same frame").unwrap();
        let mut release_observed = false;
        let completed = timeout(Duration::from_secs(2), async {
            assert!(matches!(first.events.recv().await,
                Some(RuntimeEventKind::Notice { text, .. }) if text == "release marker consumed"));
            release_observed = true;
            assert!(matches!(first.events.recv().await,
                Some(RuntimeEventKind::Notice { text, .. }) if text == "unowned host effect rejected"));
        })
        .await;
        assert!(
            completed.is_ok(),
            "Canceled admission did not reject its host effect; release marker consumed: {release_observed}"
        );
        let runtime = match Arc::try_unwrap(runtime) {
            Ok(runtime) => runtime,
            Err(_) => panic!("Canceled admission retained the runtime"),
        };
        runtime.close().await.unwrap();
    }

    #[tokio::test]
    async fn shutdown_bypasses_a_saturated_queue_and_reaps_a_child_that_never_reads_again() {
        use crate::{
            protocol::{RuntimeCommand, RuntimeEventKind},
            runtime::{CommandMessage, Runtime},
        };
        use tokio::sync::oneshot;
        let state = tempfile::tempdir().unwrap();
        let script = state.path().join("blocked.mjs");
        std::fs::write(&script, r#"
import {writeFileSync} from 'node:fs';import {join} from 'node:path';
let input='',first,paused=false;
const emit=(id,event)=>process.stdout.write(JSON.stringify({version:1,id,event})+'\n');
process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{
 input+=chunk;
 if(first!==undefined&&!paused){paused=true;process.stdin.pause();emit(first,{type:'notice',task_id:null,text:'stdin paused'});}
 if(first===undefined&&input.includes('\n')){
  const end=input.indexOf('\n'),{id}=JSON.parse(input.slice(0,end));input=input.slice(end+1);first=id;
  writeFileSync(join(process.argv[2],'pid'),String(process.pid));emit(id,{type:'configured'});
 }
});setInterval(()=>{},1000);
"#).unwrap();
        let runtime = Runtime::start(&script, state.path()).unwrap();
        let mut first = runtime.request(RuntimeCommand::Status).await.unwrap();
        assert!(matches!(
            first.events.recv().await,
            Some(RuntimeEventKind::Configured)
        ));
        let (admitted, mut admission) = oneshot::channel();
        runtime
            .commands
            .send(CommandMessage::Request {
                command: Box::new(RuntimeCommand::Chat {
                    attachments: None,
                    input: "x".repeat(2 * 1024 * 1024),
                    input_id: Some("blocked-input".into()),
                    instructions: String::new(),
                    model: None,
                    origin_host_id: None,
                    cwd: "/".into(),
                    hosts: vec![],
                }),
                admitted,
            })
            .await
            .unwrap();
        assert!(matches!(
            timeout(Duration::from_secs(2), first.events.recv())
                .await
                .unwrap(),
            Some(RuntimeEventKind::Notice { .. })
        ));
        assert!(
            matches!(
                admission.try_recv(),
                Err(oneshot::error::TryRecvError::Empty)
            ),
            "A partial frame cannot be admitted"
        );
        let mut queued = Vec::new();
        for _ in 0..64 {
            let (admitted, receiver) = oneshot::channel();
            queued.push(receiver);
            assert!(
                runtime
                    .commands
                    .try_send(CommandMessage::Request {
                        command: Box::new(RuntimeCommand::Status),
                        admitted
                    })
                    .is_ok()
            );
        }
        assert_eq!(runtime.commands.capacity(), 0);
        assert!(
            timeout(
                Duration::from_millis(20),
                runtime.request(RuntimeCommand::Status)
            )
            .await
            .is_err()
        );
        let pid: i32 = std::fs::read_to_string(state.path().join("pid"))
            .unwrap()
            .parse()
            .unwrap();
        timeout(Duration::from_secs(6), runtime.close())
            .await
            .unwrap()
            .unwrap();
        assert!(admission.await.is_err());
        for receiver in queued {
            assert!(receiver.await.is_err());
        }
        assert_eq!(
            unsafe { libc::kill(pid, 0) },
            -1,
            "The unresponsive child must be reaped before writer ownership is released"
        );
    }

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
        let incomplete = FrameReader::new(b"incomplete".as_slice())
            .next_frame()
            .await
            .unwrap_err();
        assert_eq!(
            incomplete.downcast_ref::<std::io::Error>().unwrap().kind(),
            std::io::ErrorKind::UnexpectedEof,
        );
        assert!(
            FrameReader::new(b"".as_slice())
                .next_frame()
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn native_runtime_logs_correlated_lifecycle_without_private_payloads() {
        use crate::protocol::{InputMode, RuntimeCommand, RuntimeEventKind};
        use crate::runtime::{
            Runtime,
            diagnostics::{BrowserCause, BrowserOutcome, Event, Record},
        };
        let state = tempfile::tempdir().unwrap();
        let script = state.path().join("fixture.mjs");
        std::fs::write(&script, r#"
import {createInterface} from 'node:readline';
const model={provider:'openai',model_id:'fixture',reasoning:null,fast:false};
createInterface({input:process.stdin}).on('line',line=>{
 const {id,command}=JSON.parse(line);
 const emit=event=>process.stdout.write(JSON.stringify({version:1,id,event})+'\n');
 if(command.type==='chat') {
  emit({type:'main_ready',conversation_id:'conversation-one',model,cwd:'/PRIVATE_DIRECTORY_SENTINEL'});
  emit({type:'input_placed',input_id:command.input_id,entry_id:'entry-one'});
  emit({type:'message',message:{entry_id:'entry-one',role:'user',text:'PRIVATE_HISTORY_SENTINEL',continuation:false,final_chunk:true}});
  emit({type:'activity',activity:{type:'thinking',text:'PRIVATE_THINKING_SENTINEL'}});
  emit({type:'activity',activity:{type:'tool_started',call_id:'tool-one',name:'PRIVATE_TOOL_NAME_SENTINEL'}});
  emit({type:'host_call',call_id:'host-one',command:{type:'on_node',host_id:'PRIVATE_IDENTITY_SENTINEL',command:{type:'exec',program:'PRIVATE_PROGRAM_SENTINEL',args:['PRIVATE_ARGUMENT_SENTINEL'],cwd:'/PRIVATE_PATH_SENTINEL',timeout_seconds:10}}});
 } else if(command.type==='host_reply') {
  if(command.call_id==='host-one') emit({type:'host_call',call_id:'browser-ready',command:{type:'browser',host_id:'PRIVATE_BROWSER_HOST_SENTINEL',request:{owner_id:'1',session_id:'11111111-1111-4111-8111-111111111111',operation_id:'browser-ready|tool-one',action:{type:'run_code',tab_id:7,code:"async page => page.goto('https://PRIVATE_BROWSER_URL_SENTINEL/?token=PRIVATE_CREDENTIAL_SENTINEL')"}}}});
  else if(command.call_id==='browser-ready') emit({type:'host_call',call_id:'browser-timeout',command:{type:'browser',host_id:'PRIVATE_BROWSER_HOST_SENTINEL',request:{owner_id:'1',session_id:'11111111-1111-4111-8111-111111111111',operation_id:'browser-timeout|tool-one',action:{type:'navigate',tab_id:7,url:'https://PRIVATE_BROWSER_URL_SENTINEL'}}}});
  else emit({type:'activity',activity:{type:'tool_finished',call_id:'tool-one',name:'PRIVATE_TOOL_NAME_SENTINEL'}});
 } else if(command.type==='submit_input') {
  emit({type:'input_accepted',input_id:command.input_id});
  emit({type:'input_placed',input_id:command.input_id,entry_id:'entry-two'});
  emit({type:'host_call',call_id:'host-two',command:{type:'browser',host_id:'PRIVATE_BROWSER_HOST_SENTINEL',request:{owner_id:'1',session_id:'11111111-1111-4111-8111-111111111111',operation_id:'browser-cancel|tool-two',action:{type:'fill',tab_id:7,element_ref:'PRIVATE_SELECTOR_SENTINEL',value:'PRIVATE_FORM_VALUE_SENTINEL'}}}});
 } else if(command.type==='read_history') {
  emit({type:'history',conversation_id:'child-conversation',messages:[],next_cursor:null}); emit({type:'done'});
 } else if(command.type==='interrupt') {
  emit({type:'host_cancel',call_id:'host-two'});
  emit({type:'input_rejected',input_id:'queued-input',message:'PRIVATE_REJECTION_SENTINEL'});
  emit({type:'interrupted'});
  emit({type:'failure',code:'provider_unavailable',message:'PRIVATE_FAILURE_SENTINEL'});
  emit({type:'done'});
 }
});
"#).unwrap();
        let runtime = Runtime::start(&script, state.path()).unwrap();
        let mut call = runtime
            .request(RuntimeCommand::Chat {
                attachments: None,
                input: "PRIVATE_PROMPT_SENTINEL".into(),
                input_id: Some("initial-input".into()),
                instructions: "PRIVATE_INSTRUCTIONS_SENTINEL".into(),
                model: None,
                origin_host_id: None,
                cwd: "/PRIVATE_WORKSPACE_SENTINEL".into(),
                hosts: vec![],
            })
            .await
            .unwrap();
        let request_id = call.request_id;
        timeout(Duration::from_secs(3), async {
            loop {
                match call.events.recv().await.unwrap() {
                    RuntimeEventKind::HostCall { call_id, command } => {
                        let result = if let crate::protocol::HostCommand::Browser { request, .. } = *command {
                            crate::protocol::HostResult::Browser { response: if call_id == "browser-ready" {
                                crate::browser::BrowserResponse::Ready {
                                    session_id: request.session_id,
                                    tabs: vec![crate::browser::BrowserTab { id: 7,
                                        title: "PRIVATE_BROWSER_TITLE_SENTINEL".into(),
                                        url: "https://PRIVATE_BROWSER_URL_SENTINEL".into() }],
                                    output: "PRIVATE_BROWSER_OUTPUT_SENTINEL".into(), is_error: false,
                                }
                            } else { crate::browser::BrowserResponse::Uncertain {
                                session_id: request.session_id,
                                message: "Failure stage: browser_operation. PRIVATE_BROWSER_ERROR_SENTINEL Connection stage: pairing.".into(),
                            } } }
                        } else { crate::protocol::HostResult::Process {
                                exit_code: 0,
                                stdout: "PRIVATE_STDOUT_SENTINEL".into(),
                                stderr: "PRIVATE_STDERR_SENTINEL".into(),
                                truncated: false,
                            } };
                        runtime.reply(request_id, call_id, result).await.unwrap();
                    }
                    RuntimeEventKind::Activity {
                        activity: crate::protocol::ModelActivity::ToolFinished { .. },
                    } => break,
                    _ => {}
                }
            }
            runtime
                .worker_control(
                    request_id,
                    RuntimeCommand::SubmitInput {
                        attachments: None,
                        input_id: "queued-input".into(),
                        input: "PRIVATE_STEERING_SENTINEL".into(),
                        mode: InputMode::FollowUp,
                    },
                )
                .await
                .unwrap();
            while !matches!(
                call.events.recv().await.unwrap(),
                RuntimeEventKind::HostCall { .. }
            ) {}
            runtime
                .worker_control(request_id, RuntimeCommand::Interrupt)
                .await
                .unwrap();
            while !matches!(call.events.recv().await.unwrap(), RuntimeEventKind::Done) {}
        })
        .await
        .unwrap();
        runtime
            .worker_control(
                request_id,
                RuntimeCommand::SubmitInput {
                    attachments: None,
                    input_id: "late-input".into(),
                    input: "PRIVATE_LATE_INPUT_SENTINEL".into(),
                    mode: InputMode::Steer,
                },
            )
            .await
            .unwrap();
        let task_id = crate::protocol::TaskId::new();
        let mut history = runtime
            .request(RuntimeCommand::ReadHistory {
                task_id: Some(task_id.clone()),
                agent_id: Some("child-one".into()),
                cursor: None,
            })
            .await
            .unwrap();
        let history_request = history.request_id;
        timeout(Duration::from_secs(3), async {
            while !matches!(history.events.recv().await.unwrap(), RuntimeEventKind::Done) {}
        })
        .await
        .unwrap();
        runtime.close().await.unwrap();
        let path = state.path().join("diagnostics/runtime.jsonl");
        let (text, records) = timeout(Duration::from_secs(3), async {
            loop {
                let text = std::fs::read_to_string(&path).unwrap_or_default();
                let complete = text.rsplit_once('\n').map_or("", |(complete, _)| complete);
                let records = complete
                    .lines()
                    .map(serde_json::from_str::<Record>)
                    .collect::<Result<Vec<_>, _>>()
                    .unwrap();
                if records.iter().any(|record| {
                    record.request_id == history_request && matches!(record.event, Event::Done)
                }) {
                    break (text, records);
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert!(
            !text.contains("PRIVATE_"),
            "No prompts, paths, identities, tool names, arguments, thinking, output or errors belong in mechanical logs"
        );
        assert!(records.iter().all(|record| record.timestamp_ms > 0));
        let child = records
            .iter()
            .filter(|record| record.request_id == history_request)
            .collect::<Vec<_>>();
        assert!(child.iter().all(|record| record.task_id.as_deref()
            == Some(task_id.to_string().as_str())
            && record.agent_id.as_deref() == Some("child-one")));
        assert_eq!(
            child.last().unwrap().conversation_id.as_deref(),
            Some("child-conversation")
        );
        let records = records
            .into_iter()
            .filter(|record| record.request_id == request_id)
            .collect::<Vec<_>>();
        assert!(
            records
                .iter()
                .filter_map(|record| record.elapsed_ms)
                .collect::<Vec<_>>()
                .windows(2)
                .all(|pair| pair[0] <= pair[1])
        );
        let events = records
            .iter()
            .map(|record| &record.event)
            .collect::<Vec<_>>();
        assert!(matches!(events[0], Event::RequestReceived));
        assert!(
            matches!(events[1], Event::InputReceived { input_id: Some(id), mode: None } if id == "initial-input")
        );
        assert!(matches!(events[2], Event::CommandSent { command } if command == "chat"));
        assert!(matches!(events[3], Event::Ready));
        assert!(
            matches!(events[4], Event::InputPlaced { input_id: Some(id), .. } if id == "initial-input")
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, Event::FirstActivity))
                .count(),
            1
        );
        assert!(events.iter().any(
            |event| matches!(event, Event::HostCall { command: Some(kind), .. } if kind == "exec")
        ));
        assert!(events.iter().any(
            |event| matches!(event, Event::HostReply { command: Some(kind), .. } if kind == "exec")
        ));
        let browser_calls = events
            .iter()
            .filter_map(|event| match event {
                Event::HostCall {
                    browser: Some(browser),
                    ..
                } => Some(browser),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(browser_calls.len(), 3);
        assert!(
            browser_calls
                .iter()
                .all(|browser| browser.owner_id.as_deref() == Some("1")
                    && browser.session_id.to_string() == "11111111-1111-4111-8111-111111111111"
                    && browser.tab_id == Some(7))
        );
        assert_eq!(browser_calls[0].action, "run_code");
        assert_eq!(
            browser_calls[0].operation_id.as_deref(),
            Some("browser-ready|tool-one")
        );
        assert!(events.iter().any(|event| matches!(event,
            Event::HostReply { call_id: Some(id), browser: Some(browser), .. }
            if id == "browser-ready" && matches!(browser.outcome, BrowserOutcome::Ready)
                && !browser.is_error && browser.owned_count == Some(1)
                && browser.call.operation_id.as_deref() == Some("browser-ready|tool-one"))));
        assert!(events.iter().any(|event| matches!(event,
            Event::HostReply { call_id: Some(id), browser: Some(browser), .. }
            if id == "browser-timeout" && matches!(browser.outcome, BrowserOutcome::Uncertain)
                && browser.is_error && browser.owned_count.is_none()
                && matches!(browser.cause, Some(BrowserCause::BrowserOperation))
                && browser.call.operation_id.as_deref() == Some("browser-timeout|tool-one"))));
        assert!(events.iter().any(|event| matches!(event,
            Event::HostCancelRequested { call_id: Some(id), browser: Some(browser), .. }
            if id == "host-two" && browser.action == "fill"
                && browser.operation_id.as_deref() == Some("browser-cancel|tool-two"))));
        assert!(events.iter().any(|event| matches!(event, Event::InputReceived { input_id: Some(id), mode: Some(InputMode::FollowUp) } if id == "queued-input")));
        assert!(events.iter().any(|event| matches!(event, Event::HostCancelRequested { call_id: Some(id), duration_ms: Some(_), .. } if id == "host-two")));
        assert!(events.iter().any(|event| matches!(
            event,
            Event::Failure {
                code: crate::protocol::ErrorCode::ProviderUnavailable
            }
        )));
        let done = events
            .iter()
            .position(|event| matches!(event, Event::Done))
            .unwrap();
        assert!(
            matches!(events[done + 1], Event::InputReceived { input_id: Some(id), mode: Some(InputMode::Steer) } if id == "late-input")
        );
        assert!(matches!(events[done + 2], Event::ControlIgnored));
        assert!(
            records
                .iter()
                .skip(done + 1)
                .all(|record| record.elapsed_ms.is_none() && record.conversation_id.is_none())
        );
        assert!(
            records
                .iter()
                .skip(3)
                .filter(|record| record.elapsed_ms.is_some())
                .all(|record| record.conversation_id.as_deref() == Some("conversation-one"))
        );
    }

    #[tokio::test]
    async fn unavailable_diagnostics_does_not_block_or_change_runtime_results() {
        use crate::protocol::{RuntimeCommand, RuntimeEventKind};
        use crate::runtime::Runtime;
        let state = tempfile::tempdir().unwrap();
        std::fs::write(
            state.path().join("diagnostics"),
            "Preserve existing unrelated file",
        )
        .unwrap();
        let script = state.path().join("fixture.mjs");
        std::fs::write(
            &script,
            r#"
import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{
 const {id}=JSON.parse(line);
 process.stdout.write(JSON.stringify({version:1,id,event:{type:'configured'}})+'\n');
 process.stdout.write(JSON.stringify({version:1,id,event:{type:'done'}})+'\n');
});
"#,
        )
        .unwrap();
        let runtime = Runtime::start(&script, state.path()).unwrap();
        for _ in 0..3 {
            let mut call = runtime.request(RuntimeCommand::Status).await.unwrap();
            timeout(Duration::from_secs(3), async {
                assert!(matches!(
                    call.events.recv().await,
                    Some(RuntimeEventKind::Configured)
                ));
                assert!(matches!(
                    call.events.recv().await,
                    Some(RuntimeEventKind::Done)
                ));
            })
            .await
            .unwrap();
        }
        runtime.close().await.unwrap();
        assert_eq!(
            std::fs::read_to_string(state.path().join("diagnostics")).unwrap(),
            "Preserve existing unrelated file"
        );
    }
}
