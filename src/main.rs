mod chat_admission;
mod chat_history;
mod chat_view;
mod mail;
mod state;

use std::{
    collections::{HashMap, VecDeque},
    env,
    fs::OpenOptions,
    io::{ErrorKind, IsTerminal},
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{Duration, SystemTime},
};

use agent_cli::{
    background::BackgroundSettings,
    chat_commands::{ChatCommand, JobRunArgs},
    config::{self, ClientConfig},
    context::ContextStore,
    discovery,
    feedback::FeedbackContext,
    host, instructions, jobs,
    models::{ModelProvider, ModelSelection, Reasoning},
    protocol::{
        AuthStatus, ConversationChange, ConversationSettings, CoordinatorBootstrap,
        CoordinatorSettings, ImportPhase, InputMode, MainInputContext, RuntimeCommand,
        RuntimeEventKind, SavedConversation, SearchMode, TaskId, WorkerLaunch, WorkerRef,
    },
    rex::{BlockId, RexClient, SessionId},
    runtime::{FrameReader, decode_coordinator_event},
    service,
    tui::attachments::ComposerInput,
    tui::{Tui, TuiHandle, TuiInfo, TuiInput},
    usage,
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
    /// Use the plain line interface in an interactive terminal.
    #[arg(long, global = true)]
    no_tui: bool,
    #[command(subcommand)]
    command: Option<Action>,
}

#[derive(Subcommand)]
enum Action {
    /// Create private TOML settings without overwriting an existing file.
    Init,
    /// Apply declarative preferences while preserving private machine settings.
    Config {
        #[command(subcommand)]
        command: ConfigAction,
    },
    /// Install the headless Messages reader in the local Rex server.
    Rex {
        #[command(subcommand)]
        command: RexAction,
    },
    Login,
    Status,
    Logout,
    Usage,
    /// Show background source coverage and checkpoints.
    Sources,
    /// Validate or reconcile Git-managed scheduled jobs, independently of sources.
    Jobs {
        #[command(subcommand)]
        command: JobsAction,
    },
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
    /// Import local Codex history without creating tasks or Rex sessions.
    Import {
        #[command(subcommand)]
        command: ImportAction,
    },
    /// Find, read or continue saved conversations.
    History {
        #[command(subcommand)]
        command: HistoryAction,
    },
    /// Read a private debugging snapshot captured by /feedback.
    Feedback {
        #[command(subcommand)]
        command: FeedbackAction,
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
    #[command(hide = true)]
    MessagesRead {
        #[arg(required = true, trailing_var_arg = true, allow_hyphen_values = true)]
        argv: Vec<String>,
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
enum ImportAction {
    Codex {
        /// Restrict import to these registered host IDs or names.
        #[arg(long = "host")]
        hosts: Vec<String>,
        /// Prefer this registered host for indexing; compute falls back locally.
        #[arg(long, value_name = "NAME_OR_ID", value_parser = clap::builder::NonEmptyStringValueParser::new())]
        embedding_host: Option<String>,
    },
    Status,
}

#[derive(Subcommand)]
enum HistoryAction {
    Search {
        query: String,
        #[arg(long, default_value_t = 8, value_parser = clap::value_parser!(u32).range(1..=50))]
        limit: u32,
        #[arg(long, value_enum, default_value_t = SearchMode::Semantic)]
        mode: SearchMode,
    },
    Read {
        conversation_id: String,
        #[arg(long)]
        cursor: Option<String>,
    },
    Open {
        conversation_id: String,
        #[arg(long)]
        host: Option<String>,
    },
}

#[derive(Subcommand)]
enum FeedbackAction {
    Latest,
    Show {
        id: String,
    },
    /// Retry the exact locally retained report after an unconfirmed delivery.
    Retry {
        id: uuid::Uuid,
    },
}

#[derive(Subcommand)]
enum ConfigAction {
    Apply { settings: PathBuf },
}

#[derive(Subcommand)]
enum RexAction {
    Install,
}

#[derive(Subcommand)]
enum ResourcesAction {
    List,
    Collect,
}

#[derive(Subcommand)]
enum JobsAction {
    /// Run an applied job now, choosing a schedule when it has several.
    Run(JobRunArgs),
    /// Validate the complete job catalog and preview upcoming occurrences.
    Check {
        #[arg(long = "directory")]
        directories: Vec<PathBuf>,
        #[arg(long, default_value_t = 5, value_parser = clap::value_parser!(u16).range(1..=100))]
        next: u16,
    },
    /// Reconcile the complete catalog; built-in source timers are unaffected.
    Sync {
        #[arg(long = "directory")]
        directories: Vec<PathBuf>,
    },
    /// List the applied jobs and their next occurrences.
    List,
    /// Show an applied job's prompt, model and schedules.
    Get { id: String },
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

fn job_directories(config: &ClientConfig, explicit: Vec<PathBuf>) -> Result<Vec<PathBuf>> {
    if explicit.is_empty() {
        ensure!(
            !config.job_directories.is_empty(),
            "Configure job_directories or pass --directory; use an empty directory to remove all managed jobs"
        );
        return Ok(config.job_directories.clone());
    }
    explicit
        .into_iter()
        .map(|path| std::path::absolute(path).map_err(Into::into))
        .collect()
}

fn startup_jobs(config: &ClientConfig) -> Option<Vec<jobs::ScheduledJob>> {
    if config.job_directories.is_empty() {
        return None;
    }
    match jobs::load(&config.job_directories) {
        Ok(jobs) => Some(jobs),
        Err(error) => {
            eprintln!(
                "Scheduled job validation failed; previously applied jobs are retained: {error:#}"
            );
            None
        }
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
        Action::MessagesRead { argv } => {
            let output = agent_cli::sources::messages_read::capture(&argv).await?;
            println!("{}", serde_json::to_string(&output)?);
            return Ok(());
        }
        Action::Rex {
            command: RexAction::Install,
        } => {
            let installed =
                agent_cli::rex::install::install(agent_cli::rex::source::MODULE).await?;
            if arguments.json {
                println!("{}", serde_json::to_string(&installed)?);
            } else {
                println!("Messages reads configured through Rex Server");
            }
            return Ok(());
        }
        Action::Config {
            command: ConfigAction::Apply { settings },
        } => {
            let path = arguments
                .config
                .clone()
                .map(Ok)
                .unwrap_or_else(config::default_path)?;
            let result = config::apply(&path, &settings)?;
            if arguments.json {
                println!("{}", serde_json::to_string(&result)?);
            } else {
                println!(
                    "{} {}",
                    if result.changed {
                        "Updated"
                    } else {
                        "Unchanged"
                    },
                    result.path.display()
                );
            }
            return Ok(());
        }
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
        Action::Jobs {
            command: JobsAction::Check { directories, next },
        } => {
            let config = config::load(arguments.config.as_deref())?;
            let jobs = jobs::load(&job_directories(&config, directories)?)?;
            let now = jobs::UtcMillis::now()?;
            #[derive(serde::Serialize)]
            struct Preview {
                job_id: jobs::JobId,
                schedule_id: jobs::ScheduleId,
                timezone: jobs::TimezoneId,
                occurrences: Vec<jobs::UtcMillis>,
            }
            let mut previews = Vec::new();
            for job in jobs {
                for schedule in &job.schedules {
                    previews.push(Preview {
                        job_id: job.id.clone(),
                        schedule_id: schedule.id.clone(),
                        timezone: job.timezone.clone(),
                        occurrences: jobs::preview(
                            schedule,
                            &job.timezone,
                            now,
                            usize::from(next),
                        )?,
                    });
                }
            }
            println!("{}", serde_json::to_string_pretty(&previews)?);
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
        if !no_sources {
            configure_messages(&config.sources).await;
        }
        let policy =
            agent_cli::tailnet::PeerPolicy::new(&config.trusted_nodes, &config.trusted_user_ids)?;
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
            &daemon,
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
            background: Some(BackgroundSettings {
                poll_interval_seconds: u32::try_from(config.poll_interval_seconds)?,
                sources: !no_sources,
                jobs: startup_jobs(&config),
            }),
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
        Action::Usage => RuntimeCommand::Usage {
            provider: conversation_settings(
                &config,
                coordinator.as_deref(),
                &script,
                &directory,
                None,
                None,
                false,
            )
            .await?
            .model
            .provider,
        },
        Action::Logout => RuntimeCommand::Logout,
        Action::Sources => RuntimeCommand::SourceStates,
        Action::Jobs { command } => match command {
            JobsAction::Run(args) => args.request(),
            JobsAction::Sync { directories } => {
                ensure!(
                    coordinator.is_none(),
                    "Run jobs sync on the coordinator in the checkout that owns the job files; client paths cannot select the coordinator's working directory"
                );
                RuntimeCommand::SyncJobs {
                    jobs: jobs::load(&job_directories(&config, directories)?)?,
                }
            }
            JobsAction::List => RuntimeCommand::ListJobs,
            JobsAction::Get { id } => RuntimeCommand::ReadJob {
                job_id: jobs::JobId::try_from(id)?,
            },
            JobsAction::Check { .. } => bail!("Job checks must run locally"),
        },
        Action::Nodes => RuntimeCommand::Environment { telemetry: false },
        Action::Feedback { command } => match command {
            FeedbackAction::Latest => RuntimeCommand::ReadFeedback { id: None },
            FeedbackAction::Show { id } => RuntimeCommand::ReadFeedback { id: Some(id) },
            FeedbackAction::Retry { id } => read_feedback_submission(&directory, id)?,
        },
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
        Action::Import { command } => match command {
            ImportAction::Codex {
                hosts,
                embedding_host,
            } => RuntimeCommand::ImportCodex {
                hosts,
                embedding_host,
            },
            ImportAction::Status => RuntimeCommand::ImportStatus,
        },
        Action::History { command } => match command {
            HistoryAction::Search { query, limit, mode } => {
                RuntimeCommand::SearchHistory { query, limit, mode }
            }
            HistoryAction::Read {
                conversation_id,
                cursor,
            } => RuntimeCommand::ReadConversation {
                conversation_id,
                cursor,
            },
            HistoryAction::Open {
                conversation_id,
                host,
            } => RuntimeCommand::OpenConversation {
                conversation_id,
                host,
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
            interactive: Some(true),
        },
        Action::Chat {
            prompt: Some(input),
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
            if let Some(command) = ChatCommand::parse(&input) {
                let command = command?;
                match command {
                    ChatCommand::Help => {
                        println!("{}", agent_cli::tui::help_text());
                        return Ok(());
                    }
                    ChatCommand::Exit => return Ok(()),
                    ChatCommand::Resume { query } if use_tui(&arguments) => {
                        return chat_tui(
                            &arguments,
                            &config,
                            coordinator.as_deref(),
                            &script,
                            &directory,
                            &cwd,
                            ChatStart {
                                model,
                                prompt: Some(format!("/resume {}", query.join(" "))),
                            },
                        )
                        .await;
                    }
                    ChatCommand::History => {
                        return request(
                            &arguments,
                            &config,
                            coordinator.as_deref(),
                            &script,
                            &directory,
                            RuntimeCommand::ReadHistory {
                                task_id: None,
                                agent_id: None,
                                cursor: None,
                            },
                        )
                        .await
                        .map(|_| ());
                    }
                    ChatCommand::Feedback { .. } => {}
                    command => {
                        if !matches!(command, ChatCommand::Machines | ChatCommand::Worktrees)
                            && let Some(model) = model
                        {
                            conversation_settings(
                                &config,
                                coordinator.as_deref(),
                                &script,
                                &directory,
                                None,
                                Some(ConversationChange::SetSelection { model }),
                                false,
                            )
                            .await?;
                        }
                        return local_command_plain(
                            ClientContext {
                                config: &config,
                                coordinator: coordinator.as_deref(),
                                script: &script,
                                directory: &directory,
                            },
                            &command,
                            None,
                            &cwd,
                            arguments.json,
                        )
                        .await;
                    }
                }
            }
            if use_tui(&arguments) {
                return chat_tui(
                    &arguments,
                    &config,
                    coordinator.as_deref(),
                    &script,
                    &directory,
                    &cwd,
                    ChatStart {
                        model,
                        prompt: Some(input),
                    },
                )
                .await;
            }
            chat_command(input, model, &cwd).await?
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
            if use_tui(&arguments) {
                return chat_tui(
                    &arguments,
                    &config,
                    coordinator.as_deref(),
                    &script,
                    &directory,
                    &cwd,
                    ChatStart {
                        model,
                        prompt: None,
                    },
                )
                .await;
            }
            conversation_settings(
                &config,
                coordinator.as_deref(),
                &script,
                &directory,
                None,
                model.map(|model| ConversationChange::SetSelection { model }),
                false,
            )
            .await?;
            let model: Option<ModelSelection> = None;
            let _watch = watch(
                &config,
                coordinator.as_deref(),
                &script,
                &directory,
                arguments.json,
            )
            .await?;
            let mut history_cursor = request(
                &arguments,
                &config,
                coordinator.as_deref(),
                &script,
                &directory,
                RuntimeCommand::ReadHistory {
                    task_id: None,
                    agent_id: None,
                    cursor: None,
                },
            )
            .await?;
            let mut input = BufReader::new(tokio::io::stdin()).lines();
            let mut feedback = tokio::task::JoinSet::new();
            let result = async {
                loop {
                    if !arguments.json && std::io::stdin().is_terminal() {
                        let mut stdout = tokio::io::stdout();
                        stdout.write_all(b"agent> ").await?;
                        stdout.flush().await?;
                    }
                    let Some(line) = input.next_line().await? else {
                        return Ok(());
                    };
                    let local = ChatCommand::parse(&line);
                    if let Some(command) = local {
                        match command {
                            Err(error) => {
                                eprintln!("{error}");
                                continue;
                            }
                            Ok(ChatCommand::Help) => {
                                println!("{}", agent_cli::tui::help_text());
                                continue;
                            }
                            Ok(ChatCommand::Exit) => return Ok(()),
                            Ok(ChatCommand::History | ChatCommand::Feedback { .. }) => {}
                            Ok(command) => {
                                if let Err(error) = local_command_plain(
                                    ClientContext {
                                        config: &config,
                                        coordinator: coordinator.as_deref(),
                                        script: &script,
                                        directory: &directory,
                                    },
                                    &command,
                                    None,
                                    &cwd,
                                    arguments.json,
                                )
                                .await
                                {
                                    eprintln!("Local command failed: {error}");
                                }
                                continue;
                            }
                        }
                    }
                    if line.trim() == "/exit" {
                        return Ok(());
                    }
                    if let Some(description) = agent_cli::feedback::command(&line) {
                        let config = config.clone();
                        let coordinator = coordinator.clone();
                        let script = script.clone();
                        let directory = directory.clone();
                        let cwd = cwd.to_string_lossy().into_owned();
                        let model = model.clone();
                        let description = description.to_owned();
                        let json = arguments.json;
                        while feedback.try_join_next().is_some() {}
                        feedback.spawn(async move {
                            let captured = async {
                                let context = feedback_context(cwd, model, None).await?;
                                exchange(
                                    &config,
                                    coordinator.as_deref(),
                                    &script,
                                    &directory,
                                    context.command(description),
                                )
                                .await
                            }
                            .await;
                            match captured {
                                Ok(events) => {
                                    for event in events {
                                        if let Err(error) = display(&event, json) {
                                            eprintln!(
                                                "Feedback receipt could not be displayed: {error}"
                                            );
                                        }
                                    }
                                }
                                Err(error) => eprintln!("Feedback could not start: {error}"),
                            }
                        });
                        continue;
                    }
                    if line.trim() == "/history" {
                        if history_cursor.is_none() {
                            if !arguments.json {
                                println!("No older history.");
                            }
                        } else {
                            history_cursor = request(
                                &arguments,
                                &config,
                                coordinator.as_deref(),
                                &script,
                                &directory,
                                RuntimeCommand::ReadHistory {
                                    task_id: None,
                                    agent_id: None,
                                    cursor: history_cursor,
                                },
                            )
                            .await?;
                        }
                        continue;
                    }
                    if !line.trim().is_empty() {
                        let command = chat_command(line, model.clone(), &cwd).await?;
                        request_presented(
                            &arguments,
                            ClientContext {
                                config: &config,
                                coordinator: coordinator.as_deref(),
                                script: &script,
                                directory: &directory,
                            },
                            command,
                            None,
                            PlainNoticeRoute::Watch,
                        )
                        .await?;
                    }
                }
            }
            .await;
            finish_controls(&mut feedback).await;
            return result;
        }
        _ => bail!("Unsupported client command"),
    };
    if use_tui(&arguments)
        && let RuntimeCommand::RunTask {
            model,
            cwd,
            task_id,
            agent_id,
            allocation_id,
            ..
        } = &command
    {
        let owner = UiRecoveryOwner::Task {
            task_id: task_id.clone(),
            agent_id: agent_id.clone(),
            allocation_id: allocation_id.clone(),
        };
        let (handle, inputs, guard) = Tui::start(TuiInfo {
            title: "Connecting to task".into(),
            model: Some(model.clone()),
            cwd: cwd.clone(),
        })?;
        let mut ui = UiSession::new(handle, inputs);
        ui.initial_replay = Some(ui.handle.begin_history_replay()?);
        let result = request_with_ui(
            &arguments,
            &config,
            coordinator.as_deref(),
            &script,
            &directory,
            command,
            &mut ui,
        )
        .await
        .map(|_| ());
        let recovery = if result.is_err() {
            Some(preserve_ui_recovery(&directory, owner, &ui).await)
        } else {
            None
        };
        ui.close_view().await;
        finish_controls(&mut ui.controls).await;
        let stopped = guard.stop().await;
        match recovery {
            Some(Ok(Some(path))) => eprintln!(
                "Unsent input saved privately to {}. It will not be replayed automatically.",
                path.display()
            ),
            Some(Err(error)) => eprintln!("Could not preserve unsent terminal input: {error}"),
            _ => {}
        }
        return result.and(stopped);
    }
    request(
        &arguments,
        &config,
        coordinator.as_deref(),
        &script,
        &directory,
        command,
    )
    .await
    .map(|_| ())
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
            let Ok(event) = decode_coordinator_event(&frame) else {
                break;
            };
            if matches!(event, RuntimeEventKind::Notice { .. }) && display(&event, json).is_err() {
                break;
            }
        }
        eprintln!("Live updates disconnected; saved work is retained.");
    })))
}

fn use_tui(arguments: &Arguments) -> bool {
    !arguments.json
        && !arguments.no_tui
        && std::io::stdin().is_terminal()
        && std::io::stdout().is_terminal()
}

struct ChatStart {
    model: Option<ModelSelection>,
    prompt: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum UiRecoveryOwner {
    Main,
    Conversation {
        conversation_id: String,
    },
    Task {
        task_id: TaskId,
        agent_id: Option<String>,
        allocation_id: String,
    },
}
#[derive(serde::Serialize, serde::Deserialize)]
struct UiRecovery {
    owner: UiRecoveryOwner,
    draft: ComposerInput,
    queued_inputs: Vec<QueuedInput>,
}

async fn preserve_ui_recovery(
    directory: &Path,
    owner: UiRecoveryOwner,
    ui: &UiSession,
) -> Result<Option<PathBuf>> {
    let draft = ui.handle.composer_draft().await?;
    if draft.is_empty() && ui.queued.is_empty() && ui.submitted.is_empty() {
        return Ok(None);
    }
    write_ui_recovery(
        directory,
        &UiRecovery {
            owner,
            draft,
            queued_inputs: ui
                .queued
                .iter()
                .chain(ui.submitted.iter())
                .cloned()
                .collect(),
        },
    )
    .map(Some)
}

async fn preserve_observed_recovery(directory: &Path, ui: &UiSession) -> Result<Vec<PathBuf>> {
    let mut drafts = ui.drafts.clone();
    if let Some(id) = &ui.conversation_id {
        drafts.insert(id.clone(), ui.handle.composer_draft().await?);
    }
    let mut queued = HashMap::<String, Vec<QueuedInput>>::new();
    for input in &ui.pending_admissions {
        if input.retained()? {
            queued
                .entry(input.conversation_id.clone())
                .or_default()
                .push(QueuedInput {
                    id: input.id.clone(),
                    input: input.input()?,
                    mode: input.mode,
                });
        }
    }
    for id in queued.keys() {
        drafts.entry(id.clone()).or_default();
    }
    let mut paths = Vec::new();
    for (conversation_id, draft) in drafts {
        let queued_inputs = queued.remove(&conversation_id).unwrap_or_default();
        if draft.is_empty() && queued_inputs.is_empty() {
            continue;
        }
        paths.push(write_ui_recovery(
            directory,
            &UiRecovery {
                owner: UiRecoveryOwner::Conversation { conversation_id },
                draft,
                queued_inputs,
            },
        )?);
    }
    Ok(paths)
}

fn write_ui_recovery(directory: &Path, recovery: &UiRecovery) -> Result<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let directory = directory.join("recovery");
    std::fs::create_dir_all(&directory)?;
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))?;
    let id = uuid::Uuid::new_v4();
    let temporary = directory.join(format!(".tui-draft-{id}.tmp"));
    let path = directory.join(format!("tui-draft-{id}.json"));
    let saved = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?;
        serde_json::to_writer(&mut file, recovery)?;
        file.sync_all()?;
        std::fs::rename(&temporary, &path)?;
        Ok(())
    })();
    if saved.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    saved?;
    Ok(path)
}
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct QueuedInput {
    id: String,
    input: ComposerInput,
    mode: InputMode,
}

