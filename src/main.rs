mod instructions;
mod mail;
mod runtime;
mod state;
mod usage;

use std::{env, io::IsTerminal, path::PathBuf};

use agent_cli::protocol::{AuthStatus, RuntimeCommand, RuntimeEventKind};
use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

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
    json: bool,
    #[command(subcommand)]
    command: Option<Action>,
}

#[derive(Subcommand)]
enum Action {
    /// Read plan quota from the installed Codex account connection.
    Usage,
    /// Read mail through every configured Google account in Switchboard.
    Mail {
        #[command(subcommand)]
        command: MailAction,
    },
    #[command(flatten)]
    Runtime(RuntimeAction),
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

#[derive(Subcommand)]
enum RuntimeAction {
    /// Sign in with ChatGPT using this installation's own connection.
    Login,
    /// Show the saved ChatGPT connection.
    Status,
    /// Disconnect this installation's ChatGPT connection.
    Logout,
    /// Talk to the persistent main conversation.
    Chat {
        prompt: Option<String>,
        #[arg(long, default_value = "gpt-6.1-sol")]
        model: String,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    let mut arguments = Arguments::parse();
    let action = match arguments
        .command
        .take()
        .unwrap_or(Action::Runtime(RuntimeAction::Chat {
            prompt: None,
            model: "gpt-6.1-sol".into(),
        })) {
        Action::Usage => {
            let usage = usage::read(None).await?;
            if arguments.json {
                println!("{}", serde_json::to_string_pretty(&usage)?);
            } else {
                println!("{}", usage);
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
        Action::Runtime(action) => action,
    };
    let directory = state::directory(arguments.state_dir)?;
    let script = arguments
        .runtime
        .or_else(|| env::var_os("AGENT_RUNTIME_PATH").map(PathBuf::from))
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("runtime/dist/src/bridge.js")
        });
    let mut runtime = runtime::Runtime::start(&script, &directory)?;
    let outcome = match action {
        RuntimeAction::Login => run(&mut runtime, RuntimeCommand::Login, arguments.json).await,
        RuntimeAction::Status => run(&mut runtime, RuntimeCommand::Status, arguments.json).await,
        RuntimeAction::Logout => run(&mut runtime, RuntimeCommand::Logout, arguments.json).await,
        RuntimeAction::Chat { prompt, model } => {
            let global = arguments
                .instructions
                .unwrap_or(instructions::default_path()?);
            if let Some(input) = prompt {
                run(
                    &mut runtime,
                    RuntimeCommand::Chat {
                        input,
                        instructions: instructions::load(&global, &env::current_dir()?)?,
                        model,
                    },
                    arguments.json,
                )
                .await
            } else {
                interactive(&mut runtime, global, model, arguments.json).await
            }
        }
    };
    let closed = runtime.close().await;
    outcome?;
    closed
}

async fn interactive(
    runtime: &mut runtime::Runtime,
    global: PathBuf,
    model: String,
    json: bool,
) -> Result<()> {
    let mut input = BufReader::new(tokio::io::stdin()).lines();
    loop {
        if !json && std::io::stdin().is_terminal() {
            let mut stdout = tokio::io::stdout();
            stdout.write_all(b"agent> ").await?;
            stdout.flush().await?;
        }
        let Some(input) = input.next_line().await? else {
            break;
        };
        if input.trim().is_empty() {
            continue;
        }
        if input.trim() == "/exit" {
            break;
        }
        run(
            runtime,
            RuntimeCommand::Chat {
                input,
                instructions: instructions::load(&global, &env::current_dir()?)?,
                model: model.clone(),
            },
            json,
        )
        .await?;
    }
    Ok(())
}

async fn run(runtime: &mut runtime::Runtime, command: RuntimeCommand, json: bool) -> Result<()> {
    runtime
        .call(command, |event| {
            match event {
                RuntimeEventKind::AuthorizationUrl { url } => {
                    anyhow::ensure!(
                        url.starts_with("https://auth.openai.com/"),
                        "Unexpected authorization host"
                    );
                    let status = std::process::Command::new("open")
                        .args(["-a", "Google Chrome", url])
                        .status()
                        .context("Could not open Chrome for ChatGPT sign-in")?;
                    anyhow::ensure!(status.success(), "Chrome did not open");
                    eprintln!("Finish ChatGPT sign-in in Chrome.");
                }
                RuntimeEventKind::AuthStatus { status } if !json => match status {
                    AuthStatus::SignedOut => println!("Not signed in. Run agent login."),
                    AuthStatus::NeedsSignIn { .. } => {
                        println!("ChatGPT needs sign-in. Run agent login.")
                    }
                    AuthStatus::Connected { account, .. } => match &account.email {
                        Some(email) => println!("Using ChatGPT plan: {email}"),
                        None => println!("Using ChatGPT plan."),
                    },
                },
                RuntimeEventKind::Answer { text, .. } if !json => println!("{text}"),
                _ if json => println!("{}", serde_json::to_string(event)?),
                _ => {}
            }
            Ok(())
        })
        .await
}
