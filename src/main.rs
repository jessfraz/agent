mod mail;
mod state;
mod usage;

use std::{
    env,
    fs::OpenOptions,
    io::{ErrorKind, IsTerminal},
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use agent_cli::{
    config::{self, ClientConfig},
    context::ContextStore,
    discovery, host, instructions, intake,
    models::{ModelProvider, ModelSelection, Reasoning},
    protocol::{
        AuthStatus, CoordinatorBootstrap, CoordinatorSettings, RuntimeCommand, RuntimeEventKind,
        TaskId, WorkerLaunch, WorkerRef,
    },
    rex::{BlockId, RexClient, SessionId},
    runtime::FrameReader,
    service,
};
use anyhow::{Context, Result, bail, ensure};
use clap::{Args, Parser, Subcommand};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
    net::UnixStream,
    process::{Child, Command},
    time::{Instant, sleep, timeout},
};

#[derive(Parser)]
#[command(name = "agent", version, about = "An agent, regrettably")]
struct Arguments {
    #[arg(long, global = true)]
    state_dir: Option<PathBuf>,
    #[arg(long, global = true)]
    runtime: Option<PathBuf>,
    #[arg(long, global = true)]
    instructions: Option<PathBuf>,
    #[arg(long, global = true)]
    config: Option<PathBuf>,
    /// Connect to a coordinator through Tailscale or an existing SSH host.
    #[arg(long, global = true)]
    coordinator: Option<String>,
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: Option<Action>,
}

#[derive(Subcommand)]
enum Action {
    /// Create private TOML settings without overwriting an existing file.
    Init,
    Login,
    Status,
    Logout,
    Usage,
    /// Show background source coverage and checkpoints.
    Sources,
    /// Show shared settings and registered machines.
    Nodes,
    /// Inspect owned worktrees or collect eligible merged worktrees.
    Resources {
        #[command(subcommand)]
        command: ResourcesAction,
    },
    Chat {
        prompt: Option<String>,
        #[command(flatten)]
        selection: ModelArgs,
    },
    /// Search and read stored task conversations.
    Tasks {
        #[command(subcommand)]
        command: TasksAction,
    },
    /// Run this machine's coordinator or registered worker service.
    Serve {
        #[arg(long, default_value_t = agent_cli::tailnet::DEFAULT_PORT, value_parser = clap::value_parser!(u16).range(1..))]
        tailnet_port: u16,
        #[arg(long, hide = true, conflicts_with = "tailnet_port")]
        local_only: bool,
        #[arg(long)]
        no_sources: bool,
        #[arg(long, hide = true)]
        coordinator_only: bool,
    },
    /// Keep this worker connected and collect eligible owned worktrees.
    Maintain {
        #[arg(long, default_value_t = 300, value_parser = clap::value_parser!(u16).range(60..=3600))]
        interval_seconds: u16,
    },
    /// Bridge stdin/stdout to this machine's local coordinator.
    #[command(hide = true)]
    Rpc,
    /// Attach the task's Rex worker to its stored conversation.
    #[command(hide = true)]
    RunTask {
        task_id: TaskId,
        #[arg(long)]
        agent_id: Option<String>,
        #[arg(long)]
        allocation_id: String,
        #[command(flatten)]
        selection: ModelArgs,
    },
    Mail {
        #[command(subcommand)]
        command: MailAction,
    },
}

#[derive(Args, Default)]
struct ModelArgs {
    #[arg(long, value_enum)]
    provider: Option<ModelProvider>,
    #[arg(long, value_parser = clap::builder::NonEmptyStringValueParser::new())]
    model: Option<String>,
    #[arg(long, value_enum)]
    reasoning: Option<Reasoning>,
    #[arg(long, conflicts_with = "no_fast")]
    fast: bool,
    #[arg(long, conflicts_with = "fast")]
    no_fast: bool,
    #[arg(long, hide = true, conflicts_with = "reasoning")]
    default_reasoning: bool,
}

impl ModelArgs {
    fn is_empty(&self) -> bool {
        self.provider.is_none()
            && self.model.is_none()
            && self.reasoning.is_none()
            && !self.fast
            && !self.no_fast
            && !self.default_reasoning
    }
    fn resolve(self, defaults: &ModelSelection) -> Result<ModelSelection> {
        let selection = ModelSelection {
            provider: self.provider.unwrap_or(defaults.provider),
            model_id: self.model.unwrap_or_else(|| defaults.model_id.clone()),
            reasoning: if self.default_reasoning {
                None
            } else {
                self.reasoning.or(defaults.reasoning)
            },
            fast: if self.fast {
                true
            } else if self.no_fast {
                false
            } else {
                defaults.fast
            },
        };
        selection.validate()?;
        Ok(selection)
    }
}

