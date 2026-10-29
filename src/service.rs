use std::{
    collections::{HashMap, HashSet},
    fs,
    future::{Future, pending},
    io,
    os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use crate::{
    broker::Broker,
    protocol::{CoordinatorBootstrap, HostCommand, RuntimeCommand, RuntimeEventKind},
};
use anyhow::{Context, Result, ensure};
use serde::Serialize;
use tokio::{
    io::{AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
    task::JoinSet,
    time::timeout,
};

use crate::runtime::{FrameReader, Runtime, ShutdownSignal};

const SOCKET_NAME: &str = "agent.sock";

pub async fn connect(state: &Path) -> io::Result<UnixStream> {
    UnixStream::connect(state.join(SOCKET_NAME)).await
}

/// SSH carries this same local protocol without another database or listener.
pub async fn relay(stream: UnixStream) -> Result<()> {
    let (mut reader, mut writer) = stream.into_split();
    let mut input = tokio::io::stdin();
    let mut output = tokio::io::stdout();
    let incoming = async {
        tokio::io::copy(&mut input, &mut writer).await?;
        writer.shutdown().await?;
        Ok::<(), io::Error>(())
    };
    let outgoing = async {
        tokio::io::copy(&mut reader, &mut output).await?;
        output.flush().await?;
        Ok::<(), io::Error>(())
    };
    tokio::pin!(incoming, outgoing);
    tokio::select! {
        result = &mut incoming => { result?; outgoing.await?; }
        result = &mut outgoing => { result?; }
    }
    Ok(())
}

pub async fn serve(script: &Path, state: &Path) -> Result<()> {
    serve_until(script, state, shutdown_signal()).await
}

pub async fn serve_tailnet(
    script: &Path,
    state: &Path,
    port: u16,
    policy: crate::tailnet::PeerPolicy,
    daemon: crate::tailnet::Daemon,
) -> Result<()> {
    serve_with_transport(
        script,
        state,
        Some(port),
        policy,
        daemon,
        None,
        shutdown_signal(),
    )
    .await
}

pub async fn serve_configured(
    script: &Path,
    state: &Path,
    port: Option<u16>,
    policy: crate::tailnet::PeerPolicy,
    daemon: crate::tailnet::Daemon,
    bootstrap: CoordinatorBootstrap,
) -> Result<()> {
    serve_with_transport(
        script,
        state,
        port,
        policy,
        daemon,
        Some(bootstrap),
        shutdown_signal(),
    )
    .await
}

#[derive(Clone, Copy)]
enum ShutdownReason {
    Signal(ShutdownSignal),
    #[cfg(test)]
    Requested,
}

async fn shutdown_signal() -> Result<ShutdownReason> {
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let signal = tokio::select! {
        result = tokio::signal::ctrl_c() => { result?; ShutdownSignal::Sigint }
        _ = terminate.recv() => ShutdownSignal::Sigterm,
    };
    Ok(ShutdownReason::Signal(signal))
}

async fn serve_until(
    script: &Path,
    state: &Path,
    shutdown: impl Future<Output = Result<ShutdownReason>>,
) -> Result<()> {
    serve_with_transport(
        script,
        state,
        None,
        crate::tailnet::PeerPolicy::new(&[], &[])?,
        crate::tailnet::Daemon::default(),
        None,
        shutdown,
    )
    .await
}

async fn serve_with_transport(
    script: &Path,
    state: &Path,
    port: Option<u16>,
    policy: crate::tailnet::PeerPolicy,
    daemon: crate::tailnet::Daemon,
    bootstrap: Option<CoordinatorBootstrap>,
    shutdown: impl Future<Output = Result<ShutdownReason>>,
) -> Result<()> {
    // Claim the writer before deciding an old socket is stale.
    let background = bootstrap
        .as_ref()
        .and_then(|value| value.background.clone());
    let owner = Runtime::start(script, state)?;
    let broker = match Broker::with_tailscale(bootstrap.as_ref(), state, daemon.clone()) {
        Ok(broker) => Arc::new(broker),
        Err(error) => {
            owner.close().await?;
            return Err(error);
        }
    };
    if let Some(bootstrap) = bootstrap {
        let host_ids = bootstrap
            .node
            .as_ref()
            .map(|node| node.host_id.clone())
            .into_iter()
            .collect();
        if let Err(error) = async {
            crate::broker::control(&owner, RuntimeCommand::ConfigureCoordinator { bootstrap })
                .await?;
            crate::broker::control(&owner, RuntimeCommand::SetConnectedNodes { host_ids }).await
        }
        .await
        {
            owner.close().await?;
            return Err(error);
        }
    }
    let (listener, socket) = match SocketOwner::bind(state.join(SOCKET_NAME)) {
        Ok(bound) => bound,
        Err(error) => {
            owner.close().await?;
            return Err(error);
        }
    };
    let owner = Arc::new(owner);
    let tailnet = match port {
        Some(port) => match crate::tailnet::listen(port, &daemon).await {
            Ok(listener) => Some(listener),
            Err(error) => {
                drop(listener);
                drop(socket);
                Arc::try_unwrap(owner)
                    .map_err(|_| anyhow::anyhow!("Coordinator ownership leaked"))?
                    .close()
                    .await?;
                return Err(error);
            }
        },
        None => None,
    };
    let mut clients = JoinSet::new();
    let mut background = background.map(|settings| {
        let runtime = owner.clone();
        let broker = broker.clone();
        tokio::spawn(async move { crate::background::run(runtime, broker, settings).await })
    });
    tokio::pin!(shutdown);
    let result = loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    let runtime = owner.clone();
                    let broker = broker.clone();
                    clients.spawn(async move { handle(stream, runtime, broker).await });
                }
                Err(error) => break Err(error.into()),
            },
            accepted = async {
                match &tailnet {
                    Some(listener) => listener.accept().await,
                    None => pending().await,
                }
            } => match accepted {
                Ok((stream, peer)) => {
                    let local = match stream.local_addr() {
                        Ok(local) => local,
                        Err(error) => break Err(error.into()),
                    };
                    let runtime = owner.clone();
                    let policy = policy.clone();
                    let daemon = daemon.clone();
                    let broker = broker.clone();
                    clients.spawn(async move {
                        authenticated(stream, runtime, broker, peer, crate::tailnet::validate_connection(local, peer, &policy, &daemon)).await
                    });
                }
                Err(error) => break Err(error.into()),
            },
            _ = owner.stopped() => {
                break Err(anyhow::anyhow!("The Pi runtime stopped; saved work is retained"));
            }
            result = async {
                match &mut background {
                    Some(task) => task.await,
                    None => pending().await,
                }
            } => {
                background = None;
                break Err(anyhow::anyhow!("The background transport stopped; saved work is retained: {result:?}"));
            },
            result = &mut shutdown => {
                if let Ok(ShutdownReason::Signal(signal)) = &result {
                    owner.record_shutdown(*signal);
                }
                break result.map(|_| ());
            },
            Some(_) = clients.join_next(), if !clients.is_empty() => {}
        }
    };
    drop(listener);
    drop(tailnet);
    // Allow terminal results to flush, then release idle client ownership.
    let _ = timeout(Duration::from_secs(1), async {
        while clients.join_next().await.is_some() {}
    })
    .await;
    clients.abort_all();
    while clients.join_next().await.is_some() {}
    if let Some(task) = background {
        task.abort();
        let _ = task.await;
    }
    let runtime = Arc::try_unwrap(owner)
        .map_err(|_| anyhow::anyhow!("A client retained coordinator ownership"))?;
    let closed = runtime.close().await;
    drop(socket);
    closed?;
    result
}

