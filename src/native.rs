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
    Attachment {
        request: crate::attachments::AttachmentRequest,
    },
    Observe {
        input_ids: Vec<String>,
    },
    Submit {
        input_id: String,
        text: String,
        mode: InputMode,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        attachments: Option<Vec<crate::attachments::AttachmentRef>>,
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
    FeedbackReady {
        input_id: String,
        receipt: crate::feedback::FeedbackReceipt,
    },
    Attachment {
        response: crate::attachments::AttachmentResponse,
    },
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
        NativeRequest::Attachment { request } => RuntimeCommand::Attachment { request },
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
            attachments,
        } => {
            validate_id(&input_id)?;
            ensure!(
                (!text.trim().is_empty()
                    || attachments.as_ref().is_some_and(|items| !items.is_empty()))
                    && text.len() <= 65_536,
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
                ensure!(
                    attachments
                        .as_ref()
                        .is_none_or(|items| items.len() <= crate::attachments::MAX_ATTACHMENTS),
                    "Choose at most eight attachments"
                );
                if !matches!(&control, ChatCommand::Feedback { .. })
                    && attachments.as_ref().is_some_and(|items| !items.is_empty())
                {
                    return Ok(Operation::Local(NativeEvent::Rejected { input_id, message: "This command does not accept attachments; use /feedback or send a message.".into() }));
                }
                if let ChatCommand::RunJob(args) = &control {
                    return Ok(Operation::Runtime(Box::new(
                        args.request_with_id(format!("native-job:{input_id}")),
                    )));
                }
                if let Some(command) = control.request().or_else(|| control.settings(None)) {
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
                        description: description.join(" "), input_id: attachments.as_ref().map(|_| input_id), attachments,
                    },
                    ChatCommand::Resume { .. } => return Ok(Operation::Local(NativeEvent::Rejected {
                        input_id, message: "This phone client stays on the main conversation. Saved conversation viewing with /resume is available in the TUI.".into(),
                    })),
                    ChatCommand::Status | ChatCommand::Model { .. } | ChatCommand::Fast { .. }
                    | ChatCommand::Reasoning { .. } | ChatCommand::Jobs { .. }
                    | ChatCommand::RunJob(_) | ChatCommand::Worktrees => anyhow::bail!("The shared control handler did not accept this request"),
                }
            } else {
                RuntimeCommand::MainInput {
                    input_id,
                    input: text,
                    mode,
                    context: None,
                    attachments,
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
        RuntimeEventKind::Attachment { response } => NativeEvent::Attachment {
            response: response.clone(),
        },
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
        RuntimeEventKind::Resources { resources } => NativeEvent::Notice {
            text: crate::resources::format_inventory(resources),
        },
        RuntimeEventKind::FeedbackReady {
            receipt,
            input_id: Some(input_id),
        } => NativeEvent::FeedbackReady {
            input_id: input_id.clone(),
            receipt: receipt.clone(),
        },
        RuntimeEventKind::FeedbackReady {
            receipt,
            input_id: None,
        } => NativeEvent::Notice {
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
    fn omitted_attachment_fields_preserve_old_wire_and_new_feedback_has_a_correlated_receipt() {
        let input_id = uuid::Uuid::new_v4().to_string();
        let legacy: NativeRequest = serde_json::from_str(&format!(r#"{{"type":"submit","input_id":"{input_id}","text":"/feedback report","mode":"steer"}}"#)).unwrap();
        assert!(
            !String::from_utf8(serde_json::to_vec(&legacy).unwrap())
                .unwrap()
                .contains("attachments")
        );
        let Operation::Runtime(command) = prepare(legacy).unwrap() else {
            panic!("Expected shared feedback")
        };
        assert!(matches!(
            *command,
            RuntimeCommand::MainFeedback {
                input_id: None,
                attachments: None,
                ..
            }
        ));
        let Operation::Runtime(command) = prepare(NativeRequest::Submit {
            input_id: input_id.clone(),
            text: "/feedback report".into(),
            mode: InputMode::Steer,
            attachments: Some(vec![]),
        })
        .unwrap() else {
            panic!("Expected shared feedback")
        };
        assert!(
            matches!(*command, RuntimeCommand::MainFeedback { input_id: Some(ref id), .. } if id == &input_id)
        );
        let receipt = crate::feedback::FeedbackReceipt {
            id: input_id.clone(),
            path: "/invented/private/feedback.json".into(),
            task_id: crate::protocol::TaskId::new(),
            agent_id: None,
        };
        assert!(matches!(
            crate::native::project(&crate::protocol::RuntimeEventKind::FeedbackReady {
                receipt: receipt.clone(),
                input_id: None
            }),
            Some(crate::native::NativeEvent::Notice { .. })
        ));
        assert!(
            matches!(crate::native::project(&crate::protocol::RuntimeEventKind::FeedbackReady { receipt, input_id: Some(input_id.clone()) }), Some(crate::native::NativeEvent::FeedbackReady { input_id: id, .. }) if id == input_id)
        );
    }

    #[test]
    fn file_only_input_reaches_main_but_control_commands_preserve_the_attachment_draft() {
        let attachment = crate::attachments::AttachmentRef {
            id: uuid::Uuid::new_v4().to_string(),
            name: "screenshot.png".into(),
            media_type: "image/png".into(),
            size_bytes: 0,
            sha256: "0".repeat(64),
        };
        let request = |text: &str| NativeRequest::Submit {
            input_id: uuid::Uuid::new_v4().to_string(),
            text: text.into(),
            mode: InputMode::Steer,
            attachments: Some(vec![attachment.clone()]),
        };
        assert!(
            matches!(prepare(request("")).unwrap(), Operation::Runtime(command) if matches!(*command, RuntimeCommand::MainInput { ref attachments, .. } if attachments.as_ref().unwrap() == std::slice::from_ref(&attachment)))
        );
        assert!(matches!(
            prepare(request("/help")).unwrap(),
            Operation::Local(crate::native::NativeEvent::Rejected { .. })
        ));
    }
    #[test]
    fn manual_job_controls_reuse_native_input_identity_across_retries() {
        let input_id = uuid::Uuid::new_v4().to_string();
        let request = || NativeRequest::Submit {
            attachments: None,
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
                    attachments: None,
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
                    attachments: None,
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
                attachments: None,
                input_id: uuid::Uuid::new_v4().to_string(),
                text: "/resume saved-chat".into(),
                mode: InputMode::Steer
            })
            .unwrap(),
            Operation::Local(crate::native::NativeEvent::Rejected { .. })
        ));
    }

    #[test]
    fn worktree_control_uses_existing_inventory_without_model_input() {
        for mode in [InputMode::Steer, InputMode::FollowUp] {
            let operation = prepare(NativeRequest::Submit {
                attachments: None,
                input_id: uuid::Uuid::new_v4().to_string(),
                text: "/worktrees".into(),
                mode,
            })
            .unwrap();
            assert!(matches!(
                operation,
                Operation::Runtime(command) if matches!(*command, RuntimeCommand::ListResources)
            ));
        }
    }

    #[test]
    fn worktree_inventory_projects_to_existing_native_notice() {
        let task_id = crate::protocol::TaskId::new();
        let mut resource =
            crate::resources::ResourceRecord::allocating(crate::resources::WorktreeAllocation {
                host_id: "worker-a".into(),
                task_id: task_id.clone(),
                allocation_id: uuid::Uuid::new_v4(),
                repository: "/workspace/project".into(),
                branch: "task/review".into(),
            });
        resource.state = crate::resources::ResourceState::Held {
            identity: Some(crate::resources::NativeWorktreeIdentity {
                primary: "/workspace/project".into(),
                top: "/workspace/project-review".into(),
                common_dir: "/workspace/project/.git".into(),
                git_dir: "/workspace/project/.git/worktrees/review".into(),
                branch: "task/review".into(),
                head: "fixture-head".into(),
            }),
            reason: "Task is still open".into(),
        };
        let Some(crate::native::NativeEvent::Notice { text }) =
            crate::native::project(&crate::protocol::RuntimeEventKind::Resources {
                resources: vec![resource],
            })
        else {
            panic!("Native clients must receive the existing inventory");
        };
        let task_label = task_id.to_string();
        for expected in [
            "/workspace/project-review",
            "task/review",
            "worker-a",
            "held",
            "Task is still open",
            task_label.as_str(),
        ] {
            assert!(text.contains(expected), "Missing {expected}: {text}");
        }
        assert!(matches!(
            crate::native::project(&crate::protocol::RuntimeEventKind::Resources {
                resources: vec![],
            }),
            Some(crate::native::NativeEvent::Notice { text }) if text == "No Agent-owned worktrees."
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
                attachments: None,
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
                attachments: None,
                input_id: "invalid".into(),
                text: "Hi".into(),
                mode: InputMode::Steer
            })
            .is_err()
        );
    }
}