#[derive(Subcommand)]
enum TasksAction {
    List,
    Search {
        query: String,
    },
    Read {
        task_id: TaskId,
    },
    /// Revoke one interrupted or uncertain allocation by its exact ID.
    Recover {
        task_id: TaskId,
        #[arg(long)]
        allocation_id: String,
        #[arg(long)]
        agent_id: Option<String>,
    },
}

#[derive(Subcommand)]
enum ResourcesAction {
    List,
    Collect,
}

#[derive(Subcommand)]
enum MailAction {
    Accounts,
    Search {
        query: String,
        #[arg(long)]
        namespace: Option<String>,
        #[arg(long, default_value_t = 20)]
        limit: u16,
        #[arg(long)]
        cursor: Option<String>,
    },
}

struct Wire {
    reader: Box<dyn AsyncRead + Unpin + Send>,
    writer: Box<dyn AsyncWrite + Unpin + Send>,
    child: Option<Child>,
}

struct WatchGuard(tokio::task::JoinHandle<()>);
impl Drop for WatchGuard {
    fn drop(&mut self) {
        self.0.abort();
    }
}

impl Wire {
    fn local(stream: UnixStream) -> Self {
        let (reader, writer) = stream.into_split();
        Self {
            reader: Box::new(reader),
            writer: Box::new(writer),
            child: None,
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let mut arguments = Arguments::parse();
    let action = arguments.command.take().unwrap_or(Action::Chat {
        prompt: None,
        selection: ModelArgs::default(),
    });
    match action {
        Action::Init => {
            let path = arguments
                .config
                .clone()
                .map(Ok)
                .unwrap_or_else(config::default_path)?;
            config::initialize(&path, arguments.coordinator.as_deref())?;
            println!("Created {}", path.display());
            return Ok(());
        }
        Action::Usage => {
            let usage = usage::read(None).await?;
            if arguments.json {
                println!("{}", serde_json::to_string_pretty(&usage)?);
            } else {
                print!("{usage}");
            }
            return Ok(());
        }
        Action::Mail { command } => {
            match command {
                MailAction::Accounts => println!(
                    "{}",
                    serde_json::to_string_pretty(&mail::accounts().await?)?
                ),
                MailAction::Search {
                    query,
                    namespace,
                    limit,
                    cursor,
                } => println!(
                    "{}",
                    serde_json::to_string_pretty(
                        &mail::search(&query, namespace.as_deref(), limit, cursor.as_deref())
                            .await?
                    )?
                ),
            }
            return Ok(());
        }
        _ => {}
    }
    let directory = state::directory(arguments.state_dir.clone())?;
    let script = arguments
        .runtime
        .clone()
        .or_else(|| env::var_os("AGENT_RUNTIME_PATH").map(PathBuf::from))
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("runtime/dist/src/bridge.js")
        });
    let mut config = config::load(arguments.config.as_deref())?;
    config.launch = Some(worker_launch(&arguments, &config, &directory, &script)?);
    let coordinator = arguments
        .coordinator
        .clone()
        .or_else(|| env::var("AGENT_COORDINATOR").ok())
        .or_else(|| config.coordinator.clone());
    if let Some(value) = &coordinator {
        config::validate_coordinator(value)?;
    }
    let cwd = env::current_dir()?;
    if let Action::Serve {
        tailnet_port,
        local_only,
        no_sources,
        coordinator_only,
    } = action
    {
        ensure!(
            !coordinator_only || coordinator.is_none(),
            "The coordinator service cannot use a worker configuration"
        );
        if coordinator.is_some() {
            ensure!(
                !local_only,
                "A worker profile cannot start a second local coordinator"
            );
            return worker_service(&config, coordinator.as_deref(), &script, &directory, 300).await;
        }
        let policy = agent_cli::tailnet::PeerPolicy::new(&config.trusted_nodes)?;
        let daemon = agent_cli::tailnet::Daemon::new(config.tailscale_socket.as_deref())?;
        let contexts = ContextStore::load(&config.context_repositories)?;
        let global = arguments
            .instructions
            .clone()
            .unwrap_or(instructions::default_path()?);
        let node = match discovery::local_node(
            None,
            config
                .launch
                .clone()
                .context("Missing local launch metadata")?,
            config.node_name.as_deref(),
        )
        .await
        {
            Ok(node) => Some(node),
            Err(_) => {
                eprintln!(
                    "Local Rex is unavailable; this coordinator has no local worker until restarted."
                );
                None
            }
        };
        let bootstrap = CoordinatorBootstrap {
            settings: CoordinatorSettings {
                model: config.model.clone(),
                instructions: instructions::global(&global)?,
                context_repositories: contexts.repositories().to_vec(),
                sources: config.sources.clone(),
            },
            node,
        };
        let _sources = if no_sources {
            None
        } else {
            let context = intake::ContextBundle {
                model: config.model.clone(),
                cwd: cwd.to_string_lossy().into_owned(),
            };
            let state = directory.clone();
            Some(WatchGuard(tokio::spawn(async move {
                let _ = intake::run(state, config, context).await;
            })))
        };
        return service::serve_configured(
            &script,
            &directory,
            (!local_only).then_some(tailnet_port),
            policy,
            daemon,
            bootstrap,
        )
        .await;
    }
    if matches!(action, Action::Rpc) {
        ensure!(
            coordinator.is_none(),
            "RPC must run on the selected coordinator"
        );
        return service::relay(
            local_connection(&script, &directory, arguments.config.as_deref()).await?,
        )
        .await;
    }
    if let Action::Maintain { interval_seconds } = action {
        ensure!(
            coordinator.is_some(),
            "Worker service requires a selected remote coordinator"
        );
        return worker_service(
            &config,
            coordinator.as_deref(),
            &script,
            &directory,
            interval_seconds,
        )
        .await;
    }
    let command = match action {
        Action::Login => RuntimeCommand::Login,
        Action::Status => RuntimeCommand::Status,
        Action::Logout => RuntimeCommand::Logout,
        Action::Sources => RuntimeCommand::SourceStates,
        Action::Nodes => RuntimeCommand::Environment,
        Action::Resources { command } => match command {
            ResourcesAction::List => RuntimeCommand::ListResources,
            ResourcesAction::Collect => RuntimeCommand::CollectResources {
                host_id: RexClient::new(None).whoami().await?.host_id.to_string(),
            },
        },
        Action::Tasks { command } => match command {
            TasksAction::List => RuntimeCommand::ListTasks,
            TasksAction::Search { query } => RuntimeCommand::SearchTasks { query },
            TasksAction::Read { task_id } => RuntimeCommand::ReadTask { task_id },
            TasksAction::Recover {
                task_id,
                allocation_id,
                agent_id,
            } => RuntimeCommand::RevokeAllocation {
                task_id,
                allocation_id,
                agent_id,
            },
        },
        Action::RunTask {
            task_id,
            agent_id,
            allocation_id,
            selection,
        } => RuntimeCommand::RunTask {
            task_id,
            agent_id,
            allocation_id,
            binding: local_worker_binding().await?,
            instructions: instructions::project(&cwd)?,
            model: selection.resolve(
                &environment(&config, coordinator.as_deref(), &script, &directory)
                    .await?
                    .model,
            )?,
            cwd: cwd.to_string_lossy().into_owned(),
        },
        Action::Chat {
            prompt: Some(input),
            selection,
        } => {
            chat_command(
                input,
                selected_model(
                    selection,
                    &config,
                    coordinator.as_deref(),
                    &script,
                    &directory,
                )
                .await?,
                &cwd,
            )
            .await?
        }
        Action::Chat {
            prompt: None,
            selection,
        } => {
            let model = selected_model(
                selection,
                &config,
                coordinator.as_deref(),
                &script,
                &directory,
            )
            .await?;
            let _watch = watch(
                &config,
                coordinator.as_deref(),
                &script,
                &directory,
                arguments.json,
            )
            .await?;
            let mut input = BufReader::new(tokio::io::stdin()).lines();
            loop {
                if !arguments.json && std::io::stdin().is_terminal() {
                    let mut stdout = tokio::io::stdout();
                    stdout.write_all(b"agent> ").await?;
                    stdout.flush().await?;
                }
                let Some(line) = input.next_line().await? else {
                    return Ok(());
                };
                if line.trim() == "/exit" {
                    return Ok(());
                }
                if !line.trim().is_empty() {
                    let command = chat_command(line, model.clone(), &cwd).await?;
                    request(
                        &arguments,
                        &config,
                        coordinator.as_deref(),
                        &script,
                        &directory,
                        command,
                    )
                    .await?;
                }
            }
        }
        _ => bail!("Unsupported client command"),
    };
    request(
        &arguments,
        &config,
        coordinator.as_deref(),
        &script,
        &directory,
        command,
    )
    .await
}