struct UiSession {
    handle: TuiHandle,
    inputs: tokio::sync::mpsc::UnboundedReceiver<TuiInput>,
    queued: VecDeque<QueuedInput>,
    history_cursor: Option<String>,
    exiting: bool,
    failure_shown: bool,
    conversation_id: Option<String>,
    submitted: VecDeque<QueuedInput>,
    errors: VecDeque<String>,
    controls: tokio::task::JoinSet<()>,
    tool_lookup: Option<tokio::task::AbortHandle>,
    selected: Option<SavedConversation>,
    admissions: tokio::task::JoinSet<()>,
    pending_admissions: Vec<Arc<chat_admission::Admission>>,
    interrupts: HashMap<String, tokio::sync::watch::Receiver<bool>>,
    drafts: HashMap<String, ComposerInput>,
    view: Option<chat_view::View>,
    observer_ready: bool,
    history: Option<chat_history::Job>,
    initial_replay: Option<agent_cli::tui::HistoryReplay>,
    initial_history: Vec<RuntimeEventKind>,
    view_sender: tokio::sync::mpsc::UnboundedSender<(uuid::Uuid, RuntimeEventKind)>,
    view_events: tokio::sync::mpsc::UnboundedReceiver<(uuid::Uuid, RuntimeEventKind)>,
}
impl UiSession {
    fn new(handle: TuiHandle, inputs: tokio::sync::mpsc::UnboundedReceiver<TuiInput>) -> Self {
        let (view_sender, view_events) = tokio::sync::mpsc::unbounded_channel();
        Self {
            handle,
            inputs,
            queued: VecDeque::new(),
            history_cursor: None,
            exiting: false,
            failure_shown: false,
            conversation_id: None,
            submitted: VecDeque::new(),
            errors: VecDeque::new(),
            controls: tokio::task::JoinSet::new(),
            tool_lookup: None,
            selected: None,
            admissions: tokio::task::JoinSet::new(),
            pending_admissions: Vec::new(),
            interrupts: HashMap::new(),
            drafts: HashMap::new(),
            view: None,
            observer_ready: false,
            history: None,
            initial_replay: None,
            initial_history: Vec::new(),
            view_sender,
            view_events,
        }
    }
    fn view_event(&mut self, token: uuid::Uuid, event: RuntimeEventKind) -> Result<()> {
        let id = match &event {
            RuntimeEventKind::InputAccepted { input_id }
            | RuntimeEventKind::InputPlaced { input_id, .. }
            | RuntimeEventKind::InputRejected { input_id, .. } => Some(input_id),
            _ => None,
        };
        let admission = id
            .and_then(|id| self.pending_admissions.iter().find(|input| &input.id == id))
            .cloned();
        let previous = admission.as_ref().map(|input| input.stage()).transpose()?;
        if let Some(input) = &admission {
            input.observe(&event)?;
        }
        // An admission belongs to its conversation even if it outlived an old
        // view token. Other events remain isolated to their exact observer.
        let current = admission.as_ref().map_or_else(
            || self.view.as_ref().is_some_and(|view| view.token == token),
            |input| {
                self.selected
                    .as_ref()
                    .is_some_and(|selected| selected.conversation_id == input.conversation_id)
            },
        );
        if matches!(event, RuntimeEventKind::InputRejected { .. }) {
            if let Some(input) = &admission {
                if !matches!(
                    previous,
                    Some(
                        chat_admission::Stage::Placed
                            | chat_admission::Stage::Rejected
                            | chat_admission::Stage::Canceled
                    )
                ) {
                    if current {
                        self.handle.restore_composer(input.input()?)?;
                    } else {
                        let draft = self
                            .drafts
                            .entry(input.conversation_id.clone())
                            .or_default();
                        draft.append(input.input()?);
                    }
                }
            } else if current
                && let RuntimeEventKind::InputRejected { input_id, .. } = &event
                && let Some(index) = self
                    .submitted
                    .iter()
                    .position(|input| &input.id == input_id)
                && let Some(input) = self.submitted.remove(index)
            {
                self.handle.restore_composer(input.input)?;
            }
        }
        if !current {
            return Ok(());
        }
        if let RuntimeEventKind::InputPlaced { input_id, .. } = &event {
            self.placed_input(input_id);
        }
        if matches!(event, RuntimeEventKind::ConversationReady { .. }) {
            if self.observer_ready
                && let Some(view) = &self.view
            {
                let replay = self.handle.begin_history_reconciliation()?;
                self.history = Some(view.replay(replay));
            }
            self.observer_ready = true;
        }
        self.handle.event(event)?;
        self.reconcile_inputs()?;
        if let Some(view) = &self.view {
            self.handle.observation(view.state())?;
        }
        Ok(())
    }
    fn reconcile_inputs(&self) -> Result<()> {
        if let (Some(view), Some(selected)) = (&self.view, &self.selected) {
            let mut ids = Vec::new();
            for input in &self.pending_admissions {
                if input.conversation_id == selected.conversation_id && input.retained()? {
                    ids.push(input.id.clone());
                }
            }
            view.reconcile(ids);
        }
        Ok(())
    }
    async fn next(&mut self) -> Option<TuiInput> {
        loop {
            tokio::select! {
                input=self.inputs.recv()=>return input,
                frame=self.view_events.recv(),if self.view.is_some()=>{
                    if let Some((token,event))=frame && let Err(error)=self.view_event(token,event) {
                        let _=self.handle.notice(error.to_string());
                    }
                }
            }
        }
    }
    async fn finish_admissions(&mut self) -> Result<()> {
        // Detaching cannot discard an input still waiting for observation or
        // its write receipt. The coordinator owns work after durable admission;
        // its model generation may continue after this terminal closes.
        let mut readiness = self.view.as_ref().map(|view| view.ready.clone());
        loop {
            if self.view.as_ref().is_some_and(|view| {
                matches!(
                    view.state(),
                    agent_cli::tui::ObservationState::Reconnecting
                        | agent_cli::tui::ObservationState::Disconnected
                )
            }) {
                return Ok(());
            }
            let mut waiting = false;
            for input in &self.pending_admissions {
                waiting |= matches!(
                    input.stage()?,
                    chat_admission::Stage::Waiting | chat_admission::Stage::Sending
                );
            }
            if !waiting {
                return Ok(());
            }
            let next = tokio::select! {
                next = self.view_events.recv() => next,
                _ = async {
                    if let Some(ready) = &mut readiness {
                        let _ = ready.changed().await;
                    } else {
                        std::future::pending::<()>().await;
                    }
                } => continue,
            };
            let (token, event) =
                next.context("Input admission disconnected before it could be confirmed")?;
            let failure = match &event {
                RuntimeEventKind::Failure { message, .. } => Some(message.clone()),
                _ => None,
            };
            self.view_event(token, event)?;
            if let Some(message) = failure {
                bail!("Input admission could not be confirmed: {message}");
            }
        }
    }
    fn cancel_waiting(&mut self, conversation_id: &str) -> Result<Vec<String>> {
        let mut canceled = Vec::new();
        for input in &self.pending_admissions {
            if input.conversation_id == conversation_id && input.cancel_waiting()? {
                let draft = self.drafts.entry(conversation_id.to_owned()).or_default();
                draft.append(input.input()?);
                canceled.push(input.id.clone());
            }
        }
        Ok(canceled)
    }
    async fn close_view(&mut self) {
        if let Some(view) = self.view.take() {
            view.stop().await;
        }
        if let Some(history) = self.history.take() {
            history.cancel().await;
        }
        self.initial_replay.take();
        self.admissions.abort_all();
        while self.admissions.join_next().await.is_some() {}
        self.controls.abort_all();
        while self.controls.join_next().await.is_some() {}
    }
    fn enqueue(&mut self, input: ComposerInput, mode: InputMode) -> Result<()> {
        let id = uuid::Uuid::new_v4().to_string();
        self.handle.pending_composer(id.clone(), &input, mode)?;
        self.queued.push_back(QueuedInput { id, input, mode });
        Ok(())
    }
    fn placed_input(&mut self, input_id: &str) {
        if let Some(index) = self.submitted.iter().position(|input| input.id == input_id) {
            self.submitted.remove(index);
        }
    }
}

