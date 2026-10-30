//! Codex 0.165 presentation conventions, applied to Agent's shared native cells.
//! Source: openai/codex rust-v0.165.0, tui/src/history_cell/messages.rs and exec_cell/render.rs.
//! Metadata chooses headings; payload text never has to masquerade as a heading.

use crate::{
    protocol::{
        AgentAction, AgentActivityState, AgentState, MediaOperation, MessagePresentation,
        ReviewStage, ToolStatus, WebSearchAction,
    },
    tui::{AttachmentLabel, InputDelivery, MessageKind, Role, markdown, transcript::CachedText},
};
use ratatui::{
    style::{Color, Modifier, Style},
    text::{Line, Span},
};

pub(super) struct Content<'a> {
    pub(super) role: Role,
    pub(super) text: &'a str,
    pub(super) kind: &'a MessageKind,
    pub(super) presentation: Option<&'a MessagePresentation>,
    pub(super) tool_name: &'a str,
    pub(super) attachments: &'a [AttachmentLabel],
}

pub(super) fn render(message: Content<'_>) -> CachedText {
    let mut rendered = if message.role == Role::User {
        CachedText::prompt(message.text)
    } else if let Some(presentation) = message.presentation {
        presented(&message, presentation)
    } else if let MessageKind::Tool { status, .. } = message.kind {
        tool(&message, heading(None, message.tool_name, *status), *status)
    } else {
        let style = if message.role == Role::Thinking {
            Style::default().add_modifier(Modifier::DIM | Modifier::ITALIC)
        } else {
            Style::default()
        };
        let body = if message.role == Role::Failure {
            format!("Error: {}", message.text)
        } else {
            message.text.to_owned()
        };
        CachedText::markdown(
            Span::styled(
                if message.role == Role::Failure {
                    "■ "
                } else {
                    "• "
                },
                if message.role == Role::Failure {
                    Style::default().fg(Color::Red).add_modifier(Modifier::BOLD)
                } else {
                    Style::default().add_modifier(Modifier::DIM)
                },
            ),
            &body,
            style,
        )
    };
    if let MessageKind::Input { mode, delivery, .. } = message.kind {
        let state = match (*mode, delivery) {
            (_, InputDelivery::Submitting) => Some("sending…"),
            (_, InputDelivery::Uncertain) => Some("delivery unconfirmed; not resent"),
            (crate::protocol::InputMode::Steer, InputDelivery::Waiting) => {
                Some("steering, waiting…")
            }
            (crate::protocol::InputMode::FollowUp, InputDelivery::Waiting) => Some("queued"),
            (_, InputDelivery::Placed { .. }) => None,
        };
        if let Some(state) = state {
            rendered.append_line(Line::styled(state, dim()));
        }
    }
    if message.role == Role::PartialAnswer {
        rendered.append_line(Line::styled("Response incomplete", dim()));
    }
    for file in message.attachments {
        rendered.append_line(Line::styled(
            format!(
                "Attachment: {} · {} bytes",
                markdown::plain(&file.name),
                file.size_bytes
            ),
            dim(),
        ));
    }
    rendered
}

fn dim() -> Style {
    Style::default().add_modifier(Modifier::DIM)
}

fn marker(status: ToolStatus) -> Span<'static> {
    Span::styled(
        "• ",
        match status {
            ToolStatus::Finished => Style::default()
                .fg(Color::Green)
                .add_modifier(Modifier::BOLD),
            ToolStatus::Failed => Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
            _ => dim(),
        },
    )
}

fn presented(message: &Content<'_>, presentation: &MessagePresentation) -> CachedText {
    let status = match message.kind {
        MessageKind::Tool { status, .. } => *status,
        _ => ToolStatus::Unknown,
    };
    let title = heading(Some(presentation), message.tool_name, status);
    if (message.role == Role::Tool || matches!(message.kind, MessageKind::Tool { .. }))
        && !matches!(
            presentation,
            MessagePresentation::Plan
                | MessagePresentation::Review { .. }
                | MessagePresentation::HookPrompt
        )
    {
        tool(message, title, status)
    } else {
        CachedText::markdown_heading(
            title,
            Span::styled("• ", dim()),
            message.text,
            Style::default(),
        )
    }
}