pub(crate) async fn write_frame<W: AsyncWrite + Unpin, T: Serialize>(
    writer: &mut W,
    value: &T,
) -> Result<()> {
    let mut bytes = serde_json::to_vec(value)?;
    bytes.push(b'\n');
    writer.write_all(&bytes).await?;
    writer.flush().await?;
    Ok(())
}

async fn authenticated<S: AsyncRead + AsyncWrite + Unpin>(
    stream: S,
    runtime: Arc<Runtime>,
    broker: Arc<Broker>,
    peer: std::net::SocketAddr,
    authorization: impl Future<Output = Result<()>>,
) -> Result<()> {
    if let Err(error) = authorization.await {
        runtime.record_peer_rejected(peer, &error.to_string());
        return Err(error);
    }
    handle(stream, runtime, broker).await
}

async fn handle<S: AsyncRead + AsyncWrite + Unpin>(
    stream: S,
    runtime: Arc<Runtime>,
    broker: Arc<Broker>,
) -> Result<()> {
    let (reader, mut writer) = tokio::io::split(stream);
    let mut reader = FrameReader::new(BufReader::new(reader));
    let initial = reader
        .next_frame()
        .await?
        .context("Client sent no command")?;
    let mut command: RuntimeCommand =
        serde_json::from_slice(&initial).context("Client sent an invalid command")?;
    let attachment = match &command {
        RuntimeCommand::Attachment { request } => Some((request.clone(), false)),
        RuntimeCommand::Native {
            request: crate::native::NativeRequest::Attachment { request },
        } => Some((request.clone(), true)),
        _ => None,
    };
    if let Some((mut request, native)) = attachment {
        // One authenticated owner transfers a file sequentially, without a
        // new socket or a live main-conversation observer for every chunk.
        loop {
            let mut call = runtime
                .request(RuntimeCommand::Attachment { request })
                .await?;
            let mut completed = false;
            while let Some(event) = call.events.recv().await {
                let done = matches!(event, RuntimeEventKind::Done);
                if native {
                    if let Some(event) = crate::native::project(&event) {
                        write_frame(&mut writer, &event).await?;
                    }
                } else {
                    write_frame(&mut writer, &event).await?;
                }
                if done {
                    completed = true;
                    break;
                }
            }
            anyhow::ensure!(completed, "Attachment transfer ended without completion");
            let Some(frame) =
                tokio::time::timeout(std::time::Duration::from_secs(60), reader.next_frame())
                    .await??
            else {
                return Ok(());
            };
            request = match serde_json::from_slice::<RuntimeCommand>(&frame)? {
                RuntimeCommand::Attachment { request } if !native => request,
                RuntimeCommand::Native {
                    request: crate::native::NativeRequest::Attachment { request },
                } if native => request,
                next if matches!(&next, RuntimeCommand::Native { .. }) == native => {
                    command = next;
                    break;
                }
                _ => anyhow::bail!("An attachment connection must preserve its protocol envelope"),
            };
        }
    }
    let native = matches!(command, RuntimeCommand::Native { .. });
    let command = match command {
        RuntimeCommand::Native { request } => {
            match crate::native::prepare(request).unwrap_or_else(|error| {
                crate::native::Operation::Local(crate::native::NativeEvent::Failure {
                    message: error.to_string(),
                })
            }) {
                crate::native::Operation::Runtime(command) => *command,
                crate::native::Operation::Local(event) => {
                    write_frame(&mut writer, &event).await?;
                    write_frame(&mut writer, &crate::native::NativeEvent::Done).await?;
                    return Ok(());
                }
            }
        }
        command => command,
    };
    let login = matches!(command, RuntimeCommand::Login);
    ensure!(
        !matches!(
            command,
            RuntimeCommand::Interrupt
                | RuntimeCommand::DetachMain
                | RuntimeCommand::DetachConversation
                | RuntimeCommand::SubmitInput { .. }
                | RuntimeCommand::WorkerInput { .. }
                | RuntimeCommand::DetachWorker
                | RuntimeCommand::HostReply { .. }
                | RuntimeCommand::OAuthCallback { .. }
        ),
        "Control commands require their active chat or login connection"
    );
    ensure!(
        !matches!(
            command,
            RuntimeCommand::ConfigureCoordinator { .. }
                | RuntimeCommand::RunBackground { .. }
                | RuntimeCommand::RegisterNode { .. }
                | RuntimeCommand::SetConnectedNodes { .. }
        ),
        "Coordinator metadata is owned by its local service"
    );
    if let RuntimeCommand::ConnectWorker { node } = command {
        return broker.worker(reader, writer, &runtime, node).await;
    }
    if matches!(command, RuntimeCommand::Watch) {
        let mut notices = runtime.subscribe();
        loop {
            tokio::select! {
                notice = notices.recv() => match notice {
                    Ok(notice) => write_frame(&mut writer, &notice.event).await?,
                    Err(_) => anyhow::bail!("Live updates were interrupted; saved task updates remain available"),
                },
                _ = runtime.stopped() => anyhow::bail!("Coordinator stopped; saved updates remain available"),
                input = reader.next_frame() => {
                    ensure!(input?.is_none(), "A live-update subscriber cannot submit another command");
                    return Ok(());
                }
            }
        }
    }
    let attached = matches!(command, RuntimeCommand::RunTask { .. });
    let main_view = matches!(
        command,
        RuntimeCommand::AttachMain
            | RuntimeCommand::ObserveMain { .. }
            | RuntimeCommand::AttachConversation { .. }
    );
    let interruptible = attached || main_view || matches!(command, RuntimeCommand::Chat { .. });
    let interactive = matches!(
        command,
        RuntimeCommand::RunTask {
            interactive: Some(true),
            ..
        }
    );
    if native && main_view {
        write_frame(
            &mut writer,
            &crate::native::NativeEvent::Commands {
                commands: crate::native::commands(),
            },
        )
        .await?;
    }
    let mut call = runtime.request(command).await?;
    let mut input_closed = false;
    let mut output_closed = false;
    let mut host_calls = HashSet::new();
    let mut effects = JoinSet::new();
    let mut cancellations: HashMap<String, tokio::sync::watch::Sender<bool>> = HashMap::new();
    let result: Result<()> = async {
        loop {
            tokio::select! {
                completed = effects.join_next(), if !effects.is_empty() => {
                    let (call_id, result) = completed.context("Owned effect queue closed")??;
                    cancellations.remove(&call_id);
                    runtime.reply(call.request_id, call_id, result).await?;
                }
                event = call.events.recv() => {
                    let event = event.context("Coordinator closed before completing the request")?;
                    if let RuntimeEventKind::HostCall { call_id, command } = &event {
                        if !attached || matches!(**command, HostCommand::OnNode { .. } | HostCommand::ReadContext { .. } | HostCommand::SearchContext { .. } | HostCommand::ReloadGuidance | HostCommand::Embed { .. }) {
                            let (cancel, cancelled) = tokio::sync::watch::channel(false);
                            cancellations.insert(call_id.clone(), cancel);
                            let broker = broker.clone(); let command = (**command).clone(); let call_id = call_id.clone();
                            effects.spawn(async move { (call_id, broker.execute_cancelled(command, cancelled).await) });
                            continue;
                        }
                        if input_closed {
                            runtime.reply(call.request_id, call_id.clone(), disconnected()).await?;
                            continue;
                        }
                        host_calls.insert(call_id.clone());
                    }
                    if let RuntimeEventKind::HostCancel { call_id } = &event
                        && let Some(cancel) = cancellations.get(call_id) {
                        let _ = cancel.send(true);
                        continue;
                    }
                    let done = matches!(event, RuntimeEventKind::Done);
                    let written = if native {
                        match crate::native::project(&event) {
                            Some(event) if !output_closed => write_frame(&mut writer, &event).await,
                            _ => Ok(()),
                        }
                    } else if !output_closed { write_frame(&mut writer, &event).await } else { Ok(()) };
                    if let Err(error) = written {
                        if attached || main_view { return Err(error); }
                        input_closed = true;
                        output_closed = true;
                    }
                    if done { return Ok(()); }
                }
                frame = reader.next_frame(), if !input_closed => {
                    let bytes = match frame {
                        Ok(bytes) => bytes,
                        Err(_) if !attached && !main_view => {
                            // A dropped CLI does not revoke work it already
                            // admitted. Keep the effect owner alive through its
                            // real result, as with EOF or a failed output write.
                            input_closed = true;
                            output_closed = true;
                            continue;
                        }
                        Err(error) => return Err(error),
                    };
                    let Some(bytes) = bytes else {
                        if main_view { return Ok(()); }
                        input_closed = true;
                        if interactive { runtime.worker_control(call.request_id, RuntimeCommand::DetachWorker).await?; }
                        for call_id in host_calls.drain() {
                            runtime.reply(call.request_id, call_id, disconnected()).await?;
                        }
                        continue;
                    };
                    let reply: RuntimeCommand = serde_json::from_slice(&bytes)
                        .context("Execution client sent an invalid host reply")?;
                    match reply {
                        RuntimeCommand::HostReply { call_id, result } => {
                            ensure!(host_calls.remove(&call_id), "Client replied to an unknown host call");
                            runtime.reply(call.request_id, call_id, result).await?;
                        }
                        RuntimeCommand::Interrupt if interruptible => {
                            runtime.worker_control(call.request_id, RuntimeCommand::Interrupt).await?;
                        }
                        command @ RuntimeCommand::SubmitInput { .. } if interactive || (!attached && interruptible) => {
                            runtime.worker_control(call.request_id, command).await?;
                        }
                        RuntimeCommand::OAuthCallback { target } if login => {
                            runtime.callback(call.request_id, target).await?;
                        }
                        command @ (RuntimeCommand::WorkerInput { .. } | RuntimeCommand::DetachWorker) if interactive => {
                            runtime.worker_control(call.request_id, command).await?;
                        }
                        _ => anyhow::bail!("An active client may only reply to its host calls"),
                    }
                }
            }
        }
    }.await;
    for cancel in cancellations.values() {
        let _ = cancel.send(true);
    }
    while let Some(completed) = effects.join_next().await {
        if let Ok((call_id, response)) = completed {
            let _ = runtime.reply(call.request_id, call_id, response).await;
        }
    }
    runtime.detach(call.request_id).await;
    result
}