async fn watch(
    config: &ClientConfig,
    coordinator: Option<&str>,
    script: &Path,
    directory: &Path,
    json: bool,
) -> Result<WatchGuard> {
    let mut wire = connection(config, coordinator, script, directory, false).await?;
    write_command(&mut *wire.writer, &RuntimeCommand::Watch).await?;
    Ok(WatchGuard(tokio::spawn(async move {
        let _writer = wire.writer;
        let _child = wire.child;
        let mut reader = FrameReader::new(BufReader::new(wire.reader));
        while let Ok(Some(frame)) = reader.next_frame().await {
            let Ok(event) = serde_json::from_slice::<RuntimeEventKind>(&frame) else {
                break;
            };
            if matches!(event, RuntimeEventKind::Notice { .. }) && display(&event, json).is_err() {
                break;
            }
        }
        eprintln!("Live updates disconnected; saved work is retained.");
    })))
}

async fn exchange(
    config: &ClientConfig,
    coordinator: Option<&str>,
    script: &Path,
    directory: &Path,
    command: RuntimeCommand,
) -> Result<Vec<RuntimeEventKind>> {
    let mut wire = connection(config, coordinator, script, directory, false).await?;
    write_command(&mut *wire.writer, &command).await?;
    let mut reader = FrameReader::new(BufReader::new(wire.reader));
    let mut events = Vec::new();
    loop {
        let frame = reader
            .next_frame()
            .await?
            .context("Coordinator disconnected")?;
        let event: RuntimeEventKind = serde_json::from_slice(&frame)?;
        match event {
            RuntimeEventKind::Done => return Ok(events),
            RuntimeEventKind::Failure { message, .. } => bail!(message),
            RuntimeEventKind::HostCall { .. } => {
                bail!("Coordinator unexpectedly delegated an owned effect to a CLI client")
            }
            event => events.push(event),
        }
    }
}

