//! Private, bounded diagnostics. Captures never include configuration or auth stores.

use crate::{
    models::ModelSelection,
    protocol::{AllocationDecision, DelegationDecision, HistoryRole, TaskId, WorkerRef},
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Only the exact slash command is a control; `/feedbackish` is ordinary input.
pub fn command(input: &str) -> Option<&str> {
    let input = input.trim();
    input
        .strip_prefix("/feedback")
        .filter(|rest| rest.is_empty() || rest.starts_with(char::is_whitespace))
        .map(str::trim)
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct FeedbackContext {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub attachments: Option<Vec<crate::attachments::AttachmentRef>>,
    pub origin_host_id: String,
    pub cwd: String,
    pub conversation_id: Option<String>,
    pub task_id: Option<TaskId>,
    pub agent_id: Option<String>,
    pub model: Option<ModelSelection>,
    pub binding: Option<WorkerRef>,
    pub draft: String,
    pub queued_inputs: Vec<String>,
    pub client_errors: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub truncated: Option<bool>,
}

impl FeedbackContext {
    /// Bound client drafts before sending them over the coordinator transport.
    pub fn command(mut self, mut description: String) -> crate::protocol::RuntimeCommand {
        let mut truncated = self.truncated.unwrap_or(false);
        truncated |= bound(&mut description, 4096);
        truncated |= bound(&mut self.draft, 8192);
        if self.queued_inputs.len() > 16 {
            self.queued_inputs.truncate(16);
            truncated = true;
        }
        if self.client_errors.len() > 8 {
            self.client_errors.drain(..self.client_errors.len() - 8);
            truncated = true;
        }
        for text in &mut self.queued_inputs {
            truncated |= bound(text, 1024);
        }
        for text in &mut self.client_errors {
            truncated |= bound(text, 2048);
        }
        self.truncated = truncated.then_some(true);
        crate::protocol::RuntimeCommand::Feedback {
            description,
            context: self,
            input_id: None,
        }
    }
}

fn bound(value: &mut String, limit: usize) -> bool {
    if value.len() <= limit {
        return false;
    }
    let mut end = limit;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value.truncate(end);
    true
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FeedbackEvidence {
    Message {
        role: HistoryRole,
        text: String,
    },
    ToolCall {
        tool_call_id: String,
        name: String,
        arguments: Option<String>,
        omitted: Option<String>,
    },
    ToolResult {
        tool_call_id: String,
        name: String,
        is_error: bool,
        text: Option<String>,
        omitted: Option<String>,
    },
    Delegation {
        decision: DelegationDecision,
    },
    Allocation {
        decision: Box<AllocationDecision>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct FeedbackEntry {
    pub entry_id: String,
    pub kind: String,
    pub evidence: Vec<FeedbackEvidence>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct FeedbackBundle {
    pub id: String,
    #[ts(type = "number")]
    pub created_at: u64,
    pub description: String,
    pub context: FeedbackContext,
    pub entries: Vec<FeedbackEntry>,
    pub older_entries: bool,
    pub truncated: bool,
    pub omissions: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct FeedbackReceipt {
    pub id: String,
    pub path: String,
    pub task_id: TaskId,
    pub agent_id: Option<String>,
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_real_feedback_request_bounds_unicode_input_before_transport() {
        let context = crate::feedback::FeedbackContext {
            attachments: None,
            origin_host_id: "11111111-1111-4111-8111-111111111111".into(),
            cwd: "/example/project".into(),
            conversation_id: None,
            task_id: None,
            agent_id: None,
            model: Some(crate::models::ModelSelection::default()),
            binding: None,
            draft: "🦀".repeat(20_000),
            queued_inputs: vec!["🦀".repeat(20_000); 30],
            client_errors: vec!["Synthetic error".repeat(1000); 20],
            truncated: None,
        };
        let command = context.command("🦀".repeat(4000));
        assert!(serde_json::to_vec(&command).unwrap().len() < 65_536);
        let crate::protocol::RuntimeCommand::Feedback {
            context,
            description,
            ..
        } = command
        else {
            panic!("Wrong command")
        };
        assert_eq!(context.truncated, Some(true));
        assert_eq!(context.queued_inputs.len(), 16);
        assert_eq!(context.client_errors.len(), 8);
        assert_eq!(context.draft.len(), 8192);
        assert_eq!(description.len(), 4096);
    }
    #[test]
    fn only_the_exact_feedback_slash_command_is_a_control() {
        assert_eq!(
            crate::feedback::command(" /feedback wrong task \n"),
            Some("wrong task")
        );
        assert_eq!(crate::feedback::command("/feedback"), Some(""));
        assert_eq!(
            crate::feedback::command("/feedback\nUnicode 🦀"),
            Some("Unicode 🦀")
        );
        assert_eq!(crate::feedback::command("/feedbackish ordinary text"), None);
        assert_eq!(crate::feedback::command("Please /feedback later"), None);
    }
}
