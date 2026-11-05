//! Local chat controls. Clap owns parsing and the command list shown in help.

use crate::{
    jobs::{JobId, ScheduleId},
    models::{ModelProvider, Reasoning},
    protocol::{ConversationChange, FastMode, RuntimeCommand, TaskId},
};
use clap::{Args, CommandFactory, Parser, Subcommand, ValueEnum};
use std::ops::Range;

#[derive(Clone, Debug)]
pub struct Completion {
    pub range: Range<usize>,
    pub text: String,
    pub label: String,
    pub description: String,
}

/// CLI and slash commands share selection parsing and request identity creation.
#[derive(Args, Clone, Debug, PartialEq, Eq)]
pub struct JobRunArgs {
    #[arg(value_name = "JOB_ID", value_parser = parse_job_id)]
    pub job_id: JobId,
    #[arg(long = "schedule", value_name = "SCHEDULE_ID", value_parser = parse_schedule_id)]
    pub schedule_id: Option<ScheduleId>,
}

impl JobRunArgs {
    pub fn request(&self) -> RuntimeCommand {
        self.request_with_id(uuid::Uuid::new_v4().to_string())
    }

    pub fn request_with_id(&self, request_id: String) -> RuntimeCommand {
        RuntimeCommand::RunJob {
            job_id: self.job_id.clone(),
            schedule_id: self.schedule_id.clone(),
            request_id,
        }
    }
}

/// Complete only command names and static positional values owned by Clap.
pub fn completions(line: &str, cursor: usize) -> Vec<Completion> {
    if !line.starts_with('/') || !line.is_char_boundary(cursor) {
        return Vec::new();
    }
    let parser = Input::command();
    let end = line.find(char::is_whitespace).unwrap_or(line.len());
    if cursor <= end {
        let prefix = &line[1..cursor.max(1)];
        return parser
            .get_subcommands()
            .filter(|command| !command.is_hide_set() && command.get_name().starts_with(prefix))
            .map(|command| Completion {
                range: 0..end,
                text: format!("/{}", command.get_name()),
                label: format!("/{}", command.get_name()),
                description: command
                    .get_about()
                    .map(ToString::to_string)
                    .unwrap_or_default(),
            })
            .collect();
    }
    let Some(command) = parser.find_subcommand(&line[1..end]) else {
        return Vec::new();
    };
    let rest = &line[end..];
    let start = end + rest.len() - rest.trim_start().len();
    if cursor < start || line[start..cursor].chars().any(char::is_whitespace) {
        return Vec::new();
    }
    let Some(argument) = command.get_positionals().next() else {
        return Vec::new();
    };
    let Some(values) = argument.get_value_parser().possible_values() else {
        return Vec::new();
    };
    let prefix = &line[start..cursor];
    let argument_end = line[start..]
        .find(char::is_whitespace)
        .map_or(line.len(), |end| start + end);
    values
        .filter(|value| !value.is_hide_set() && value.get_name().starts_with(prefix))
        .map(|value| Completion {
            range: start..argument_end,
            text: value.get_name().into(),
            label: format!("/{} {}", command.get_name(), value.get_name()),
            description: value
                .get_help()
                .map(ToString::to_string)
                .unwrap_or_default(),
        })
        .collect()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelReference {
    pub provider: Option<ModelProvider>,
    pub model_id: String,
}
impl std::str::FromStr for ModelReference {
    type Err = String;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let (provider, model_id) = value
            .split_once('/')
            .map_or((None, value), |(prefix, rest)| {
                ModelProvider::from_str(prefix, false)
                    .map_or((None, value), |provider| (Some(provider), rest))
            });
        if model_id.trim().is_empty() || model_id.chars().any(char::is_control) {
            return Err("Choose a nonempty model ID".into());
        }
        Ok(Self {
            provider,
            model_id: model_id.into(),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Subcommand)]
pub enum ChatCommand {
    /// Show commands and keyboard shortcuts.
    Help,
    /// Show this conversation's model and connection.
    Status,
    /// Show machines, capacity and observed load.
    Machines,
    /// List Beep Boop-owned worktrees across registered machines.
    Worktrees,
    /// Show scheduled jobs, or inspect one job by its stable ID.
    Jobs {
        #[arg(value_name = "JOB_ID", value_parser = parse_job_id)]
        id: Option<JobId>,
    },
    /// Run an applied job now, choosing a schedule when it has several.
    RunJob(JobRunArgs),
    /// Show available models, or choose [provider/]model.
    Model {
        #[arg(value_name = "MODEL")]
        model: Option<ModelReference>,
    },
    /// Toggle fast mode, or explicitly turn it on or off.
    Fast {
        #[arg(value_enum)]
        mode: Option<FastMode>,
    },
    /// Show reasoning, or choose an effort for later generation.
    Reasoning {
        #[arg(value_enum)]
        level: Option<Reasoning>,
    },
    /// Resume a saved chat, optionally finding its title or exact ID.
    Resume {
        #[arg(value_name = "QUERY_OR_ID", num_args = 0.., trailing_var_arg = true, allow_hyphen_values = true)]
        query: Vec<String>,
    },
    /// Load earlier saved messages.
    #[command(hide = true)]
    History,
    /// Start a background repair with private diagnostic context.
    Feedback {
        #[arg(required = true, num_args = 1.., trailing_var_arg = true, allow_hyphen_values = true)]
        description: Vec<String>,
    },
    /// Detach from chat while keeping saved work.
    #[command(alias = "quit")]
    Exit,
}

#[derive(Parser)]
#[command(
    no_binary_name = true,
    disable_help_flag = true,
    disable_help_subcommand = true
)]
struct Input {
    #[command(subcommand)]
    command: ChatCommand,
}