async fn environment(
    config: &ClientConfig,
    coordinator: Option<&str>,
    script: &Path,
    directory: &Path,
) -> Result<CoordinatorSettings> {
    exchange(
        config,
        coordinator,
        script,
        directory,
        RuntimeCommand::Environment,
    )
    .await?
    .into_iter()
    .find_map(|event| match event {
        RuntimeEventKind::Environment { settings, .. } => Some(settings),
        _ => None,
    })
    .context("Coordinator returned no shared settings")
}

async fn selected_model(
    selection: ModelArgs,
    config: &ClientConfig,
    coordinator: Option<&str>,
    script: &Path,
    directory: &Path,
) -> Result<Option<ModelSelection>> {
    if selection.is_empty() {
        return Ok(None);
    }
    Ok(Some(
        selection.resolve(
            &environment(config, coordinator, script, directory)
                .await?
                .model,
        )?,
    ))
}

async fn worker_service(
    config: &ClientConfig,
    coordinator: Option<&str>,
    script: &Path,
    directory: &Path,
    interval: u16,
) -> Result<()> {
    ensure!(
        coordinator.is_some(),
        "A worker needs a selected coordinator"
    );
    let mut delay = 1;
    let shutdown = tokio::signal::ctrl_c();
    tokio::pin!(shutdown);
    loop {
        let attempt = async {
            let node = discovery::local_node(
                coordinator,
                config
                    .launch
                    .clone()
                    .context("Missing worker launch metadata")?,
                config.node_name.as_deref(),
            )
            .await?;
            let mut wire = connection(config, coordinator, script, directory, false).await?;
            write_command(
                &mut *wire.writer,
                &RuntimeCommand::ConnectWorker { node: node.clone() },
            )
            .await?;
            let mut reader = FrameReader::new(BufReader::new(wire.reader));
            let frame = reader
                .next_frame()
                .await?
                .context("Coordinator closed the worker registration")?;
            ensure!(
                matches!(
                    serde_json::from_slice::<RuntimeEventKind>(&frame)?,
                    RuntimeEventKind::WorkerReady { .. }
                ),
                "Coordinator did not accept this worker"
            );
            delay = 1;
            eprintln!("Worker connected as {}.", node.name);
            // Collection uses another request while this connection continues
            // serving its effects. Doing both on one loop would deadlock.
            let profile = config.clone();
            let target = coordinator.map(str::to_owned);
            let runtime = script.to_owned();
            let state = directory.to_owned();
            let _collection = WatchGuard(tokio::spawn(async move {
                loop {
                    if exchange(
                        &profile,
                        target.as_deref(),
                        &runtime,
                        &state,
                        RuntimeCommand::CollectResources {
                            host_id: node.host_id.clone(),
                        },
                    )
                    .await
                    .is_err()
                    {
                        eprintln!(
                            "Worker cleanup could not complete; saved ownership is retained."
                        );
                    }
                    sleep(Duration::from_secs(interval.into())).await;
                }
            }));
            let mut effects = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    completed = effects.join_next(), if !effects.is_empty() => {
                        let (call_id,result) = completed.context("Worker effect queue closed")??;
                        write_command(&mut *wire.writer, &RuntimeCommand::HostReply {call_id,result}).await?;
                    }
                    frame = reader.next_frame(), if effects.len() < 32 => {
                        let frame = frame?.context("Coordinator closed the worker connection")?;
                        let event: RuntimeEventKind = serde_json::from_slice(&frame)?;
                        let RuntimeEventKind::HostCall {call_id,command} = event else { bail!("Unexpected event on the registered worker connection"); };
                        effects.spawn(async move { (call_id,host::execute(*command).await) });
                    }
                }
            }
            #[allow(unreachable_code)]
            Ok::<(), anyhow::Error>(())
        };
        tokio::select! {
            result = attempt => { if result.is_err() { eprintln!("Worker connection unavailable; retrying in {delay}s. Saved work is retained."); } }
            signal = &mut shutdown => { signal?; return Ok(()); }
        }
        tokio::select! {
            _ = sleep(Duration::from_secs(delay)) => {}
            signal = &mut shutdown => {signal?;return Ok(());}
        }
        delay = (delay * 2).min(30);
    }
}

