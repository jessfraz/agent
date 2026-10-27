//! The coordinator owns routing; each connected node owns its local effects.

use std::{collections::HashMap, time::Duration};

use anyhow::{Context, Result, ensure};
use tokio::{
    io::{AsyncRead, AsyncWrite, BufReader},
    sync::{Mutex, mpsc, oneshot, watch},
    time::timeout,
};
use uuid::Uuid;

use crate::{
    context::ContextStore,
    discovery::validate_node,
    host,
    protocol::{
        AgentNode, CoordinatorBootstrap, HostCommand, HostResult, RuntimeCommand, RuntimeEventKind,
    },
    runtime::{FrameReader, Runtime},
};

struct Peer {
    generation: Uuid,
    calls: mpsc::Sender<Effect>,
    stop: watch::Sender<bool>,
}
struct Effect {
    command: HostCommand,
    reply: oneshot::Sender<HostResult>,
}

pub struct Broker {
    local: Option<AgentNode>,
    contexts: ContextStore,
    peers: Mutex<HashMap<String, Peer>>,
}

impl Broker {
    pub fn new(bootstrap: Option<&CoordinatorBootstrap>) -> Result<Self> {
        let local = bootstrap.and_then(|bootstrap| bootstrap.node.clone());
        if let Some(node) = &local {
            validate_node(node)?;
        }
        let contexts = match bootstrap {
            Some(bootstrap) => ContextStore::load(
                &bootstrap
                    .settings
                    .context_repositories
                    .iter()
                    .map(|repository| repository.root.clone().into())
                    .collect::<Vec<_>>(),
            )?,
            None => ContextStore::default(),
        };
        Ok(Self {
            local,
            contexts,
            peers: Mutex::new(HashMap::new()),
        })
    }

    fn online(&self, peers: &HashMap<String, Peer>) -> Vec<String> {
        let mut ids: Vec<_> = peers.keys().cloned().collect();
        if let Some(local) = &self.local {
            ids.push(local.host_id.clone());
        }
        ids.sort();
        ids
    }

    async fn register(
        &self,
        runtime: &Runtime,
        node: &AgentNode,
        calls: mpsc::Sender<Effect>,
        stop: watch::Sender<bool>,
    ) -> Result<Uuid> {
        validate_node(node)?;
        ensure!(
            self.local
                .as_ref()
                .is_none_or(|local| local.host_id != node.host_id),
            "A worker cannot replace the coordinator's native node"
        );
        ensure!(
            node.coordinator.is_some(),
            "A worker must name its selected coordinator transport"
        );
        let mut peers = self.peers.lock().await;
        control(runtime, RuntimeCommand::RegisterNode { node: node.clone() }).await?;
        let generation = Uuid::new_v4();
        let previous = peers.insert(
            node.host_id.clone(),
            Peer {
                generation,
                calls,
                stop,
            },
        );
        if let Err(error) = control(
            runtime,
            RuntimeCommand::SetConnectedNodes {
                host_ids: self.online(&peers),
            },
        )
        .await
        {
            peers.remove(&node.host_id);
            if let Some(previous) = previous {
                peers.insert(node.host_id.clone(), previous);
            }
            return Err(error);
        }
        if let Some(previous) = previous {
            let _ = previous.stop.send(true);
        }
        Ok(generation)
    }

    async fn unregister(&self, runtime: &Runtime, id: &str, generation: Uuid) {
        let mut peers = self.peers.lock().await;
        if peers
            .get(id)
            .is_none_or(|peer| peer.generation != generation)
        {
            return;
        }
        peers.remove(id);
        let _ = control(
            runtime,
            RuntimeCommand::SetConnectedNodes {
                host_ids: self.online(&peers),
            },
        )
        .await;
    }

    async fn node(&self, id: &str, command: HostCommand) -> HostResult {
        if self.local.as_ref().is_some_and(|node| node.host_id == id) {
            return host::execute(command).await;
        }
        let sender = self
            .peers
            .lock()
            .await
            .get(id)
            .map(|peer| peer.calls.clone());
        let Some(sender) = sender else {
            return unavailable();
        };
        let (reply, received) = oneshot::channel();
        if sender.send(Effect { command, reply }).await.is_err() {
            return unavailable();
        }
        match timeout(Duration::from_secs(305), received).await {
            Ok(Ok(result)) => result,
            _ => unavailable(),
        }
    }