fn selected_input(
    client: ClientContext<'_>,
    ui: &mut UiSession,
    input: ComposerInput,
    mode: InputMode,
    cwd: PathBuf,
) -> Result<()> {
    let conversation_id = ui
        .selected
        .as_ref()
        .context("Choose a saved conversation")?
        .conversation_id
        .clone();
    let view = ui
        .view
        .as_ref()
        .context("Conversation view is unavailable")?;
    if view.state() == agent_cli::tui::ObservationState::Disconnected {
        ui.handle.restore_composer(input)?;
        ui.handle.notice(format!(
            "Reconnect with `/resume {conversation_id}` before sending. Saved work may still be running."
        ))?;
        return Ok(());
    }
    let token = view.token;
    let mut ready = view.ready.clone();
    let retry = view.retry.clone();
    let interrupt = ui.interrupts.get(&conversation_id).cloned();
    let admission = Arc::new(chat_admission::Admission::new(conversation_id, input, mode));
    ui.pending_admissions
        .retain(|input| !matches!(input.retained(), Ok(false)));
    ui.handle
        .pending_composer(admission.id.clone(), &admission.input()?, admission.mode)?;
    ui.pending_admissions.push(admission.clone());
    ui.reconcile_inputs()?;
    let sender = ui.view_sender.clone();
    let handle = ui.handle.clone();
    let config = client.config.clone();
    let coordinator = client.coordinator.map(str::to_owned);
    let script = client.script.to_owned();
    let directory = client.directory.to_owned();
    while ui.admissions.try_join_next().is_some() {}
    ui.admissions.spawn(async move {
        loop {
        let result: std::result::Result<(), chat_view::ViewError> = async {
            if ready.wait_for(|ready| matches!(ready, agent_cli::tui::ObservationState::Connected | agent_cli::tui::ObservationState::Disconnected)).await.is_err()
                || chat_view::observation(&ready) != agent_cli::tui::ObservationState::Connected
            {
                if admission.stage()? == chat_admission::Stage::Canceled {
                    return Ok(());
                }
                return Err(chat_view::ViewError::Coordinator(anyhow::anyhow!("The conversation view did not attach; this input remains unsent.")));
            }
            if admission.stage()? == chat_admission::Stage::Canceled {
                return Ok(());
            }
            let mut input = admission.input()?;
            let prepared = prepare_attachments(ClientContext {
                config: &config, coordinator: coordinator.as_deref(), script: &script, directory: &directory,
            }, &mut input).await;
            admission.prepared(input.clone())?;
            prepared?;
            if admission.stage()? == chat_admission::Stage::Canceled {
                return Ok(());
            }
            if let Some(mut interrupted) = interrupt.clone()
                && interrupted.wait_for(|stopped| *stopped).await.is_err()
            {
                if admission.stage()? == chat_admission::Stage::Canceled {
                    return Ok(());
                }
                let _ = sender.send((token, RuntimeEventKind::InputRejected {
                    input_id: admission.id.clone(),
                    message: "The previous interruption could not be confirmed. This input remains unsent; reconnect before sending it again.".into(),
                }));
                return Ok(());
            }
            let context = match chat_command(String::new(), None, &cwd).await? {
                RuntimeCommand::Chat {
                    instructions,
                    origin_host_id,
                    cwd,
                    hosts,
                    ..
                } => MainInputContext {
                    instructions,
                    origin_host_id,
                    cwd,
                    hosts,
                },
                _ => return Err(anyhow::anyhow!("The main chat context is unavailable").into()),
            };
            chat_view::control(
                ClientContext {
                    config: &config,
                    coordinator: coordinator.as_deref(),
                    script: &script,
                    directory: &directory,
                },
                RuntimeCommand::ConversationInput {
                    conversation_id: admission.conversation_id.clone(),
                    input_id: admission.id.clone(),
                    input: admission.text.clone(),
                    attachments: (!input.attachments.is_empty()).then_some(input.attachments),
                    mode: admission.mode,
                    context: Some(context),
                },
                token,
                sender.clone(),
                &admission,
                &ready,
            )
            .await
        }
        .await;
        if matches!(result, Err(chat_view::ViewError::Coordinator(_))) && ready.has_changed().is_ok() {
            let _ = ready.borrow_and_update();
            let _ = retry.try_send(());
            // A claimed write is uncertain. Reattach reconciles its original ID;
            // only inputs that never claimed a write may resume automatically.
            if matches!(admission.stage(), Ok(chat_admission::Stage::Waiting)) {
                if ready.changed().await.is_ok() { continue; }
            } else {
                if matches!(admission.uncertain(), Ok(true)) {
                    let _ = handle.input_uncertain(admission.id.clone());
                }
                return;
            }
        }
        if let Err(error) = result {
            let event = error.event(&admission.conversation_id);
            if matches!(admission.stage(), Ok(chat_admission::Stage::Waiting)) {
                if let RuntimeEventKind::Failure { message, .. } = event {
                    let _ = sender.send((token, RuntimeEventKind::InputRejected {
                        input_id: admission.id.clone(), message,
                    }));
                }
            } else {
                let _ = sender.send((token, event));
            }
        }
        return;
        }
    });
    Ok(())
}

async fn selected_interrupt(client: ClientContext<'_>, ui: &mut UiSession) -> Result<()> {
    let Some(selected) = &ui.selected else {
        return Ok(());
    };
    let conversation_id = selected.conversation_id.clone();
    ui.drafts
        .insert(conversation_id.clone(), ui.handle.composer_draft().await?);
    let canceled = ui.cancel_waiting(&conversation_id)?;
    for input_id in &canceled {
        ui.handle.event(RuntimeEventKind::InputRejected {
            input_id: input_id.clone(),
            message: "Input canceled before admission.".into(),
        })?;
    }
    if !canceled.is_empty() {
        ui.handle
            .set_composer(ui.drafts.get(&conversation_id).cloned().unwrap_or_default())?;
    }
    // The stop and later input use independent connections. Retain their
    // conversation order so a delayed stop cannot abort the next request.
    let (stopped, receipt) = tokio::sync::watch::channel(false);
    let previous = ui.interrupts.insert(conversation_id.clone(), receipt);
    let command = RuntimeCommand::ConversationInterrupt { conversation_id };
    let config = client.config.clone();
    let coordinator = client.coordinator.map(str::to_owned);
    let script = client.script.to_owned();
    let directory = client.directory.to_owned();
    let sender = ui.view_sender.clone();
    let token = ui.view.as_ref().map(|view| view.token);
    // Switching views cancels local reads, not this already requested stop.
    ui.admissions.spawn(async move {
        if let Some(mut previous) = previous {
            let _ = previous.wait_for(|stopped| *stopped).await;
        }
        match exchange(
            &config,
            coordinator.as_deref(),
            &script,
            &directory,
            command,
        )
        .await
        {
            Ok(events) => {
                if let Some(token) = token {
                    for event in events {
                        let _ = sender.send((token, event));
                    }
                }
                let _ = stopped.send(true);
            }
            Err(error) => {
                if let Some(token) = token {
                    let _ = sender.send((
                        token,
                        RuntimeEventKind::Failure {
                            code: agent_cli::protocol::ErrorCode::Internal,
                            message: error.to_string(),
                        },
                    ));
                }
            }
        }
    });
    Ok(())
}

async fn feedback_context(
    cwd: String,
    model: Option<ModelSelection>,
    target: Option<(TaskId, Option<String>)>,
) -> Result<FeedbackContext> {
    let origin_host_id = RexClient::new(None).whoami().await?.host_id.to_string();
    let binding = if env::var_os("REX_SESSION").is_some() && env::var_os("REX_BLOCK").is_some() {
        Some(local_worker_binding().await?)
    } else {
        None
    };
    let (task_id, agent_id) = target.map_or((None, None), |(task, agent)| (Some(task), agent));
    Ok(FeedbackContext {
        origin_host_id,
        cwd,
        conversation_id: None,
        task_id,
        agent_id,
        model,
        binding,
        draft: String::new(),
        queued_inputs: Vec::new(),
        client_errors: Vec::new(),
        truncated: None,
        attachments: None,
    })
}

fn feedback_from_ui(
    config: &ClientConfig,
    coordinator: Option<&str>,
    script: &Path,
    directory: &Path,
    ui: &mut UiSession,
    target: Option<(TaskId, Option<String>)>,
    input: ComposerInput,
) {
    let config = config.clone();
    let coordinator = coordinator.map(str::to_owned);
    let script = script.to_owned();
    let directory = directory.to_owned();
    let handle = ui.handle.clone();
    let conversation_id = ui.conversation_id.clone();
    let queued_inputs = ui
        .queued
        .iter()
        .map(|input| &input.input.text)
        .chain(ui.submitted.iter().map(|input| &input.input.text))
        .cloned()
        .collect();
    let client_errors = ui.errors.iter().cloned().collect();
    while ui.controls.try_join_next().is_some() {}
    ui.controls.spawn(async move {
        let input_id = uuid::Uuid::new_v4();
        let mut input = input;
        let mut submitted = false;
        let result = async {
            let info = handle.info().await?;
            let draft = handle.draft().await?;
            let mut context = feedback_context(info.cwd, info.model, target).await?;
            context.conversation_id = conversation_id;
            context.draft = draft;
            context.queued_inputs = queued_inputs;
            context.client_errors = client_errors;
            // Capture the origin pane before feedback can create a repair worker.
            // Rex's supported visual format is HTML, not a whole-desktop image.
            let capture = if input.attachment_count() < agent_cli::attachments::MAX_ATTACHMENTS {
                match context.binding.as_ref() {
                    Some(binding) => match capture_feedback_view(&directory, binding).await {
                        Ok(capture) => Some(capture),
                        Err(error) => {
                            context.client_errors.push(format!("Terminal view capture unavailable: {error}"));
                            None
                        }
                    },
                    None => {
                        context.client_errors.push("No exact Rex pane was available for a terminal view capture.".into());
                        None
                    }
                }
            } else {
                context.client_errors.push("Terminal view capture omitted because all attachment slots are occupied.".into());
                None
            };
            if let Some(capture) = &capture {
                input.files.push(agent_cli::tui::attachments::ComposerFile::read_metadata(capture.path.clone())?);
            }
            let prepared = prepare_attachments(ClientContext {config:&config,coordinator:coordinator.as_deref(),script:&script,directory:&directory}, &mut input).await;
            if prepared.is_err() && let Some(capture)=&capture {
                input.files.retain(|file| file.path != capture.path);
            }
            prepared?;
            context.attachments = (!input.attachments.is_empty()).then(||input.attachments.clone());
            let mut command = context.command(input.text.clone());
            if let RuntimeCommand::Feedback { input_id: id, .. } = &mut command {
                *id = Some(input_id.to_string());
            }
            write_feedback_submission(&directory,input_id,&command)?;
            submitted = true;
            let events = exchange(
                &config,
                coordinator.as_deref(),
                &script,
                &directory,
                command,
            )
            .await?;
            ensure!(events.iter().any(|event|matches!(event,RuntimeEventKind::FeedbackReady{input_id:Some(id),..} if id==&input_id.to_string())),"Feedback admission was not confirmed");
            acknowledge_feedback_submission(&directory,&input_id.to_string());
            Ok::<_,anyhow::Error>(events)
        }
        .await;
        match result {
            Ok(events) => {
                for event in events {
                    if let RuntimeEventKind::FeedbackReady { receipt, .. } = event {
                        let _ = handle.notice(format!(
                            "Feedback {}: debugging in the background; results will return here.",
                            receipt.id
                        ));
                    }
                }
            }
            Err(error) => {
                if submitted {
                    let _=handle.notice(format!("Feedback delivery is unconfirmed: {error}. The original report was retained; check `agent feedback latest` before retrying with `agent feedback retry {input_id}`."));
                } else {
                    input.text = if input.text.is_empty() {"/feedback".into()} else {format!("/feedback {}",input.text)};
                    let _=handle.restore_composer(input);
                    let _ = handle.notice(format!("Feedback was not sent: {error}"));
                }
            }
        }
    });
}

struct FeedbackViewCapture {
    path: PathBuf,
}
impl Drop for FeedbackViewCapture {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        if let Some(directory) = self.path.parent() {
            let _ = std::fs::remove_dir(directory);
        }
    }
}
async fn capture_feedback_view(
    directory: &Path,
    binding: &WorkerRef,
) -> Result<FeedbackViewCapture> {
    use std::io::Write;
    use std::os::unix::fs::DirBuilderExt;
    let html = RexClient::new(None)
        .capture_terminal(
            &SessionId::parse(&binding.session_id)?,
            &BlockId::parse(&binding.block_id)?,
        )
        .await?;
    let folder = directory
        .join("feedback-views")
        .join(uuid::Uuid::new_v4().to_string());
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&folder)?;
    let capture = FeedbackViewCapture {
        path: folder.join("terminal-view.html"),
    };
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&capture.path)?;
    file.write_all(html.as_bytes())?;
    file.sync_all()?;
    Ok(capture)
}
fn write_feedback_submission(
    directory: &Path,
    id: uuid::Uuid,
    command: &RuntimeCommand,
) -> Result<()> {
    use std::{io::Write, os::unix::fs::DirBuilderExt};
    let folder = directory.join("feedback-outbox");
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&folder)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(folder.join(format!("{id}.json")))?;
    file.write_all(&serde_json::to_vec(command)?)?;
    file.sync_all()?;
    Ok(())
}
fn read_feedback_submission(directory: &Path, id: uuid::Uuid) -> Result<RuntimeCommand> {
    ensure!(!id.is_nil(), "Invalid feedback input ID");
    let command: RuntimeCommand = serde_json::from_slice(&std::fs::read(
        directory.join("feedback-outbox").join(format!("{id}.json")),
    )?)?;
    ensure!(
        matches!(&command,RuntimeCommand::Feedback {input_id:Some(saved),..} if saved==&id.to_string()),
        "The retained report does not match this feedback input ID"
    );
    Ok(command)
}
fn acknowledge_feedback_submission(directory: &Path, id: &str) {
    if let Ok(id) = uuid::Uuid::parse_str(id) {
        let _ = std::fs::remove_file(directory.join("feedback-outbox").join(format!("{id}.json")));
    }
}
fn acknowledge_feedback_event(
    directory: &Path,
    command: &RuntimeCommand,
    event: &RuntimeEventKind,
) -> Result<()> {
    if let (
        RuntimeCommand::Feedback {
            input_id: Some(expected),
            ..
        },
        RuntimeEventKind::FeedbackReady { input_id, .. },
    ) = (command, event)
    {
        ensure!(
            input_id.as_ref() == Some(expected),
            "Feedback receipt does not match the submitted report"
        );
        acknowledge_feedback_submission(directory, expected);
    }
    Ok(())
}