async fn chat_command(
    input: String,
    model: Option<ModelSelection>,
    cwd: &Path,
) -> Result<RuntimeCommand> {
    Ok(RuntimeCommand::Chat {
        input,
        instructions: instructions::project(cwd)?,
        model,
        origin_host_id: RexClient::new(None)
            .whoami()
            .await
            .ok()
            .map(|identity| identity.host_id.to_string()),
        cwd: cwd.to_string_lossy().into_owned(),
        hosts: Vec::new(),
    })
}

fn worker_launch(
    arguments: &Arguments,
    config: &ClientConfig,
    directory: &Path,
    script: &Path,
) -> Result<WorkerLaunch> {
    let instructions = arguments
        .instructions
        .clone()
        .unwrap_or(instructions::default_path()?);
    Ok(WorkerLaunch {
        state_dir: Some(
            std::path::absolute(directory)?
                .to_string_lossy()
                .into_owned(),
        ),
        runtime: Some(std::path::absolute(script)?.to_string_lossy().into_owned()),
        config: config
            .path
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned()),
        instructions: Some(
            std::path::absolute(instructions)?
                .to_string_lossy()
                .into_owned(),
        ),
        model: None,
    })
}

async fn local_worker_binding() -> Result<WorkerRef> {
    let session = SessionId::parse(
        &env::var("REX_SESSION").context("Task workers must run in their assigned Rex session")?,
    )?;
    let block =
        BlockId::parse(&env::var("REX_BLOCK").context("Task worker has no assigned Rex pane")?)?;
    let rex = RexClient::new(None);
    let identity = rex.whoami().await?;
    let view = rex.inspect_session(&session).await?;
    let window = view
        .windows
        .iter()
        .find(|window| {
            window
                .layers
                .iter()
                .flat_map(|layer| &layer.blocks)
                .any(|candidate| candidate.block_id.as_ref() == Some(&block))
        })
        .and_then(|window| window.window_id.as_ref())
        .context("Assigned worker pane is no longer present")?;
    Ok(WorkerRef {
        host_id: identity.host_id.to_string(),
        session_id: session.to_string(),
        window_id: window.to_string(),
        block_id: block.to_string(),
    })
}

async fn local_connection(
    script: &Path,
    directory: &Path,
    config_path: Option<&Path>,
) -> Result<UnixStream> {
    match service::connect(directory).await {
        Ok(stream) => return Ok(stream),
        Err(error)
            if matches!(
                error.kind(),
                ErrorKind::NotFound | ErrorKind::ConnectionRefused
            ) => {}
        Err(error) => return Err(error).context("Could not connect to the local coordinator"),
    }
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(directory.join("coordinator.log"))?;
    let mut command = local_service_command(&config::program()?, script, directory, config_path);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(log));
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command
        .spawn()
        .context("Could not start the local coordinator")?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(stream) = service::connect(directory).await {
            return Ok(stream);
        }
        if let Some(status) = child.try_wait()? {
            // A simultaneous client may have won the writer lock.
            if let Ok(stream) = service::connect(directory).await {
                return Ok(stream);
            }
            bail!("Coordinator exited with {status}; see its private coordinator.log");
        }
        ensure!(
            Instant::now() < deadline,
            "Coordinator startup timed out; inspect its private log before retrying"
        );
        sleep(Duration::from_millis(25)).await;
    }
}

fn local_service_command(
    program: &Path,
    script: &Path,
    directory: &Path,
    config_path: Option<&Path>,
) -> Command {
    let mut command = Command::new(program);
    if let Some(path) = config_path {
        command.arg("--config").arg(path);
    }
    command
        .arg("--state-dir")
        .arg(directory)
        .arg("--runtime")
        .arg(script)
        .arg("serve")
        .arg("--local-only");
    command
}

fn quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

async fn connection(
    config: &ClientConfig,
    coordinator: Option<&str>,
    script: &Path,
    directory: &Path,
    login: bool,
) -> Result<Wire> {
    let Some(coordinator) = coordinator else {
        return Ok(Wire::local(
            local_connection(script, directory, config.path.as_deref()).await?,
        ));
    };
    if let Some(address) = coordinator.strip_prefix("tailscale://") {
        let address = config::tailnet_address(address)?;
        let policy = agent_cli::tailnet::PeerPolicy::new(&config.trusted_nodes)?;
        let daemon = agent_cli::tailnet::Daemon::new(config.tailscale_socket.as_deref())?;
        let stream = agent_cli::tailnet::connect(address, &policy, &daemon).await?;
        let (reader, writer) = stream.into_split();
        return Ok(Wire {
            reader: Box::new(reader),
            writer: Box::new(writer),
            child: None,
        });
    }
    let mut command = Command::new("ssh");
    command.args(["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"]);
    if login {
        command.args([
            "-o",
            "ExitOnForwardFailure=yes",
            "-L",
            "1455:127.0.0.1:1455",
        ]);
    }
    let remote = format!(
        "{} rpc",
        quoted(config.coordinator_program.as_deref().unwrap_or("agent"))
    );
    command
        .arg("--")
        .arg(coordinator)
        .arg(remote)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .context("Could not start the coordinator SSH connection")?;
    let reader = child.stdout.take().context("SSH output is unavailable")?;
    let writer = child.stdin.take().context("SSH input is unavailable")?;
    Ok(Wire {
        reader: Box::new(reader),
        writer: Box::new(writer),
        child: Some(child),
    })
}