    pub async fn execute(&self, command: HostCommand) -> HostResult {
        let result = match command {
            HostCommand::ReadContext {
                repository_id,
                path,
                offset,
                limit,
            } => {
                self.contexts
                    .read(&repository_id, &path, offset, limit)
                    .await
            }
            HostCommand::SearchContext {
                repository_id,
                path,
                query,
                limit,
            } => {
                self.contexts
                    .search(&repository_id, path.as_deref(), &query, limit)
                    .await
            }
            HostCommand::OnNode { host_id, command } => {
                if matches!(
                    *command,
                    HostCommand::OnNode { .. }
                        | HostCommand::ReadContext { .. }
                        | HostCommand::SearchContext { .. }
                ) {
                    return HostResult::Failed {
                        message: "Nested node routing and remote context access are unsupported"
                            .into(),
                    };
                }
                if target(&command).is_some_and(|target| target != host_id) {
                    return HostResult::Failed {
                        message: "The explicit node differs from the resource's native owner"
                            .into(),
                    };
                }
                return self.node(&host_id, *command).await;
            }
            command => {
                if let Some(id) = target(&command).map(str::to_owned) {
                    return self.node(&id, command).await;
                }
                return host::execute(command).await;
            }
        };
        result.unwrap_or_else(|error| HostResult::Failed {
            message: error.to_string(),
        })
    }

    pub async fn worker<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
        &self,
        mut reader: FrameReader<BufReader<R>>,
        mut writer: W,
        runtime: &Runtime,
        node: AgentNode,
    ) -> Result<()> {
        let (calls, mut incoming) = mpsc::channel::<Effect>(32);
        let (stop, mut stopped) = watch::channel(false);
        let generation = self.register(runtime, &node, calls, stop).await?;
        let mut pending: HashMap<String, oneshot::Sender<HostResult>> = HashMap::new();
        let result: Result<()> = async {
            crate::service::write_frame(&mut writer, &RuntimeEventKind::WorkerReady { connection_id: generation.to_string() }).await?;
            loop {
                tokio::select! {
                    changed = stopped.changed() => { let _ = changed; anyhow::bail!("A newer connection owns this node"); }
                    _ = runtime.stopped() => anyhow::bail!("Coordinator stopped"),
                    effect = incoming.recv() => {
                        let Some(effect) = effect else { return Ok(()); };
                        let call_id = Uuid::new_v4().to_string();
                        pending.insert(call_id.clone(), effect.reply);
                        crate::service::write_frame(&mut writer, &RuntimeEventKind::HostCall { call_id, command: Box::new(effect.command) }).await?;
                    }
                    frame = reader.next_frame() => {
                        let frame = frame?.context("The node connection closed")?;
                        let command: RuntimeCommand = serde_json::from_slice(&frame).context("The node sent an invalid reply")?;
                        let RuntimeCommand::HostReply { call_id, result } = command else { anyhow::bail!("A registered node may only answer its owned host calls"); };
                        let reply = pending.remove(&call_id).context("Node replied to an unknown effect")?;
                        let _ = reply.send(result);
                    }
                }
            }
        }.await;
        for reply in pending.into_values() {
            let _ = reply.send(unavailable());
        }
        drop(incoming);
        self.unregister(runtime, &node.host_id, generation).await;
        result
    }
}

fn target(command: &HostCommand) -> Option<&str> {
    match command {
        HostCommand::ResourceAllocate { request } => Some(&request.host_id),
        HostCommand::ResourceInspect { record }
        | HostCommand::ResourcePlanCleanup { record }
        | HostCommand::ResourceCollect { record, .. } => Some(&record.host_id),
        HostCommand::SpawnWorker { host, .. } => host.host_id.as_deref(),
        HostCommand::SpawnSubagent { parent, .. } => Some(&parent.host_id),
        HostCommand::ResumeWorker { binding, .. } => Some(&binding.host_id),
        _ => None,
    }
}

