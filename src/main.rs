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
    host, instructions, intake,
    protocol::{AuthStatus, RuntimeCommand, RuntimeEventKind, TaskId, WorkerLaunch, WorkerRef},
    rex::{BlockId, RexClient, SessionId},
    runtime::FrameReader,
    service,
};
use anyhow::{Context, Result, bail, ensure};
use clap::{Parser, Subcommand};
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
    Login,
    Status,
    Logout,
    Usage,
    /// Show background source coverage and checkpoints.
    Sources,
    /// Inspect owned worktrees or collect eligible merged worktrees.
    Resources {
        #[command(subcommand)]
        command: ResourcesAction,
    },
    Chat {
        prompt: Option<String>,
        #[arg(long, default_value = "gpt-6.1-sol")]
        model: String,
    },
    /// Search and read stored task conversations.
    Tasks {
        #[command(subcommand)]
        command: TasksAction,
    },
    /// Run the local coordinator in the foreground.
    Serve {
        #[arg(long)]
        tailnet_port: Option<u16>,
        #[arg(long)]
        no_sources: bool,
    },
    /// Collect eligible owned worktrees on this client; never polls sources.
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
        #[arg(long, default_value = "gpt-6.1-sol")]
        model: String,
    },
    Mail {
        #[command(subcommand)]
        command: MailAction,
    },
}

#[derive(Subcommand)]
enum TasksAction {
    List,
    Search { query: String },
    Read { task_id: TaskId },
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
        model: "gpt-6.1-sol".into(),
    });
    match action {
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
    // Service entrypoints always own the explicitly selected local state, even
    // when this machine's ordinary client profile points elsewhere.
    if let Action::Serve {
        tailnet_port,
        no_sources,
    } = action
    {
        let mut profile = config::load(arguments.config.as_deref())?;
        let policy = agent_cli::tailnet::PeerPolicy::new(&profile.trusted_nodes)?;
        let daemon = agent_cli::tailnet::Daemon::new(profile.tailscale_socket.as_deref())?;
        let _sources = if no_sources {
            None
        } else {
            profile.launch = Some(worker_launch(&arguments, &profile, &directory, &script)?);
            let cwd = env::current_dir()?;
            let context = intake::ContextBundle {
                instructions_file: arguments
                    .instructions
                    .clone()
                    .unwrap_or(instructions::default_path()?),
                model: "gpt-6.1-sol".into(),
                cwd: cwd.to_string_lossy().into_owned(),
                hosts: config::worker_hosts(&profile, None, &cwd)?,
            };
            let state = directory.clone();
            Some(WatchGuard(tokio::spawn(async move {
                let _ = intake::run(state, profile, context).await;
            })))
        };
        return match tailnet_port {
            Some(port) => service::serve_tailnet(&script, &directory, port, policy, daemon).await,
            None => service::serve(&script, &directory).await,
        };
    }
    if matches!(action, Action::Rpc) {
        return service::relay(
            local_connection(&script, &directory, arguments.config.as_deref()).await?,
        )
        .await;
    }
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
    let global = arguments
        .instructions
        .clone()
        .unwrap_or(instructions::default_path()?);
    let cwd = env::current_dir()?;
    if let Action::Maintain { interval_seconds } = action {
        ensure!(
            coordinator.is_some(),
            "Client maintenance requires a selected remote coordinator"
        );
        loop {
            let identity = RexClient::new(None).whoami().await;
            let collected = match identity {
                Ok(identity) => {
                    request(
                        &arguments,
                        &config,
                        coordinator.as_deref(),
                        &script,
                        &directory,
                        RuntimeCommand::CollectResources {
                            host_id: identity.host_id.to_string(),
                        },
                    )
                    .await
                }
                Err(error) => Err(error.into()),
            };
            if collected.is_err() {
                eprintln!("Resource maintenance could not complete; saved ownership is retained.");
            }
            sleep(Duration::from_secs(interval_seconds.into())).await;
        }
    }
    let command = match action {
        Action::Login => RuntimeCommand::Login,
        Action::Status => RuntimeCommand::Status,
        Action::Logout => RuntimeCommand::Logout,
        Action::Sources => RuntimeCommand::SourceStates,
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
        },
        Action::RunTask {
            task_id,
            agent_id,
            allocation_id,
            model,
        } => RuntimeCommand::RunTask {
            task_id,
            agent_id,
            allocation_id,
            binding: local_worker_binding().await?,
            instructions: instructions::load(&global, &cwd)?,
            model,
            cwd: cwd.to_string_lossy().into_owned(),
        },
        Action::Chat {
            prompt: Some(input),
            model,
        } => chat_command(input, model, &global, &cwd, &config, coordinator.as_deref())?,
        Action::Chat {
            prompt: None,
            model,
        } => {
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
                    let command = chat_command(
                        line,
                        model.clone(),
                        &global,
                        &cwd,
                        &config,
                        coordinator.as_deref(),
                    )?;
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

fn chat_command(
    input: String,
    model: String,
    global: &Path,
    cwd: &Path,
    config: &ClientConfig,
    coordinator: Option<&str>,
) -> Result<RuntimeCommand> {
    let mut hosts = config::worker_hosts(config, coordinator, cwd)?;
    for host in &mut hosts {
        host.launch
            .get_or_insert_with(|| WorkerLaunch {
                state_dir: None,
                runtime: None,
                config: None,
                instructions: None,
                model: model.clone(),
            })
            .model = model.clone();
    }
    Ok(RuntimeCommand::Chat {
        input,
        instructions: instructions::load(global, cwd)?,
        model,
        cwd: cwd.to_string_lossy().into_owned(),
        hosts,
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
        model: "gpt-6.1-sol".into(),
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
    let mut command = Command::new(config::program()?);
    if let Some(path) = config_path {
        command.arg("--config").arg(path);
    }
    command
        .arg("--state-dir")
        .arg(directory)
        .arg("--runtime")
        .arg(script)
        .arg("serve")
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
        let address = address.parse()?;
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
    let mut wire = connection(config, coordinator, script, directory, login).await?;
    let relay_needed = match (
        login,
        coordinator.and_then(|value| value.strip_prefix("tailscale://")),
    ) {
        (true, Some(address)) => {
            let address: std::net::SocketAddr = address.parse()?;
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
        RuntimeEventKind::Notice { text, .. } => println!("{text}"),
        _ => {}
    }
    Ok(())
}
