//! Native presentation boundary. Pi owns conversation state; Clap owns controls.
use crate::{
    chat_commands::ChatCommand,
    protocol::{HistoryMessage, InputMode, ModelActivity, RuntimeCommand, RuntimeEventKind},
};
use anyhow::{Result, ensure};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NativeCommand {
    Native { request: NativeRequest },
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum NativeRequest {
    Observe {
        input_ids: Vec<String>,
    },
    Submit {
        input_id: String,
        text: String,
        mode: InputMode,
    },
    History {
        cursor: Option<String>,
    },
    Interrupt,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct SlashCommand {
    pub usage: String,
    pub description: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NativeEvent {
    Commands {
        commands: Vec<SlashCommand>,
    },
    Ready {
        conversation_id: String,
        model: String,
    },
    History {
        messages: Vec<HistoryMessage>,
        next_cursor: Option<String>,
        page_complete: bool,
    },
    Message {
        message: HistoryMessage,
    },
    Answer {
        entry_id: Option<String>,
        text: String,
    },
    TextDelta {
        text: String,
    },
    Activity {
        activity: ModelActivity,
    },
    Accepted {
        input_id: String,
    },
    Placed {
        input_id: String,
        entry_id: String,
    },
    Rejected {
        input_id: String,
        message: String,
    },
    Notice {
        text: String,
    },
    Failure {
        message: String,
    },
    Idle,
    Disconnect,
    Done,
}

pub enum Operation {
    Runtime(Box<RuntimeCommand>),
    Local(NativeEvent),
}

pub fn commands() -> Vec<SlashCommand> {
    crate::chat_commands::command_help()
        .into_iter()
        .filter(|(usage, _)| usage.split_whitespace().next() != Some("/resume"))
        .map(|(usage, description)| SlashCommand { usage, description })
        .collect()
}

pub fn prepare(request: NativeRequest) -> Result<Operation> {
    let command = match request {
        NativeRequest::Observe { input_ids } => {
            ensure!(input_ids.len() <= 32, "Too many pending inputs");
            for id in &input_ids {
                validate_id(id)?;
            }
            RuntimeCommand::ObserveMain { input_ids }
        }
        NativeRequest::History { cursor } => RuntimeCommand::ReadHistory {
            task_id: None,
            agent_id: None,
            cursor,
        },
        NativeRequest::Interrupt => RuntimeCommand::MainInterrupt,
        NativeRequest::Submit {
            input_id,
            text,
            mode,
        } => {
            validate_id(&input_id)?;
            ensure!(
                !text.trim().is_empty() && text.len() <= 65_536,
                "Input must contain 1 to 65536 UTF-8 bytes"
            );
            if let Some(control) = ChatCommand::parse(&text) {
                let control = match control {
                    Ok(control) => control,
                    Err(error) => {
                        return Ok(Operation::Local(NativeEvent::Rejected {
                            input_id,
                            message: error.to_string(),
                        }));
                    }
                };
                if let ChatCommand::RunJob(args) = &control {
                    return Ok(Operation::Runtime(Box::new(
                        args.request_with_id(format!("native-job:{input_id}")),
                    )));
                }
                if let Some(command) = control.jobs().or_else(|| control.settings(None)) {
                    return Ok(Operation::Runtime(Box::new(command)));
                }
                match control {
                    ChatCommand::Help => {
                        return Ok(Operation::Local(NativeEvent::Notice {
                            text: commands().into_iter().map(|command| format!("{}  {}", command.usage, command.description)).collect::<Vec<_>>().join("\n"),
                        }));
                    }
                    ChatCommand::Exit => return Ok(Operation::Local(NativeEvent::Disconnect)),
                    ChatCommand::History => RuntimeCommand::ReadHistory {
                        task_id: None,
                        agent_id: None,
                        cursor: None,
                    },
                    ChatCommand::Machines => RuntimeCommand::Environment { telemetry: true },
                    ChatCommand::Feedback { description } => RuntimeCommand::MainFeedback {
                        description: description.join(" "),
                    },
                    ChatCommand::Resume { .. } => return Ok(Operation::Local(NativeEvent::Rejected {
                        input_id, message: "This phone client stays on the main conversation. Saved conversation viewing with /resume is available in the TUI.".into(),
                    })),
                    ChatCommand::Status | ChatCommand::Model { .. } | ChatCommand::Fast { .. }
                    | ChatCommand::Reasoning { .. } | ChatCommand::Jobs { .. }
                    | ChatCommand::RunJob(_) => anyhow::bail!("The shared control handler did not accept this request"),
                }
            } else {
                RuntimeCommand::MainInput {
                    input_id,
                    input: text,
                    mode,
                    context: None,
                }
            }
        }
    };
    Ok(Operation::Runtime(Box::new(command)))
}

fn validate_id(id: &str) -> Result<()> {
    ensure!(
        uuid::Uuid::parse_str(id).is_ok_and(|id| !id.is_nil()),
        "Input ID must be a nonnil UUID"
    );
    Ok(())
}

fn model_label(model: &crate::models::ModelSelection) -> String {
    format!(
        "{}/{} · {}{}",
        model.provider.as_str(),
        model.model_id,
        model
            .reasoning
            .map_or("default", crate::models::Reasoning::as_str),
        if model.fast { " · fast" } else { "" }
    )
}

pub fn project(event: &RuntimeEventKind) -> Option<NativeEvent> {
    if let Some(text) = crate::job_view::event(event) {
        return Some(NativeEvent::Notice { text });
    }
    Some(match event {
        RuntimeEventKind::MainReady {
            conversation_id,
            model,
            ..
        } => NativeEvent::Ready {
            conversation_id: conversation_id.clone(),
            model: model_label(model),
        },
        RuntimeEventKind::History {
            messages,
            next_cursor,
            page_complete,
            ..
        } => NativeEvent::History {
            messages: messages.clone(),
            next_cursor: next_cursor.clone(),
            page_complete: *page_complete,
        },
        RuntimeEventKind::Message { message } => NativeEvent::Message {
            message: message.clone(),
        },
        RuntimeEventKind::Answer { entry_id, text, .. } => NativeEvent::Answer {
            entry_id: entry_id.clone(),
            text: text.clone(),
        },
        RuntimeEventKind::TextDelta { text } => NativeEvent::TextDelta { text: text.clone() },
        RuntimeEventKind::Activity { activity } => NativeEvent::Activity {
            activity: activity.clone(),
        },
        RuntimeEventKind::InputAccepted { input_id } => NativeEvent::Accepted {
            input_id: input_id.clone(),
        },
        RuntimeEventKind::InputPlaced { input_id, entry_id } => NativeEvent::Placed {
            input_id: input_id.clone(),
            entry_id: entry_id.clone(),
        },
        RuntimeEventKind::InputRejected { input_id, message } => NativeEvent::Rejected {
            input_id: input_id.clone(),
            message: message.clone(),
        },
        RuntimeEventKind::Failure { message, .. } => NativeEvent::Failure {
            message: message.clone(),
        },
        RuntimeEventKind::Notice { text, .. } => NativeEvent::Notice { text: text.clone() },
        RuntimeEventKind::Interrupted | RuntimeEventKind::WorkerIdle => NativeEvent::Idle,
        RuntimeEventKind::Done => NativeEvent::Done,
        RuntimeEventKind::ConversationSettings { settings } => NativeEvent::Notice {
            text: std::iter::once(model_label(&settings.model))
                .chain(settings.catalog.iter().map(|model| {
                    format!(
                        "{}/{} · {}",
                        model.provider.as_str(),
                        model.model_id,
                        model.name
                    )
                }))
                .collect::<Vec<_>>()
                .join("\n"),
        },
        RuntimeEventKind::Environment {
            nodes,
            online_host_ids,
            unavailable_host_ids,
            ..
        } => NativeEvent::Notice {
            text: crate::machines::MachineInventory {
                nodes: nodes.clone(),
                online_host_ids: online_host_ids.clone(),
                unavailable_host_ids: unavailable_host_ids.clone().unwrap_or_default(),
            }
            .format(std::time::SystemTime::now()),
        },
        RuntimeEventKind::FeedbackReady { receipt } => NativeEvent::Notice {
            text: format!("Feedback saved. Repair task: {}", receipt.task_id),
        },
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use crate::{
        native::{NativeRequest, Operation, prepare},
        protocol::{InputMode, RuntimeCommand},
    };
    #[test]
    fn manual_job_controls_reuse_native_input_identity_across_retries() {
        let input_id = uuid::Uuid::new_v4().to_string();
        let request = || NativeRequest::Submit {
            input_id: input_id.clone(),
            text: "/run-job Daily_Review.v2 --schedule Morning.v1".into(),
            mode: InputMode::Steer,
        };
        let mut ids = Vec::new();
        for _ in 0..2 {
            let Operation::Runtime(command) = prepare(request()).unwrap() else {
                panic!("Manual control must reach the shared job controller");
            };
            let RuntimeCommand::RunJob {
                job_id,
                schedule_id: Some(schedule_id),
                request_id,
            } = *command
            else {
                panic!("Manual control must produce a typed job admission");
            };
            assert_eq!(job_id.as_str(), "Daily_Review.v2");
            assert_eq!(schedule_id.as_str(), "Morning.v1");
            ids.push(request_id);
        }
        assert_eq!(
            ids,
            [
                format!("native-job:{input_id}"),
                format!("native-job:{input_id}")
            ]
        );
    }

    #[test]
    fn native_envelope_is_consumed_by_the_real_transport_and_bounds_are_enforced() {
        let id = uuid::Uuid::new_v4().to_string();
        let command = crate::native::NativeCommand::Native {
            request: NativeRequest::Observe {
                input_ids: vec![id.clone()],
            },
        };
        let bytes = serde_json::to_vec(&command).unwrap();
        assert!(
            matches!(serde_json::from_slice::<RuntimeCommand>(&bytes).unwrap(),
            RuntimeCommand::Native { request: NativeRequest::Observe { input_ids } } if input_ids == [id])
        );
        for input_id in [String::new(), uuid::Uuid::nil().to_string()] {
            assert!(
                prepare(NativeRequest::Submit {
                    input_id,
                    text: "Hello".into(),
                    mode: InputMode::Steer
                })
                .is_err()
            );
        }
        assert!(
            prepare(NativeRequest::Observe {
                input_ids: (0..33).map(|_| uuid::Uuid::new_v4().to_string()).collect()
            })
            .is_err()
        );
        for text in [" ".to_owned(), "🦀".repeat(16385)] {
            assert!(
                prepare(NativeRequest::Submit {
                    input_id: uuid::Uuid::new_v4().to_string(),
                    text,
                    mode: InputMode::Steer
                })
                .is_err()
            );
        }
    }

    #[test]
    fn native_catalog_does_not_advertise_task_or_saved_conversation_execution() {
        assert!(
            crate::native::commands()
                .iter()
                .all(|command| !command.usage.starts_with("/resume"))
        );
        assert!(matches!(
            prepare(NativeRequest::Submit {
                input_id: uuid::Uuid::new_v4().to_string(),
                text: "/resume saved-chat".into(),
                mode: InputMode::Steer
            })
            .unwrap(),
            Operation::Local(crate::native::NativeEvent::Rejected { .. })
        ));
    }

    #[test]
    fn native_controls_use_the_real_chat_parser_and_never_become_model_input() {
        for text in [
            "/help",
            "/status",
            "/machines",
            "/model",
            "/fast",
            "/reasoning",
            "/history",
            "/feedback fix this",
            "/exit",
            "/quit",
        ] {
            let operation = prepare(NativeRequest::Submit {
                input_id: uuid::Uuid::new_v4().to_string(),
                text: text.into(),
                mode: InputMode::Steer,
            })
            .unwrap();
            assert!(
                !matches!(
                    operation,
                    Operation::Runtime(command) if matches!(*command, RuntimeCommand::MainInput { .. })
                ),
                "{text}"
            );
        }
        assert!(
            prepare(NativeRequest::Submit {
                input_id: "invalid".into(),
                text: "Hi".into(),
                mode: InputMode::Steer
            })
            .is_err()
        );
    }
}
