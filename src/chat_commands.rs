//! Local chat controls. Clap owns parsing and the command list shown in help.

use crate::{
    models::{ModelProvider, Reasoning},
    protocol::{ConversationChange, FastMode, RuntimeCommand, TaskId},
};
use clap::{CommandFactory, Parser, Subcommand, ValueEnum};
use std::ops::Range;

#[derive(Clone, Debug)]
pub struct Completion {
    pub range: Range<usize>,
    pub text: String,
    pub label: String,
    pub description: String,
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
    /// Load earlier saved messages.
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
            change,
            catalog,
        })
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
        models::ModelProvider,
        protocol::{ConversationChange, FastMode, RuntimeCommand},
    };

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
    }

    #[test]
    fn help_uses_the_actual_parser_and_control_requests_never_create_chat_input() {
        for (usage, _) in command_help() {
            let name = usage.split_whitespace().next().unwrap();
            if name != "/feedback" {
                assert!(ChatCommand::parse(name).unwrap().is_ok(), "{name}");
            }
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