async fn finish_controls(admissions: &mut tokio::task::JoinSet<()>) {
    // Wait for local settings or feedback admission, never for background repair.
    while let Some(result) = admissions.join_next().await {
        if let Err(error) = result {
            eprintln!("A local chat command stopped unexpectedly: {error}");
        }
    }
}

async fn conversation_settings(
    config: &ClientConfig,
    coordinator: Option<&str>,
    script: &Path,
    directory: &Path,
    target: Option<(TaskId, Option<String>)>,
    change: Option<ConversationChange>,
    catalog: bool,
) -> Result<ConversationSettings> {
    let (task_id, agent_id) = target.map_or((None, None), |(task, agent)| (Some(task), agent));
    exchange(
        config,
        coordinator,
        script,
        directory,
        RuntimeCommand::ConversationSettings {
            task_id,
            agent_id,
            conversation_id: None,
            change,
            catalog,
        },
    )
    .await?
    .into_iter()
    .find_map(|event| match event {
        RuntimeEventKind::ConversationSettings { settings } => Some(settings),
        _ => None,
    })
    .context("The coordinator returned no conversation settings")
}

fn settings_text(
    command: &ChatCommand,
    settings: &ConversationSettings,
    info: &TuiInfo,
    coordinator: Option<&str>,
) -> String {
    let model = &settings.model;
    let selected = format!(
        "{}/{} · reasoning {} · fast {}",
        model.provider.as_str(),
        model.model_id,
        model.reasoning.map_or("default", Reasoning::as_str),
        if model.fast { "on" } else { "off" }
    );
    match command {
        ChatCommand::Model { model: None } => {
            let models = settings
                .catalog
                .iter()
                .filter(|option| option.provider == model.provider)
                .collect::<Vec<_>>();
            let mut text = format!("{selected}\n\nModels for {}:", model.provider.as_str());
            for option in models.iter().take(12) {
                text.push_str(&format!(
                    "\n  {}{}",
                    option.model_id,
                    if option.model_id == model.model_id {
                        " (selected)"
                    } else {
                        ""
                    }
                ));
            }
            if models.len() > 12 {
                text.push_str(&format!("\n  … {} more in Pi's catalog", models.len() - 12));
            }
            text.push_str("\nChoose with /model [provider/]model.");
            text
        }
        ChatCommand::Status => format!(
            "{}\n{selected}\n{}\nCoordinator: {}",
            info.title,
            info.cwd,
            coordinator.unwrap_or("local")
        ),
        ChatCommand::Fast { .. } => format!("Fast mode {}.", if model.fast { "on" } else { "off" }),
        ChatCommand::Reasoning { .. } => format!(
            "Reasoning: {}.",
            model.reasoning.map_or("default", Reasoning::as_str)
        ),
        _ => format!("Next generation: {selected}"),
    }
}

async fn local_settings(
    config: &ClientConfig,
    coordinator: Option<&str>,
    script: &Path,
    directory: &Path,
    command: &ChatCommand,
    target: Option<(TaskId, Option<String>)>,
) -> Result<ConversationSettings> {
    let request = command
        .settings(target)
        .context("This command does not change conversation settings")?;
    exchange(config, coordinator, script, directory, request)
        .await?
        .into_iter()
        .find_map(|event| match event {
            RuntimeEventKind::ConversationSettings { settings } => Some(settings),
            _ => None,
        })
        .context("The coordinator returned no conversation settings")
}

async fn conversation_usage(
    client: ClientContext<'_>,
    provider: ModelProvider,
) -> usage::UsageAvailability {
    exchange(
        client.config,
        client.coordinator,
        client.script,
        client.directory,
        RuntimeCommand::Usage { provider },
    )
    .await
    .ok()
    .and_then(|events| {
        events.into_iter().find_map(|event| match event {
            RuntimeEventKind::Usage { usage } => Some(usage),
            _ => None,
        })
    })
    .unwrap_or(usage::UsageAvailability::Unavailable {
        reason: usage::UsageUnavailable::ReadFailed,
    })
}

fn local_command_from_ui(
    config: &ClientConfig,
    coordinator: Option<&str>,
    script: &Path,
    directory: &Path,
    ui: &mut UiSession,
    target: Option<(TaskId, Option<String>)>,
    command: ChatCommand,
) {
    let config = config.clone();
    let coordinator = coordinator.map(str::to_owned);
    let script = script.to_owned();
    let directory = directory.to_owned();
    let handle = ui.handle.clone();
    let selected = ui
        .selected
        .as_ref()
        .map(|item| item.conversation_id.clone());
    while ui.controls.try_join_next().is_some() {}
    ui.controls.spawn(async move {
        let changed = async {
            if let Some(request) = command.request() {
                let events = exchange(
                    &config,
                    coordinator.as_deref(),
                    &script,
                    &directory,
                    request,
                )
                .await?;
                for event in events {
                    let text = match &event {
                        RuntimeEventKind::Resources { resources } => {
                            Some(agent_cli::resources::format_inventory(resources))
                        }
                        _ => agent_cli::job_view::event(&event),
                    };
                    if let Some(text) = text {
                        handle.notice(text)?;
                    }
                }
                return Ok(());
            }
            if matches!(command, ChatCommand::Machines) {
                let inventory = machine_inventory(ClientContext {
                    config: &config,
                    coordinator: coordinator.as_deref(),
                    script: &script,
                    directory: &directory,
                })
                .await?;
                return handle.notice(inventory.format(SystemTime::now()));
            }
            let info = handle.info().await?;
            let settings = if let Some(conversation_id) = selected {
                let mut request = command
                    .settings(target)
                    .context("This command does not change conversation settings")?;
                if let RuntimeCommand::ConversationSettings {
                    conversation_id: selected,
                    ..
                } = &mut request
                {
                    *selected = Some(conversation_id);
                }
                exchange(
                    &config,
                    coordinator.as_deref(),
                    &script,
                    &directory,
                    request,
                )
                .await?
                .into_iter()
                .find_map(|event| match event {
                    RuntimeEventKind::ConversationSettings { settings } => Some(settings),
                    _ => None,
                })
                .context("The coordinator returned no conversation settings")?
            } else {
                local_settings(
                    &config,
                    coordinator.as_deref(),
                    &script,
                    &directory,
                    &command,
                    target,
                )
                .await?
            };
            let mut text = settings_text(&command, &settings, &info, coordinator.as_deref());
            let provider = settings.model.provider;
            handle.event(RuntimeEventKind::ConversationSettings { settings })?;
            if matches!(command, ChatCommand::Status) {
                let usage = conversation_usage(
                    ClientContext {
                        config: &config,
                        coordinator: coordinator.as_deref(),
                        script: &script,
                        directory: &directory,
                    },
                    provider,
                )
                .await;
                text.push_str("\n\n");
                text.push_str(&usage::format_status(&usage, SystemTime::now()));
            }
            handle.notice(text)
        }
        .await;
        if let Err(error) = changed {
            let _ = handle.notice(format!("Local command failed: {error}"));
        }
    });
}

#[derive(Clone, Copy)]
struct ClientContext<'a> {
    config: &'a ClientConfig,
    coordinator: Option<&'a str>,
    script: &'a Path,
    directory: &'a Path,
}

async fn prepare_attachments(client: ClientContext<'_>, input: &mut ComposerInput) -> Result<()> {
    use agent_cli::attachments::{MAX_ATTACHMENTS, upload_file};
    ensure!(
        input.attachment_count() <= MAX_ATTACHMENTS,
        "Attach at most 8 files"
    );
    if input.files.is_empty() {
        return Ok(());
    }
    let Wire {
        reader,
        writer,
        child,
    } = connection(
        client.config,
        client.coordinator,
        client.script,
        client.directory,
        false,
    )
    .await?;
    // The upload callback owns this one connection across chunks, including
    // its buffered reader and any local relay child.
    let transfer = Arc::new(tokio::sync::Mutex::new((
        FrameReader::new(BufReader::new(reader)),
        writer,
        child,
    )));
    while let Some(file) = input.files.first().cloned() {
        let attachment = upload_file(&file.path, |request| {
            let transfer = transfer.clone();
            async move {
                let mut owned = transfer.lock().await;
                let (reader, writer, _child) = &mut *owned;
                write_command(&mut **writer, &RuntimeCommand::Attachment { request }).await?;
                timeout(Duration::from_secs(30), async {
                    let mut response = None;
                    loop {
                        let frame = reader
                            .next_frame()
                            .await?
                            .context("Coordinator disconnected during attachment upload")?;
                        match decode_coordinator_event(&frame)? {
                            RuntimeEventKind::Attachment { response: value }
                                if response.is_none() =>
                            {
                                response = Some(value)
                            }
                            RuntimeEventKind::Done => {
                                return response.context("Attachment upload returned no receipt");
                            }
                            RuntimeEventKind::Failure { message, .. } => {
                                bail!("Attachment could not be uploaded: {message}")
                            }
                            _ => {
                                bail!("The coordinator returned an unexpected attachment response")
                            }
                        }
                    }
                })
                .await
                .context("Attachment upload timed out")?
            }
        })
        .await?;
        input.attachments.push(attachment);
        input.files.remove(0);
    }
    Ok(())
}

async fn machine_inventory(
    client: ClientContext<'_>,
) -> Result<agent_cli::machines::MachineInventory> {
    exchange(
        client.config,
        client.coordinator,
        client.script,
        client.directory,
        RuntimeCommand::Environment { telemetry: true },
    )
    .await?
    .into_iter()
    .find_map(|event| match event {
        RuntimeEventKind::Environment {
            nodes,
            online_host_ids,
            unavailable_host_ids,
            ..
        } => Some(agent_cli::machines::MachineInventory {
            nodes,
            online_host_ids,
            unavailable_host_ids: unavailable_host_ids.unwrap_or_default(),
        }),
        _ => None,
    })
    .context("The coordinator returned no machine inventory")
}

async fn local_command_plain(
    client: ClientContext<'_>,
    command: &ChatCommand,
    target: Option<(TaskId, Option<String>)>,
    cwd: &Path,
    json: bool,
) -> Result<()> {
    if let ChatCommand::Resume { query } = command {
        let items = chat_view::choices(client, query.join(" ")).await?;
        if json {
            display(
                &RuntimeEventKind::Conversations {
                    items,
                    next_cursor: None,
                },
                true,
            )?;
        } else {
            for item in items {
                println!("{}  {}", item.conversation_id, item.title);
            }
            println!("Open an interactive agent chat to select a saved conversation.");
        }
        return Ok(());
    }
    if let Some(request) = command.request() {
        for event in exchange(
            client.config,
            client.coordinator,
            client.script,
            client.directory,
            request,
        )
        .await?
        {
            display(&event, json)?;
        }
        return Ok(());
    }
    if matches!(command, ChatCommand::Machines) {
        let inventory = machine_inventory(client).await?;
        if json {
            println!("{}", serde_json::to_string(&inventory)?);
        } else {
            println!("{}", inventory.format(SystemTime::now()));
        }
        return Ok(());
    }
    let settings = local_settings(
        client.config,
        client.coordinator,
        client.script,
        client.directory,
        command,
        target,
    )
    .await?;
    let quota = if matches!(command, ChatCommand::Status) {
        Some(
            conversation_usage(
                ClientContext {
                    config: client.config,
                    coordinator: client.coordinator,
                    script: client.script,
                    directory: client.directory,
                },
                settings.model.provider,
            )
            .await,
        )
    } else {
        None
    };
    if json {
        display(&RuntimeEventKind::ConversationSettings { settings }, true)?;
        if let Some(usage) = quota {
            display(&RuntimeEventKind::Usage { usage }, true)?;
        }
    } else {
        let mut text = settings_text(
            command,
            &settings,
            &TuiInfo {
                title: "Agent".into(),
                model: Some(settings.model.clone()),
                cwd: cwd.to_string_lossy().into_owned(),
            },
            client.coordinator,
        );
        if let Some(usage) = quota {
            text.push_str("\n\n");
            text.push_str(&usage::format_status(&usage, SystemTime::now()));
        }
        println!("{text}");
    }
    Ok(())
}
struct Presentation<'a> {
    handle: TuiHandle,
    session: Option<&'a mut UiSession>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PlainNoticeRoute {
    Direct,
    Watch,
}