fn verb(
    status: ToolStatus,
    running: &'static str,
    finished: &'static str,
    neutral: &'static str,
) -> &'static str {
    match status {
        ToolStatus::Running => running,
        ToolStatus::Finished => finished,
        _ => neutral,
    }
}

fn heading(
    presentation: Option<&MessagePresentation>,
    name: &str,
    status: ToolStatus,
) -> Line<'static> {
    let (action, detail) = match presentation {
        Some(MessagePresentation::Command {
            command, exit_code, ..
        }) => (
            if status == ToolStatus::Failed && exit_code.is_some() {
                "Ran"
            } else {
                verb(status, "Running", "Ran", "Command")
            },
            command.as_deref().unwrap_or(name).to_owned(),
        ),
        Some(MessagePresentation::FileChanges { changes }) => (
            verb(status, "Updating", "Updated", "File changes"),
            changes
                .iter()
                .map(|change| change.path.as_str())
                .collect::<Vec<_>>()
                .join(", "),
        ),
        Some(MessagePresentation::Tool { namespace }) => (
            verb(status, "Calling", "Called", "Tool"),
            namespace.as_ref().map_or_else(
                || name.to_owned(),
                |namespace| format!("{namespace}.{name}"),
            ),
        ),
        Some(MessagePresentation::AgentCoordination {
            action,
            receiver_thread_ids,
            ..
        }) => (
            match action {
                Some(AgentAction::Spawn) => {
                    verb(status, "Spawning agent", "Spawned agent", "Agent spawn")
                }
                Some(AgentAction::SendInput | AgentAction::SendMessage) => {
                    verb(status, "Sending input", "Sent input", "Agent input")
                }
                Some(AgentAction::Followup) => verb(
                    status,
                    "Queueing input",
                    "Queued input",
                    "Queued agent input",
                ),
                Some(AgentAction::Resume) => {
                    verb(status, "Resuming agent", "Resumed agent", "Agent resume")
                }
                Some(AgentAction::Wait) => verb(
                    status,
                    "Waiting for agents",
                    "Waited for agents",
                    "Agent wait",
                ),
                Some(AgentAction::Close) => {
                    verb(status, "Closing agent", "Closed agent", "Agent close")
                }
                Some(AgentAction::Interrupt) => verb(
                    status,
                    "Interrupting agent",
                    "Interrupted agent",
                    "Agent interrupt",
                ),
                Some(AgentAction::List) => {
                    verb(status, "Listing agents", "Listed agents", "Agent list")
                }
                Some(AgentAction::Report) => verb(
                    status,
                    "Reporting result",
                    "Reported result",
                    "Agent report",
                ),
                None => "Agent operation",
            },
            receiver_thread_ids.join(", "),
        ),
        Some(MessagePresentation::AgentActivity {
            agent_path, state, ..
        }) => (
            match state {
                Some(AgentActivityState::Started) => "Agent started",
                Some(AgentActivityState::Interacted) => "Interacted with agent",
                Some(AgentActivityState::Interrupted) => "Agent interrupted",
                Some(AgentActivityState::Completed) => "Agent completed",
                None => "Agent activity",
            },
            agent_path.to_owned(),
        ),
        Some(MessagePresentation::WebSearch { query, action }) => (
            match action {
                Some(WebSearchAction::OpenPage) => {
                    verb(status, "Opening page", "Opened page", "Page open")
                }
                Some(WebSearchAction::FindInPage) => {
                    verb(status, "Searching page", "Searched page", "Page search")
                }
                _ => verb(status, "Searching web", "Searched web", "Web search"),
            },
            query.to_owned(),
        ),
        Some(MessagePresentation::Media {
            operation,
            path,
            status: media_status,
        }) => (
            match operation {
                MediaOperation::View => "Image view",
                MediaOperation::Generate => match media_status.as_deref() {
                    Some("inProgress" | "running") => "Generating image",
                    Some("completed" | "finished") => "Generated image",
                    Some("failed") => "Image generation failed",
                    Some("declined") => "Image generation declined",
                    Some("interrupted") => "Image generation interrupted",
                    _ => "Image generation",
                },
                MediaOperation::Attachment => "Media attachment",
            },
            path.clone().unwrap_or_default(),
        ),
        Some(MessagePresentation::Sleep { duration_ms }) => (
            verb(status, "Waiting", "Waited", "Wait"),
            duration_ms.map_or_else(String::new, |value| format!("{value}ms")),
        ),
        Some(MessagePresentation::Plan) => (
            verb(status, "Updating plan", "Updated plan", "Plan"),
            String::new(),
        ),
        Some(MessagePresentation::Review { stage }) => (
            match stage {
                ReviewStage::Started => "Review started",
                ReviewStage::Finished => "Review finished",
            },
            String::new(),
        ),
        Some(MessagePresentation::HookPrompt) => ("Historical hook prompt", "inert".to_owned()),
        Some(MessagePresentation::Compaction) => ("Context compaction", String::new()),
        Some(MessagePresentation::Unknown { kind }) => ("Unknown history item", kind.to_owned()),
        Some(MessagePresentation::Unavailable { kind }) => {
            ("Original unavailable", kind.to_owned())
        }
        None => (verb(status, "Calling", "Called", "Tool"), name.to_owned()),
    };
    Line::from(vec![
        Span::styled(action, Style::default().add_modifier(Modifier::BOLD)),
        Span::raw(if detail.is_empty() {
            String::new()
        } else {
            format!(" {}", markdown::plain(&detail))
        }),
    ])
}