async fn write_command(
    writer: &mut (dyn AsyncWrite + Unpin + Send),
    command: &RuntimeCommand,
) -> Result<()> {
    let mut bytes = serde_json::to_vec(command)?;
    bytes.push(b'\n');
    writer.write_all(&bytes).await?;
    writer.flush().await?;
    Ok(())
}

async fn request(
    arguments: &Arguments,
    config: &ClientConfig,
    coordinator: Option<&str>,
    script: &Path,
    directory: &Path,
    command: RuntimeCommand,
) -> Result<()> {
    let login = matches!(command, RuntimeCommand::Login);
    let attached = matches!(command, RuntimeCommand::RunTask { .. });
    let mut wire = connection(config, coordinator, script, directory, login).await?;
    let relay_needed = match (
        login,
        coordinator.and_then(|value| value.strip_prefix("tailscale://")),
    ) {
        (true, Some(address)) => {
            let address = config::tailnet_address(address)?;
            let daemon = agent_cli::tailnet::Daemon::new(config.tailscale_socket.as_deref())?;
            address.ip() != agent_cli::tailnet::self_address(0, &daemon).await?.ip()
        }
        _ => false,
    };
    let mut callback = if relay_needed {
        Some(agent_cli::callback::CallbackRelay::bind()?)
    } else {
        None
    };
    write_command(&mut *wire.writer, &command).await?;
    let mut reader = FrameReader::new(BufReader::new(wire.reader));
    let mut failure = None;
    let mut outcome = false;
    loop {
        let frame = tokio::select! {
            frame = reader.next_frame() => frame?.context("Coordinator disconnected; saved work is retained")?,
            target = async {
                match callback.as_mut() {
                    Some(callback) => callback.next().await,
                    None => std::future::pending().await,
                }
            } => {
                write_command(&mut *wire.writer, &RuntimeCommand::OAuthCallback { target: target? }).await?;
                continue;
            }
        };
        let event: RuntimeEventKind =
            serde_json::from_slice(&frame).context("Coordinator returned an invalid event")?;
        match event {
            RuntimeEventKind::HostCall { call_id, command } => {
                ensure!(
                    attached,
                    "Only an attached task worker may execute coordinator host calls"
                );
                let result = host::execute(*command).await;
                write_command(
                    &mut *wire.writer,
                    &RuntimeCommand::HostReply { call_id, result },
                )
                .await?;
            }
            RuntimeEventKind::AuthorizationUrl { url } => {
                ensure!(
                    url.starts_with("https://auth.openai.com/"),
                    "Unexpected authorization host"
                );
                let status = std::process::Command::new("open")
                    .args(["-a", "Google Chrome", &url])
                    .status()
                    .context("Could not open Chrome for ChatGPT sign-in")?;
                ensure!(status.success(), "Chrome did not open");
                eprintln!("Finish ChatGPT sign-in in Chrome.");
            }
            RuntimeEventKind::Failure { message, .. } => {
                failure = Some(message);
            }
            RuntimeEventKind::Done => break,
            RuntimeEventKind::Notice { text, .. } if !arguments.json => eprintln!("{text}"),
            other => {
                outcome = true;
                display(&other, arguments.json)?;
            }
        }
    }
    wire.writer.shutdown().await?;
    if let Some(mut child) = wire.child {
        match timeout(Duration::from_secs(3), child.wait()).await {
            Ok(status) => {
                ensure!(status?.success(), "Coordinator SSH connection failed");
            }
            Err(_) => {
                child.kill().await?;
                child.wait().await?;
            }
        }
    }
    if let Some(failure) = failure {
        bail!("{failure}");
    }
    ensure!(outcome, "Coordinator completed without a result");
    Ok(())
}