async fn chat_tui(
    _arguments: &Arguments,
    config: &ClientConfig,
    coordinator: Option<&str>,
    script: &Path,
    directory: &Path,
    cwd: &Path,
    start: ChatStart,
) -> Result<()> {
    let client = ClientContext {
        config,
        coordinator,
        script,
        directory,
    };
    let resuming = start.prompt.as_ref().is_some_and(|prompt| {
        matches!(
            ChatCommand::parse(prompt),
            Some(Ok(ChatCommand::Resume { .. }))
        )
    });
    let resumed_model = if resuming { start.model.clone() } else { None };
    let mut initial_prompt = start.prompt;
    let (handle, inputs, guard) =
        Tui::connecting("Main agent".into(), cwd.to_string_lossy().into_owned())?;
    handle.observation(agent_cli::tui::ObservationState::Connecting)?;
    let mut ui = UiSession::new(handle, inputs);
    let mut startup_inputs = VecDeque::new();
    let result = async {
        let request = conversation_settings(
            config,
            coordinator,
            script,
            directory,
            None,
            if resuming {
                None
            } else {
                start
                    .model
                    .map(|model| ConversationChange::SetSelection { model })
            },
            false,
        );
        tokio::pin!(request);
        let settings = loop {
            tokio::select! {
                result = &mut request => break result.context("Could not load the main conversation settings")?,
                input = ui.next() => match input.unwrap_or(TuiInput::Exit) {
                    TuiInput::Exit => { ui.exiting = true; return Ok(()); }
                    input => startup_inputs.push_back(input),
                }
            }
        };
        let chief = SavedConversation {
            conversation_id: settings.conversation_id.clone(),
            title: "Main agent".into(),
            updated_at: None,
            task_id: None,
            agent_id: None,
            host: None,
            source_thread_id: None,
        };
        ui.handle
            .event(RuntimeEventKind::ConversationSettings { settings })?;
        chat_view::open(client, &mut ui, chief).await?;
        if let Some(prompt) = initial_prompt.clone() {
            if let Some(Ok(ChatCommand::Resume { query })) = ChatCommand::parse(&prompt) {
                if chat_view::resume(client, &mut ui, query.join(" ")).await?
                    && let Some(model) = resumed_model
                    && let Some(selected) = &ui.selected
                {
                    for event in exchange(
                        config,
                        coordinator,
                        script,
                        directory,
                        RuntimeCommand::ConversationSettings {
                            task_id: selected.task_id.clone(),
                            agent_id: selected.agent_id.clone(),
                            conversation_id: Some(selected.conversation_id.clone()),
                            change: Some(ConversationChange::SetSelection { model }),
                            catalog: false,
                        },
                    )
                    .await?
                    {
                        ui.handle.event(event)?;
                    }
                }
            } else {
                selected_input(client, &mut ui, prompt.into(), InputMode::Steer, cwd.to_owned())?;
            }
            initial_prompt = None;
        }
        while !ui.exiting {
            let input = match startup_inputs.pop_front() {
                Some(input) => input,
                None => ui.next().await.unwrap_or(TuiInput::Exit),
            };
            match input {
                TuiInput::Submit(text) => {
                    selected_input(client, &mut ui, text, InputMode::Steer, cwd.to_owned())?
                }
                TuiInput::Queue(text) => {
                    selected_input(client, &mut ui, text, InputMode::FollowUp, cwd.to_owned())?
                }
                TuiInput::Command(ChatCommand::Resume { query }) => {
                    if let Err(error) = chat_view::resume(client, &mut ui, query.join(" ")).await {
                        ui.handle.notice(error.to_string())?;
                    }
                }
                TuiInput::Command(command) => {
                    let target = ui.selected.as_ref().and_then(|item| {
                        item.task_id.clone().map(|id| (id, item.agent_id.clone()))
                    });
                    local_command_from_ui(
                        config,
                        coordinator,
                        script,
                        directory,
                        &mut ui,
                        target,
                        command,
                    );
                }
                TuiInput::Feedback(description) => {
                    let target = ui.selected.as_ref().and_then(|item| {
                        item.task_id.clone().map(|id| (id, item.agent_id.clone()))
                    });
                    feedback_from_ui(
                        config,
                        coordinator,
                        script,
                        directory,
                        &mut ui,
                        target,
                        description,
                    );
                }
                TuiInput::Interrupt => selected_interrupt(client, &mut ui).await?,
                TuiInput::ToolDetails(request) => tool_details_from_ui(client, &mut ui, None, request),
                TuiInput::History => {} // All native pages are already being replayed in the background.
                TuiInput::Exit => {
                    ui.finish_admissions().await?;
                    ui.exiting = true;
                }
            }
        }
        Ok(())
    }
    .await;
    // Before a conversation is selected, these inputs have no native admission.
    // Retain them locally on exit or a failed connection, without replaying them.
    if ui.selected.is_none() {
        while let Ok(input) = ui.inputs.try_recv() {
            startup_inputs.push_back(input);
        }
    }
    let queued_inputs = initial_prompt
        .into_iter()
        .map(|text| QueuedInput {
            id: uuid::Uuid::new_v4().to_string(),
            input: text.into(),
            mode: InputMode::Steer,
        })
        .chain(startup_inputs.iter().filter_map(|input| match input {
            TuiInput::Submit(input) => Some(QueuedInput {
                id: uuid::Uuid::new_v4().to_string(),
                input: input.clone(),
                mode: InputMode::Steer,
            }),
            TuiInput::Queue(input) => Some(QueuedInput {
                id: uuid::Uuid::new_v4().to_string(),
                input: input.clone(),
                mode: InputMode::FollowUp,
            }),
            _ => None,
        }))
        .collect::<Vec<_>>();
    let recovery = if ui.selected.is_none() || !queued_inputs.is_empty() {
        Some(
            async {
                let draft = ui.handle.composer_draft().await?;
                if draft.is_empty() && queued_inputs.is_empty() {
                    return Ok(None);
                }
                write_ui_recovery(
                    directory,
                    &UiRecovery {
                        owner: UiRecoveryOwner::Main,
                        draft,
                        queued_inputs,
                    },
                )
                .map(Some)
            }
            .await,
        )
    } else {
        None
    };
    let observed_recovery = preserve_observed_recovery(directory, &ui).await;
    ui.close_view().await;
    finish_controls(&mut ui.controls).await;
    let stopped = guard.stop().await;
    let retained = match recovery {
        Some(Ok(Some(path))) => {
            eprintln!(
                "Unsent input saved privately to {}. It will not be replayed automatically.",
                path.display()
            );
            Ok(())
        }
        Some(Err(error)) => Err(error),
        _ => Ok(()),
    };
    if let Ok(paths) = &observed_recovery {
        for path in paths {
            eprintln!(
                "Pending input saved privately to {}. It will not be replayed automatically.",
                path.display()
            );
        }
    }
    result
        .and(stopped)
        .and(retained)
        .and(observed_recovery.map(|_| ()))
}

// A detail read owns one cancellable action connection. It never enters the
// model-input/admission path and its UI identity rejects late view results.
fn tool_details_from_ui(
    client: ClientContext<'_>,
    ui: &mut UiSession,
    fallback: Option<(agent_cli::protocol::TaskId, Option<String>)>,
    request: Option<agent_cli::tui::activity::ToolDetailRequest>,
) {
    if let Some(previous) = ui.tool_lookup.take() {
        previous.abort();
    }
    let Some(request) = request else {
        return;
    };
    let target = ui.selected.as_ref().map_or(fallback, |selected| {
        selected
            .task_id
            .clone()
            .map(|task| (task, selected.agent_id.clone()))
    });
    let config = client.config.clone();
    let coordinator = client.coordinator.map(str::to_owned);
    let script = client.script.to_owned();
    let directory = client.directory.to_owned();
    let handle = ui.handle.clone();
    while ui.controls.try_join_next().is_some() {}
    ui.tool_lookup = Some(ui.controls.spawn(async move {
        let details = read_tool_details(
            ClientContext {
                config: &config,
                coordinator: coordinator.as_deref(),
                script: &script,
                directory: &directory,
            },
            &request,
            target,
        )
        .await
        .map_err(|error| error.to_string());
        let _ = handle.tool_details(request, details);
    }));
}

async fn read_tool_details(
    client: ClientContext<'_>,
    request: &agent_cli::tui::activity::ToolDetailRequest,
    target: Option<(agent_cli::protocol::TaskId, Option<String>)>,
) -> Result<agent_cli::native::ToolDetails> {
    let (task_id, agent_id) = target.map_or((None, None), |(task, agent)| (Some(task), agent));
    let events = tokio::time::timeout(
        Duration::from_secs(30),
        exchange(
            client.config,
            client.coordinator,
            client.script,
            client.directory,
            request.command(task_id, agent_id),
        ),
    )
    .await
    .context("Tool details timed out; expand the tool to retry.")??;
    events
        .into_iter()
        .find_map(|event| match event {
            RuntimeEventKind::ToolDetails { details } => Some(details),
            _ => None,
        })
        .context("The coordinator returned no tool details.")
}