fn tool(message: &Content<'_>, title: Line<'static>, status: ToolStatus) -> CachedText {
    let mut lines = vec![title];
    if let Some(MessagePresentation::AgentCoordination { agents, .. }) = message.presentation {
        for (index, agent) in agents.iter().take(4).enumerate() {
            let state = match agent.state.as_ref() {
                Some(AgentState::Pending) => "pending",
                Some(AgentState::Running) => "running",
                Some(AgentState::Interrupted) => "interrupted",
                Some(AgentState::Completed) => "completed",
                Some(AgentState::Failed) => "failed",
                Some(AgentState::Shutdown) => "closed",
                Some(AgentState::NotFound) => "not found",
                None => "state unavailable",
            };
            lines.push(Line::styled(
                format!(
                    "{}{} · {state}",
                    if index == 0 { "└ " } else { "  " },
                    markdown::plain(&agent.thread_id)
                ),
                dim(),
            ));
        }
        if agents.len() > 4 {
            lines.push(Line::styled("  … more agents (ctrl+t to expand)", dim()));
        }
    }
    if let Some(MessagePresentation::Media {
        status: Some(state),
        ..
    }) = message.presentation
    {
        lines.push(Line::styled(format!("└ {}", markdown::plain(state)), dim()));
    }
    let body_start = lines.len();
    for (index, line) in message.text.lines().take(6).enumerate() {
        let style = if matches!(
            message.presentation,
            Some(MessagePresentation::FileChanges { .. })
        ) {
            match line.chars().next() {
                Some('+') => Style::default().fg(Color::Green),
                Some('-') => Style::default().fg(Color::Red),
                _ => dim(),
            }
        } else {
            dim()
        };
        lines.push(Line::from(vec![
            Span::styled(if index == 0 { "└ " } else { "  " }, dim()),
            Span::styled(markdown::plain(line), style),
        ]));
    }
    let body_end = lines.len();
    let notice = lines.len();
    lines.push(Line::styled("  … more lines (ctrl+t to expand)", dim()));
    let terminal = match status {
        ToolStatus::Failed => Some("Failed"),
        ToolStatus::Declined => Some("Declined"),
        ToolStatus::Interrupted => Some("Interrupted"),
        _ => None,
    };
    if let Some(terminal) = terminal {
        lines.push(Line::styled(format!("└ {terminal}"), dim()));
    }
    if let Some(MessagePresentation::Command {
        exit_code: Some(code),
        ..
    }) = message.presentation
        && *code != 0
    {
        lines.push(Line::styled(
            format!("└ Process exited with code {code}"),
            dim(),
        ));
    }
    if status == ToolStatus::Unknown && matches!(message.kind, MessageKind::Tool { .. }) {
        lines.push(Line::styled("└ Status unavailable", dim()));
    }
    lines.push(Line::default());
    CachedText::tool_preview(lines, marker(status), body_start..body_end, notice)
}

#[cfg(test)]
mod tests {
    use crate::{
        protocol::{
            AgentAction, HistoryMessage, HistoryRole, MediaOperation, MessagePresentation,
            RuntimeEventKind, ToolHistory, ToolStatus,
        },
        tui::{State, TuiInfo},
    };
    use ratatui::{Terminal, backend::TestBackend};