fn parse_job_id(value: &str) -> Result<JobId, String> {
    JobId::try_from(value.to_owned()).map_err(|error| error.to_string())
}

fn parse_schedule_id(value: &str) -> Result<ScheduleId, String> {
    ScheduleId::try_from(value.to_owned()).map_err(|error| error.to_string())
}

impl ChatCommand {
    pub fn parse(value: &str) -> Option<Result<Self, clap::Error>> {
        let value = value.trim();
        if matches!(value, "?" | "/") {
            return Some(Ok(Self::Help));
        }
        value.strip_prefix('/').map(|command| {
            Input::try_parse_from(command.split_whitespace()).map(|input| input.command)
        })
    }

    pub fn settings(&self, target: Option<(TaskId, Option<String>)>) -> Option<RuntimeCommand> {
        let (change, catalog) = match self {
            Self::Status | Self::Reasoning { level: None } => (None, false),
            Self::Model { model: None } => (None, true),
            Self::Model { model: Some(model) } => (
                Some(ConversationChange::SetModel {
                    provider: model.provider,
                    model_id: model.model_id.clone(),
                }),
                false,
            ),
            Self::Fast { mode } => (
                Some(ConversationChange::SetFast {
                    mode: mode.unwrap_or(FastMode::Toggle),
                }),
                false,
            ),
            Self::Reasoning { level: Some(level) } => (
                Some(ConversationChange::SetReasoning {
                    reasoning: Some(*level),
                }),
                false,
            ),
            _ => return None,
        };
        let (task_id, agent_id) = target.map_or((None, None), |(task, agent)| (Some(task), agent));
        Some(RuntimeCommand::ConversationSettings {
            task_id,
            agent_id,
            conversation_id: None,
            change,
            catalog,
        })
    }

    pub fn request(&self) -> Option<RuntimeCommand> {
        match self {
            Self::Worktrees => Some(RuntimeCommand::ListResources),
            Self::RunJob(args) => Some(args.request()),
            Self::Jobs { id: None } => Some(RuntimeCommand::ListJobs),
            Self::Jobs { id: Some(job_id) } => Some(RuntimeCommand::ReadJob {
                job_id: job_id.clone(),
            }),
            _ => None,
        }
    }
}

/// Render the same enum metadata that parses the commands, including arguments.
pub fn command_help() -> Vec<(String, String)> {
    let parser = Input::command();
    parser
        .get_subcommands()
        .filter(|command| !command.is_hide_set())
        .map(|command| {
            let name = format!("/{}", command.get_name());
            let mut display = command.clone().no_binary_name(false).bin_name(name);
            let usage = display.render_usage().to_string();
            (
                usage.trim_start_matches("Usage: ").trim().into(),
                command
                    .get_about()
                    .map(ToString::to_string)
                    .unwrap_or_default(),
            )
        })
        .collect()
}