async fn exchange(
    config: &ClientConfig,
    coordinator: Option<&str>,
    script: &Path,
    directory: &Path,
    command: RuntimeCommand,
) -> Result<Vec<RuntimeEventKind>> {
    let feedback = matches!(&command, RuntimeCommand::Feedback { .. });
    let mut wire = connection(config, coordinator, script, directory, false)
        .await
        .map_err(chat_view::ViewError::transport)?;
    write_command(&mut *wire.writer, &command)
        .await
        .map_err(chat_view::ViewError::read)?;
    let mut reader = FrameReader::new(BufReader::new(wire.reader));
    let mut events = Vec::new();
    loop {
        let frame = reader
            .next_frame()
            .await
            .map_err(chat_view::ViewError::read)?
            .ok_or_else(|| {
                chat_view::ViewError::transport(anyhow::anyhow!("Coordinator disconnected"))
            })?;
        let event = decode_coordinator_event(&frame)?;
        acknowledge_feedback_event(directory, &command, &event)?;
        match event {
            event @ RuntimeEventKind::FeedbackReady { .. } if feedback => {
                events.push(event);
                return Ok(events);
            }
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
        RuntimeCommand::Environment { telemetry: false },
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

fn service_notice(message: impl std::fmt::Display) {
    let timestamp = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    eprintln!("[{timestamp}] {message}");
}

async fn configure_messages(sources: &[agent_cli::sources::SourceConfig]) {
    if sources.iter().any(|source| {
        matches!(
            source,
            agent_cli::sources::SourceConfig::Messages { enabled: true, .. }
        )
    }) && let Err(error) = agent_cli::rex::install::install(agent_cli::rex::source::MODULE).await
    {
        service_notice(format_args!("Messages Rex setup is unavailable: {error}"));
    }
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
    let daemon = agent_cli::tailnet::Daemon::new(config.tailscale_socket.as_deref())?;
    let executor = Arc::new(
        host::Executor::with_tailscale(directory, daemon.clone())
            .with_browser(script, config.browser.clone()),
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
                &daemon,
            )
            .await?;
            let settings = environment(config, coordinator, script, directory).await?;
            configure_messages(&settings.sources).await;
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
                    decode_coordinator_event(&frame)?,
                    RuntimeEventKind::WorkerReady { .. }
                ),
                "Coordinator did not accept this worker"
            );
            delay = 1;
            service_notice(format_args!("Worker connected as {}.", node.name));
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
                        service_notice(
                            "Worker cleanup could not complete; saved ownership is retained.",
                        );
                    }
                    sleep(Duration::from_secs(interval.into())).await;
                }
            }));
            let mut effects = tokio::task::JoinSet::new();
            let mut cancellations: HashMap<String, tokio::sync::watch::Sender<bool>> =
                HashMap::new();
            loop {
                tokio::select! {
                    completed = effects.join_next(), if !effects.is_empty() => {
                        let (call_id,result) = completed.context("Worker effect queue closed")??;
                        cancellations.remove(&call_id);
                        write_command(&mut *wire.writer, &RuntimeCommand::HostReply {call_id,result}).await?;
                    }
                    frame = reader.next_frame() => {
                        let frame = frame?.context("Coordinator closed the worker connection")?;
                        let event = decode_coordinator_event(&frame)?;
                        if let RuntimeEventKind::HostCancel { call_id } = &event {
                            if let Some(cancel) = cancellations.get(call_id) { let _ = cancel.send(true); }
                            continue;
                        }
                        let RuntimeEventKind::HostCall {call_id,command} = event else { bail!("Unexpected event on the registered worker connection"); };
                        if effects.len() >= 32 {
                            write_command(&mut *wire.writer, &RuntimeCommand::HostReply { call_id, result: agent_cli::protocol::HostResult::Failed { message: "The worker is busy; no command was started".into() } }).await?;
                            continue;
                        }
                        let (cancel, cancelled) = tokio::sync::watch::channel(false);
                        ensure!(cancellations.insert(call_id.clone(), cancel).is_none(), "A host call ID is already running");
                        let executor = executor.clone();
                        effects.spawn(async move { (call_id,executor.execute_cancelled(*command, cancelled).await) });
                    }
                }
            }
            #[allow(unreachable_code)]
            Ok::<(), anyhow::Error>(())
        };
        tokio::select! {
            result = attempt => { if result.is_err() { service_notice(format_args!("Worker connection unavailable; retrying in {delay}s. Saved work is retained.")); } }
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
    if let Some(description) = agent_cli::feedback::command(&input) {
        return Ok(
            feedback_context(cwd.to_string_lossy().into_owned(), model, None)
                .await?
                .command(description.to_owned()),
        );
    }
    Ok(RuntimeCommand::Chat {
        input,
        attachments: None,
        input_id: None,
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
        let policy =
            agent_cli::tailnet::PeerPolicy::new(&config.trusted_nodes, &config.trusted_user_ids)?;
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
) -> Result<Option<String>> {
    request_presented(
        arguments,
        ClientContext {
            config,
            coordinator,
            script,
            directory,
        },
        command,
        None,
        PlainNoticeRoute::Direct,
    )
    .await
}

async fn request_with_ui(
    arguments: &Arguments,
    config: &ClientConfig,
    coordinator: Option<&str>,
    script: &Path,
    directory: &Path,
    command: RuntimeCommand,
    ui: &mut UiSession,
) -> Result<Option<String>> {
    ui.failure_shown = false;
    request_presented(
        arguments,
        ClientContext {
            config,
            coordinator,
            script,
            directory,
        },
        command,
        Some(Presentation {
            handle: ui.handle.clone(),
            session: Some(ui),
        }),
        PlainNoticeRoute::Direct,
    )
    .await
}

async fn request_presented(
    arguments: &Arguments,
    client: ClientContext<'_>,
    command: RuntimeCommand,
    mut presentation: Option<Presentation<'_>>,
    notices: PlainNoticeRoute,
) -> Result<Option<String>> {
    let ClientContext {
        config,
        coordinator,
        script,
        directory,
    } = client;
    let login = matches!(command, RuntimeCommand::Login);
    let attached = matches!(command, RuntimeCommand::RunTask { .. });
    let main_view = matches!(command, RuntimeCommand::AttachMain);
    let chat = matches!(command, RuntimeCommand::Chat { .. }) || main_view;
    let mut active_turn = chat || attached;
    let importing = matches!(command, RuntimeCommand::ImportCodex { .. });
    let mut ui_controls = presentation
        .as_ref()
        .is_some_and(|view| view.session.is_some());
    let mut interactive = matches!(
        command,
        RuntimeCommand::RunTask {
            interactive: Some(true),
            ..
        }
    );
    let history_target = match &command {
        RuntimeCommand::RunTask {
            task_id, agent_id, ..
        } => Some((task_id.clone(), agent_id.clone())),
        _ => None,
    };
    let feedback_settings = match &command {
        RuntimeCommand::RunTask { model, cwd, .. } => Some((Some(model.clone()), cwd.clone())),
        RuntimeCommand::Chat { model, cwd, .. } => Some((model.clone(), cwd.clone())),
        _ => None,
    };
    let mut ready = false;
    let mut history_cursor = None;
    let mut input = BufReader::new(tokio::io::stdin()).lines();
    let mut operations = tokio::task::JoinSet::new();
    let mut feedback = tokio::task::JoinSet::new();
    let mut cancellations: HashMap<String, tokio::sync::watch::Sender<bool>> = HashMap::new();
    let executor = Arc::new(
        host::Executor::with_tailscale(
            directory,
            agent_cli::tailnet::Daemon::new(config.tailscale_socket.as_deref())?,
        )
        .with_browser(script, config.browser.clone()),
    );
    let mut thinking = false;
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
    let result = async {
    write_command(&mut *wire.writer, &command).await?;
    let mut reader = FrameReader::new(BufReader::new(wire.reader));
    let mut failure = None;
    let mut outcome = false;
    let mut progress_key = None;
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
            action = async {
                match presentation.as_mut().and_then(|view| view.session.as_deref_mut()) {
                    Some(ui) => ui.next().await,
                    None => std::future::pending().await,
                }
            }, if ui_controls => {
                let action = action.unwrap_or(TuiInput::Exit);
                let mode = if matches!(action, TuiInput::Queue(_)) { InputMode::FollowUp } else { InputMode::Steer };
                match action {
                    TuiInput::Submit(mut input) | TuiInput::Queue(mut input) => {
                        let ui = presentation.as_mut().and_then(|view| view.session.as_deref_mut()).context("Missing terminal input owner")?;
                        if ui.selected.is_some() {
                            let cwd=feedback_settings.as_ref().map(|(_,cwd)|PathBuf::from(cwd)).unwrap_or(env::current_dir()?);
                            selected_input(ClientContext{config,coordinator,script,directory},ui,input,mode,cwd)?;
                        } else {
                            if let Err(error) = prepare_attachments(ClientContext{config,coordinator,script,directory}, &mut input).await {
                                ui.handle.restore_composer(input)?;
                                ui.handle.notice(format!("Nothing was sent: {error}"))?;
                                continue;
                            }
                            if (chat && (!main_view || ready)) || (attached && ready) {
                                active_turn = true;
                                let input_id = uuid::Uuid::new_v4().to_string();
                                ui.handle.pending_composer(input_id.clone(), &input, mode)?;
                                ui.submitted.push_back(QueuedInput {id:input_id.clone(), input:input.clone(), mode});
                                write_command(&mut *wire.writer, &RuntimeCommand::SubmitInput { input_id, input: input.text, attachments: (!input.attachments.is_empty()).then_some(input.attachments), mode }).await?;
                            } else { ui.enqueue(input, mode)?; }
                        }
                    }
                    TuiInput::Feedback(description) => {
                        if let Some(ui) = presentation.as_mut().and_then(|view| view.session.as_deref_mut()) {
                            let target=ui.selected.as_ref().map_or_else(||history_target.clone(),|item|item.task_id.clone().map(|id|(id,item.agent_id.clone())));
                            feedback_from_ui(config, coordinator, script, directory, ui, target, description);
                        }
                    }
                    TuiInput::Command(command) => {
                        if let Some(ui) = presentation.as_mut().and_then(|view| view.session.as_deref_mut()) {
                            if let ChatCommand::Resume{query}=command {
                                if let Err(error)=chat_view::resume(ClientContext{config,coordinator,script,directory},ui,query.join(" ")).await {ui.handle.notice(error.to_string())?;}
                            } else {
                                let target=ui.selected.as_ref().map_or_else(||history_target.clone(),|item|item.task_id.clone().map(|id|(id,item.agent_id.clone())));
                                local_command_from_ui(config, coordinator, script, directory, ui, target, command);
                            }
                        }
                    }
                    TuiInput::Interrupt => {
                        if let Some(ui)=presentation.as_mut().and_then(|view|view.session.as_deref_mut()).filter(|ui|ui.selected.is_some()) {
                            selected_interrupt(ClientContext{config,coordinator,script,directory},ui).await?;
                        } else if active_turn { write_command(&mut *wire.writer, &RuntimeCommand::Interrupt).await?; }
                        else if let Some(view) = &presentation { view.handle.working(false)?; }
                    }
                    TuiInput::ToolDetails(request) => {
                        if let Some(ui) = presentation.as_mut().and_then(|view| view.session.as_deref_mut()) {
                            tool_details_from_ui(ClientContext { config, coordinator, script, directory }, ui, history_target.clone(), request);
                        }
                    }
                    TuiInput::History => {
                        if presentation.as_ref().and_then(|view|view.session.as_ref()).is_some_and(|ui|ui.selected.is_some()) {continue;}
                        let view = presentation.as_mut().context("Missing terminal presentation")?;
                        let cursor = if attached { history_cursor.take() } else { view.session.as_mut().and_then(|ui| ui.history_cursor.take()) };
                        if let Some(cursor) = cursor {
                            let (task_id, agent_id) = history_target.clone().map_or((None, None), |(task, agent)| (Some(task), agent));
                            let next = Box::pin(request_presented(arguments, ClientContext { config, coordinator, script, directory },
                                RuntimeCommand::ReadHistory { task_id, agent_id, cursor: Some(cursor) },
                                Some(Presentation { handle: view.handle.clone(), session: None }), PlainNoticeRoute::Direct)).await?;
                            if attached { history_cursor = next; } else if let Some(ui) = view.session.as_mut() { ui.history_cursor = next; }
                        } else { view.handle.event(RuntimeEventKind::Notice { task_id: None, text: "No older history.".into() })?; }
                    }
                    TuiInput::Exit => {
                        if let Some(ui) = presentation.as_mut().and_then(|view| view.session.as_deref_mut()) {
                            ui.finish_admissions().await?;
                            ui.exiting = true;
                        }
                        if chat { return Ok(history_cursor); }
                        if active_turn { write_command(&mut *wire.writer, &RuntimeCommand::Interrupt).await?; }
                        if attached { write_command(&mut *wire.writer, &RuntimeCommand::DetachWorker).await?; }
                        ui_controls = false;
                    }
                }
                continue;
            }
            line = input.next_line(), if interactive && ready && presentation.is_none() => {
                let line = line?;
                if line.as_deref().is_none_or(|line| line.trim() == "/exit") {
                    write_command(&mut *wire.writer, &RuntimeCommand::DetachWorker).await?;
                    interactive = false;
                } else if let Some(line) = line {
                    if let Some(command) = ChatCommand::parse(&line) {
                        match command {
                            Err(error) => { eprintln!("{error}"); continue; }
                            Ok(ChatCommand::Help) => { println!("{}", agent_cli::tui::help_text()); continue; }
                            Ok(ChatCommand::Exit) => {
                                write_command(&mut *wire.writer, &RuntimeCommand::DetachWorker).await?;
                                interactive = false;
                                continue;
                            }
                            Ok(ChatCommand::History | ChatCommand::Feedback { .. }) => {}
                            Ok(command) => {
                                let cwd = feedback_settings.as_ref().map(|(_, cwd)| Path::new(cwd)).unwrap_or_else(|| Path::new("."));
                                if let Err(error) = local_command_plain(ClientContext { config, coordinator, script, directory }, &command, history_target.clone(), cwd, arguments.json).await { eprintln!("Local command failed: {error}"); }
                                continue;
                            }
                        }
                    }
                    if line.trim() == "/history" {
                        if let Some((task_id, agent_id)) = &history_target {
                            if history_cursor.is_none() {
                                if !arguments.json { println!("No older history."); }
                            } else {
                                history_cursor = Box::pin(request(arguments, config, coordinator, script, directory,
                                    RuntimeCommand::ReadHistory { task_id: Some(task_id.clone()), agent_id: agent_id.clone(), cursor: history_cursor })).await?;
                            }
                        }
                    } else if let Some(description) = agent_cli::feedback::command(&line) {
                        if let Some((model, cwd)) = &feedback_settings {
                            let config = config.clone(); let coordinator = coordinator.map(str::to_owned);
                            let script = script.to_owned(); let directory = directory.to_owned();
                            let cwd = cwd.clone(); let model = model.clone(); let target = history_target.clone();
                            let description = description.to_owned(); let json = arguments.json;
                            while feedback.try_join_next().is_some() {}
                            feedback.spawn(async move {
                            let captured = async {
                                let context = feedback_context(cwd, model, target).await?;
                                exchange(&config, coordinator.as_deref(), &script, &directory, context.command(description)).await
                            }.await;
                            match captured {
                                Ok(events) => for event in events { if let Err(error) = display(&event, json) { eprintln!("Feedback receipt could not be displayed: {error}"); } },
                                Err(error) => eprintln!("Feedback could not start: {error}"),
                            }
                            });
                        }
                    } else if !line.trim().is_empty() {
                        write_command(&mut *wire.writer, &RuntimeCommand::SubmitInput {
                            input_id: uuid::Uuid::new_v4().to_string(), input: line, attachments:None, mode: InputMode::Steer,
                        }).await?;
                    }
                }
                continue;
            }
            signal = tokio::signal::ctrl_c(), if interactive && presentation.is_none() => {
                signal?;
                write_command(&mut *wire.writer, &RuntimeCommand::DetachWorker).await?;
                interactive = false;
                continue;
            }
            completed = operations.join_next(), if !operations.is_empty() => {
                if let Some(completed) = completed {
                    let (call_id, result) = completed.context("Host execution task stopped")?;
                    cancellations.remove(&call_id);
                    write_command(&mut *wire.writer, &RuntimeCommand::HostReply { call_id, result }).await?;
                }
                continue;
            }
        };
        let event = decode_coordinator_event(&frame)?;
        acknowledge_feedback_event(directory, &command, &event)?;
        if let Some(ui) = presentation
            .as_mut()
            .and_then(|view| view.session.as_deref_mut()).filter(|ui|ui.selected.is_none())
        {
            match &event {
                RuntimeEventKind::InputRejected { input_id, .. } => {
                    if let Some(index) = ui.submitted.iter().position(|input| &input.id == input_id)
                        && let Some(input) = ui.submitted.remove(index)
                    {
                        ui.handle.restore_composer(input.input)?;
                    }
                }
                RuntimeEventKind::InputPlaced { input_id, .. } => {
                    ui.placed_input(input_id);
                }
                RuntimeEventKind::Failure { message, .. } => {
                    if ui.errors.len() == 8 {
                        ui.errors.pop_front();
                    }
                    ui.errors.push_back(message.clone());
                }
                RuntimeEventKind::TaskReady {
                    conversation_id, ..
                }
                | RuntimeEventKind::MainReady { conversation_id, .. }
                | RuntimeEventKind::Answer {
                    conversation_id, ..
                } => ui.conversation_id = Some(conversation_id.clone()),
                _ => {}
            }
        }
        match &event {
            RuntimeEventKind::MainReady { .. }
            | RuntimeEventKind::Activity { .. }
            | RuntimeEventKind::Message {
                message:
                    agent_cli::protocol::HistoryMessage {
                        role: agent_cli::protocol::HistoryRole::User,
                        ..
                    },
            } => active_turn = true,
            RuntimeEventKind::Answer { .. }
            | RuntimeEventKind::Interrupted
            | RuntimeEventKind::WorkerIdle => active_turn = false,
            _ => {}
        }
        let replayed = if let Some(ui)=presentation.as_mut().and_then(|view|view.session.as_deref_mut()).filter(|ui|ui.selected.is_none()) {
            if let RuntimeEventKind::History{conversation_id,next_cursor,page_complete,..}=&event {
                if ui.initial_replay.is_some() {
                    ui.initial_history.push(event.clone());
                    if *page_complete && let Some(replay)=ui.initial_replay.take() {
                        replay.page(std::mem::take(&mut ui.initial_history))?;
                        if let Some(cursor)=next_cursor {
                            ui.history=Some(chat_history::Job::start(ClientContext{config,coordinator,script,directory},conversation_id.clone(),chat_history::Start::Older(cursor.clone()),replay));
                        }else{replay.finish()?;}
                    }
                    true
                }else{false}
            }else{false}
        }else{false};
        // Worker results render through their canonical messages and final answer.
        // Anonymous execution notices must not repeat that result in the same view.
        if let Some(view) = &presentation
            && view.session.as_ref().is_none_or(|ui|ui.selected.is_none())
            && !replayed
            && !matches!(event, RuntimeEventKind::Notice { .. })
        {
            view.handle.event(event.clone())?;
        }
        match event {
            RuntimeEventKind::HostCall { call_id, command } => {
                ensure!(
                    attached,
                    "Only an attached task worker may execute coordinator host calls"
                );
                let executor = executor.clone();
                let (cancel, cancelled) = tokio::sync::watch::channel(false);
                ensure!(
                    cancellations.insert(call_id.clone(), cancel).is_none(),
                    "A host call ID is already running"
                );
                operations.spawn(async move {
                    (
                        call_id,
                        executor.execute_cancelled(*command, cancelled).await,
                    )
                });
            }
            RuntimeEventKind::HostCancel { call_id } => {
                if let Some(cancel) = cancellations.get(&call_id) {
                    let _ = cancel.send(true);
                }
            }
            RuntimeEventKind::Interrupted => {
                outcome = true;
                if presentation.is_none() {
                    display(&RuntimeEventKind::Interrupted, arguments.json)?;
                }
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
                if let Some(ui) = presentation
                    .as_mut()
                    .and_then(|view| view.session.as_deref_mut())
                {
                    ui.failure_shown = true;
                }
                failure = Some(message);
            }
            RuntimeEventKind::Done => {
                if chat && let Some(view) = &presentation && view.session.as_ref().is_none_or(|ui|ui.selected.is_none()) { view.handle.working(false)?; }
                break;
            }
            RuntimeEventKind::MainReady { .. } => {
                ready = true;
                if let Some(ui) = presentation.as_mut().and_then(|view| view.session.as_deref_mut()) {
                    while let Some(input) = ui.queued.pop_front() {
                        let input_id = input.id.clone();
                        ui.submitted.push_back(input.clone());
                        write_command(&mut *wire.writer, &RuntimeCommand::SubmitInput { input_id, input: input.input.text, attachments: (!input.input.attachments.is_empty()).then_some(input.input.attachments), mode: input.mode }).await?;
                    }
                }
                if arguments.json { display(&event, true)?; }
            }
            RuntimeEventKind::TaskReady { ref title, .. } => {
                ready = true;
                outcome = true;
                if let Some(ui) = presentation
                    .as_mut()
                    .and_then(|view| view.session.as_deref_mut())
                {
                    while let Some(input) = ui.queued.pop_front() {
                        let input_id = input.id.clone();
                        ui.submitted.push_back(input.clone());
                        write_command(&mut *wire.writer, &RuntimeCommand::SubmitInput { input_id, input: input.input.text, attachments: (!input.input.attachments.is_empty()).then_some(input.input.attachments), mode: input.mode }).await?;
                    }
                } else if arguments.json {
                    display(&event, true)?;
                } else {
                    println!("{title}\n");
                }
            }
            RuntimeEventKind::History {
                ref next_cursor,
                ref conversation_id,
                ..
            } => {
                if let Some(ui) = presentation
                    .as_mut()
                    .and_then(|view| view.session.as_deref_mut()).filter(|ui|ui.selected.is_none())
                {
                    ui.conversation_id = Some(conversation_id.clone());
                }
                history_cursor = next_cursor.clone();
                outcome = true;
                if presentation.is_none() {
                    display(&event, arguments.json)?;
                }
            }
            RuntimeEventKind::WorkerIdle => {
                if presentation.is_some() {
                    continue;
                }
                if arguments.json {
                    display(&event, true)?;
                } else if std::io::stdin().is_terminal() {
                    let mut stdout = tokio::io::stdout();
                    stdout.write_all(b"task> ").await?;
                    stdout.flush().await?;
                }
            }
            RuntimeEventKind::Activity { ref activity }
                if !arguments.json && presentation.is_none() =>
            {
                use agent_cli::protocol::ModelActivity;
                match activity {
                    ModelActivity::Thinking { text } => {
                        if !thinking {
                            eprint!("thinking> ");
                            thinking = true;
                        }
                        eprint!("{text}");
                        std::io::Write::flush(&mut std::io::stderr())?;
                    }
                    ModelActivity::ToolStarted { name, .. } => {
                        if thinking {
                            eprintln!();
                            thinking = false;
                        }
                        eprintln!("[{name}]");
                    }
                    ModelActivity::ToolFinished { .. } => {}
                    ModelActivity::Compaction { active, failed } => {
                        if thinking {
                            eprintln!();
                            thinking = false;
                        }
                        if *failed {
                            eprintln!("Context compaction failed. Saved history is retained.");
                        } else if *active {
                            eprintln!("Compacting context");
                        }
                    }
                }
            }
            RuntimeEventKind::Notice { text, .. } if !arguments.json && presentation.is_none() => {
                outcome = true;
                if !attached && notices == PlainNoticeRoute::Direct {
                    eprintln!("{text}");
                }
            }
            RuntimeEventKind::ImportProgress { ref progress } => {
                outcome = true;
                let key = (
                    import_phase(&progress.phase),
                    progress.threads_seen / 100,
                    progress
                        .threads_imported
                        .saturating_add(progress.threads_unchanged)
                        / 100,
                    progress.items_added / 1000,
                );
                if arguments.json || progress_key.as_ref() != Some(&key) {
                    display(&event, arguments.json)?;
                    progress_key = Some(key);
                }
                if importing && matches!(progress.phase, ImportPhase::Partial) {
                    failure = Some(format!(
                        "History import is partial ({} gaps); committed history and checkpoints are retained",
                        progress.gap_count
                    ));
                }
            }
            other => {
                if thinking {
                    eprintln!();
                    thinking = false;
                }
                outcome = true;
                if presentation.is_none() {
                    display(&other, arguments.json)?;
                }
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
    ensure!(outcome || main_view, "Coordinator completed without a result");
    Ok(history_cursor)
    }.await;
    finish_controls(&mut feedback).await;
    result
}

fn display(event: &RuntimeEventKind, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string(event)?);
        return Ok(());
    }
    match event {
        RuntimeEventKind::FeedbackReady { receipt, .. } => println!(
            "Feedback {}: debugging in the background; results will return to the main chat.",
            receipt.id
        ),
        RuntimeEventKind::Feedback { bundle } => {
            println!("{}", serde_json::to_string_pretty(bundle)?)
        }
        RuntimeEventKind::Interrupted => println!("Interrupted."),
        RuntimeEventKind::ImportProgress { progress } => {
            println!(
                "{}: {} imported, {} unchanged, {} seen; {} items added, {} assets, {} gaps",
                import_phase_name(&progress.phase),
                progress.threads_imported,
                progress.threads_unchanged,
                progress.threads_seen,
                progress.items_added,
                progress.assets_saved,
                progress.gap_count
            );
            if matches!(progress.phase, ImportPhase::Complete | ImportPhase::Partial) {
                for gap in progress.gaps.iter().take(3) {
                    eprintln!("  {gap}");
                }
                if progress.gaps.len() > 3 {
                    eprintln!(
                        "  {} more gaps; use --json for details.",
                        progress.gaps.len() - 3
                    );
                }
            }
        }
        RuntimeEventKind::SavedMatches { matches, gaps } => {
            for found in matches {
                println!(
                    "{}  {}\n{}\n",
                    found.conversation_id,
                    found.title,
                    found.excerpt.chars().take(240).collect::<String>()
                );
            }
            for gap in gaps.iter().take(3) {
                eprintln!("Search coverage: {gap}");
            }
            if gaps.len() > 3 {
                eprintln!(
                    "{} more retrieval gaps; use --json for details.",
                    gaps.len() - 3
                );
            }
        }
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
        RuntimeEventKind::Usage { usage } => {
            print!("{}", usage::format_status(usage, SystemTime::now()))
        }
        RuntimeEventKind::History { messages, .. } => {
            use agent_cli::protocol::HistoryRole;
            for message in messages {
                let role = match message.role {
                    HistoryRole::User => "user",
                    HistoryRole::Assistant | HistoryRole::Final => "agent",
                    HistoryRole::Commentary => "update",
                    HistoryRole::PartialAnswer => "partial answer",
                    HistoryRole::Notice => "notice",
                    HistoryRole::Thinking => "thinking",
                    HistoryRole::Tool => "tool",
                };
                if message.continuation {
                    println!("{}", message.text);
                } else {
                    println!("{role}> {}", message.text);
                }
            }
        }
        RuntimeEventKind::Message { message } => {
            if message.continuation {
                println!("{}", message.text);
            } else {
                println!(
                    "{}> {}",
                    if matches!(message.role, agent_cli::protocol::HistoryRole::User) {
                        "input"
                    } else {
                        "agent"
                    },
                    message.text
                );
            }
        }
        RuntimeEventKind::InputRejected { message, .. } => eprintln!("Input not saved: {message}"),
        RuntimeEventKind::Tasks { tasks } => {
            for task in tasks {
                println!("{}  {}", task.id, task.title);
            }
        }
        RuntimeEventKind::Resources { resources } => {
            println!("{}", agent_cli::resources::format_inventory(resources));
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
        event @ (RuntimeEventKind::JobsSynced { .. }
        | RuntimeEventKind::JobRun { .. }
        | RuntimeEventKind::ScheduledJobs { .. }
        | RuntimeEventKind::ScheduledJob { .. }) => {
            if let Some(text) = agent_cli::job_view::event(event) {
                println!("{text}");
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

fn import_phase(phase: &ImportPhase) -> u8 {
    match phase {
        ImportPhase::Discovering => 0,
        ImportPhase::Importing => 1,
        ImportPhase::Indexing => 2,
        ImportPhase::Complete => 3,
        ImportPhase::Partial => 4,
    }
}
fn import_phase_name(phase: &ImportPhase) -> &'static str {
    match phase {
        ImportPhase::Discovering => "Discovering",
        ImportPhase::Importing => "Importing",
        ImportPhase::Indexing => "Indexing",
        ImportPhase::Complete => "Complete",
        ImportPhase::Partial => "Partial",
    }
}

#[cfg(test)]
mod tests {
    use crate::{Action, Arguments, ModelArgs, local_service_command};
    use agent_cli::models::{ModelProvider, ModelSelection, Reasoning};
    use agent_cli::protocol::SearchMode;
    use clap::Parser;
    use std::path::Path;

    #[tokio::test]
    async fn tool_details_read_uses_only_the_shared_request_and_closes_the_action_socket() {
        use agent_cli::{
            native::{ToolDetailContent, ToolDetails},
            protocol::{RuntimeCommand, RuntimeEventKind, ToolStatus},
            runtime::FrameReader,
            tui::activity::ToolDetailRequest,
        };
        use tokio::{
            io::{AsyncWriteExt, BufReader},
            net::UnixListener,
        };
        for (recorded, scoped) in [(true, false), (false, true)] {
            let directory = tempfile::tempdir().unwrap();
            let listener = UnixListener::bind(directory.path().join("agent.sock")).unwrap();
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let (reader, mut writer) = stream.into_split();
                let mut reader = FrameReader::new(BufReader::new(reader));
                let command: RuntimeCommand =
                    serde_json::from_slice(&reader.next_frame().await.unwrap().unwrap()).unwrap();
                assert!(
                    matches!(command, RuntimeCommand::ReadToolDetails { entry_id, call_id, task_id, agent_id } if entry_id == "42" && call_id == "call-example" && task_id.is_some() == scoped && agent_id.as_deref() == scoped.then_some("delegate-example"))
                );
                let details = if recorded {
                    ToolDetails::Available {
                        call_id: "call-example".into(),
                        name: "exec".into(),
                        status: ToolStatus::Failed,
                        input: ToolDetailContent::Text {
                            text: "printf 'example command'".into(),
                            truncated: false,
                        },
                        output: ToolDetailContent::Text {
                            text: "exit_code: 1\nexample failure".into(),
                            truncated: true,
                        },
                    }
                } else {
                    ToolDetails::Unavailable {
                        call_id: "call-example".into(),
                    }
                };
                for event in [
                    RuntimeEventKind::ToolDetails { details },
                    RuntimeEventKind::Done,
                ] {
                    writer
                        .write_all(&serde_json::to_vec(&event).unwrap())
                        .await
                        .unwrap();
                    writer.write_all(b"\n").await.unwrap();
                }
                assert!(
                    reader.next_frame().await.unwrap().is_none(),
                    "completed action must close its connection"
                );
            });
            let request = ToolDetailRequest {
                id: uuid::Uuid::new_v4(),
                entry_id: "42".into(),
                call_id: "call-example".into(),
            };
            let config = agent_cli::config::ClientConfig::default();
            let details = crate::read_tool_details(
                crate::ClientContext {
                    config: &config,
                    coordinator: None,
                    script: Path::new("/example/unused-runtime"),
                    directory: directory.path(),
                },
                &request,
                scoped.then(|| {
                    (
                        "11111111-1111-4111-8111-111111111111".parse().unwrap(),
                        Some("delegate-example".into()),
                    )
                }),
            )
            .await
            .unwrap();
            if recorded {
                assert!(
                    matches!(details, ToolDetails::Available { name, status: ToolStatus::Failed, input: ToolDetailContent::Text { text: input, truncated: false }, output: ToolDetailContent::Text { text: output, truncated: true }, .. } if name == "exec" && input == "printf 'example command'" && output == "exit_code: 1\nexample failure")
                );
            } else {
                assert!(
                    matches!(details, ToolDetails::Unavailable { call_id } if call_id == request.call_id)
                );
            }
            tokio::time::timeout(std::time::Duration::from_secs(2), server)
                .await
                .unwrap()
                .unwrap();
        }
    }

    #[tokio::test]
    async fn canceling_tool_details_closes_the_inflight_action_connection() {
        use agent_cli::{
            protocol::RuntimeCommand, runtime::FrameReader, tui::activity::ToolDetailRequest,
        };
        use tokio::{io::BufReader, net::UnixListener};
        let directory = tempfile::tempdir().unwrap();
        let listener = UnixListener::bind(directory.path().join("agent.sock")).unwrap();
        let (observed, command_received) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut reader = FrameReader::new(BufReader::new(stream));
            let command: RuntimeCommand =
                serde_json::from_slice(&reader.next_frame().await.unwrap().unwrap()).unwrap();
            assert!(matches!(command, RuntimeCommand::ReadToolDetails { .. }));
            observed.send(()).unwrap();
            assert!(
                reader.next_frame().await.unwrap().is_none(),
                "canceling the owner must close its action socket"
            );
        });
        let path = directory.path().to_owned();
        let mut controls = tokio::task::JoinSet::new();
        let task = controls.spawn(async move {
            let config = agent_cli::config::ClientConfig::default();
            let request = ToolDetailRequest {
                id: uuid::Uuid::new_v4(),
                entry_id: "42".into(),
                call_id: "call-example".into(),
            };
            crate::read_tool_details(
                crate::ClientContext {
                    config: &config,
                    coordinator: None,
                    script: Path::new("/example/unused-runtime"),
                    directory: &path,
                },
                &request,
                None,
            )
            .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(2), command_received)
            .await
            .unwrap()
            .unwrap();
        task.abort();
        assert!(
            controls
                .join_next()
                .await
                .unwrap()
                .unwrap_err()
                .is_cancelled()
        );
        tokio::time::timeout(std::time::Duration::from_secs(2), server)
            .await
            .unwrap()
            .unwrap();
    }

    #[test]
    fn feedback_cli_reads_a_typed_private_bundle_without_starting_chat() {
        use crate::FeedbackAction;
        let parsed = Arguments::try_parse_from(["agent", "--json", "feedback", "latest"]).unwrap();
        assert!(parsed.json);
        assert!(matches!(
            parsed.command,
            Some(Action::Feedback {
                command: FeedbackAction::Latest
            })
        ));
        let parsed =
            Arguments::try_parse_from(["agent", "feedback", "show", "example-id"]).unwrap();
        assert!(
            matches!(parsed.command, Some(Action::Feedback { command: FeedbackAction::Show { id } }) if id == "example-id")
        );
        assert!(Arguments::try_parse_from(["agent", "feedback", "upload"]).is_err());
    }

    fn attachment_feedback_command(id: uuid::Uuid) -> agent_cli::protocol::RuntimeCommand {
        let context = agent_cli::feedback::FeedbackContext {
            origin_host_id: "11111111-1111-4111-8111-111111111111".into(),
            cwd: "/example/project".into(),
            conversation_id: Some("fixture".into()),
            task_id: None,
            agent_id: None,
            model: None,
            binding: None,
            draft: "Keep this draft".into(),
            queued_inputs: Vec::new(),
            client_errors: Vec::new(),
            truncated: None,
            attachments: Some(vec![agent_cli::attachments::AttachmentRef {
                id: "22222222-2222-4222-8222-222222222222".into(),
                name: "terminal-view.html".into(),
                media_type: "text/html".into(),
                size_bytes: 13,
                sha256: "a".repeat(64),
            }]),
        };
        let mut command = context.command("The composer is clipped".into());
        let agent_cli::protocol::RuntimeCommand::Feedback { input_id, .. } = &mut command else {
            panic!("Expected feedback")
        };
        *input_id = Some(id.to_string());
        command
    }

    #[test]
    fn feedback_retry_retains_exact_attachment_receipts_and_report_identity_privately() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4();
        let command = attachment_feedback_command(id);
        crate::write_feedback_submission(directory.path(), id, &command).unwrap();
        let restored = crate::read_feedback_submission(directory.path(), id).unwrap();
        assert_eq!(
            serde_json::to_vec(&restored).unwrap(),
            serde_json::to_vec(&command).unwrap()
        );
        let parsed =
            Arguments::try_parse_from(["agent", "feedback", "retry", &id.to_string()]).unwrap();
        assert!(
            matches!(parsed.command,Some(Action::Feedback {command:crate::FeedbackAction::Retry {id:saved}}) if saved==id)
        );
        assert!(Arguments::try_parse_from(["agent", "feedback", "retry", "../other"]).is_err());
        let path = directory
            .path()
            .join("feedback-outbox")
            .join(format!("{id}.json"));
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        crate::acknowledge_feedback_submission(directory.path(), "not-an-id");
        assert!(path.exists());
        let mut receipt = agent_cli::protocol::RuntimeEventKind::FeedbackReady {
            input_id: None,
            receipt: agent_cli::feedback::FeedbackReceipt {
                id: "fixture-report".into(),
                path: "/example/private/feedback.json".into(),
                task_id: "33333333-3333-4333-8333-333333333333".parse().unwrap(),
                agent_id: None,
            },
        };
        assert!(crate::acknowledge_feedback_event(directory.path(), &command, &receipt).is_err());
        assert!(
            path.exists(),
            "A missing input identity must not acknowledge this report"
        );
        let agent_cli::protocol::RuntimeEventKind::FeedbackReady { input_id, .. } = &mut receipt
        else {
            panic!("Expected receipt")
        };
        *input_id = Some(id.to_string());
        crate::acknowledge_feedback_event(directory.path(), &command, &receipt).unwrap();
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn a_feedback_ready_receipt_confirms_admission_even_without_a_done_frame() {
        use agent_cli::{
            protocol::{RuntimeCommand, RuntimeEventKind},
            runtime::FrameReader,
        };
        use tokio::{io::AsyncWriteExt, net::UnixListener};
        let directory = tempfile::tempdir().unwrap();
        let listener = UnixListener::bind(directory.path().join("agent.sock")).unwrap();
        let id = uuid::Uuid::new_v4();
        let command = attachment_feedback_command(id);
        crate::write_feedback_submission(directory.path(), id, &command).unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (reader, mut writer) = stream.into_split();
            let mut reader = FrameReader::new(tokio::io::BufReader::new(reader));
            let command: RuntimeCommand =
                serde_json::from_slice(&reader.next_frame().await.unwrap().unwrap()).unwrap();
            assert!(
                matches!(command,RuntimeCommand::Feedback {input_id:Some(saved),context,..} if saved==id.to_string() && context.attachments.as_ref().is_some_and(|attachments|attachments.len()==1))
            );
            let event = RuntimeEventKind::FeedbackReady {
                input_id: Some(id.to_string()),
                receipt: agent_cli::feedback::FeedbackReceipt {
                    id: "fixture-report".into(),
                    path: "/example/private/feedback.json".into(),
                    task_id: "33333333-3333-4333-8333-333333333333".parse().unwrap(),
                    agent_id: None,
                },
            };
            writer
                .write_all(&serde_json::to_vec(&event).unwrap())
                .await
                .unwrap();
            writer.write_all(b"\n").await.unwrap();
        });
        let events = crate::exchange(
            &agent_cli::config::ClientConfig::default(),
            None,
            Path::new("/example/unused-runtime"),
            directory.path(),
            command,
        )
        .await
        .unwrap();
        assert!(matches!(
            events.last(),
            Some(RuntimeEventKind::FeedbackReady { .. })
        ));
        assert!(crate::read_feedback_submission(directory.path(), id).is_err());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn attachment_upload_keeps_one_chunk_connection_and_preserves_partial_preparation() {
        use agent_cli::{
            attachments::{
                ATTACHMENT_CHUNK_BYTES, AttachmentRef, AttachmentRequest, AttachmentResponse,
            },
            protocol::{RuntimeCommand, RuntimeEventKind},
            runtime::FrameReader,
            tui::attachments::{ComposerFile, ComposerInput},
        };
        use base64::{Engine, engine::general_purpose::STANDARD};
        use sha2::{Digest, Sha256};
        use tokio::{io::AsyncWriteExt, net::UnixListener};
        let directory = tempfile::tempdir().unwrap();
        let listener = UnixListener::bind(directory.path().join("agent.sock")).unwrap();
        let first = directory.path().join("report.txt");
        let missing = directory.path().join("missing.txt");
        let bytes = vec![b'a'; ATTACHMENT_CHUNK_BYTES as usize + 17];
        std::fs::write(&first, &bytes).unwrap();
        std::fs::write(&missing, b"remove before preparation").unwrap();
        let mut input = ComposerInput {
            text: "Review these files".into(),
            files: vec![
                ComposerFile::read_metadata(first.clone()).unwrap(),
                ComposerFile::read_metadata(missing.clone()).unwrap(),
            ],
            attachments: Vec::new(),
        };
        std::fs::remove_file(&missing).unwrap();
        let expected = bytes.clone();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (reader, mut writer) = stream.into_split();
            let mut reader = FrameReader::new(tokio::io::BufReader::new(reader));
            let mut uploaded = Vec::new();
            let mut identity = None;
            let mut chunks = 0;
            loop {
                let command: RuntimeCommand =
                    serde_json::from_slice(&reader.next_frame().await.unwrap().unwrap()).unwrap();
                let RuntimeCommand::Attachment {
                    request:
                        AttachmentRequest::Upload {
                            id,
                            name,
                            media_type,
                            size_bytes,
                            offset,
                            data_base64,
                            complete,
                        },
                } = command
                else {
                    panic!("Expected only attachment transfer")
                };
                assert_eq!(offset as usize, uploaded.len());
                assert_eq!(size_bytes as usize, expected.len());
                if let Some(previous) = &identity {
                    assert_eq!(previous, &id);
                } else {
                    identity = Some(id.clone());
                }
                let data = STANDARD.decode(data_base64).unwrap();
                assert!(data.len() <= ATTACHMENT_CHUNK_BYTES as usize);
                uploaded.extend(data);
                chunks += 1;
                let receipt = complete.then(|| AttachmentRef {
                    id,
                    name,
                    media_type,
                    size_bytes,
                    sha256: format!("{:x}", Sha256::digest(&uploaded)),
                });
                let event = RuntimeEventKind::Attachment {
                    response: AttachmentResponse::Uploaded {
                        next_offset: uploaded.len() as u32,
                        attachment: receipt.clone(),
                    },
                };
                for event in [event, RuntimeEventKind::Done] {
                    writer
                        .write_all(&serde_json::to_vec(&event).unwrap())
                        .await
                        .unwrap();
                    writer.write_all(b"\n").await.unwrap();
                }
                if let Some(receipt) = receipt {
                    assert_eq!(uploaded, expected);
                    assert_eq!(chunks, 2);
                    return receipt;
                }
            }
        });
        let config = agent_cli::config::ClientConfig::default();
        let client = crate::ClientContext {
            config: &config,
            coordinator: None,
            script: Path::new("/example/unused-runtime"),
            directory: directory.path(),
        };
        assert!(
            crate::prepare_attachments(client, &mut input)
                .await
                .is_err()
        );
        let receipt = server.await.unwrap();
        assert_eq!(input.attachments, vec![receipt.clone()]);
        assert_eq!(input.files.len(), 1);
        assert_eq!(input.files[0].path, missing);
        assert_eq!(input.text, "Review these files");
        std::fs::write(first, b"changed after immutable upload").unwrap();
        input.files.clear();
        crate::prepare_attachments(client, &mut input)
            .await
            .unwrap();
        assert_eq!(input.attachments, vec![receipt]);
        let admission = crate::chat_admission::Admission::new(
            "fixture".into(),
            input.clone(),
            agent_cli::protocol::InputMode::Steer,
        );
        let id = admission.id.clone();
        assert!(admission.sending().unwrap());
        assert_eq!(admission.input().unwrap(), input);
        assert_eq!(admission.id, id);
    }

    #[test]
    fn history_import_and_terminal_flags_parse_into_typed_commands() {
        let parsed = Arguments::try_parse_from([
            "agent", "--no-tui", "import", "codex", "--host", "desktop", "--host", "laptop",
        ])
        .unwrap();
        assert!(parsed.no_tui);
        assert!(
            matches!(parsed.command, Some(Action::Import { command: crate::ImportAction::Codex { hosts, embedding_host: None } }) if hosts == ["desktop", "laptop"])
        );
        let parsed = Arguments::try_parse_from([
            "agent",
            "import",
            "codex",
            "--host",
            "archive",
            "--embedding-host",
            "workstation",
        ])
        .unwrap();
        assert!(matches!(parsed.command, Some(Action::Import {
            command: crate::ImportAction::Codex { hosts, embedding_host: Some(host) }
        }) if hosts == ["archive"] && host == "workstation"));
        assert!(
            Arguments::try_parse_from(["agent", "import", "codex", "--embedding-host", ""])
                .is_err()
        );
        let parsed = Arguments::try_parse_from([
            "agent",
            "history",
            "search",
            "a different phrase",
            "--limit",
            "5",
        ])
        .unwrap();
        assert!(
            matches!(parsed.command, Some(Action::History { command: crate::HistoryAction::Search { query, limit: 5, mode: SearchMode::Semantic } }) if query == "a different phrase")
        );
        let parsed = Arguments::try_parse_from([
            "agent",
            "history",
            "search",
            "ERR_FIXTURE",
            "--mode",
            "keyword",
        ])
        .unwrap();
        assert!(matches!(
            parsed.command,
            Some(Action::History {
                command: crate::HistoryAction::Search {
                    mode: SearchMode::Keyword,
                    ..
                }
            })
        ));
        assert!(
            Arguments::try_parse_from(
                ["agent", "history", "search", "query", "--mode", "unknown",]
            )
            .is_err()
        );
        assert!(
            Arguments::try_parse_from(["agent", "history", "search", "query", "--limit", "0"])
                .is_err()
        );
        let parsed = Arguments::try_parse_from([
            "agent",
            "history",
            "read",
            "stored-conversation",
            "--cursor",
            "opaque-cursor",
        ])
        .unwrap();
        assert!(
            matches!(parsed.command, Some(Action::History { command: crate::HistoryAction::Read { conversation_id, cursor: Some(cursor) } }) if conversation_id == "stored-conversation" && cursor == "opaque-cursor")
        );
        let parsed = Arguments::try_parse_from([
            "agent",
            "history",
            "open",
            "stored-conversation",
            "--host",
            "desktop",
        ])
        .unwrap();
        assert!(
            matches!(parsed.command, Some(Action::History { command: crate::HistoryAction::Open { conversation_id, host: Some(host) } }) if conversation_id == "stored-conversation" && host == "desktop")
        );
    }

    #[test]
    fn terminal_recovery_keeps_exact_unsent_data_in_a_private_atomic_file() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let task: agent_cli::protocol::TaskId =
            "11111111-1111-4111-8111-111111111111".parse().unwrap();
        let recovery = crate::UiRecovery {
            owner: crate::UiRecoveryOwner::Task {
                task_id: task.clone(),
                agent_id: Some("review".into()),
                allocation_id: "22222222-2222-4222-8222-222222222222".into(),
            },
            draft: "Unsubmitted correction\nwith Unicode 🦀".into(),
            queued_inputs: vec![crate::QueuedInput {
                id: "33333333-3333-4333-8333-333333333333".into(),
                input: "Queued but not submitted".into(),
                mode: agent_cli::protocol::InputMode::Steer,
            }],
        };
        let path = crate::write_ui_recovery(directory.path(), &recovery).unwrap();
        let saved: crate::UiRecovery =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(
            matches!(saved.owner, crate::UiRecoveryOwner::Task { task_id, agent_id: Some(agent_id), allocation_id }
            if task_id == task && agent_id == "review" && allocation_id == "22222222-2222-4222-8222-222222222222")
        );
        assert_eq!(saved.draft, recovery.draft);
        assert_eq!(saved.queued_inputs, recovery.queued_inputs);
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
            1
        );
    }

    #[tokio::test]
    async fn machine_command_reads_native_inventory_without_model_or_conversation_requests() {
        use agent_cli::{
            config,
            machines::MachineSnapshot,
            protocol::{
                AgentNode, CoordinatorSettings, RuntimeCommand, RuntimeEventKind, WorkerLaunch,
            },
            runtime::FrameReader,
        };
        use tokio::{io::AsyncWriteExt, net::UnixListener};
        let directory = tempfile::tempdir().unwrap();
        let listener = UnixListener::bind(directory.path().join("agent.sock")).unwrap();
        let snapshot = MachineSnapshot::native().unwrap();
        let expected = snapshot.clone();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (reader, mut writer) = stream.into_split();
            let mut reader = FrameReader::new(tokio::io::BufReader::new(reader));
            let command: RuntimeCommand =
                serde_json::from_slice(&reader.next_frame().await.unwrap().unwrap()).unwrap();
            assert!(matches!(
                command,
                RuntimeCommand::Environment { telemetry: true }
            ));
            let node = AgentNode {
                host_id: "11111111-1111-4111-8111-111111111111".into(),
                name: "desktop".into(),
                rex_server: None,
                agent_program: "/example/agent".into(),
                home_directory: "/example".into(),
                coordinator: None,
                launch: WorkerLaunch {
                    state_dir: None,
                    runtime: None,
                    config: None,
                    instructions: None,
                    model: None,
                },
                machine: Some(snapshot),
                capabilities: Default::default(),
            };
            let event = RuntimeEventKind::Environment {
                settings: CoordinatorSettings {
                    model: ModelSelection::default(),
                    instructions: String::new(),
                    context_repositories: vec![],
                    sources: vec![],
                },
                online_host_ids: vec![node.host_id.clone()],
                nodes: vec![node],
                unavailable_host_ids: None,
            };
            let mut frame = serde_json::to_vec(&event).unwrap();
            frame.push(b'\n');
            writer.write_all(&frame).await.unwrap();
            writer.write_all(b"{\"type\":\"done\"}\n").await.unwrap();
        });
        let config = config::ClientConfig::default();
        let result = crate::machine_inventory(crate::ClientContext {
            config: &config,
            coordinator: None,
            script: Path::new("/unused-runtime"),
            directory: directory.path(),
        })
        .await
        .unwrap();
        assert_eq!(result.nodes.len(), 1);
        assert_eq!(result.nodes[0].machine.as_ref(), Some(&expected));
        assert_eq!(result.online_host_ids, [result.nodes[0].host_id.clone()]);
        assert!(result.unavailable_host_ids.is_empty());
        server.await.unwrap();
    }

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
            assert!(matches!(
                command,
                RuntimeCommand::Environment { telemetry: false }
            ));
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
                unavailable_host_ids: None,
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