    fn draw(
        presentation: MessagePresentation,
        status: Option<ToolStatus>,
        body: &str,
        width: u16,
    ) -> (State, String) {
        let mut state = State::new(TuiInfo {
            title: "Fixture".into(),
            model: Some(crate::models::ModelSelection::default()),
            cwd: "/example".into(),
        });
        state.event(RuntimeEventKind::Message {
            message: HistoryMessage {
                entry_id: "entry".into(),
                role: HistoryRole::Tool,
                text: body.into(),
                continuation: false,
                final_chunk: true,
                presentation: Some(Box::new(presentation)),
                attachments: None,
                tool: status.map(|status| ToolHistory {
                    call_id: "call".into(),
                    name: "exec".into(),
                    status,
                }),
            },
        });
        let mut terminal = Terminal::new(TestBackend::new(width, 24)).unwrap();
        terminal.draw(|frame| state.draw(frame)).unwrap();
        let text = (0..24)
            .map(|y| {
                (0..width)
                    .map(|x| terminal.backend().buffer()[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");
        (state, text)
    }

    #[test]
    fn headings_never_infer_completion_from_unknown_declined_or_failed_status() {
        for status in [ToolStatus::Unknown, ToolStatus::Declined] {
            let (_, text) = draw(
                MessagePresentation::Command {
                    command: Some("printf fixture".into()),
                    exit_code: None,
                    duration_ms: None,
                },
                Some(status),
                "",
                100,
            );
            assert!(
                text.contains("Command printf fixture") && !text.contains("Ran printf"),
                "{text}"
            );
            assert!(
                text.contains(if status == ToolStatus::Unknown {
                    "Status unavailable"
                } else {
                    "Declined"
                }),
                "{text}"
            );
        }
        let (_, files) = draw(
            MessagePresentation::FileChanges { changes: vec![] },
            Some(ToolStatus::Unknown),
            "",
            100,
        );
        assert!(
            files.contains("File changes")
                && files.contains("Status unavailable")
                && !files.contains("Updated"),
            "{files}"
        );
        for (status, action, expected, forbidden) in [
            (
                ToolStatus::Running,
                AgentAction::List,
                "Listing agents",
                "Listed agents",
            ),
            (
                ToolStatus::Failed,
                AgentAction::Spawn,
                "Agent spawn",
                "Spawned agent",
            ),
        ] {
            let (_, text) = draw(
                MessagePresentation::AgentCoordination {
                    action: Some(action),
                    sender_thread_id: None,
                    receiver_thread_ids: vec![],
                    agents: vec![],
                },
                Some(status),
                "",
                100,
            );
            assert!(
                text.contains(expected) && !text.contains(forbidden),
                "{text}"
            );
        }
        for (status, expected, forbidden) in [
            (Some("inProgress"), "Generating image", "Generated image"),
            (None, "Image generation", "Generated image"),
        ] {
            let (_, text) = draw(
                MessagePresentation::Media {
                    operation: MediaOperation::Generate,
                    status: status.map(str::to_owned),
                    path: None,
                },
                None,
                "",
                100,
            );
            assert!(
                text.contains(expected) && !text.contains(forbidden),
                "{text}"
            );
        }
    }

    #[test]
    fn tool_preview_is_bounded_in_native_rows_even_for_one_long_line_and_resize() {
        let body = "BODY".repeat(1000);
        let (mut state, narrow) = draw(
            MessagePresentation::Command {
                command: Some("printf fixture".into()),
                exit_code: Some(0),
                duration_ms: Some(1),
            },
            Some(ToolStatus::Finished),
            &body,
            24,
        );
        assert!(
            narrow.contains("Ran printf fixture") && narrow.contains("more lines"),
            "{narrow}"
        );
        assert_eq!(
            narrow.lines().position(|line| line.contains("… more")),
            Some(6),
            "{narrow}"
        );
        let mut terminal = Terminal::new(TestBackend::new(100, 24)).unwrap();
        terminal.draw(|frame| state.draw(frame)).unwrap();
        let wide = (0..24)
            .map(|y| {
                (0..100)
                    .map(|x| terminal.backend().buffer()[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(
            wide.lines().position(|line| line.contains("… more")),
            Some(6),
            "{wide}"
        );
        assert_eq!(
            state.messages[0].text, body,
            "The preview must not alter retained tool output"
        );
    }
}