pub fn help() -> String {
    command_help()
        .into_iter()
        .map(|(usage, description)| format!("{usage}\n  {description}"))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use crate::{
        chat_commands::{ChatCommand, ModelReference, command_help},
        jobs::JobId,
        models::ModelProvider,
        protocol::{ConversationChange, FastMode, RuntimeCommand},
    };

    #[test]
    fn manual_job_controls_share_typed_selection_and_keep_job_inspection_unambiguous() {
        let command = ChatCommand::parse("/run-job Daily_Review.v2 --schedule Morning.v1")
            .unwrap()
            .unwrap();
        let Some(RuntimeCommand::RunJob {
            job_id,
            schedule_id: Some(schedule_id),
            request_id,
        }) = command.request()
        else {
            panic!("Manual job control must produce the shared admission request");
        };
        assert_eq!(job_id.as_str(), "Daily_Review.v2");
        assert_eq!(schedule_id.as_str(), "Morning.v1");
        assert!(uuid::Uuid::parse_str(&request_id).is_ok());
        assert!(command.settings(None).is_none());
        assert!(matches!(
            ChatCommand::parse("/run-job daily-review")
                .unwrap()
                .unwrap()
                .request(),
            Some(RuntimeCommand::RunJob {
                schedule_id: None,
                ..
            })
        ));
        assert!(
            matches!(ChatCommand::parse("/jobs run").unwrap().unwrap().request(),
            Some(RuntimeCommand::ReadJob { job_id }) if job_id.as_str() == "run")
        );
        for invalid in [
            "/run-job",
            "/run-job daily extra",
            "/run-job daily --schedule",
            "/run-job daily --schedule invalid\u{0007}",
        ] {
            assert!(ChatCommand::parse(invalid).unwrap().is_err(), "{invalid}");
        }
    }

    #[test]
    fn job_controls_produce_typed_requests_and_reject_invalid_ids() {
        let listing = ChatCommand::parse("/jobs").unwrap().unwrap();
        assert_eq!(listing, ChatCommand::Jobs { id: None });
        assert!(matches!(listing.request(), Some(RuntimeCommand::ListJobs)));
        assert!(listing.settings(None).is_none());

        let job_id = JobId::try_from("daily-review".to_owned()).unwrap();
        let detail = ChatCommand::parse("/jobs daily-review").unwrap().unwrap();
        assert_eq!(
            detail,
            ChatCommand::Jobs {
                id: Some(job_id.clone())
            }
        );
        assert!(matches!(
            detail.request(),
            Some(RuntimeCommand::ReadJob { job_id: actual }) if actual == job_id
        ));
        assert!(ChatCommand::parse("/jobs Daily_Review").unwrap().is_ok());
        for invalid in ["/jobs daily extra", "/jobs invalid\u{0007}"] {
            assert!(ChatCommand::parse(invalid).unwrap().is_err(), "{invalid}");
        }
        assert!(ChatCommand::Machines.request().is_none());
        assert_eq!(
            crate::chat_commands::completions("/jo", 3)
                .into_iter()
                .map(|item| item.text)
                .collect::<Vec<_>>(),
            ["/jobs"]
        );
    }

    #[test]
    fn local_controls_parse_typed_values_and_keep_namespaced_model_ids() {
        assert_eq!(
            ChatCommand::parse("/fast on").unwrap().unwrap(),
            ChatCommand::Fast {
                mode: Some(FastMode::On)
            }
        );
        assert_eq!(
            ChatCommand::parse("/model openai/example")
                .unwrap()
                .unwrap(),
            ChatCommand::Model {
                model: Some(ModelReference {
                    provider: Some(ModelProvider::OpenAi),
                    model_id: "example".into()
                })
            }
        );
        assert_eq!(
            ChatCommand::parse("/model owner/model").unwrap().unwrap(),
            ChatCommand::Model {
                model: Some(ModelReference {
                    provider: None,
                    model_id: "owner/model".into()
                })
            }
        );
        assert!(ChatCommand::parse("/fast maybe").unwrap().is_err());
        assert!(ChatCommand::parse("/model openai/").unwrap().is_err());
        assert!(ChatCommand::parse("Explain this? ").is_none());
        assert_eq!(ChatCommand::parse("?").unwrap().unwrap(), ChatCommand::Help);
        assert_eq!(
            ChatCommand::parse("/quit").unwrap().unwrap(),
            ChatCommand::Exit
        );
        assert_eq!(
            ChatCommand::parse("/machines").unwrap().unwrap(),
            ChatCommand::Machines
        );
        assert_eq!(
            crate::chat_commands::completions("/mac", 4)
                .into_iter()
                .map(|item| item.text)
                .collect::<Vec<_>>(),
            ["/machines"]
        );
        assert!(ChatCommand::Machines.settings(None).is_none());
        assert_eq!(
            ChatCommand::parse("/resume").unwrap().unwrap(),
            ChatCommand::Resume { query: Vec::new() }
        );
        assert_eq!(
            ChatCommand::parse("/resume hardware board")
                .unwrap()
                .unwrap(),
            ChatCommand::Resume {
                query: vec!["hardware".into(), "board".into()]
            }
        );
        assert!(
            ChatCommand::Resume { query: Vec::new() }
                .settings(None)
                .is_none()
        );
    }

    #[test]
    fn help_uses_the_actual_parser_and_control_requests_never_create_chat_input() {
        for (usage, _) in command_help() {
            let name = usage.split_whitespace().next().unwrap();
            let invocation = match name {
                "/feedback" => "/feedback explain the failure",
                "/run-job" => "/run-job daily-review",
                other => other,
            };
            assert!(
                ChatCommand::parse(invocation).unwrap().is_ok(),
                "{invocation}"
            );
        }
        let command = ChatCommand::Fast { mode: None }.settings(None).unwrap();
        assert!(matches!(
            command,
            RuntimeCommand::ConversationSettings {
                change: Some(ConversationChange::SetFast {
                    mode: FastMode::Toggle
                }),
                catalog: false,
                ..
            }
        ));
        assert!(matches!(
            ChatCommand::Model { model: None }.settings(None),
            Some(RuntimeCommand::ConversationSettings { catalog: true, .. })
        ));
    }
}