fn disconnected() -> crate::protocol::HostResult {
    crate::protocol::HostResult::Failed {
        message: "The execution client disconnected; no command ran on a fallback host.".into(),
    }
}

struct SocketOwner {
    path: PathBuf,
    device: u64,
    inode: u64,
}

impl SocketOwner {
    fn bind(path: PathBuf) -> Result<(UnixListener, Self)> {
        match fs::symlink_metadata(&path) {
            Ok(metadata) => {
                ensure!(
                    metadata.file_type().is_socket(),
                    "Coordinator socket path contains a foreign non-socket; preserving it"
                );
                fs::remove_file(&path)?;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let listener = UnixListener::bind(&path)?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
        let metadata = fs::symlink_metadata(&path)?;
        Ok((
            listener,
            Self {
                path,
                device: metadata.dev(),
                inode: metadata.ino(),
            },
        ))
    }
}

impl Drop for SocketOwner {
    fn drop(&mut self) {
        if let Ok(metadata) = fs::symlink_metadata(&self.path)
            && metadata.file_type().is_socket()
            && metadata.dev() == self.device
            && metadata.ino() == self.inode
        {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
#[path = "service/reset_tests.rs"]
mod reset_tests;

#[cfg(test)]
mod tests {
    use crate::protocol::{AuthStatus, HostResult, InputMode, RuntimeCommand, RuntimeEventKind};
    use crate::runtime::{FrameReader, Runtime, ShutdownSignal};
    use crate::service::{
        SOCKET_NAME, ShutdownReason, SocketOwner, authenticated, connect, serve_until, write_frame,
    };
    use anyhow::Result;
    use std::{fs, path::PathBuf, sync::Arc, time::Duration};
    use tokio::{
        io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
        net::{TcpListener, TcpStream, UnixStream},
        sync::oneshot,
        task::JoinHandle,
        time::{Instant, sleep, timeout},
    };

    const FIXTURE: &str = r#"
      import { createInterface } from 'node:readline';
      import { renameSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const emit = (id,event) => process.stdout.write(JSON.stringify({version:1,id,event})+'\n');
      const finish = id => { emit(id,{type:'auth_status',status:{state:'signed_out'}}); emit(id,{type:'done'}); };
      const publish = (name, value) => {
        const path = join(process.argv[2],name), temporary = path+'.'+process.pid+'.tmp';
        writeFileSync(temporary,value); renameSync(temporary,path);
      };
      createInterface({input:process.stdin}).on('line', line => {
        const {id,command}=JSON.parse(line);
        publish('admitted','yes');
        if(command.type==='login') {
          publish('login-id',String(id));
          setTimeout(() => {
            emit(id,{type:'notice',task_id:'22222222-2222-4222-8222-222222222222',text:'Synthetic task completed.'});
            publish('completed','yes'); finish(id);
          },60);
        } else if(typeof command.target==='string') {
          publish('callback.json',JSON.stringify({id,target:command.target}));
        } else if(command.type==='run_task'&&command.interactive) {
          emit(id,{type:'task_ready',conversation_id:'persisted-task',title:'Interactive fixture'});
          emit(id,{type:'worker_idle'});
        } else if(command.type==='chat') {
          emit(id,{type:'notice',task_id:null,text:'Chat ready'});
        } else if(command.type==='submit_input') {
          publish('input-'+command.input_id+'.json',JSON.stringify({id,input:command.input,mode:command.mode}));
          emit(id,{type:'input_accepted',input_id:command.input_id});
        } else if(command.type==='interrupt') {
          finish(id);
        } else if(command.type==='worker_input') {
          publish('worker-input.json',JSON.stringify({id,input:command.input}));
          emit(id,{type:'answer',conversation_id:'persisted-task',text:command.input}); emit(id,{type:'worker_idle'});
        } else if(command.type==='detach_worker') {
          publish('worker-detached',String(id)); emit(id,{type:'done'});
        } else if(command.type==='run_task'||command.type==='logout') {
          emit(id,{type:'host_call',call_id:'11111111-1111-4111-8111-111111111111',command:{
            type:'exec',program:'node',args:['--eval','process.stdout.write("synthetic\\n")'],cwd:'/',timeout_seconds:60}});
        } else if(command.type==='host_reply') {
          publish('reply.json',JSON.stringify(command.result)); finish(id);
        } else if(command.type==='list_tasks') { process.exit(0); }
        else { finish(id); }
      });
    "#;

    fn attached_command() -> RuntimeCommand {
        RuntimeCommand::RunTask {
            task_id: crate::protocol::TaskId::new(),
            agent_id: None,
            allocation_id: "fixture".into(),
            binding: crate::protocol::WorkerRef {
                host_id: "11111111-1111-4111-8111-111111111111".into(),
                session_id: "fixture".into(),
                window_id: "fixture".into(),
                block_id: "fixture".into(),
            },
            instructions: String::new(),
            model: crate::models::ModelSelection::default(),
            cwd: "/".into(),
            interactive: None,
        }
    }

    #[tokio::test]
    async fn submitted_inputs_stay_on_their_active_chat_or_worker_connection() {
        #[derive(serde::Deserialize)]
        struct Submitted {
            id: u32,
            input: String,
            mode: InputMode,
        }
        let service = Running::start().await;
        let mut unscoped = service.client().await;
        write_frame(
            &mut unscoped,
            &RuntimeCommand::SubmitInput {
                attachments: None,
                input_id: "unscoped".into(),
                input: "Rejected".into(),
                mode: InputMode::Steer,
            },
        )
        .await
        .unwrap();
        let mut bytes = Vec::new();
        unscoped.read_to_end(&mut bytes).await.unwrap();
        assert!(bytes.is_empty());
        assert!(
            !service
                .directory
                .path()
                .join("input-unscoped.json")
                .exists()
        );

        let mut chat = service.client().await;
        write_frame(
            &mut chat,
            &RuntimeCommand::Chat {
                attachments: None,
                input: "Start chat".into(),
                input_id: None,
                instructions: String::new(),
                model: None,
                origin_host_id: None,
                cwd: "/".into(),
                hosts: vec![],
            },
        )
        .await
        .unwrap();
        let (read, mut write) = chat.into_split();
        let mut chat = FrameReader::new(BufReader::new(read));
        chat.next_frame().await.unwrap().unwrap();
        for (input_id, mode) in [("steer", InputMode::Steer), ("queue", InputMode::FollowUp)] {
            write_frame(
                &mut write,
                &RuntimeCommand::SubmitInput {
                    attachments: None,
                    input_id: input_id.into(),
                    input: input_id.into(),
                    mode,
                },
            )
            .await
            .unwrap();
            let event: RuntimeEventKind =
                serde_json::from_slice(&chat.next_frame().await.unwrap().unwrap()).unwrap();
            assert!(
                matches!(event, RuntimeEventKind::InputAccepted { input_id: accepted } if accepted == input_id)
            );
        }
        let read = |name: &str| -> Submitted {
            serde_json::from_slice(
                &fs::read(service.directory.path().join(format!("input-{name}.json"))).unwrap(),
            )
            .unwrap()
        };
        let steer = read("steer");
        let queue = read("queue");
        assert_eq!(steer.id, queue.id);
        assert_eq!(steer.input, "steer");
        assert_eq!(steer.mode, InputMode::Steer);
        assert_eq!(queue.mode, InputMode::FollowUp);
        status(service.client().await).await;
        write_frame(&mut write, &RuntimeCommand::Interrupt)
            .await
            .unwrap();
        loop {
            let event: RuntimeEventKind =
                serde_json::from_slice(&chat.next_frame().await.unwrap().unwrap()).unwrap();
            if matches!(event, RuntimeEventKind::Done) {
                break;
            }
        }
        drop((chat, write));
        service.stop().await;
    }

    struct Running {
        directory: tempfile::TempDir,
        stop: oneshot::Sender<()>,
        task: JoinHandle<Result<()>>,
    }

    impl Running {
        async fn start() -> Self {
            Self::start_with_shutdown(ShutdownReason::Requested).await
        }

        async fn start_with_shutdown(reason: ShutdownReason) -> Self {
            let directory = tempfile::tempdir().unwrap();
            let script = directory.path().join("fixture.mjs");
            fs::write(&script, FIXTURE).unwrap();
            Self::start_script(directory, script, reason).await
        }

        async fn start_script(
            directory: tempfile::TempDir,
            script: PathBuf,
            reason: ShutdownReason,
        ) -> Self {
            let state = directory.path().to_path_buf();
            let (stop, stopped) = oneshot::channel();
            let task = tokio::spawn(async move {
                serve_until(&script, &state, async {
                    let _ = stopped.await;
                    Ok(reason)
                })
                .await
            });
            let result = Self {
                directory,
                stop,
                task,
            };
            drop(result.client().await);
            result
        }

        async fn client(&self) -> UnixStream {
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                match connect(self.directory.path()).await {
                    Ok(stream) => return stream,
                    Err(_) => {
                        assert!(Instant::now() < deadline, "Coordinator did not bind");
                        sleep(Duration::from_millis(5)).await;
                    }
                }
            }
        }

        async fn stop(self) {
            self.stop.send(()).unwrap();
            timeout(Duration::from_secs(5), self.task)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert!(!self.directory.path().join(SOCKET_NAME).exists());
        }

        async fn wait_for(&self, filename: &str) -> PathBuf {
            let path = self.directory.path().join(filename);
            let deadline = Instant::now() + Duration::from_secs(3);
            while !path.exists() {
                assert!(
                    Instant::now() < deadline,
                    "Expected fixture result {filename}"
                );
                sleep(Duration::from_millis(5)).await;
            }
            path
        }
    }

    #[tokio::test]
    async fn real_attachment_store_transfers_multiple_chunks_on_one_socket_and_reads_through_native_envelope()
     {
        use crate::attachments::{
            ATTACHMENT_CHUNK_BYTES, AttachmentRequest, AttachmentResponse, upload_file,
        };
        use crate::native::{NativeEvent, NativeRequest};
        use base64::{Engine, engine::general_purpose::STANDARD};
        let directory = tempfile::tempdir().unwrap();
        let script = std::env::var_os("AGENT_RUNTIME_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("runtime/dist/src/bridge.js")
            });
        let service = Running::start_script(directory, script, ShutdownReason::Requested).await;
        let bytes = vec![b'a'; ATTACHMENT_CHUNK_BYTES as usize + 11];
        let source = service.directory.path().join("upload.txt");
        fs::write(&source, &bytes).unwrap();
        let stream = service.client().await;
        let (reader, writer) = stream.into_split();
        let connection = Arc::new(tokio::sync::Mutex::new((
            FrameReader::new(BufReader::new(reader)),
            writer,
        )));
        let attachment = upload_file(&source, |request| {
            let connection = connection.clone();
            async move {
                let mut connection = connection.lock().await;
                let (reader, writer) = &mut *connection;
                write_frame(writer, &RuntimeCommand::Attachment { request }).await?;
                let mut response = None;
                loop {
                    let frame = reader.next_frame().await?.unwrap();
                    match serde_json::from_slice::<RuntimeEventKind>(&frame)? {
                        RuntimeEventKind::Attachment { response: received } => {
                            response = Some(received)
                        }
                        RuntimeEventKind::Done => {
                            return response
                                .ok_or_else(|| anyhow::anyhow!("Missing attachment response"));
                        }
                        RuntimeEventKind::Failure { message, .. } => anyhow::bail!(message),
                        _ => anyhow::bail!("Unexpected transfer event"),
                    }
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(attachment.size_bytes as usize, bytes.len());
        drop(connection);
        let mut native = service.client().await;
        write_frame(
            &mut native,
            &RuntimeCommand::Native {
                request: NativeRequest::Attachment {
                    request: AttachmentRequest::Download {
                        id: attachment.id,
                        offset: ATTACHMENT_CHUNK_BYTES,
                        limit: 32,
                    },
                },
            },
        )
        .await
        .unwrap();
        let (native_read, mut native_write) = native.into_split();
        let mut reader = FrameReader::new(BufReader::new(native_read));
        let event: NativeEvent =
            serde_json::from_slice(&reader.next_frame().await.unwrap().unwrap()).unwrap();
        assert!(
            matches!(event, NativeEvent::Attachment { response: AttachmentResponse::Download { data_base64, next_offset: None } } if STANDARD.decode(&data_base64).unwrap() == bytes[ATTACHMENT_CHUNK_BYTES as usize..])
        );
        assert!(matches!(
            serde_json::from_slice::<NativeEvent>(&reader.next_frame().await.unwrap().unwrap())
                .unwrap(),
            NativeEvent::Done
        ));
        write_frame(
            &mut native_write,
            &RuntimeCommand::Native {
                request: NativeRequest::Submit {
                    input_id: uuid::Uuid::new_v4().to_string(),
                    text: "/help".into(),
                    mode: InputMode::Steer,
                    attachments: None,
                },
            },
        )
        .await
        .unwrap();
        assert!(matches!(
            serde_json::from_slice::<NativeEvent>(&reader.next_frame().await.unwrap().unwrap())
                .unwrap(),
            NativeEvent::Notice { .. }
        ));
        assert!(matches!(
            serde_json::from_slice::<NativeEvent>(&reader.next_frame().await.unwrap().unwrap())
                .unwrap(),
            NativeEvent::Done
        ));
        drop(reader);
        drop(native_write);
        service.stop().await;
    }

    #[tokio::test]
    async fn signal_shutdown_records_exact_intent_before_stopping_active_requests() {
        #[derive(serde::Deserialize)]
        #[serde(tag = "event", rename_all = "snake_case")]
        enum StopEvent {
            ServiceShutdown {
                signal: ShutdownSignal,
            },
            RuntimeStopped {
                code: crate::protocol::ErrorCode,
            },
            #[serde(other)]
            Other,
        }
        #[derive(serde::Deserialize)]
        struct StopRecord {
            timestamp_ms: u64,
            request_id: u32,
            elapsed_ms: Option<u64>,
            conversation_id: Option<String>,
            task_id: Option<String>,
            agent_id: Option<String>,
            #[serde(flatten)]
            event: StopEvent,
        }
        let now = || {
            u64::try_from(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis(),
            )
            .unwrap()
        };
        for signal in [ShutdownSignal::Sigint, ShutdownSignal::Sigterm] {
            let service = Running::start_with_shutdown(ShutdownReason::Signal(signal)).await;
            let mut client = service.client().await;
            write_frame(
                &mut client,
                &RuntimeCommand::Chat {
                    attachments: None,
                    input: "Keep this synthetic request active".into(),
                    input_id: None,
                    instructions: String::new(),
                    model: None,
                    origin_host_id: None,
                    cwd: "/".into(),
                    hosts: vec![],
                },
            )
            .await
            .unwrap();
            let mut client = FrameReader::new(BufReader::new(client));
            let event: RuntimeEventKind =
                serde_json::from_slice(&client.next_frame().await.unwrap().unwrap()).unwrap();
            assert!(matches!(event, RuntimeEventKind::Notice { .. }));
            let before = now();
            let Running {
                directory,
                stop,
                task,
            } = service;
            stop.send(()).unwrap();
            timeout(Duration::from_secs(5), task)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let after = now();
            let records = timeout(Duration::from_secs(3), async {
                loop {
                    let text =
                        fs::read_to_string(directory.path().join("diagnostics/runtime.jsonl"))
                            .unwrap_or_default();
                    let complete = text.rsplit_once('\n').map_or("", |(complete, _)| complete);
                    let records = complete
                        .lines()
                        .map(serde_json::from_str::<StopRecord>)
                        .collect::<Result<Vec<_>, _>>()
                        .unwrap();
                    if records
                        .iter()
                        .any(|record| matches!(record.event, StopEvent::RuntimeStopped { .. }))
                    {
                        break records;
                    }
                    sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .unwrap();
            let shutdowns = records
                .iter()
                .enumerate()
                .filter(|(_, record)| matches!(record.event, StopEvent::ServiceShutdown { .. }))
                .collect::<Vec<_>>();
            assert_eq!(shutdowns.len(), 1);
            let (intent_index, intent) = shutdowns[0];
            assert!(
                matches!(intent.event, StopEvent::ServiceShutdown { signal: actual } if actual == signal)
            );
            assert!((before..=after).contains(&intent.timestamp_ms));
            assert_eq!(intent.request_id, 0);
            assert!(
                intent.elapsed_ms.is_none()
                    && intent.conversation_id.is_none()
                    && intent.task_id.is_none()
                    && intent.agent_id.is_none()
            );
            assert!(
                records
                    .iter()
                    .enumerate()
                    .any(|(index, record)| index > intent_index
                        && record.request_id == 1
                        && matches!(
                            record.event,
                            StopEvent::RuntimeStopped {
                                code: crate::protocol::ErrorCode::Internal
                            }
                        ))
            );
            drop(client);
        }
    }

    async fn status<S: AsyncRead + AsyncWrite + Unpin>(mut stream: S) {
        write_frame(&mut stream, &RuntimeCommand::Status)
            .await
            .unwrap();
        let mut reader = FrameReader::new(BufReader::new(stream));
        let event: RuntimeEventKind =
            serde_json::from_slice(&reader.next_frame().await.unwrap().unwrap()).unwrap();
        assert!(matches!(
            event,
            RuntimeEventKind::AuthStatus {
                status: AuthStatus::SignedOut
            }
        ));
        let event: RuntimeEventKind =
            serde_json::from_slice(&reader.next_frame().await.unwrap().unwrap()).unwrap();
        assert!(matches!(event, RuntimeEventKind::Done));
    }

    #[tokio::test]
    async fn independent_clients_share_one_writer_and_do_not_block_each_other() {
        let service = Running::start().await;
        let mut slow = service.client().await;
        write_frame(&mut slow, &RuntimeCommand::Login)
            .await
            .unwrap();
        let first = service.client().await;
        let second = service.client().await;
        timeout(Duration::from_secs(1), async {
            tokio::join!(status(first), status(second));
        })
        .await
        .unwrap();
        service.wait_for("completed").await;
        drop(slow);
        service.stop().await;
    }

    #[tokio::test]
    async fn disconnected_client_keeps_admitted_work_running() {
        let service = Running::start().await;
        let mut client = service.client().await;
        write_frame(&mut client, &RuntimeCommand::Login)
            .await
            .unwrap();
        drop(client);
        service.wait_for("completed").await;
        status(service.client().await).await;
        service.stop().await;
    }

    #[tokio::test]
    async fn half_closed_input_still_receives_the_requested_result() {
        let service = Running::start().await;
        let mut client = service.client().await;
        write_frame(&mut client, &RuntimeCommand::Status)
            .await
            .unwrap();
        client.shutdown().await.unwrap();
        let mut reader = FrameReader::new(BufReader::new(client));
        let frame = reader.next_frame().await.unwrap().unwrap();
        let event: RuntimeEventKind = serde_json::from_slice(&frame).unwrap();
        assert!(matches!(event, RuntimeEventKind::AuthStatus { .. }));
        let frame = reader.next_frame().await.unwrap().unwrap();
        let event: RuntimeEventKind = serde_json::from_slice(&frame).unwrap();
        assert!(matches!(event, RuntimeEventKind::Done));
        service.stop().await;
    }

    #[tokio::test]
    async fn interactive_input_and_eof_stay_on_the_attached_request_and_release_it() {
        let service = Running::start().await;
        let mut client = service.client().await;
        let mut command = attached_command();
        if let RuntimeCommand::RunTask { interactive, .. } = &mut command {
            *interactive = Some(true);
        }
        write_frame(&mut client, &command).await.unwrap();
        let (reader, mut writer) = client.into_split();
        let mut reader = FrameReader::new(BufReader::new(reader));
        let ready: RuntimeEventKind =
            serde_json::from_slice(&reader.next_frame().await.unwrap().unwrap()).unwrap();
        assert!(
            matches!(ready, RuntimeEventKind::TaskReady { conversation_id, .. } if conversation_id == "persisted-task")
        );
        reader.next_frame().await.unwrap().unwrap();
        write_frame(
            &mut writer,
            &RuntimeCommand::WorkerInput {
                attachments: None,
                input_id: "input-one".into(),
                input: "A reply in the existing tab".into(),
            },
        )
        .await
        .unwrap();
        let answer: RuntimeEventKind =
            serde_json::from_slice(&reader.next_frame().await.unwrap().unwrap()).unwrap();
        assert!(
            matches!(answer, RuntimeEventKind::Answer { conversation_id, text, .. } if conversation_id == "persisted-task" && text == "A reply in the existing tab")
        );
        reader.next_frame().await.unwrap().unwrap();
        writer.shutdown().await.unwrap();
        let done = timeout(Duration::from_secs(1), reader.next_frame())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(matches!(
            serde_json::from_slice::<RuntimeEventKind>(&done).unwrap(),
            RuntimeEventKind::Done
        ));
        #[derive(serde::Deserialize)]
        struct Input {
            id: u32,
            input: String,
        }
        let admitted: Input =
            serde_json::from_slice(&fs::read(service.wait_for("worker-input.json").await).unwrap())
                .unwrap();
        assert_eq!(admitted.input, "A reply in the existing tab");
        assert_eq!(
            fs::read_to_string(service.wait_for("worker-detached").await).unwrap(),
            admitted.id.to_string()
        );
        status(service.client().await).await;
        drop((reader, writer));
        service.stop().await;
    }

    #[tokio::test]
    async fn ordinary_requests_execute_owned_effects_without_delegating_to_the_sending_cli() {
        let service = Running::start().await;
        let mut client = service.client().await;
        write_frame(&mut client, &RuntimeCommand::Logout)
            .await
            .unwrap();
        let mut reader = FrameReader::new(BufReader::new(client));
        let event: RuntimeEventKind =
            serde_json::from_slice(&reader.next_frame().await.unwrap().unwrap()).unwrap();
        assert!(matches!(event, RuntimeEventKind::AuthStatus { .. }));
        let event: RuntimeEventKind =
            serde_json::from_slice(&reader.next_frame().await.unwrap().unwrap()).unwrap();
        assert!(matches!(event, RuntimeEventKind::Done));
        let result: HostResult =
            serde_json::from_slice(&fs::read(service.wait_for("reply.json").await).unwrap())
                .unwrap();
        assert!(
            matches!(&result,HostResult::Process{exit_code:0,stdout,..} if stdout=="synthetic\n"),
            "{result:?}"
        );
        drop(reader);
        service.stop().await;
    }

    #[tokio::test]
    async fn ordinary_clients_cannot_mutate_authoritative_node_connectivity() {
        let service = Running::start().await;
        let mut client = service.client().await;
        write_frame(
            &mut client,
            &RuntimeCommand::SetConnectedNodes {
                host_ids: vec!["forged".into()],
            },
        )
        .await
        .unwrap();
        let mut reader = FrameReader::new(BufReader::new(client));
        assert!(reader.next_frame().await.unwrap().is_none());
        assert!(!service.directory.path().join("admitted").exists());
        drop(reader);
        service.stop().await;
    }

    #[tokio::test]
    async fn host_replies_are_scoped_to_their_own_client() {
        let service = Running::start().await;
        let mut first = service.client().await;
        let mut second = service.client().await;
        write_frame(&mut first, &attached_command()).await.unwrap();
        write_frame(&mut second, &attached_command()).await.unwrap();
        let (first_read, mut first_write) = first.into_split();
        let (second_read, mut second_write) = second.into_split();
        let mut first_read = FrameReader::new(BufReader::new(first_read));
        let mut second_read = FrameReader::new(BufReader::new(second_read));
        first_read.next_frame().await.unwrap().unwrap();
        second_read.next_frame().await.unwrap().unwrap();
        let reply = || RuntimeCommand::HostReply {
            call_id: "11111111-1111-4111-8111-111111111111".into(),
            result: HostResult::Written,
        };
        write_frame(&mut first_write, &reply()).await.unwrap();
        first_read.next_frame().await.unwrap().unwrap();
        first_read.next_frame().await.unwrap().unwrap();
        assert!(
            timeout(Duration::from_millis(20), second_read.next_frame())
                .await
                .is_err()
        );
        write_frame(&mut second_write, &reply()).await.unwrap();
        second_read.next_frame().await.unwrap().unwrap();
        second_read.next_frame().await.unwrap().unwrap();
        drop((first_read, first_write, second_read, second_write));
        service.stop().await;
    }

    #[tokio::test]
    async fn child_exit_closes_the_listener_and_preserves_saved_state() {
        let service = Running::start().await;
        let mut client = service.client().await;
        write_frame(&mut client, &RuntimeCommand::ListTasks)
            .await
            .unwrap();
        let mut reader = FrameReader::new(BufReader::new(client));
        let frame = reader.next_frame().await.unwrap().unwrap();
        let event: RuntimeEventKind = serde_json::from_slice(&frame).unwrap();
        assert!(matches!(event, RuntimeEventKind::Failure { .. }));
        drop(reader);
        let Running {
            directory,
            stop,
            task,
        } = service;
        drop(stop);
        assert!(
            timeout(Duration::from_secs(3), task)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
        assert!(!directory.path().join(SOCKET_NAME).exists());
        assert!(directory.path().join("writer.lock").is_file());
    }

    #[tokio::test]
    async fn notices_reach_watchers_without_finishing_the_worker_request() {
        let service = Running::start().await;
        let mut watcher = service.client().await;
        write_frame(&mut watcher, &RuntimeCommand::Watch)
            .await
            .unwrap();
        let mut watcher = FrameReader::new(BufReader::new(watcher));
        let mut worker = service.client().await;
        write_frame(&mut worker, &RuntimeCommand::Login)
            .await
            .unwrap();
        let mut worker = FrameReader::new(BufReader::new(worker));
        let frame = timeout(Duration::from_secs(3), watcher.next_frame())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let event: RuntimeEventKind = serde_json::from_slice(&frame).unwrap();
        assert!(matches!(event, RuntimeEventKind::Notice { .. }));
        let mut notice_count = 0;
        let mut answer_count = 0;
        loop {
            let frame = worker.next_frame().await.unwrap().unwrap();
            match serde_json::from_slice::<RuntimeEventKind>(&frame).unwrap() {
                RuntimeEventKind::Notice { .. } => notice_count += 1,
                RuntimeEventKind::AuthStatus { .. } => answer_count += 1,
                RuntimeEventKind::Done => break,
                _ => panic!("Unexpected worker event"),
            }
        }
        assert_eq!((notice_count, answer_count), (1, 1));
        drop((watcher, worker));
        service.stop().await;
    }

    #[tokio::test]
    async fn network_authorization_finishes_before_protocol_admission() {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("fixture.mjs");
        fs::write(&script, FIXTURE).unwrap();
        let runtime = Arc::new(Runtime::start(&script, directory.path()).unwrap());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut denied_client = TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        let (server, peer) = listener.accept().await.unwrap();
        let denied_peer = peer;
        let rejected_runtime = runtime.clone();
        let rejected = tokio::spawn(async move {
            authenticated(
                server,
                rejected_runtime,
                Arc::new(crate::broker::Broker::new(None, std::path::Path::new("/tmp")).unwrap()),
                peer,
                async {
                    anyhow::bail!("Rejected synthetic peer");
                },
            )
            .await
        });
        let _ = write_frame(&mut denied_client, &RuntimeCommand::Status).await;
        assert!(rejected.await.unwrap().is_err());
        let mut bytes = Vec::new();
        let _ = denied_client.read_to_end(&mut bytes).await;
        assert!(bytes.is_empty());
        assert!(!directory.path().join("admitted").exists());

        let allowed_client = TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        let (server, peer) = listener.accept().await.unwrap();
        let allowed_runtime = runtime.clone();
        let allowed = tokio::spawn(async move {
            authenticated(
                server,
                allowed_runtime,
                Arc::new(crate::broker::Broker::new(None, std::path::Path::new("/tmp")).unwrap()),
                peer,
                async { Ok(()) },
            )
            .await
        });
        status(allowed_client).await;
        allowed.await.unwrap().unwrap();
        assert!(directory.path().join("admitted").exists());
        Arc::try_unwrap(runtime)
            .ok()
            .unwrap()
            .close()
            .await
            .unwrap();
        #[derive(serde::Deserialize)]
        #[serde(tag = "event", rename_all = "snake_case")]
        enum Receipt {
            PeerRejected {
                peer: std::net::SocketAddr,
                reason: String,
            },
            #[serde(other)]
            Other,
        }
        timeout(Duration::from_secs(2), async {
            loop {
                let saved = fs::read_to_string(directory.path().join("diagnostics/runtime.jsonl")).unwrap_or_default();
                if saved.lines().any(|line| matches!(serde_json::from_str::<Receipt>(line).unwrap(), Receipt::PeerRejected { peer, reason } if peer == denied_peer && reason == "Rejected synthetic peer")) { break; }
                sleep(Duration::from_millis(5)).await;
            }
        }).await.unwrap();
    }

    #[tokio::test]
    async fn oauth_callbacks_keep_the_active_login_id_and_are_rejected_on_other_calls() {
        #[derive(serde::Deserialize)]
        struct Callback {
            id: u32,
            target: String,
        }
        let service = Running::start().await;
        let mut login = service.client().await;
        write_frame(&mut login, &RuntimeCommand::Login)
            .await
            .unwrap();
        let target = "http://127.0.0.1:1455/auth/callback?code=synthetic&state=expected";
        write_frame(
            &mut login,
            &RuntimeCommand::OAuthCallback {
                target: target.into(),
            },
        )
        .await
        .unwrap();
        let callback = service.wait_for("callback.json").await;
        let value: Callback = serde_json::from_slice(&fs::read(&callback).unwrap()).unwrap();
        assert_eq!(value.target, target);
        assert_eq!(
            value.id,
            fs::read_to_string(service.wait_for("login-id").await)
                .unwrap()
                .parse::<u32>()
                .unwrap()
        );
        let mut login = FrameReader::new(BufReader::new(login));
        let mut results = 0;
        loop {
            let frame = login.next_frame().await.unwrap().unwrap();
            match serde_json::from_slice::<RuntimeEventKind>(&frame).unwrap() {
                RuntimeEventKind::AuthStatus { .. } => results += 1,
                RuntimeEventKind::Done => break,
                _ => {}
            }
        }
        assert_eq!(results, 1);
        fs::remove_file(callback).unwrap();
        let mut other = service.client().await;
        write_frame(&mut other, &attached_command()).await.unwrap();
        let (other_read, mut other_write) = other.into_split();
        let mut other = FrameReader::new(BufReader::new(other_read));
        other.next_frame().await.unwrap().unwrap();
        // A separate socket cannot smuggle a callback through a non-login call.
        write_frame(
            &mut other_write,
            &RuntimeCommand::OAuthCallback {
                target: target.into(),
            },
        )
        .await
        .unwrap();
        service.wait_for("reply.json").await;
        assert!(!service.directory.path().join("callback.json").exists());
        drop((login, other, other_write));
        service.stop().await;
    }

    #[tokio::test]
    async fn disconnected_executor_gets_no_fallback_host_execution() {
        let service = Running::start().await;
        let mut client = service.client().await;
        write_frame(&mut client, &attached_command()).await.unwrap();
        let mut reader = FrameReader::new(BufReader::new(client));
        let event: RuntimeEventKind =
            serde_json::from_slice(&reader.next_frame().await.unwrap().unwrap()).unwrap();
        assert!(matches!(event, RuntimeEventKind::HostCall { .. }));
        drop(reader);
        let path = service.wait_for("reply.json").await;
        let reply: HostResult = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert!(
            matches!(reply, HostResult::Failed { message } if message.contains("disconnected"))
        );
        status(service.client().await).await;
        service.stop().await;
    }

    #[tokio::test]
    async fn socket_cleanup_preserves_foreign_replacements() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(SOCKET_NAME);
        fs::write(&path, "foreign file").unwrap();
        assert!(SocketOwner::bind(path.clone()).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "foreign file");
        fs::remove_file(&path).unwrap();
        let (listener, owner) = SocketOwner::bind(path.clone()).unwrap();
        fs::remove_file(&path).unwrap();
        fs::write(&path, "replacement").unwrap();
        drop(owner);
        drop(listener);
        assert_eq!(fs::read_to_string(path).unwrap(), "replacement");
    }
}