fn display(event: &RuntimeEventKind, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string(event)?);
        return Ok(());
    }
    match event {
        RuntimeEventKind::AuthStatus { status } => match status {
            AuthStatus::SignedOut => println!("Not signed in. Run agent login."),
            AuthStatus::NeedsSignIn { .. } => println!("ChatGPT needs sign-in. Run agent login."),
            AuthStatus::Connected { account, .. } => println!(
                "Using ChatGPT plan{}.",
                account
                    .email
                    .as_ref()
                    .map(|email| format!(": {email}"))
                    .unwrap_or_default()
            ),
        },
        RuntimeEventKind::Answer { text, .. } => println!("{text}"),
        RuntimeEventKind::Tasks { tasks } => {
            for task in tasks {
                println!("{}  {}", task.id, task.title);
            }
        }
        RuntimeEventKind::Resources { resources } => {
            let mut previous_task = None;
            let mut ordered: Vec<_> = resources.iter().collect();
            ordered.sort_by_key(|resource| {
                (
                    resource.task_id.to_string(),
                    resource.repository.clone(),
                    resource.branch.clone(),
                )
            });
            for resource in ordered {
                if previous_task.as_ref() != Some(&resource.task_id) {
                    println!("Task {}", resource.task_id);
                    previous_task = Some(resource.task_id.clone());
                }
                let (status, reason) = match &resource.state {
                    agent_cli::resources::ResourceState::Allocating => ("allocating", None),
                    agent_cli::resources::ResourceState::Ready { .. } => ("ready", None),
                    agent_cli::resources::ResourceState::Retiring { .. } => ("retiring", None),
                    agent_cli::resources::ResourceState::Held { reason, .. } => {
                        ("held", Some(reason))
                    }
                    agent_cli::resources::ResourceState::Removed { .. } => ("removed", None),
                    agent_cli::resources::ResourceState::Partial { reason, .. } => {
                        ("partial", Some(reason))
                    }
                };
                let path = resource
                    .state
                    .identity()
                    .map(|identity| identity.top.as_str())
                    .unwrap_or(&resource.repository);
                println!(
                    "  {} ({})  {status}{}  @{}",
                    path,
                    resource.branch,
                    reason
                        .map(|reason| format!(": {reason}"))
                        .unwrap_or_default(),
                    resource.host_id,
                );
            }
        }
        RuntimeEventKind::Sources { sources } => {
            for source in sources {
                let status = match source.coverage {
                    agent_cli::sources::SourceCoverage::Complete => "current",
                    agent_cli::sources::SourceCoverage::More => "catching up",
                    agent_cli::sources::SourceCoverage::Partial { .. } => "partial",
                    agent_cli::sources::SourceCoverage::Unavailable { .. } => "unavailable",
                };
                println!(
                    "{} / {}: {status}",
                    source.source.provider, source.source.account
                );
            }
        }
        RuntimeEventKind::Task { task, history } => println!("{}\n\n{history}", task.title),
        RuntimeEventKind::Environment {
            nodes,
            online_host_ids,
            ..
        } => {
            for node in nodes {
                println!(
                    "{}  {}  {}",
                    node.host_id,
                    node.name,
                    if online_host_ids.contains(&node.host_id) {
                        "online"
                    } else {
                        "offline"
                    }
                );
            }
        }
        RuntimeEventKind::Notice { text, .. } => println!("{text}"),
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::{Action, Arguments, ModelArgs, local_service_command};
    use agent_cli::models::{ModelProvider, ModelSelection, Reasoning};
    use clap::Parser;
    use std::path::Path;

    #[tokio::test]
    async fn plain_chat_uses_server_defaults_and_partial_overrides_fetch_the_selected_coordinator()
    {
        use agent_cli::{
            config::ClientConfig,
            protocol::{CoordinatorSettings, RuntimeCommand, RuntimeEventKind},
            runtime::FrameReader,
        };
        use tokio::{
            io::{AsyncWriteExt, BufReader},
            net::UnixListener,
        };
        let directory = tempfile::tempdir().unwrap();
        let config = ClientConfig {
            model: ModelSelection {
                provider: ModelProvider::Google,
                model_id: "client-stale".into(),
                ..ModelSelection::default()
            },
            ..ClientConfig::default()
        };
        assert!(
            crate::selected_model(
                ModelArgs::default(),
                &config,
                None,
                Path::new("/unused-runtime"),
                directory.path()
            )
            .await
            .unwrap()
            .is_none()
        );
        let listener = UnixListener::bind(directory.path().join("agent.sock")).unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (reader, mut writer) = stream.into_split();
            let mut reader = FrameReader::new(BufReader::new(reader));
            let command: RuntimeCommand =
                serde_json::from_slice(&reader.next_frame().await.unwrap().unwrap()).unwrap();
            assert!(matches!(command, RuntimeCommand::Environment));
            let event = RuntimeEventKind::Environment {
                settings: CoordinatorSettings {
                    model: ModelSelection {
                        provider: ModelProvider::Anthropic,
                        model_id: "server-model".into(),
                        reasoning: Some(Reasoning::High),
                        fast: false,
                    },
                    instructions: String::new(),
                    context_repositories: vec![],
                    sources: vec![],
                },
                nodes: vec![],
                online_host_ids: vec![],
            };
            let mut frame = serde_json::to_vec(&event).unwrap();
            frame.push(b'\n');
            writer.write_all(&frame).await.unwrap();
            writer.write_all(b"{\"type\":\"done\"}\n").await.unwrap();
        });
        let selection = ModelArgs {
            model: Some("override-model".into()),
            fast: true,
            ..ModelArgs::default()
        };
        let actual = crate::selected_model(
            selection,
            &config,
            None,
            Path::new("/unused-runtime"),
            directory.path(),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(actual.provider, ModelProvider::Anthropic);
        assert_eq!(actual.reasoning, Some(Reasoning::High));
        assert_eq!(actual.model_id, "override-model");
        assert!(actual.fast);
        server.await.unwrap();
    }

    #[test]
    fn serve_defaults_to_the_tailnet_port_and_rejects_invalid_or_conflicting_overrides() {
        let parsed = Arguments::try_parse_from(["agent", "serve"]).unwrap();
        assert!(matches!(
            parsed.command,
            Some(Action::Serve {
                tailnet_port: 43_187,
                local_only: false,
                ..
            })
        ));
        let parsed =
            Arguments::try_parse_from(["agent", "serve", "--tailnet-port", "50000"]).unwrap();
        assert!(matches!(
            parsed.command,
            Some(Action::Serve {
                tailnet_port: 50_000,
                local_only: false,
                ..
            })
        ));
        let parsed = Arguments::try_parse_from(["agent", "serve", "--local-only"]).unwrap();
        assert!(matches!(
            parsed.command,
            Some(Action::Serve {
                local_only: true,
                ..
            })
        ));
        for arguments in [
            vec!["agent", "serve", "--tailnet-port", "0"],
            vec!["agent", "serve", "--tailnet-port", "65536"],
            vec!["agent", "serve", "--local-only", "--tailnet-port", "43187"],
        ] {
            assert!(Arguments::try_parse_from(arguments).is_err());
        }
    }

    #[test]
    fn implicit_local_startup_preserves_paths_and_selects_only_the_unix_transport() {
        let program = Path::new("/example/agent");
        let script = Path::new("/example/runtime with spaces/bridge.js");
        let state = Path::new("/example/private state");
        let config = Path::new("/example/private config.toml");
        for selected in [None, Some(config)] {
            let command = local_service_command(program, script, state, selected);
            let native = command.as_std();
            let parsed = Arguments::try_parse_from(
                std::iter::once(native.get_program()).chain(native.get_args()),
            )
            .unwrap();
            assert_eq!(parsed.runtime.as_deref(), Some(script));
            assert_eq!(parsed.state_dir.as_deref(), Some(state));
            assert_eq!(parsed.config.as_deref(), selected);
            assert!(matches!(
                parsed.command,
                Some(Action::Serve {
                    local_only: true,
                    no_sources: false,
                    ..
                })
            ));
        }
    }

    #[test]
    fn model_flags_override_only_selected_defaults_and_keep_provider_values_typed() {
        let defaults = ModelSelection {
            provider: ModelProvider::Anthropic,
            model_id: "example-model".into(),
            reasoning: Some(Reasoning::High),
            fast: true,
        };
        assert_eq!(ModelArgs::default().resolve(&defaults).unwrap(), defaults);
        let parsed =
            Arguments::try_parse_from(["agent", "chat", "--model", "new-model", "--no-fast"])
                .unwrap();
        let Some(Action::Chat { selection, .. }) = parsed.command else {
            panic!("Expected chat");
        };
        assert_eq!(
            selection.resolve(&defaults).unwrap(),
            ModelSelection {
                model_id: "new-model".into(),
                fast: false,
                ..defaults.clone()
            }
        );
        for flags in [
            vec!["--provider", "unknown"],
            vec!["--reasoning", "extreme"],
            vec!["--model", ""],
            vec!["--fast", "--no-fast"],
        ] {
            assert!(Arguments::try_parse_from(["agent", "chat"].into_iter().chain(flags)).is_err());
        }
    }

    #[test]
    fn worker_model_arguments_roundtrip_without_remote_defaults_changing_the_selection() {
        let remote = ModelSelection {
            provider: ModelProvider::Anthropic,
            model_id: "remote-model".into(),
            reasoning: Some(Reasoning::High),
            fast: true,
        };
        for reasoning in [None, Some(Reasoning::Off), Some(Reasoning::Max)] {
            for fast in [false, true] {
                let expected = ModelSelection {
                    provider: ModelProvider::OpenAiCodex,
                    model_id: "future-model".into(),
                    reasoning,
                    fast,
                };
                let argv = expected.cli_args();
                let parsed = Arguments::try_parse_from(
                    [
                        "agent",
                        "run-task",
                        "11111111-1111-4111-8111-111111111111",
                        "--allocation-id",
                        "fixture",
                    ]
                    .into_iter()
                    .map(str::to_owned)
                    .chain(argv),
                )
                .unwrap();
                let Some(Action::RunTask { selection, .. }) = parsed.command else {
                    panic!("Expected worker");
                };
                assert_eq!(selection.resolve(&remote).unwrap(), expected);
            }
        }
    }
}