pub async fn control(runtime: &Runtime, command: RuntimeCommand) -> Result<()> {
    let mut call = runtime.request(command).await?;
    let result = timeout(Duration::from_secs(15), async {
        loop {
            match call
                .events
                .recv()
                .await
                .context("Coordinator control request closed")?
            {
                RuntimeEventKind::Done => return Ok(()),
                RuntimeEventKind::Failure { message, .. } => anyhow::bail!(message),
                RuntimeEventKind::HostCall { .. } => {
                    anyhow::bail!("Coordinator metadata unexpectedly requested a host effect")
                }
                _ => {}
            }
        }
    })
    .await
    .context("Coordinator metadata update timed out");
    runtime.detach(call.request_id).await;
    result?
}

fn unavailable() -> HostResult {
    HostResult::Failed { message: "The owning node disconnected or its reply was lost; no fallback host was used and the effect was not replayed.".into() }
}

#[cfg(test)]
mod tests {
    use crate::{
        broker::Broker,
        models::ModelSelection,
        protocol::{
            AgentNode, HostCommand, HostResult, RuntimeCommand, RuntimeEventKind, WorkerLaunch,
        },
        runtime::{FrameReader, Runtime},
        service::write_frame,
    };
    use std::{fs, sync::Arc, time::Duration};
    use tokio::{
        io::{BufReader, DuplexStream, ReadHalf, WriteHalf},
        task::JoinHandle,
        time::timeout,
    };

    const FIXTURE: &str = r#"
      import {createInterface} from 'node:readline';
      const emit=(id,event)=>process.stdout.write(JSON.stringify({version:1,id,event})+'\n');
      createInterface({input:process.stdin}).on('line',line=>{
        const {id,command}=JSON.parse(line);
        if(command.type==='register_node') emit(id,{type:'node_registered',host_id:command.node.host_id});
        else emit(id,{type:'configured'});
        emit(id,{type:'done'});
      });
    "#;
    struct Worker {
        reader: FrameReader<BufReader<ReadHalf<DuplexStream>>>,
        writer: WriteHalf<DuplexStream>,
        task: JoinHandle<anyhow::Result<()>>,
    }
    impl Worker {
        async fn connect(broker: Arc<Broker>, runtime: Arc<Runtime>, id: &str) -> Self {
            let (client, server) = tokio::io::duplex(65536);
            let (read, write) = tokio::io::split(server);
            let node = AgentNode {
                host_id: id.into(),
                name: format!("node-{id}"),
                rex_server: Some("https://native.example.ts.net".into()),
                agent_program: "/example/agent".into(),
                home_directory: "/example".into(),
                coordinator: Some("tailscale://100.64.0.10".into()),
                launch: WorkerLaunch {
                    state_dir: None,
                    runtime: None,
                    config: None,
                    instructions: None,
                    model: Some(ModelSelection::default()),
                },
            };
            let task = tokio::spawn(async move {
                broker
                    .worker(
                        FrameReader::new(BufReader::new(read)),
                        write,
                        &runtime,
                        node,
                    )
                    .await
            });
            let (read, writer) = tokio::io::split(client);
            let mut reader = FrameReader::new(BufReader::new(read));
            assert!(matches!(
                event(&mut reader).await,
                RuntimeEventKind::WorkerReady { .. }
            ));
            Self {
                reader,
                writer,
                task,
            }
        }
        async fn close(self) {
            drop((self.reader, self.writer));
            let _ = timeout(Duration::from_secs(2), self.task)
                .await
                .unwrap()
                .unwrap();
        }
    }
    async fn event(
        reader: &mut FrameReader<BufReader<ReadHalf<DuplexStream>>>,
    ) -> RuntimeEventKind {
        let frame = timeout(Duration::from_secs(2), reader.next_frame())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        serde_json::from_slice(&frame).unwrap()
    }
    async fn runtime() -> (tempfile::TempDir, Arc<Runtime>) {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("fixture.mjs");
        fs::write(&script, FIXTURE).unwrap();
        let runtime = Runtime::start(&script, directory.path()).unwrap();
        (directory, Arc::new(runtime))
    }
    fn effect(id: &str, command: HostCommand) -> HostCommand {
        HostCommand::OnNode {
            host_id: id.into(),
            command: Box::new(command),
        }
    }
    async fn close(runtime: Arc<Runtime>) {
        Arc::try_unwrap(runtime)
            .ok()
            .unwrap()
            .close()
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn replacement_connections_own_new_effects_and_old_cleanup_cannot_remove_them() {
        let (_directory, runtime) = runtime().await;
        let broker = Arc::new(Broker::new(None).unwrap());
        let id = "11111111-1111-4111-8111-111111111111";
        let mut old = Worker::connect(broker.clone(), runtime.clone(), id).await;
        let first = {
            let broker = broker.clone();
            tokio::spawn(async move {
                broker
                    .execute(effect(
                        id,
                        HostCommand::ReadFile {
                            path: "/example/item".into(),
                            offset: 0,
                            limit: 10,
                        },
                    ))
                    .await
            })
        };
        assert!(matches!(
            event(&mut old.reader).await,
            RuntimeEventKind::HostCall { .. }
        ));
        let mut new = Worker::connect(broker.clone(), runtime.clone(), id).await;
        assert!(
            matches!(timeout(Duration::from_secs(2),first).await.unwrap().unwrap(),HostResult::Failed{message} if message.contains("not replayed"))
        );
        old.close().await;
        let next = {
            let broker = broker.clone();
            tokio::spawn(async move {
                broker
                    .execute(effect(
                        id,
                        HostCommand::ReadFile {
                            path: "/example/item".into(),
                            offset: 0,
                            limit: 10,
                        },
                    ))
                    .await
            })
        };
        let RuntimeEventKind::HostCall { call_id, .. } = event(&mut new.reader).await else {
            panic!("Expected new connection effect")
        };
        write_frame(
            &mut new.writer,
            &RuntimeCommand::HostReply {
                call_id,
                result: HostResult::File {
                    content: "from new".into(),
                    truncated: false,
                },
            },
        )
        .await
        .unwrap();
        assert!(matches!(next.await.unwrap(),HostResult::File{content,..} if content=="from new"));
        new.close().await;
        close(runtime).await;
    }

    #[tokio::test]
    async fn lost_effect_reply_is_uncertain_without_fallback_or_automatic_replay() {
        let (directory, runtime) = runtime().await;
        let broker = Arc::new(Broker::new(None).unwrap());
        let id = "22222222-2222-4222-8222-222222222222";
        let mut worker = Worker::connect(broker.clone(), runtime.clone(), id).await;
        let marker = directory.path().join("side-effect");
        let command = HostCommand::Exec {
            program: "/bin/sh".into(),
            args: vec![
                "-c".into(),
                "printf x >> \"$1\"".into(),
                "fixture".into(),
                marker.to_str().unwrap().into(),
            ],
            cwd: "/".into(),
            timeout_seconds: 2,
        };
        let pending = {
            let broker = broker.clone();
            let command = command.clone();
            tokio::spawn(async move { broker.execute(effect(id, command)).await })
        };
        let RuntimeEventKind::HostCall {
            command: remote_command,
            ..
        } = event(&mut worker.reader).await
        else {
            panic!("Expected effect")
        };
        assert!(matches!(
            crate::host::execute(*remote_command).await,
            HostResult::Process { exit_code: 0, .. }
        ));
        worker.close().await;
        assert!(
            matches!(pending.await.unwrap(),HostResult::Failed{message} if message.contains("reply was lost"))
        );
        assert!(matches!(
            broker.execute(effect(id, command)).await,
            HostResult::Failed { .. }
        ));
        assert_eq!(fs::read_to_string(marker).unwrap(), "x");
        close(runtime).await;
    }

    #[tokio::test]
    async fn unknown_worker_replies_cannot_complete_another_connections_effects() {
        let (_directory, runtime) = runtime().await;
        let broker = Arc::new(Broker::new(None).unwrap());
        let worker = Worker::connect(
            broker.clone(),
            runtime.clone(),
            "33333333-3333-4333-8333-333333333333",
        )
        .await;
        let Worker {
            reader,
            mut writer,
            task,
        } = worker;
        write_frame(
            &mut writer,
            &RuntimeCommand::HostReply {
                call_id: "unowned".into(),
                result: HostResult::Written,
            },
        )
        .await
        .unwrap();
        assert!(
            timeout(Duration::from_secs(2), task)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
        drop((reader, writer));
        assert!(broker.peers.lock().await.is_empty());
        close(runtime).await;
    }
}
