//! Terminal presentation only. Request ownership, model calls and durable input stay outside this module.
mod inline;
mod markdown;
mod transcript;

use crate::tui::{
    inline::{CellOutput, Output, Screen, View},
    transcript::CachedText,
};
use crate::{
    chat_commands::{ChatCommand, Completion, command_help, completions},
    models::ModelSelection,
    protocol::{
        HistoryMessage, HistoryRole, InputMode, ModelActivity, RuntimeEventKind, ToolStatus,
    },
};
use anyhow::{Context, Result, anyhow, ensure};
use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use ratatui::{
    Frame,
    buffer::Buffer,
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear as ClearWidget, Paragraph, Widget, Wrap},
};
use ratatui_textarea::{DataCursor, TextArea, WrapMode};
use std::{io::IsTerminal, path::Path, sync::mpsc, thread, time::Duration};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

#[derive(Clone, Debug)]
pub struct TuiInfo {
    pub title: String,
    pub model: ModelSelection,
    pub cwd: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum TuiInput {
    Submit(String),
    Queue(String),
    Feedback(String),
    Command(ChatCommand),
    History,
    Interrupt,
    Exit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HistoryLoad {
    Older,
    Scroll,
}

enum Update {
    Event(Box<RuntimeEventKind>),
    Status(TuiInfo),
    Working(bool),
    Draft(tokio::sync::oneshot::Sender<String>),
    Info(tokio::sync::oneshot::Sender<TuiInfo>),
    Notice(String),
    RestoreInput(String),
    PendingInput {
        input_id: String,
        text: String,
        mode: InputMode,
    },
    Stop,
}

#[derive(Clone)]
pub struct TuiHandle {
    sender: mpsc::Sender<Update>,
}
impl TuiHandle {
    fn send(&self, update: Update) -> Result<()> {
        self.sender
            .send(update)
            .context("The terminal interface is closed")
    }
    pub fn event(&self, event: RuntimeEventKind) -> Result<()> {
        self.send(Update::Event(Box::new(event)))
    }
    pub fn set_status(&self, info: TuiInfo) -> Result<()> {
        self.send(Update::Status(info))
    }
    pub fn working(&self, working: bool) -> Result<()> {
        self.send(Update::Working(working))
    }
    pub async fn draft(&self) -> Result<String> {
        let (sender, draft) = tokio::sync::oneshot::channel();
        self.send(Update::Draft(sender))?;
        draft.await.context("The terminal draft could not be read")
    }
    pub async fn info(&self) -> Result<TuiInfo> {
        let (sender, info) = tokio::sync::oneshot::channel();
        self.send(Update::Info(sender))?;
        info.await.context("The terminal context could not be read")
    }
    pub fn notice(&self, text: String) -> Result<()> {
        self.send(Update::Notice(text))
    }
    pub fn restore_input(&self, text: String) -> Result<()> {
        self.send(Update::RestoreInput(text))
    }
    pub fn pending_input(&self, input_id: String, text: String, mode: InputMode) -> Result<()> {
        self.send(Update::PendingInput {
            input_id,
            text,
            mode,
        })
    }
}

pub struct TuiGuard {
    sender: mpsc::Sender<Update>,
    thread: Option<thread::JoinHandle<Result<()>>>,
}
impl TuiGuard {
    pub async fn stop(mut self) -> Result<()> {
        let _ = self.sender.send(Update::Stop);
        let Some(thread) = self.thread.take() else {
            return Ok(());
        };
        tokio::task::spawn_blocking(move || join(thread))
            .await
            .context("Terminal shutdown task stopped")?
    }
}
impl Drop for TuiGuard {
    fn drop(&mut self) {
        let _ = self.sender.send(Update::Stop);
        if let Some(thread) = self.thread.take() {
            let _ = join(thread);
        }
    }
}
fn join(thread: thread::JoinHandle<Result<()>>) -> Result<()> {
    thread
        .join()
        .map_err(|_| anyhow!("The terminal renderer stopped unexpectedly"))?
}

pub struct Tui;
impl Tui {
    pub fn start(info: TuiInfo) -> Result<(TuiHandle, UnboundedReceiver<TuiInput>, TuiGuard)> {
        ensure!(
            std::io::stdin().is_terminal() && std::io::stdout().is_terminal(),
            "The interactive interface requires a terminal"
        );
        let (sender, updates) = mpsc::channel();
        let (inputs, receiver) = unbounded_channel();
        let (ready, initialized) = mpsc::sync_channel(1);
        let thread = thread::Builder::new()
            .name("agent-tui".into())
            .spawn(move || {
                let mut screen = match Screen::open() {
                    Ok(screen) => screen,
                    Err(error) => {
                        let _ = ready.send(Err(error));
                        return Ok(());
                    }
                };
                let _ = ready.send(Ok(()));
                run(&mut screen, updates, inputs, State::new(info))
            })
            .context("Could not start the terminal renderer")?;
        let guard = TuiGuard {
            sender: sender.clone(),
            thread: Some(thread),
        };
        initialized
            .recv()
            .context("The terminal renderer stopped during setup")??;
        Ok((TuiHandle { sender }, receiver, guard))
    }
}

struct TerminalModes;
struct WindowTitle<'a>(&'a str);
impl crossterm::Command for WindowTitle<'_> {
    fn write_ansi(&self, output: &mut impl std::fmt::Write) -> std::fmt::Result {
        // BEL matches Codex's title framing; some terminal integrations display ST.
        write!(output, "\x1b]0;{}\x07", self.0)
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Role {
    User,
    Agent,
    PartialAnswer,
    Commentary,
    Thinking,
    Tool,
    Notice,
    Failure,
}
impl Role {
    fn from_history(role: &HistoryRole) -> Self {
        match role {
            HistoryRole::User => Self::User,
            HistoryRole::Assistant | HistoryRole::Final => Self::Agent,
            HistoryRole::PartialAnswer => Self::PartialAnswer,
            HistoryRole::Commentary => Self::Commentary,
            HistoryRole::Notice => Self::Notice,
            HistoryRole::Thinking => Self::Thinking,
            HistoryRole::Tool => Self::Tool,
        }
    }
    fn label(self) -> &'static str {
        match self {
            Self::User => "You",
            Self::Agent => "Agent",
            Self::PartialAnswer => "Agent · partial",
            Self::Commentary => "Update",
            Self::Thinking => "Thinking",
            Self::Tool => "Tool",
            Self::Notice => "Update",
            Self::Failure => "Error",
        }
    }
    fn color(self) -> Color {
        match self {
            Self::User => Color::Cyan,
            Self::Agent | Self::PartialAnswer => Color::Green,
            Self::Failure => Color::Red,
            _ => Color::DarkGray,
        }
    }
}
struct Message {
    id: Option<String>,
    role: Role,
    text: String,
    rendered: Option<CachedText>,
    kind: MessageKind,
    output: CellOutput,
}

enum InputDelivery {
    Submitting,
    Waiting,
    Placed { entry_id: String },
}
enum MessageKind {
    Text,
    Thinking(u64),
    Tool {
        call_id: String,
        status: ToolStatus,
    },
    Input {
        input_id: String,
        mode: InputMode,
        delivery: InputDelivery,
    },
}

#[derive(Default)]
struct InputHistory {
    entries: Vec<(Option<String>, String)>,
    cursor: Option<usize>,
    recalled: Option<String>,
}
impl InputHistory {
    fn remember(&mut self, text: String) {
        self.cursor = None;
        self.recalled = None;
        if !text.is_empty() && self.entries.last().is_none_or(|(_, saved)| saved != &text) {
            self.entries.push((None, text));
        }
    }
    fn sync(&mut self, messages: &[Message], live_entry: Option<&str>) {
        // Native IDs merge replayed pages and acknowledgements of local input.
        // Only a live acknowledgement can claim local input by text. Older
        // identical prompts must retain their own position and native identity.
        let mut before = self.entries.len();
        for message in messages
            .iter()
            .rev()
            .filter(|message| message.role == Role::User && message.id.is_some())
        {
            if message.id.as_deref() == live_entry
                && live_entry.is_some()
                && let Some(mut pending) = self
                    .entries
                    .iter()
                    .rposition(|(id, text)| id.is_none() && text == &message.text)
            {
                // A large submission may have arrived in partial frames before
                // its complete text can acknowledge the locally recorded input.
                if let Some(native) = self.entries.iter().position(|(id, _)| id == &message.id) {
                    self.entries.remove(native);
                    if native < pending {
                        pending -= 1;
                    }
                    if let Some(cursor) = self.cursor.as_mut() {
                        if *cursor == native {
                            *cursor = pending;
                        } else if *cursor > native {
                            *cursor -= 1;
                        }
                    }
                }
                self.entries[pending].0 = message.id.clone();
            }
            let known = self.entries.iter().rposition(|(id, _)| id == &message.id);
            if let Some(index) = known {
                self.entries[index] = (message.id.clone(), message.text.clone());
                before = index;
            } else {
                self.entries
                    .insert(before, (message.id.clone(), message.text.clone()));
                if let Some(cursor) = self.cursor.as_mut()
                    && *cursor >= before
                {
                    *cursor += 1;
                }
            }
        }
    }
    fn can_recall(&self, text: &str, boundary: bool) -> bool {
        !self.entries.is_empty()
            && (text.is_empty() || (boundary && self.recalled.as_deref() == Some(text)))
    }
    fn recall(&mut self, older: bool, text: &str, boundary: bool) -> Option<String> {
        if !self.can_recall(text, boundary) {
            return None;
        }
        let mut next = match (older, self.cursor) {
            (true, None) => self.entries.len().checked_sub(1)?,
            (true, Some(index)) => index.checked_sub(1)?,
            (false, None) => return None,
            (false, Some(index)) => index + 1,
        };
        while next < self.entries.len() && self.entries[next].1 == text {
            next = if older {
                next.checked_sub(1)?
            } else {
                next + 1
            };
        }
        if next == self.entries.len() {
            self.cursor = None;
            self.recalled = None;
            return Some(String::new());
        }
        self.cursor = Some(next);
        let value = self.entries[next].1.clone();
        self.recalled = Some(value.clone());
        Some(value)
    }
}

struct CompletionMenu {
    query: String,
    items: Vec<Completion>,
    selected: usize,
}
impl Message {
    fn new(id: Option<String>, role: Role, text: String) -> Self {
        Self {
            id,
            role,
            text,
            rendered: None,
            kind: MessageKind::Text,
            output: CellOutput::Ready,
        }
    }
    fn with_output(mut self, output: CellOutput) -> Self {
        self.output = output;
        self
    }
    fn cached(&mut self) -> &mut CachedText {
        self.rendered.get_or_insert_with(|| {
            let mut lines = Vec::new();
            if let MessageKind::Tool { status, .. } = &self.kind {
                lines.push(Line::styled(
                    format!(
                        "{} {}",
                        match status {
                            ToolStatus::Running => "•",
                            ToolStatus::Finished => "✓",
                            ToolStatus::Failed => "✗",
                        },
                        markdown::plain(&self.text)
                    ),
                    Style::default().fg(Color::DarkGray),
                ));
                lines.push(Line::default());
            } else {
                append(&mut lines, self.role, &self.text);
                if let MessageKind::Input { mode, delivery, .. } = &self.kind {
                    let label = match (mode, delivery) {
                        (_, InputDelivery::Submitting) => "You · sending",
                        (InputMode::Steer, InputDelivery::Waiting) => "You · steering, waiting",
                        (InputMode::FollowUp, InputDelivery::Waiting) => "You · queued",
                        (_, InputDelivery::Placed { .. }) => "You",
                    };
                    lines[0] = Line::styled(
                        label,
                        Style::default()
                            .fg(Color::Cyan)
                            .add_modifier(Modifier::BOLD),
                    );
                }
            }
            CachedText::new(lines)
        })
    }
    fn append(&mut self, text: &str) {
        self.text.push_str(text);
        self.rendered = None;
    }
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct LayoutWork {
    parsed_messages: usize,
    measured_messages: usize,
    painted_rows: usize,
}
struct State {
    info: TuiInfo,
    messages: Vec<Message>,
    output: Output,
    row_ends: Vec<usize>,
    row_width: u16,
    dirty_from: Option<usize>,
    #[cfg(test)]
    layout_work: LayoutWork,
    editor: TextArea<'static>,
    input_history: InputHistory,
    completion: Option<CompletionMenu>,
    dismissed_completion: Option<String>,
    thinking: Option<u64>,
    next_thinking: u64,
    working: bool,
    compacting: bool,
    interrupting: bool,
    exiting: bool,
    worker: bool,
    history_offset: Option<usize>,
    history_entry: Option<(String, bool)>,
    loading_history: Option<HistoryLoad>,
    more_history: bool,
    help_open: bool,
    help_scroll: usize,
    history_changed: bool,
    scroll: usize,
    page: usize,
    previous_rows: usize,
    previous_width: u16,
    changed: bool,
}
impl State {
    fn new(info: TuiInfo) -> Self {
        Self {
            info,
            messages: Vec::new(),
            output: Output::default(),
            row_ends: Vec::new(),
            row_width: 0,
            dirty_from: Some(0),
            #[cfg(test)]
            layout_work: LayoutWork::default(),
            editor: editor(),
            input_history: InputHistory::default(),
            completion: None,
            dismissed_completion: None,
            thinking: None,
            next_thinking: 0,
            working: false,
            compacting: false,
            interrupting: false,
            exiting: false,
            worker: false,
            history_offset: Some(0),
            history_entry: None,
            loading_history: None,
            more_history: false,
            help_open: false,
            help_scroll: 0,
            history_changed: false,
            scroll: 0,
            page: 10,
            previous_rows: 0,
            previous_width: 0,
            changed: true,
        }
    }
    fn push(&mut self, role: Role, text: String) {
        self.finish_thinking();
        self.invalidate(self.messages.len());
        self.messages.push(Message::new(None, role, text));
        self.changed = true;
    }
    fn invalidate(&mut self, index: usize) {
        self.output.cursor = self.output.cursor.min(index);
        self.dirty_from = Some(self.dirty_from.map_or(index, |dirty| dirty.min(index)));
    }
    fn working(&mut self, working: bool) {
        self.working = working;
        if !working {
            self.settle_legacy_answer();
            self.interrupting = false;
        }
        self.changed = true;
    }
    fn committed(&mut self, message: HistoryMessage, historical: bool) {
        let output = if historical {
            if self.loading_history.is_some() {
                CellOutput::Retained
            } else {
                CellOutput::Ready
            }
        } else if message.final_chunk {
            CellOutput::Ready
        } else {
            CellOutput::Mutable
        };
        if let Some(tool) = message.tool {
            self.tool_message(message.entry_id, tool, historical);
            return;
        }
        let role = Role::from_history(&message.role);
        if !historical && role == Role::User
            && self.messages.iter().any(|saved| matches!(&saved.kind,
                MessageKind::Input { delivery: InputDelivery::Placed { entry_id, .. }, .. } if entry_id == &message.entry_id))
        {
            // Placement identifies this exact submitted input. The immutable
            // preview already contains its complete body, so native echo chunks
            // do not create rows or mutate printed terminal scrollback.
            return;
        }
        if historical {
            self.history_changed = true;
            if self.loading_history == Some(HistoryLoad::Older) {
                self.scroll = usize::MAX;
            }
            let offset = self.history_offset.get_or_insert(0);
            if self
                .history_entry
                .as_ref()
                .is_none_or(|(id, _)| id != &message.entry_id)
            {
                // Native entries are immutable. Overlapping pages may repeat
                // an entry with several distinct blocks and continuation frames.
                let existing = self
                    .messages
                    .iter()
                    .rposition(|saved| saved.id.as_ref() == Some(&message.entry_id));
                if let Some(index) = existing {
                    *offset = (*offset).max(index + 1);
                }
                self.history_entry = Some((message.entry_id.clone(), existing.is_some()));
            }
            if self.history_entry.as_ref().is_some_and(|(_, skip)| *skip) {
                self.changed = true;
                return;
            }
            if message.continuation
                && *offset > 0
                && self.messages.get(*offset - 1).is_some_and(|previous| {
                    previous.id.as_ref() == Some(&message.entry_id) && previous.role == role
                })
            {
                let index = *offset - 1;
                self.messages[index].append(&message.text);
                self.messages[index].output = output;
                self.invalidate(index);
            } else {
                let index = *offset;
                self.messages.insert(
                    index,
                    Message::new(Some(message.entry_id), role, message.text).with_output(output),
                );
                *offset += 1;
                self.invalidate(index);
            }
        } else if message.continuation
            && let Some(index) = self.messages.iter().rposition(|previous| {
                previous.id.as_ref() == Some(&message.entry_id) && previous.role == role
            })
        {
            self.messages[index].append(&message.text);
            self.messages[index].output = output;
            self.invalidate(index);
        } else {
            self.invalidate(self.messages.len());
            self.messages
                .push(Message::new(Some(message.entry_id), role, message.text).with_output(output));
        }
        self.changed = true;
    }
    fn finish_thinking(&mut self) {
        if let Some(id) = self.thinking.take()
            && let Some(message) = self
                .messages
                .iter_mut()
                .find(|message| matches!(message.kind, MessageKind::Thinking(saved) if saved == id))
            && message.output == CellOutput::Mutable
        {
            message.output = CellOutput::Ready;
        }
    }
    fn pending_input(&mut self, input_id: String, text: String, mode: InputMode) {
        if self.messages.iter().any(|message| matches!(&message.kind, MessageKind::Input { input_id: id, .. } if id == &input_id)) { return; }
        self.push(Role::User, text);
        if let Some(message) = self.messages.last_mut() {
            message.output = CellOutput::Mutable;
            message.kind = MessageKind::Input {
                input_id,
                mode,
                delivery: InputDelivery::Submitting,
            };
        }
    }
    fn tool(&mut self, call_id: String, name: String, status: ToolStatus) {
        if let Some(index) = self.messages.iter().position(|message| matches!(&message.kind, MessageKind::Tool { call_id: id, .. } if id == &call_id)) {
            let message = &mut self.messages[index];
            if matches!(&message.kind, MessageKind::Tool { status: ToolStatus::Failed, .. })
                || (matches!(&message.kind, MessageKind::Tool { status: ToolStatus::Finished, .. }) && matches!(status, ToolStatus::Running | ToolStatus::Finished)) {
                return;
            }
            message.text = name;
            message.kind = MessageKind::Tool { call_id, status };
            if message.output != CellOutput::Printed { message.output = CellOutput::Mutable; }
            message.rendered = None;
            self.invalidate(index);
        } else {
            self.push(Role::Tool, name);
            if let Some(message) = self.messages.last_mut() { message.kind = MessageKind::Tool { call_id, status }; message.output = CellOutput::Mutable; }
        }
    }
    fn tool_message(
        &mut self,
        entry_id: String,
        tool: crate::protocol::ToolHistory,
        historical: bool,
    ) {
        let identity = tool.call_id.clone();
        let terminal = tool.status != ToolStatus::Running;
        let index = self.messages.iter().position(|message| matches!(&message.kind, MessageKind::Tool { call_id, .. } if call_id == &tool.call_id));
        if let Some(index) = index {
            let call = matches!(tool.status, ToolStatus::Running);
            self.tool(tool.call_id, tool.name, tool.status);
            if historical && call && self.messages[index].id.as_ref() != Some(&entry_id) {
                let offset = self.history_offset.get_or_insert(0);
                let mut message = self.messages.remove(index);
                message.id = Some(entry_id);
                let insertion = (*offset).min(self.messages.len());
                self.messages.insert(insertion, message);
                *offset = insertion + 1;
                self.invalidate(index.min(insertion));
            } else if self.messages[index].id.is_none() {
                self.messages[index].id = Some(entry_id);
            }
        } else {
            let mut message = Message::new(Some(entry_id), Role::Tool, tool.name);
            message.output = if historical && self.loading_history.is_some() {
                CellOutput::Retained
            } else {
                CellOutput::Mutable
            };
            if !historical {
                self.finish_thinking();
            }
            message.kind = MessageKind::Tool {
                call_id: tool.call_id,
                status: tool.status,
            };
            let index = if historical {
                *self.history_offset.get_or_insert(0)
            } else {
                self.messages.len()
            };
            self.messages.insert(index, message);
            if historical {
                self.history_offset = Some(index + 1);
            }
            self.invalidate(index);
        }
        if historical {
            if self.loading_history == Some(HistoryLoad::Older) {
                self.scroll = usize::MAX;
            }
            if let Some(index) = self.messages.iter().position(|message| matches!(&message.kind, MessageKind::Tool { call_id, .. } if call_id == &identity)) {
                let offset = self.history_offset.get_or_insert(0);
                *offset = (*offset).max(index + 1);
            }
        }
        if let Some(message) = self.messages.iter_mut().find(|message| matches!(&message.kind, MessageKind::Tool { call_id, .. } if call_id == &identity))
            && !matches!(message.output, CellOutput::Printed | CellOutput::Retained)
            && terminal
        {
            message.output = CellOutput::Ready;
        }
        self.history_changed |= historical;
    }
    fn event(&mut self, event: RuntimeEventKind) {
        match event {
            RuntimeEventKind::History {
                messages,
                next_cursor,
                ..
            } => {
                self.output.collecting_history = true;
                self.more_history = next_cursor.is_some();
                for message in messages {
                    self.output.historical_entries.insert(message.entry_id.clone());
                    self.committed(message, true);
                }
                self.input_history.sync(&self.messages, None);
            }
            RuntimeEventKind::Message { message } => {
                // A replayed page contains whole immutable native entries.
                // Ignore a delayed live delivery of that entry, not individual
                // role/text blocks, which may legitimately repeat within it.
                if self.output.historical_entries.contains(&message.entry_id) { return; }
                if message.tool.is_none() { self.finish_thinking(); }
                let user = matches!(message.role, HistoryRole::User);
                let entry_id = user.then(|| message.entry_id.clone());
                if user {
                    self.working(true);
                }
                self.committed(message, false);
                if user {
                    self.input_history.sync(&self.messages, entry_id.as_deref());
                }
            }
            RuntimeEventKind::Answer { text, entry_id, .. } => {
                self.finish_thinking();
                self.working(false);
                if entry_id.as_ref().is_none_or(|id| !self.messages.iter().any(|message| message.id.as_ref() == Some(id))) {
                    self.push(Role::Agent, text);
                    if let Some(message) = self.messages.last_mut() {
                        message.output = if entry_id.is_some() { CellOutput::Ready } else { CellOutput::AwaitingIdle };
                        message.id = entry_id;
                    }
                }
            }
            RuntimeEventKind::Activity { activity } => match activity {
                ModelActivity::Thinking { text } => {
                    self.working = true;
                    if let Some(index) = self.messages.iter().position(|message| matches!(message.kind, MessageKind::Thinking(id) if Some(id) == self.thinking)) {
                        self.messages[index].append(&text);
                        self.invalidate(index);
                    } else {
                        let id = self.next_thinking;
                        self.next_thinking = self.next_thinking.saturating_add(1);
                        self.push(Role::Thinking, text);
                        self.thinking = Some(id);
                        if let Some(message) = self.messages.last_mut() { message.kind = MessageKind::Thinking(id); message.output = CellOutput::Mutable; }
                    }
                }
                ModelActivity::ToolStarted { call_id, name } => {
                    self.working = true;
                    self.tool(call_id, name, ToolStatus::Running);
                }
                ModelActivity::ToolFinished { call_id, name } => {
                    self.working = true;
                    self.tool(call_id, name, ToolStatus::Finished);
                }
                ModelActivity::Compaction { active, failed } => {
                    self.compacting = active;
                    if failed {
                        self.push(
                            Role::Failure,
                            "Context compaction failed. Saved history is retained.".into(),
                        );
                    }
                }
            },
            RuntimeEventKind::TaskReady { title, .. } => {
                self.info.title = title;
                self.worker = true;
                self.history_offset = Some(0);
            }
            RuntimeEventKind::ConversationSettings { settings } => self.info.model = settings.model,
            RuntimeEventKind::MainReady { model, cwd, .. } => {
                self.info.model = model;
                self.info.cwd = cwd;
                self.working(true);
            }
            RuntimeEventKind::WorkerIdle => self.working(false),
            RuntimeEventKind::Interrupted => {
                self.finish_thinking();
                self.working(false);
                self.push(Role::Notice, "Interrupted".into());
            }
            RuntimeEventKind::Notice { text, .. } if !self.worker => self.push(Role::Notice, text),
            RuntimeEventKind::Done => {
                self.output.collecting_history = false;
                if !self.working { self.settle_legacy_answer(); }
                self.loading_history = None;
                self.history_entry = None;
            }
            RuntimeEventKind::Failure { message, .. } => {
                self.compacting = false;
                self.push(Role::Failure, message);
                self.working(false);
            }
            RuntimeEventKind::InputAccepted { input_id } => {
                if let Some(index) = self.messages.iter().position(|message| matches!(&message.kind, MessageKind::Input { input_id: id, delivery: InputDelivery::Submitting, .. } if id == &input_id)) {
                    if let MessageKind::Input { delivery, .. } = &mut self.messages[index].kind { *delivery = InputDelivery::Waiting; }
                    self.messages[index].rendered = None;
                    self.invalidate(index);
                }
            }
            RuntimeEventKind::InputPlaced { input_id, entry_id } => {
                if let Some(index) = self.messages.iter().position(|message| matches!(&message.kind, MessageKind::Input { input_id: id, .. } if id == &input_id)) {
                    let message = &mut self.messages[index];
                    message.id = Some(entry_id.clone());
                    message.output = CellOutput::Ready;
                    if let MessageKind::Input { delivery, .. } = &mut message.kind
                        && !matches!(delivery, InputDelivery::Placed { .. }) {
                        *delivery = InputDelivery::Placed { entry_id: entry_id.clone() };
                    }
                    message.rendered = None;
                    self.input_history.sync(&self.messages, Some(&entry_id));
                    self.invalidate(index);
                }
            }
            RuntimeEventKind::InputRejected { input_id, message } => {
                if let Some(index) = self.messages.iter().position(|message| matches!(&message.kind, MessageKind::Input { input_id: id, delivery: InputDelivery::Submitting | InputDelivery::Waiting, .. } if id == &input_id)) {
                    self.messages.remove(index);
                    self.invalidate(index);
                }
                self.push(Role::Failure, message);
            }
            _ => {}
        }
        self.changed = true;
    }
    fn status(&self) -> &'static str {
        if self.exiting {
            "Closing"
        } else if self.interrupting {
            "Interrupting"
        } else if self.compacting {
            "Compacting context"
        } else if self.working {
            "Working"
        } else {
            "Ready"
        }
    }
    fn input(&mut self, event: Event) -> Option<TuiInput> {
        self.sync_completion();
        let input = self.input_event(event);
        self.sync_completion();
        input
    }
    fn load_history(&mut self, mode: HistoryLoad) -> Option<TuiInput> {
        self.output.view = View::History;
        self.changed = true;
        if self.loading_history.is_some() {
            return None;
        }
        if !self.more_history {
            if mode == HistoryLoad::Older {
                self.push(Role::Notice, "No older history.".into());
            }
            return None;
        }
        self.history_offset = Some(0);
        self.loading_history = Some(mode);
        Some(TuiInput::History)
    }
    fn sync_completion(&mut self) {
        let text = self.editor.lines().join("\n");
        let DataCursor(row, column) = self.editor.cursor();
        let boundary = (row, column) == (0, 0)
            || (row + 1 == self.editor.lines().len()
                && column == self.editor.lines()[row].chars().count());
        if self.help_open
            || self.exiting
            || row != 0
            || self.input_history.can_recall(&text, boundary)
        {
            self.completion = None;
            return;
        }
        let line = &self.editor.lines()[0];
        let cursor = line
            .char_indices()
            .nth(column)
            .map_or(line.len(), |(offset, _)| offset);
        let items = completions(line, cursor);
        let query = line[..cursor].to_owned();
        if self.dismissed_completion.as_ref() == Some(&query) {
            self.completion = None;
            return;
        }
        self.dismissed_completion = None;
        if items.is_empty() {
            self.completion = None;
        } else if let Some(menu) = &mut self.completion
            && menu.query == query
        {
            menu.items = items;
        } else {
            self.completion = Some(CompletionMenu {
                query,
                items,
                selected: 0,
            });
        }
    }
    fn complete(&mut self) {
        let Some(menu) = self.completion.take() else {
            return;
        };
        let Some(item) = menu.items.get(menu.selected) else {
            return;
        };
        let mut lines = self.editor.lines().to_vec();
        let suffix = &lines[0][item.range.end..];
        let space = if suffix.is_empty() { " " } else { "" };
        let replacement = format!("{}{space}", item.text);
        lines[0].replace_range(item.range.clone(), &replacement);
        let column = lines[0][..item.range.start + replacement.len()]
            .chars()
            .count();
        self.editor = editor();
        self.editor.insert_str(lines.join("\n"));
        self.editor.move_cursor(ratatui_textarea::CursorMove::Jump(
            0,
            u16::try_from(column).unwrap_or(u16::MAX),
        ));
        self.dismissed_completion = Some(lines[0][..item.range.start + replacement.len()].into());
    }
    fn input_event(&mut self, event: Event) -> Option<TuiInput> {
        self.changed = true;
        if self.exiting {
            return None;
        }
        match event {
            Event::Key(key) if key.kind != KeyEventKind::Release => {
                let control = key.modifiers.contains(KeyModifiers::CONTROL);
                if let Some(menu) = &mut self.completion {
                    match key.code {
                        KeyCode::Up => {
                            menu.selected =
                                (menu.selected + menu.items.len() - 1) % menu.items.len();
                            return None;
                        }
                        KeyCode::Down => {
                            menu.selected = (menu.selected + 1) % menu.items.len();
                            return None;
                        }
                        KeyCode::Esc => {
                            self.dismissed_completion = Some(menu.query.clone());
                            self.completion = None;
                            return None;
                        }
                        KeyCode::Tab => {
                            self.complete();
                            return None;
                        }
                        KeyCode::Enter if key.modifiers.is_empty() => {
                            self.complete();
                            if ChatCommand::parse(&self.editor.lines().join("\n"))
                                .is_some_and(|command| command.is_err())
                            {
                                return None;
                            }
                        }
                        _ => {}
                    }
                }
                match key.code {
                    KeyCode::Char('?') if self.editor.lines().iter().all(String::is_empty) => {
                        self.help_open = !self.help_open;
                        self.help_scroll = 0;
                    }
                    KeyCode::Esc if self.help_open => self.help_open = false,
                    KeyCode::Esc if self.output.view == View::History && !self.working => {
                        self.output.view = View::Live;
                        self.scroll = 0;
                    }
                    KeyCode::Esc => {
                        if self.working {
                            self.interrupting = true;
                            return Some(TuiInput::Interrupt);
                        }
                    }
                    KeyCode::Char('c') if control => {
                        if self.worker && self.working && !self.interrupting {
                            self.interrupting = true;
                            return Some(TuiInput::Interrupt);
                        }
                        self.exiting = true;
                        return Some(TuiInput::Exit);
                    }
                    KeyCode::Char('d')
                        if control && self.editor.lines().iter().all(String::is_empty) =>
                    {
                        self.exiting = true;
                        return Some(TuiInput::Exit);
                    }
                    KeyCode::Char('r') if control => {
                        return self.load_history(HistoryLoad::Older);
                    }
                    KeyCode::PageUp if self.help_open => {
                        self.help_scroll = self.help_scroll.saturating_sub(self.page)
                    }
                    KeyCode::PageDown if self.help_open => {
                        self.help_scroll = self.help_scroll.saturating_add(self.page)
                    }
                    KeyCode::Home if control && self.help_open => self.help_scroll = 0,
                    KeyCode::End if control && self.help_open => self.help_scroll = usize::MAX,
                    KeyCode::PageUp => {
                        self.output.view = View::History;
                        self.scroll = self.scroll.saturating_add(self.page);
                        if self.scroll >= self.previous_rows.saturating_sub(self.page + 1) {
                            self.scroll = self
                                .scroll
                                .min(self.previous_rows.saturating_sub(self.page + 1));
                            return self.load_history(HistoryLoad::Scroll);
                        }
                    }
                    KeyCode::PageDown => self.scroll = self.scroll.saturating_sub(self.page),
                    KeyCode::Home if control => {
                        self.scroll = usize::MAX;
                        return self.load_history(HistoryLoad::Older);
                    }
                    KeyCode::End if control => {
                        self.scroll = 0;
                        self.output.view = View::Live;
                    }
                    KeyCode::Up | KeyCode::Down if key.modifiers.is_empty() => {
                        let text = self.editor.lines().join("\n");
                        let DataCursor(row, column) = self.editor.cursor();
                        let boundary = (row, column) == (0, 0)
                            || (row + 1 == self.editor.lines().len()
                                && column == self.editor.lines()[row].chars().count());
                        if let Some(recalled) =
                            self.input_history
                                .recall(key.code == KeyCode::Up, &text, boundary)
                        {
                            self.editor = editor();
                            self.editor.insert_str(recalled);
                        } else {
                            self.editor.input(key);
                        }
                    }
                    KeyCode::Enter
                        if key
                            .modifiers
                            .intersects(KeyModifiers::ALT | KeyModifiers::SHIFT) =>
                    {
                        self.editor.insert_newline();
                    }
                    KeyCode::Char('j') if control => {
                        self.editor.insert_newline();
                    }
                    KeyCode::Enter | KeyCode::Tab => {
                        let value = self.editor.lines().join("\n");
                        if let Some(command) = ChatCommand::parse(&value) {
                            match command {
                                Err(error) => self.push(Role::Failure, error.to_string()),
                                Ok(command) => {
                                    self.input_history.remember(value.clone());
                                    self.editor = editor();
                                    self.help_open = false;
                                    match command {
                                        ChatCommand::Help => {
                                            self.help_open = true;
                                            self.help_scroll = 0;
                                        }
                                        ChatCommand::Feedback { description } => {
                                            return Some(TuiInput::Feedback(description.join(" ")));
                                        }
                                        ChatCommand::History => {
                                            return self.load_history(HistoryLoad::Older);
                                        }
                                        ChatCommand::Exit => {
                                            self.exiting = true;
                                            return Some(TuiInput::Exit);
                                        }
                                        command => return Some(TuiInput::Command(command)),
                                    }
                                }
                            }
                            return None;
                        }
                        if !value.trim().is_empty() {
                            self.input_history.remember(value.clone());
                            self.editor = editor();
                            self.help_open = false;
                            self.scroll = 0;
                            self.output.view = View::Live;
                            if key.code == KeyCode::Tab {
                                return Some(TuiInput::Queue(value));
                            }
                            self.working = true;
                            return Some(TuiInput::Submit(value));
                        }
                    }
                    _ if !self.exiting => {
                        self.editor.input(key);
                    }
                    _ => {}
                }
            }
            Event::Paste(text) if !self.exiting => {
                self.editor.insert_str(markdown::plain(&text));
            }
            _ => {}
        }
        None
    }
    fn layout_transcript(&mut self, width: u16) -> usize {
        if self.row_width != width {
            self.row_width = width;
            self.dirty_from = Some(0);
        }
        if let Some(first) = self.dirty_from.take() {
            self.row_ends.truncate(first);
            let mut total = self.row_ends.last().copied().unwrap_or(0);
            for message in &mut self.messages[first..] {
                #[cfg(test)]
                {
                    self.layout_work.parsed_messages += usize::from(message.rendered.is_none());
                }
                let cached = message.cached();
                #[cfg(test)]
                {
                    self.layout_work.measured_messages +=
                        usize::from(cached.width() != Some(width));
                }
                total += cached.layout(width);
                self.row_ends.push(total);
            }
        }
        self.row_ends.last().copied().unwrap_or(0)
    }
    fn draw_transcript(&mut self, frame: &mut Frame<'_>, area: Rect, top: usize) {
        let first = self.row_ends.partition_point(|end| *end <= top);
        let mut start = first.checked_sub(1).map_or(0, |index| self.row_ends[index]);
        let mut drawn = 0;
        for (message, end) in self.messages[first..]
            .iter_mut()
            .zip(&self.row_ends[first..])
        {
            let remaining = Rect::new(area.x, area.y + drawn, area.width, area.height - drawn);
            drawn += u16::try_from(message.cached().draw(
                frame,
                remaining,
                top.saturating_sub(start),
            ))
            .unwrap_or(remaining.height);
            if drawn == area.height {
                break;
            }
            start = *end;
        }
        #[cfg(test)]
        {
            self.layout_work.painted_rows = usize::from(drawn);
        }
        #[cfg(not(test))]
        let _ = drawn;
    }
    fn draw(&mut self, frame: &mut Frame<'_>) {
        if frame.area().width < 16 || frame.area().height < 7 {
            frame.render_widget(Paragraph::new("Enlarge the terminal"), frame.area());
            self.changed = false;
            return;
        }
        self.prepare_editor();
        let height = self.editor_height(
            frame.area().width,
            frame.area().height.saturating_sub(6).clamp(1, 6),
        );
        let areas = Layout::vertical([
            Constraint::Length(1),
            Constraint::Min(1),
            Constraint::Length(height),
            Constraint::Length(1),
            Constraint::Length(1),
        ])
        .split(frame.area());
        let header =
            Layout::horizontal([Constraint::Min(1), Constraint::Length(18)]).split(areas[0]);
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(
                    " agent ",
                    Style::default()
                        .fg(Color::Cyan)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::raw(markdown::plain(&self.info.title)),
            ])),
            header[0],
        );
        frame.render_widget(
            Paragraph::new(self.status())
                .right_aligned()
                .style(Style::default().fg(if self.working || self.compacting {
                    Color::Cyan
                } else {
                    Color::DarkGray
                })),
            header[1],
        );
        if self.help_open {
            let mut lines = vec![Line::styled(
                "Commands",
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD),
            )];
            for (command, description) in command_help() {
                lines.push(Line::from(vec![
                    Span::styled(command, Style::default().fg(Color::Cyan)),
                    Span::raw("  "),
                    Span::raw(description),
                ]));
            }
            lines.push(Line::default());
            lines.push(Line::styled(
                "Keyboard",
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD),
            ));
            for (key, action) in shortcuts() {
                lines.push(Line::from(vec![
                    Span::styled(key, Style::default().fg(Color::Yellow)),
                    Span::raw("  "),
                    Span::raw(action),
                ]));
            }
            let paragraph = Paragraph::new(lines).wrap(Wrap { trim: false });
            let visible = usize::from(areas[1].height);
            self.help_scroll = self
                .help_scroll
                .min(paragraph.line_count(areas[1].width).saturating_sub(visible));
            self.page = visible.saturating_sub(1).max(1);
            frame.render_widget(
                paragraph.scroll((u16::try_from(self.help_scroll).unwrap_or(u16::MAX), 0)),
                areas[1],
            );
        } else {
            let total = self.layout_transcript(areas[1].width);
            let base = self.live_base();
            let total = total.saturating_sub(base);
            let visible = usize::from(areas[1].height);
            let maximum = total.saturating_sub(visible);
            if self.scroll > 0 && self.previous_width == areas[1].width && !self.history_changed {
                self.scroll = self
                    .scroll
                    .saturating_add(total.saturating_sub(self.previous_rows));
            }
            self.scroll = self.scroll.min(maximum);
            self.previous_rows = total;
            self.previous_width = areas[1].width;
            self.history_changed = false;
            self.page = visible.saturating_sub(1).max(1);
            let top = maximum.saturating_sub(self.scroll);
            self.draw_transcript(frame, areas[1], top + base);
        }
        frame.render_widget(&self.editor, areas[2]);
        if let Some(menu) = &self.completion {
            let height = usize::from(areas[1].height).min(6).min(menu.items.len());
            let start = menu.selected.saturating_sub(height.saturating_sub(1));
            let lines = menu
                .items
                .iter()
                .enumerate()
                .skip(start)
                .take(height)
                .map(|(index, item)| {
                    Line::from(vec![
                        Span::styled(
                            if index == menu.selected { "› " } else { "  " },
                            Style::default().fg(Color::Cyan),
                        ),
                        Span::styled(
                            item.label.clone(),
                            Style::default().fg(Color::Cyan).add_modifier(
                                if index == menu.selected {
                                    Modifier::BOLD
                                } else {
                                    Modifier::empty()
                                },
                            ),
                        ),
                        Span::raw(format!("  {}", item.description)),
                    ])
                })
                .collect::<Vec<_>>();
            let height = u16::try_from(height).unwrap_or(0);
            let area = Rect::new(
                areas[1].x,
                areas[1].bottom().saturating_sub(height),
                areas[1].width,
                height,
            );
            frame.render_widget(ClearWidget, area);
            frame.render_widget(Paragraph::new(lines), area);
        }
        let reasoning = self
            .info
            .model
            .reasoning
            .map(|value| value.as_str())
            .unwrap_or("default");
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(
                    markdown::plain(&self.info.model.model_id),
                    Style::default()
                        .fg(Color::Cyan)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(" · ", Style::default().fg(Color::DarkGray)),
                Span::styled(reasoning, Style::default().fg(Color::Magenta)),
                Span::styled(
                    if self.info.model.fast { " · fast" } else { "" },
                    Style::default().fg(Color::Yellow),
                ),
                Span::styled(" · ", Style::default().fg(Color::DarkGray)),
                Span::styled(
                    markdown::plain(&self.info.cwd),
                    Style::default().fg(Color::Blue),
                ),
                Span::styled(" · ", Style::default().fg(Color::DarkGray)),
                Span::styled(
                    self.status(),
                    Style::default().fg(if self.interrupting {
                        Color::Yellow
                    } else if self.working || self.compacting {
                        Color::Cyan
                    } else {
                        Color::Green
                    }),
                ),
            ])),
            areas[3],
        );
        frame.render_widget(
            Paragraph::new(Line::from(
                [Shortcut::Steer, Shortcut::Queue, Shortcut::Help]
                    .into_iter()
                    .enumerate()
                    .flat_map(|(index, shortcut)| {
                        let (key, hint, _) = shortcut.definition();
                        let hint = if self.completion.is_some() {
                            match shortcut {
                                Shortcut::Steer => "run",
                                Shortcut::Queue => "complete",
                                _ => hint,
                            }
                        } else {
                            hint
                        };
                        [
                            Span::raw(if index == 0 { "" } else { " · " }),
                            Span::styled(key, Style::default().fg(Color::Yellow)),
                            Span::raw(format!(" {hint}")),
                        ]
                    })
                    .collect::<Vec<_>>(),
            ))
            .style(Style::default().fg(Color::DarkGray)),
            areas[4],
        );
        self.changed = false;
    }
    fn prepare_editor(&mut self) {
        self.editor
            .set_block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(if self.exiting {
                        Color::DarkGray
                    } else {
                        Color::Cyan
                    })),
            );
    }
    fn editor_height(&mut self, width: u16, maximum: u16) -> u16 {
        // Use the editor's native WordOrGlyph map, including borders and tabs.
        // A bounded render refreshes its width after resize without cloning the
        // draft or maintaining a competing implementation of text wrapping.
        let area = Rect::new(0, 0, width, maximum + 2);
        (&self.editor).render(area, &mut Buffer::empty(area));
        let last = self.editor.screen_to_data(usize::MAX, 0);
        if let Some(row) =
            (0..maximum).find(|row| self.editor.screen_to_data(usize::from(*row), 0) == last)
        {
            // Growing the viewport must reveal the whole draft when it fits.
            let (top, _) = self.editor.scroll_offset();
            self.editor
                .scroll((-i16::try_from(top).unwrap_or(i16::MAX), 0));
            row + 3
        } else {
            maximum + 2
        }
    }
}
fn editor() -> TextArea<'static> {
    let mut editor = TextArea::default();
    editor.set_wrap_mode(WrapMode::WordOrGlyph);
    editor.set_cursor_line_style(Style::default());
    editor.set_cursor_style(Style::default().add_modifier(Modifier::REVERSED));
    editor.set_placeholder_text("Message the agent…");
    editor
}

fn terminal_title(info: &TuiInfo) -> String {
    let directory = Path::new(&info.cwd)
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_else(|| info.cwd.as_str().into());
    let title = format!("{} | {}", info.title, directory);
    title.chars().filter(|ch| !ch.is_control() && !matches!(ch, '\u{061c}' | '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{206f}' | '\u{feff}'))
        .collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ").chars().take(160).collect()
}

#[derive(Clone, Copy, clap::ValueEnum)]
enum Shortcut {
    Steer,
    Queue,
    Newline,
    Stop,
    Exit,
    Scroll,
    History,
    Recall,
    Help,
}
impl Shortcut {
    fn definition(self) -> (&'static str, &'static str, &'static str) {
        match self {
            Self::Steer => ("Enter", "steer", "Send or steer current work"),
            Self::Queue => ("Tab", "queue", "Queue a separate later turn"),
            Self::Newline => (
                "Shift+Enter",
                "newline",
                "Insert a newline (Alt+Enter or Ctrl+J also works)",
            ),
            Self::Stop => ("Esc", "stop", "Stop current work; close this help first"),
            Self::Exit => (
                "Ctrl+C",
                "exit",
                "Detach main chat; workers interrupt before exiting",
            ),
            Self::Scroll => (
                "PgUp/PgDn",
                "scroll",
                "Browse saved messages; wheel/trackpad uses terminal scrollback",
            ),
            Self::History => ("Ctrl+R", "older", "Load older saved messages"),
            Self::Recall => (
                "Up/Down",
                "recall",
                "Recall previous prompts; select visible completions",
            ),
            Self::Help => (
                "?",
                "shortcuts",
                "Toggle shortcuts when the editor is empty",
            ),
        }
    }
}
fn shortcuts() -> Vec<(&'static str, &'static str)> {
    use clap::ValueEnum;
    Shortcut::value_variants()
        .iter()
        .map(|shortcut| {
            let (key, _, action) = shortcut.definition();
            (key, action)
        })
        .collect()
}

pub fn help_text() -> String {
    format!(
        "{}\n\n{}",
        crate::chat_commands::help(),
        shortcuts()
            .into_iter()
            .map(|(key, action)| format!("{key}  {action}"))
            .collect::<Vec<_>>()
            .join("\n")
    )
}
fn append(lines: &mut Vec<Line<'static>>, role: Role, text: &str) {
    lines.push(Line::styled(
        role.label(),
        Style::default()
            .fg(role.color())
            .add_modifier(Modifier::BOLD),
    ));
    let rendered = markdown::render(text);
    if matches!(role, Role::Thinking | Role::Tool | Role::Commentary) {
        lines.extend(
            rendered
                .into_iter()
                .map(|line| line.style(Style::default().fg(Color::DarkGray))),
        );
    } else {
        lines.extend(rendered);
    }
    lines.push(Line::default());
}

fn run(
    screen: &mut Screen,
    updates: mpsc::Receiver<Update>,
    inputs: UnboundedSender<TuiInput>,
    mut state: State,
) -> Result<()> {
    loop {
        if inputs.is_closed() {
            return screen.finish(&mut state);
        }
        for _ in 0..256 {
            match updates.try_recv() {
                Ok(Update::Stop) | Err(mpsc::TryRecvError::Disconnected) => {
                    return screen.finish(&mut state);
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Ok(Update::Event(event)) => state.event(*event),
                Ok(Update::Status(info)) => {
                    state.info = info;
                    state.changed = true;
                }
                Ok(Update::Working(working)) => {
                    state.interrupting = false;
                    state.working(working);
                }
                Ok(Update::Draft(sender)) => {
                    let _ = sender.send(state.editor.lines().join("\n"));
                }
                Ok(Update::Info(sender)) => {
                    let _ = sender.send(state.info.clone());
                }
                Ok(Update::Notice(text)) => state.push(Role::Notice, text),
                Ok(Update::RestoreInput(text)) => {
                    if state.editor.lines().iter().any(|line| !line.is_empty()) {
                        state.editor.insert_newline();
                    }
                    state.editor.insert_str(text);
                    state.push(Role::Notice, "Unsent input returned to the draft.".into());
                }
                Ok(Update::PendingInput {
                    input_id,
                    text,
                    mode,
                }) => state.pending_input(input_id, text, mode),
            }
        }
        if state.changed {
            screen.draw(&mut state)?;
        }
        if event::poll(Duration::from_millis(40))?
            && let Some(input) = state.input(event::read()?)
        {
            inputs
                .send(input)
                .context("The agent input receiver closed")?;
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::{
        models::{ModelSelection, Reasoning},
        protocol::{HistoryMessage, HistoryRole, ModelActivity, RuntimeEventKind},
        tui::{State, TuiInfo, TuiInput},
    };
    use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
    use ratatui::{Terminal, backend::TestBackend};

    fn state() -> State {
        State::new(TuiInfo {
            title: "Main agent".into(),
            model: ModelSelection {
                reasoning: Some(Reasoning::High),
                ..ModelSelection::default()
            },
            cwd: "/workspace/example".into(),
        })
    }
    fn key(code: KeyCode, modifiers: KeyModifiers) -> Event {
        Event::Key(KeyEvent::new(code, modifiers))
    }
    fn rendered(state: &mut State, width: u16, height: u16) -> String {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal.draw(|frame| state.draw(frame)).unwrap();
        terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect()
    }
    #[test]
    fn scrolling_and_live_updates_reuse_saved_layout_and_resize_only_reflows_it() {
        let mut view = state();
        for index in 0..1_000 {
            view.push(
                crate::tui::Role::Agent,
                format!("Saved answer {index}: **context** with a few words and 界."),
            );
        }
        rendered(&mut view, 80, 20);
        let initial = view.layout_work;
        assert_eq!(initial.parsed_messages, 1_000);
        assert_eq!(initial.measured_messages, 1_000);
        for _ in 0..10 {
            view.input(key(KeyCode::PageUp, KeyModifiers::NONE));
            rendered(&mut view, 80, 20);
        }
        assert_eq!(view.layout_work.parsed_messages, initial.parsed_messages);
        assert_eq!(
            view.layout_work.measured_messages,
            initial.measured_messages
        );
        assert!(view.layout_work.painted_rows <= 14);
        view.event(RuntimeEventKind::Activity {
            activity: ModelActivity::Thinking {
                text: "New **live** context".into(),
            },
        });
        rendered(&mut view, 80, 20);
        let after_live = view.layout_work;
        assert_eq!(after_live.parsed_messages, initial.parsed_messages + 1);
        assert_eq!(after_live.measured_messages, initial.measured_messages + 1);
        rendered(&mut view, 43, 20);
        assert_eq!(view.layout_work.parsed_messages, after_live.parsed_messages);
        assert_eq!(
            view.layout_work.measured_messages,
            after_live.measured_messages + 1_001
        );
        view.input(key(KeyCode::End, KeyModifiers::CONTROL));
        assert!(rendered(&mut view, 80, 20).contains("New live context"));

        let mut history = state();
        let frame = |text: &str, continuation| RuntimeEventKind::History {
            conversation_id: "saved".into(),
            messages: vec![HistoryMessage {
                entry_id: "one".into(),
                role: HistoryRole::Assistant,
                text: text.into(),
                continuation,
                final_chunk: true,
                tool: None,
            }],
            next_cursor: None,
        };
        history.event(frame("Earlier ", false));
        rendered(&mut history, 80, 20);
        history.event(frame("context", true));
        assert!(rendered(&mut history, 80, 20).contains("Earlier context"));
        history.pending_input(
            "next-input".into(),
            "Next request".into(),
            crate::protocol::InputMode::FollowUp,
        );
        history.event(RuntimeEventKind::InputAccepted {
            input_id: "next-input".into(),
        });
        assert!(rendered(&mut history, 80, 20).contains("You · queued"));
        history.event(RuntimeEventKind::InputPlaced {
            input_id: "next-input".into(),
            entry_id: "next-user".into(),
        });
        assert!(!rendered(&mut history, 80, 20).contains("You · queued"));
        history.event(RuntimeEventKind::Message {
            message: HistoryMessage {
                entry_id: "next".into(),
                role: HistoryRole::Assistant,
                text: "Live ".into(),
                continuation: false,
                final_chunk: true,
                tool: None,
            },
        });
        rendered(&mut history, 80, 20);
        history.event(RuntimeEventKind::Message {
            message: HistoryMessage {
                entry_id: "next".into(),
                role: HistoryRole::Assistant,
                text: "continuation".into(),
                continuation: true,
                final_chunk: true,
                tool: None,
            },
        });
        assert!(rendered(&mut history, 80, 20).contains("Live continuation"));
    }
    #[test]
    #[ignore = "manual native scrolling measurement"]
    fn measure_large_transcript_scrolling() {
        use std::time::Instant;
        for count in [1_000, 10_000] {
            let mut view = state();
            for index in 0..count {
                view.push(crate::tui::Role::Agent, format!(
                    "Saved answer {index}\n\nA **styled** answer with `code`, a link, and some context. {}",
                    "Additional background information. ".repeat(8)
                ));
            }
            let mut terminal = Terminal::new(TestBackend::new(100, 30)).unwrap();
            let started = Instant::now();
            terminal.draw(|frame| view.draw(frame)).unwrap();
            let initial = started.elapsed();
            let started = Instant::now();
            for _ in 0..20 {
                view.input(key(KeyCode::PageUp, KeyModifiers::NONE));
                terminal.draw(|frame| view.draw(frame)).unwrap();
            }
            eprintln!(
                "{count} messages: initial {initial:?}, 20 scroll redraws {:?}",
                started.elapsed()
            );
        }
        let mut view = state();
        view.push(
            crate::tui::Role::Agent,
            "A single exceptionally long **paragraph** containing 界 and context. ".repeat(5_000),
        );
        let mut terminal = Terminal::new(TestBackend::new(100, 30)).unwrap();
        let started = Instant::now();
        terminal.draw(|frame| view.draw(frame)).unwrap();
        let initial = started.elapsed();
        let started = Instant::now();
        for _ in 0..20 {
            view.input(key(KeyCode::PageUp, KeyModifiers::NONE));
            terminal.draw(|frame| view.draw(frame)).unwrap();
        }
        eprintln!(
            "one 335KB paragraph: initial {initial:?}, 20 scroll redraws {:?}",
            started.elapsed()
        );
    }
    #[test]
    fn transcript_scroll_reaches_both_ends_beyond_u16_rows() {
        let mut view = state();
        view.push(
            crate::tui::Role::Agent,
            format!(
                "```text\nFIRST-ROW\n{}LAST-ROW\n```",
                "saved context\n".repeat(66_000)
            ),
        );
        assert!(rendered(&mut view, 80, 20).contains("LAST-ROW"));
        view.input(key(KeyCode::Home, KeyModifiers::CONTROL));
        assert!(rendered(&mut view, 80, 20).contains("FIRST-ROW"));
        view.input(key(KeyCode::End, KeyModifiers::CONTROL));
        assert!(rendered(&mut view, 80, 20).contains("LAST-ROW"));
    }
    #[test]
    fn live_activity_is_one_block_and_status_survives_markdown_answers() {
        let mut state = state();
        for text in ["First ", "second"] {
            state.event(RuntimeEventKind::Activity {
                activity: ModelActivity::Thinking { text: text.into() },
            });
        }
        state.event(RuntimeEventKind::Activity {
            activity: ModelActivity::ToolStarted {
                call_id: "one".into(),
                name: "read_file".into(),
            },
        });
        state.event(RuntimeEventKind::Activity {
            activity: ModelActivity::ToolFinished {
                call_id: "one".into(),
                name: "read_file".into(),
            },
        });
        let before = rendered(&mut state, 110, 24);
        assert_eq!(before.matches("Thinking").count(), 1);
        assert!(before.contains("First second"));
        assert!(before.contains("✓ read_file"));
        state.event(RuntimeEventKind::Answer {
            entry_id: None,
            conversation_id: "one".into(),
            text: "## Done\n\n- fixed **it**\n\n```rust\nlet ready = true;\n```".into(),
        });
        let after = rendered(&mut state, 110, 30);
        assert_eq!(after.matches("Thinking").count(), 1);
        assert!(after.contains("• fixed it"));
        assert!(after.contains("gpt-6.1-sol · high"));
        assert!(after.contains("/workspace/example · Ready"));
        assert!(after.contains("let ready = true;"));
    }
    #[test]
    fn native_compaction_status_coexists_with_work_and_retains_model_context() {
        let mut state = state();
        state.working(true);
        state.event(RuntimeEventKind::Activity {
            activity: ModelActivity::Compaction {
                active: true,
                failed: false,
            },
        });
        let compacting = rendered(&mut state, 110, 24);
        assert_eq!(compacting.matches("Compacting context").count(), 2);
        assert!(compacting.contains("gpt-6.1-sol · high"));
        assert!(compacting.contains("/workspace/example · Compacting context"));
        state.event(RuntimeEventKind::Answer {
            entry_id: None,
            conversation_id: "one".into(),
            text: "Foreground work completed".into(),
        });
        assert_eq!(state.status(), "Compacting context");
        state.event(RuntimeEventKind::Activity {
            activity: ModelActivity::Compaction {
                active: false,
                failed: false,
            },
        });
        assert_eq!(state.status(), "Ready");
        state.working(true);
        state.event(RuntimeEventKind::Activity {
            activity: ModelActivity::Compaction {
                active: true,
                failed: false,
            },
        });
        assert_eq!(
            state.input(key(KeyCode::Esc, KeyModifiers::NONE)),
            Some(TuiInput::Interrupt)
        );
        assert_eq!(state.status(), "Interrupting");
        state.event(RuntimeEventKind::Interrupted);
        assert_eq!(
            state.status(),
            "Compacting context",
            "Background compaction may survive an interrupted turn"
        );
        state.event(RuntimeEventKind::Activity {
            activity: ModelActivity::Compaction {
                active: false,
                failed: false,
            },
        });
        assert_eq!(state.status(), "Ready");
    }
    #[test]
    fn compaction_failure_is_actionable_without_changing_unrelated_work_status() {
        let mut state = state();
        state.working(true);
        state.event(RuntimeEventKind::Activity {
            activity: ModelActivity::Compaction {
                active: false,
                failed: true,
            },
        });
        assert_eq!(state.status(), "Working");
        let text = rendered(&mut state, 110, 24);
        assert!(text.contains("Context compaction failed. Saved history is retained."));
        state.working(false);
        assert_eq!(state.status(), "Ready");
        state.event(RuntimeEventKind::Activity {
            activity: ModelActivity::Compaction {
                active: true,
                failed: false,
            },
        });
        state.event(RuntimeEventKind::Failure {
            code: crate::protocol::ErrorCode::Internal,
            message: "The coordinator disconnected".into(),
        });
        assert_eq!(
            state.status(),
            "Ready",
            "A lost execution scope must not retain stale compaction status"
        );
    }
    #[test]
    fn escape_keeps_an_idle_chat_and_its_draft_open() {
        let mut state = state();
        state.input(Event::Paste("An unfinished correction".into()));
        assert_eq!(state.input(key(KeyCode::Esc, KeyModifiers::NONE)), None);
        assert!(!state.exiting);
        assert_eq!(state.editor.lines().join("\n"), "An unfinished correction");
    }
    #[test]
    fn multiline_editing_interrupt_and_queue_preserve_the_draft() {
        let mut state = state();
        state.input(Event::Paste("First line\nSecond 🦀".into()));
        state.working(true);
        assert_eq!(
            state.input(key(KeyCode::Esc, KeyModifiers::NONE)),
            Some(TuiInput::Interrupt)
        );
        assert_eq!(state.editor.lines().join("\n"), "First line\nSecond 🦀");
        state.input(key(KeyCode::Backspace, KeyModifiers::NONE));
        state.input(Event::Paste("✓".into()));
        assert_eq!(
            state.input(key(KeyCode::Enter, KeyModifiers::NONE)),
            Some(TuiInput::Submit("First line\nSecond ✓".into()))
        );
        assert!(state.editor.lines().iter().all(String::is_empty));
        assert_eq!(
            state.input(key(KeyCode::Char('c'), KeyModifiers::CONTROL)),
            Some(TuiInput::Exit)
        );
    }
    #[test]
    fn enter_steers_tab_queues_and_feedback_is_a_control_without_stopping_work() {
        let mut state = state();
        state.working(true);
        state.input(Event::Paste("Correct the active work".into()));
        assert_eq!(
            state.input(key(KeyCode::Enter, KeyModifiers::NONE)),
            Some(TuiInput::Submit("Correct the active work".into()))
        );
        state.input(Event::Paste("Do this after the current answer".into()));
        assert_eq!(
            state.input(key(KeyCode::Tab, KeyModifiers::NONE)),
            Some(TuiInput::Queue("Do this after the current answer".into()))
        );
        assert!(state.working);
        state.input(Event::Paste("First line".into()));
        state.input(key(KeyCode::Enter, KeyModifiers::SHIFT));
        state.input(Event::Paste("Second line".into()));
        assert_eq!(state.editor.lines().join("\n"), "First line\nSecond line");
        assert_eq!(
            state.input(key(KeyCode::Enter, KeyModifiers::NONE)),
            Some(TuiInput::Submit("First line\nSecond line".into()))
        );
        state.input(Event::Paste("/feedback the wrong task was opened".into()));
        assert_eq!(
            state.input(key(KeyCode::Enter, KeyModifiers::NONE)),
            Some(TuiInput::Feedback("the wrong task was opened".into()))
        );
        assert!(state.working);
        assert!(!state.interrupting);
        assert!(!state.exiting);
        assert!(state.editor.lines().iter().all(String::is_empty));
        assert!(rendered(&mut state, 120, 20).contains("Tab queue"));
    }
    #[test]
    fn help_and_local_controls_keep_active_work_and_drafts_owned_by_the_editor() {
        use crate::{chat_commands::ChatCommand, protocol::FastMode};
        let mut view = state();
        view.working(true);
        view.pending_input(
            "later".into(),
            "A later request".into(),
            crate::protocol::InputMode::FollowUp,
        );
        assert_eq!(
            view.input(key(KeyCode::Char('?'), KeyModifiers::NONE)),
            None
        );
        assert!(view.help_open);
        assert!(view.working);
        assert!(rendered(&mut view, 125, 35).contains("/fast [MODE]"));
        assert_eq!(view.input(key(KeyCode::Esc, KeyModifiers::NONE)), None);
        assert!(!view.help_open);
        assert!(!view.interrupting);
        view.input(Event::Paste("Is this working".into()));
        view.input(key(KeyCode::Char('?'), KeyModifiers::NONE));
        assert_eq!(view.editor.lines().join("\n"), "Is this working?");
        assert!(!view.help_open);
        let mut local = state();
        local.working(true);
        local.input(Event::Paste("/help".into()));
        assert_eq!(local.input(key(KeyCode::Enter, KeyModifiers::NONE)), None);
        assert!(local.help_open);
        local.input(key(KeyCode::Esc, KeyModifiers::NONE));
        local.input(Event::Paste("/fast on".into()));
        assert_eq!(
            local.input(key(KeyCode::Enter, KeyModifiers::NONE)),
            Some(TuiInput::Command(ChatCommand::Fast {
                mode: Some(FastMode::On)
            }))
        );
        assert!(local.working);
        assert!(!local.interrupting);
        assert!(local.messages.is_empty());
        local.input(Event::Paste("/fast maybe".into()));
        assert_eq!(local.input(key(KeyCode::Enter, KeyModifiers::NONE)), None);
        assert_eq!(local.editor.lines().join("\n"), "/fast maybe");
        assert!(local.working);
        assert_eq!(view.messages[0].text, "A later request");
        let mut small = state();
        small.input(key(KeyCode::Char('?'), KeyModifiers::NONE));
        let top = rendered(&mut small, 80, 14);
        small.input(key(KeyCode::PageDown, KeyModifiers::NONE));
        let lower = rendered(&mut small, 80, 14);
        assert_ne!(top, lower);
        assert!(small.help_scroll > 0);
        assert_eq!(small.scroll, 0);
        small.input(key(KeyCode::Esc, KeyModifiers::NONE));
        assert!(!small.help_open);
    }
    #[test]
    fn footer_uses_distinct_model_context_status_and_key_colors() {
        use ratatui::style::Color;
        let mut view = state();
        let mut terminal = Terminal::new(TestBackend::new(110, 24)).unwrap();
        terminal.draw(|frame| view.draw(frame)).unwrap();
        let buffer = terminal.backend().buffer();
        let footer = (0..110)
            .map(|x| buffer[(x, 22)].symbol())
            .collect::<String>();
        assert_eq!(buffer[(0, 22)].fg, Color::Cyan);
        for (text, color) in [
            ("high", Color::Magenta),
            ("/workspace/example", Color::Blue),
            ("Ready", Color::Green),
        ] {
            let column = footer[..footer.find(text).unwrap()].chars().count();
            assert_eq!(buffer[(u16::try_from(column).unwrap(), 22)].fg, color);
        }
        assert_eq!(buffer[(0, 23)].fg, Color::Yellow);
    }
    #[test]
    fn authoritative_worker_settings_replace_launch_defaults_without_replacing_its_context() {
        let mut view = state();
        view.event(RuntimeEventKind::TaskReady {
            conversation_id: "worker".into(),
            title: "Review device configuration".into(),
        });
        let mut model = view.info.model.clone();
        model.model_id = "updated-model".into();
        model.reasoning = Some(Reasoning::Off);
        model.fast = true;
        view.event(RuntimeEventKind::ConversationSettings {
            settings: crate::protocol::ConversationSettings {
                conversation_id: "worker".into(),
                task_id: None,
                agent_id: None,
                model: model.clone(),
                catalog: vec![],
            },
        });
        assert_eq!(view.info.model, model);
        assert_eq!(view.info.title, "Review device configuration");
        assert_eq!(view.info.cwd, "/workspace/example");
        let text = rendered(&mut view, 110, 24);
        assert!(text.contains("updated-model · off · fast"));
        assert!(text.contains("Review device configuration"));
    }
    #[test]
    fn terminal_title_is_bounded_sanitized_and_uses_the_native_osc_frame() {
        use crossterm::Command;
        let mut info = state().info;
        info.title = "Review 🦀 \u{1b}]52;unsafe\u{7}\u{202e}".into();
        let title = crate::tui::terminal_title(&info);
        assert!(!title.chars().any(char::is_control));
        assert!(!title.contains('\u{202e}'));
        assert!(title.ends_with(" | example"));
        let mut output = String::new();
        crate::tui::WindowTitle(&title)
            .write_ansi(&mut output)
            .unwrap();
        assert!(output.starts_with("\u{1b}]0;"));
        assert!(output.ends_with('\u{7}'));
        assert_eq!(output.matches('\u{1b}').count(), 1);
        assert_eq!(output.matches('\u{7}').count(), 1);
        info.title = "界".repeat(1000);
        assert_eq!(crate::tui::terminal_title(&info).chars().count(), 160);
    }
    #[test]
    fn control_c_detaches_main_chat_while_escape_explicitly_stops_it() {
        let mut view = state();
        view.working(true);
        view.input(Event::Paste("Unsent correction".into()));
        assert_eq!(
            view.input(key(KeyCode::Char('c'), KeyModifiers::CONTROL)),
            Some(TuiInput::Exit)
        );
        assert!(!view.interrupting);
        assert_eq!(view.editor.lines().join("\n"), "Unsent correction");
        let mut view = state();
        view.working(true);
        assert_eq!(
            view.input(key(KeyCode::Esc, KeyModifiers::NONE)),
            Some(TuiInput::Interrupt)
        );
    }
    #[test]
    fn history_prepends_in_frame_order_and_scroll_has_an_explicit_follow_mode() {
        let mut state = state();
        state.push(crate::tui::Role::Agent, "Latest answer".into());
        state.event(RuntimeEventKind::History {
            conversation_id: "main".into(),
            messages: vec![],
            next_cursor: Some("older".into()),
        });
        assert_eq!(
            state.input(key(KeyCode::Char('r'), KeyModifiers::CONTROL)),
            Some(TuiInput::History)
        );
        for (id, text) in [("old1", "Oldest question"), ("old2", "Earlier answer")] {
            state.event(RuntimeEventKind::History {
                conversation_id: "one".into(),
                messages: vec![HistoryMessage {
                    entry_id: id.into(),
                    role: HistoryRole::User,
                    text: text.into(),
                    continuation: false,
                    final_chunk: true,
                    tool: None,
                }],
                next_cursor: None,
            });
        }
        assert_eq!(
            state
                .messages
                .iter()
                .map(|message| message.text.as_str())
                .collect::<Vec<_>>(),
            ["Oldest question", "Earlier answer", "Latest answer"]
        );
        for index in 0..30 {
            state.push(crate::tui::Role::Agent, format!("Answer {index}"));
        }
        state.event(RuntimeEventKind::Done);
        state.input(key(KeyCode::End, KeyModifiers::CONTROL));
        let latest = rendered(&mut state, 100, 14);
        assert!(latest.contains("Answer 29"));
        state.input(key(KeyCode::Home, KeyModifiers::CONTROL));
        let older = rendered(&mut state, 100, 14);
        assert!(older.contains("Oldest question"));
        assert!(!older.contains("Answer 29"));
        state.input(key(KeyCode::End, KeyModifiers::CONTROL));
        assert!(rendered(&mut state, 100, 14).contains("Answer 29"));
    }
    #[test]
    fn prompt_recall_traverses_sent_and_queued_input_without_submitting_it() {
        let mut view = state();
        view.input(Event::Paste("First request".into()));
        assert_eq!(
            view.input(key(KeyCode::Enter, KeyModifiers::NONE)),
            Some(TuiInput::Submit("First request".into()))
        );
        view.input(Event::Paste("Next request\nwith more context 界".into()));
        assert_eq!(
            view.input(key(KeyCode::Tab, KeyModifiers::NONE)),
            Some(TuiInput::Queue("Next request\nwith more context 界".into()))
        );
        assert_eq!(view.input(key(KeyCode::Up, KeyModifiers::NONE)), None);
        assert_eq!(
            view.editor.lines().join("\n"),
            "Next request\nwith more context 界"
        );
        assert_eq!(
            view.editor.cursor(),
            (1, "with more context 界".chars().count())
        );
        assert!(rendered(&mut view, 80, 20).contains("with more context 界"));
        view.input(key(KeyCode::Up, KeyModifiers::NONE));
        assert_eq!(view.editor.lines().join("\n"), "First request");
        view.input(key(KeyCode::Down, KeyModifiers::NONE));
        assert_eq!(
            view.editor.lines().join("\n"),
            "Next request\nwith more context 界"
        );
        view.input(key(KeyCode::Down, KeyModifiers::NONE));
        assert_eq!(view.editor.lines().join("\n"), "");
        view.input(key(KeyCode::Down, KeyModifiers::NONE));
        assert_eq!(view.editor.lines().join("\n"), "");
    }
    #[test]
    fn prompt_recall_preserves_fresh_drafts_and_edits_inside_recalled_multiline_text() {
        let mut view = state();
        for text in ["Older request", "First line\nSecond line"] {
            view.input(Event::Paste(text.into()));
            view.input(key(KeyCode::Enter, KeyModifiers::NONE));
        }
        view.input(key(KeyCode::Up, KeyModifiers::NONE));
        view.input(key(KeyCode::Left, KeyModifiers::NONE));
        view.input(key(KeyCode::Up, KeyModifiers::NONE));
        assert_eq!(view.editor.lines().join("\n"), "First line\nSecond line");
        assert_eq!(view.editor.cursor().0, 0);
        view.input(key(KeyCode::Char('!'), KeyModifiers::NONE));
        let edited = view.editor.lines().join("\n");
        view.input(key(KeyCode::Down, KeyModifiers::NONE));
        view.input(key(KeyCode::Down, KeyModifiers::NONE));
        assert_eq!(view.editor.lines().join("\n"), edited);
        view.editor = crate::tui::editor();
        view.input(Event::Paste("Fresh draft\nstill being written".into()));
        view.input(key(KeyCode::Up, KeyModifiers::NONE));
        view.input(key(KeyCode::Down, KeyModifiers::NONE));
        assert_eq!(
            view.editor.lines().join("\n"),
            "Fresh draft\nstill being written"
        );
    }
    #[test]
    fn prompt_recall_merges_saved_user_chunks_and_live_acknowledgements_by_entry_identity() {
        let mut view = state();
        let history = |messages| RuntimeEventKind::History {
            conversation_id: "main".into(),
            messages,
            next_cursor: None,
        };
        let message = |id: &str, role, text: &str, continuation| HistoryMessage {
            entry_id: id.into(),
            role,
            text: text.into(),
            continuation,
            final_chunk: true,
            tool: None,
        };
        view.event(history(vec![
            message("old", HistoryRole::User, "Saved ", false),
            message("old", HistoryRole::User, "request", true),
            message(
                "reply",
                HistoryRole::Assistant,
                "Never recall an assistant reply",
                false,
            ),
        ]));
        view.event(RuntimeEventKind::Done);
        view.input(Event::Paste("New request".into()));
        view.input(key(KeyCode::Enter, KeyModifiers::NONE));
        view.event(RuntimeEventKind::Message {
            message: message("new", HistoryRole::User, "New request", false),
        });
        view.event(history(vec![
            message("old", HistoryRole::User, "Saved request", false),
            message("new", HistoryRole::User, "New request", false),
        ]));
        view.event(RuntimeEventKind::Done);
        view.input(key(KeyCode::Up, KeyModifiers::NONE));
        assert_eq!(view.editor.lines().join("\n"), "New request");
        view.input(key(KeyCode::Up, KeyModifiers::NONE));
        assert_eq!(view.editor.lines().join("\n"), "Saved request");
        view.input(key(KeyCode::Down, KeyModifiers::NONE));
        assert_eq!(view.editor.lines().join("\n"), "New request");
        view.input(key(KeyCode::Down, KeyModifiers::NONE));
        assert_eq!(view.editor.lines().join("\n"), "");
    }
    #[test]
    fn typed_commentary_is_visually_distinct_and_only_user_input_is_recalled() {
        use ratatui::style::Color;
        let mut view = state();
        view.event(RuntimeEventKind::History {
            conversation_id: "main".into(),
            messages: [
                (HistoryRole::User, "Actual user request"),
                (HistoryRole::Commentary, "PROGRESS_BODY"),
                (HistoryRole::PartialAnswer, "PARTIAL_BODY"),
                (HistoryRole::Final, "FINAL_BODY"),
                (HistoryRole::Notice, "NOTICE_BODY"),
            ]
            .into_iter()
            .enumerate()
            .map(|(index, (role, text))| HistoryMessage {
                entry_id: index.to_string(),
                role,
                text: text.into(),
                continuation: false,
                final_chunk: true,
                tool: None,
            })
            .collect(),
            next_cursor: None,
        });
        let mut terminal = Terminal::new(TestBackend::new(100, 30)).unwrap();
        terminal.draw(|frame| view.draw(frame)).unwrap();
        let buffer = terminal.backend().buffer();
        let body_color = |text: &str| {
            buffer
                .content
                .windows(text.len())
                .find(|cells| {
                    cells
                        .iter()
                        .zip(text.chars())
                        .all(|(cell, ch)| cell.symbol() == ch.to_string())
                })
                .unwrap()[0]
                .fg
        };
        assert_eq!(body_color("PROGRESS_BODY"), Color::DarkGray);
        assert_ne!(body_color("FINAL_BODY"), Color::DarkGray);
        assert_ne!(body_color("PARTIAL_BODY"), Color::DarkGray);
        assert!(rendered(&mut view, 100, 30).contains("Agent · partial"));
        view.input(key(KeyCode::Up, KeyModifiers::NONE));
        assert_eq!(view.editor.lines().join("\n"), "Actual user request");
    }
    #[test]
    fn older_identical_prompt_does_not_claim_an_unacknowledged_local_submission() {
        let mut view = state();
        let frame = |id: &str, text: &str| RuntimeEventKind::History {
            conversation_id: "main".into(),
            messages: vec![HistoryMessage {
                entry_id: id.into(),
                role: HistoryRole::User,
                text: text.into(),
                continuation: false,
                final_chunk: true,
                tool: None,
            }],
            next_cursor: Some("older".into()),
        };
        view.event(frame("recent", "A different request"));
        view.event(RuntimeEventKind::Done);
        view.input(Event::Paste("Please continue".into()));
        view.input(key(KeyCode::Enter, KeyModifiers::NONE));
        assert_eq!(
            view.input(key(KeyCode::Char('r'), KeyModifiers::CONTROL)),
            Some(TuiInput::History)
        );
        view.event(frame("old", "Please continue"));
        view.event(RuntimeEventKind::Done);
        view.input(key(KeyCode::Up, KeyModifiers::NONE));
        assert_eq!(view.editor.lines().join("\n"), "Please continue");
        view.input(key(KeyCode::Up, KeyModifiers::NONE));
        assert_eq!(view.editor.lines().join("\n"), "A different request");
        view.input(key(KeyCode::Up, KeyModifiers::NONE));
        assert_eq!(view.editor.lines().join("\n"), "Please continue");
    }
    #[test]
    fn slash_completion_uses_the_visible_choice_and_preserves_the_command_draft() {
        let mut view = state();
        view.input(Event::Paste("/f".into()));
        let text = rendered(&mut view, 100, 20);
        assert!(text.contains("/fast"));
        assert!(text.contains("/feedback"));
        view.input(key(KeyCode::Down, KeyModifiers::NONE));
        assert_eq!(view.input(key(KeyCode::Tab, KeyModifiers::NONE)), None);
        assert_eq!(view.editor.lines().join("\n"), "/feedback ");
        view.input(Event::Paste("Fix this behavior".into()));
        assert_eq!(
            view.input(key(KeyCode::Enter, KeyModifiers::NONE)),
            Some(TuiInput::Feedback("Fix this behavior".into()))
        );
        view.input(Event::Paste("Ordinary next turn".into()));
        assert_eq!(
            view.input(key(KeyCode::Tab, KeyModifiers::NONE)),
            Some(TuiInput::Queue("Ordinary next turn".into()))
        );
    }
    #[test]
    fn slash_completion_uses_typed_values_and_enter_dispatches_the_selected_command() {
        use crate::{chat_commands::ChatCommand, protocol::FastMode};
        let mut view = state();
        view.input(Event::Paste("/fast o".into()));
        let text = rendered(&mut view, 100, 20);
        assert!(text.contains("/fast on"));
        assert!(text.contains("/fast off"));
        view.input(key(KeyCode::Down, KeyModifiers::NONE));
        assert_eq!(
            view.input(key(KeyCode::Enter, KeyModifiers::NONE)),
            Some(TuiInput::Command(ChatCommand::Fast {
                mode: Some(FastMode::Off)
            }))
        );
        view.input(Event::Paste("/rea".into()));
        assert_eq!(
            view.input(key(KeyCode::Enter, KeyModifiers::NONE)),
            Some(TuiInput::Command(ChatCommand::Reasoning { level: None }))
        );
        view.input(Event::Paste("/feedback".into()));
        assert_eq!(view.input(key(KeyCode::Enter, KeyModifiers::NONE)), None);
        assert_eq!(view.editor.lines().join("\n"), "/feedback ");
    }
    #[test]
    fn slash_completion_dismissal_does_not_interrupt_or_replace_unmatched_text() {
        let mut view = state();
        view.working(true);
        view.input(Event::Paste("/fa".into()));
        assert_eq!(view.input(key(KeyCode::Esc, KeyModifiers::NONE)), None);
        assert!(!view.interrupting);
        assert_eq!(view.editor.lines().join("\n"), "/fa");
        assert!(view.completion.is_none());
        assert_eq!(
            view.input(key(KeyCode::Esc, KeyModifiers::NONE)),
            Some(TuiInput::Interrupt)
        );
        view.input(Event::Paste("z".into()));
        assert!(view.completion.is_none());
        assert_eq!(view.input(key(KeyCode::Tab, KeyModifiers::NONE)), None);
        assert_eq!(view.editor.lines().join("\n"), "/faz");
        assert!(rendered(&mut view, 100, 20).contains("Error"));
    }
    #[test]
    fn slash_completion_preserves_multiline_tails_and_recalled_commands_keep_arrow_navigation() {
        let mut view = state();
        view.input(Event::Paste("/feedback prior problem".into()));
        view.input(key(KeyCode::Enter, KeyModifiers::NONE));
        view.input(Event::Paste("/f\nKeep this text".into()));
        assert!(view.completion.is_none());
        view.editor
            .move_cursor(ratatui_textarea::CursorMove::Jump(0, 2));
        view.input(key(KeyCode::Tab, KeyModifiers::NONE));
        assert_eq!(view.editor.lines().join("\n"), "/fast \nKeep this text");
        view.editor = crate::tui::editor();
        view.input(key(KeyCode::Up, KeyModifiers::NONE));
        assert_eq!(view.editor.lines().join("\n"), "/feedback prior problem");
        assert!(view.completion.is_none());
        view.input(key(KeyCode::Down, KeyModifiers::NONE));
        assert_eq!(view.editor.lines().join("\n"), "");
    }
    #[test]
    fn scroll_requests_older_history_at_the_loaded_top_without_losing_the_visible_anchor() {
        let mut view = state();
        view.event(RuntimeEventKind::History {
            conversation_id: "main".into(),
            messages: vec![HistoryMessage {
                entry_id: "latest".into(),
                role: HistoryRole::Assistant,
                text: (0..40).map(|i| format!("Line {i}\n\n")).collect(),
                continuation: false,
                final_chunk: true,
                tool: None,
            }],
            next_cursor: Some("older".into()),
        });
        rendered(&mut view, 80, 20);
        let mut request = None;
        for _ in 0..8 {
            request = view.input(key(KeyCode::PageUp, KeyModifiers::NONE));
            if request.is_some() {
                break;
            }
            rendered(&mut view, 80, 20);
        }
        assert_eq!(request, Some(TuiInput::History));
        let before = rendered(&mut view, 80, 20);
        assert_eq!(
            view.input(key(KeyCode::PageUp, KeyModifiers::NONE)),
            None,
            "Only one page may be in flight"
        );
        view.event(RuntimeEventKind::History {
            conversation_id: "main".into(),
            messages: vec![HistoryMessage {
                entry_id: "older".into(),
                role: HistoryRole::Assistant,
                text: "Older saved answer\n".repeat(30),
                continuation: false,
                final_chunk: true,
                tool: None,
            }],
            next_cursor: None,
        });
        view.event(RuntimeEventKind::Done);
        assert_eq!(
            rendered(&mut view, 80, 20),
            before,
            "Prepending must retain the visible text"
        );
        view.input(key(KeyCode::PageUp, KeyModifiers::NONE));
        assert!(rendered(&mut view, 80, 20).contains("Older saved answer"));
        assert_eq!(
            view.input(key(KeyCode::Home, KeyModifiers::CONTROL)),
            None,
            "Exhausted pages are not requested again"
        );
    }
    #[test]
    fn pending_input_shows_delivery_state_and_same_text_inputs_keep_distinct_native_identities() {
        let mut view = state();
        view.pending_input(
            "one".into(),
            "Same correction".into(),
            crate::protocol::InputMode::Steer,
        );
        assert!(rendered(&mut view, 100, 30).contains("You · sending"));
        view.event(RuntimeEventKind::InputAccepted {
            input_id: "one".into(),
        });
        assert!(rendered(&mut view, 100, 30).contains("You · steering, waiting"));
        view.pending_input(
            "two".into(),
            "Same correction".into(),
            crate::protocol::InputMode::Steer,
        );
        view.event(RuntimeEventKind::InputAccepted {
            input_id: "two".into(),
        });
        view.event(RuntimeEventKind::InputPlaced {
            input_id: "one".into(),
            entry_id: "native-one".into(),
        });
        view.event(RuntimeEventKind::Message {
            message: HistoryMessage {
                entry_id: "native-one".into(),
                role: HistoryRole::User,
                text: "Same correction".into(),
                continuation: false,
                final_chunk: true,
                tool: None,
            },
        });
        assert_eq!(
            view.messages
                .iter()
                .filter(|message| message.text == "Same correction")
                .count(),
            2
        );
        assert_eq!(view.messages[0].id.as_deref(), Some("native-one"));
        assert!(view.messages[1].id.is_none());
        view.event(RuntimeEventKind::InputRejected {
            input_id: "two".into(),
            message: "Not accepted".into(),
        });
        assert_eq!(
            view.messages
                .iter()
                .filter(|message| message.text == "Same correction")
                .count(),
            1
        );
        view.event(RuntimeEventKind::InputRejected {
            input_id: "one".into(),
            message: "Late transport error".into(),
        });
        assert_eq!(view.messages[0].id.as_deref(), Some("native-one"));
    }
    #[test]
    fn placed_input_replaces_preview_with_native_chunks_once_and_preserves_later_rows() {
        let mut view = state();
        let text = "x".repeat(8192) + "\nFinal native part";
        view.pending_input(
            "input".into(),
            text.clone(),
            crate::protocol::InputMode::Steer,
        );
        view.event(RuntimeEventKind::InputPlaced {
            input_id: "input".into(),
            entry_id: "native".into(),
        });
        view.push(crate::tui::Role::Notice, "A later update".into());
        for (text, continuation) in [
            ("x".repeat(8192), false),
            ("\nFinal native part".into(), true),
        ] {
            view.event(RuntimeEventKind::Message {
                message: HistoryMessage {
                    entry_id: "native".into(),
                    role: HistoryRole::User,
                    text,
                    continuation,
                    final_chunk: true,
                    tool: None,
                },
            });
        }
        assert_eq!(view.messages[0].text, text);
        assert_eq!(view.messages[1].text, "A later update");
        assert_eq!(view.messages.len(), 2);
        view.event(RuntimeEventKind::InputAccepted {
            input_id: "input".into(),
        });
        assert!(!rendered(&mut view, 100, 30).contains("waiting"));
    }
    #[test]
    fn completed_tools_and_reasoning_keep_their_original_chronological_positions() {
        let mut view = state();
        view.event(RuntimeEventKind::Activity {
            activity: ModelActivity::Thinking {
                text: "EARLY_THOUGHT".into(),
            },
        });
        view.event(RuntimeEventKind::Activity {
            activity: ModelActivity::ToolStarted {
                call_id: "call".into(),
                name: "earlier_tool".into(),
            },
        });
        view.push(crate::tui::Role::Notice, "LATER_NOTICE".into());
        view.push(crate::tui::Role::User, "NEW_CORRECTION".into());
        view.event(RuntimeEventKind::Activity {
            activity: ModelActivity::Thinking {
                text: "LATER_THOUGHT".into(),
            },
        });
        view.event(RuntimeEventKind::Activity {
            activity: ModelActivity::ToolFinished {
                call_id: "call".into(),
                name: "earlier_tool".into(),
            },
        });
        let text = rendered(&mut view, 100, 40);
        let positions = [
            "EARLY_THOUGHT",
            "✓ earlier_tool",
            "LATER_NOTICE",
            "NEW_CORRECTION",
            "LATER_THOUGHT",
        ]
        .map(|value| text.find(value).unwrap());
        assert!(positions.windows(2).all(|pair| pair[0] < pair[1]), "{text}");
        view.event(RuntimeEventKind::Answer {
            entry_id: None,
            conversation_id: "main".into(),
            text: "FINAL_ANSWER".into(),
        });
        let text = rendered(&mut view, 100, 40);
        assert!(text.find("✓ earlier_tool").unwrap() < text.find("FINAL_ANSWER").unwrap());
        assert_eq!(text.matches("earlier_tool").count(), 1);
    }
    #[test]
    fn reopened_tools_update_by_native_call_identity_and_failure_is_not_downgraded() {
        use crate::protocol::{ToolHistory, ToolStatus};
        let mut view = state();
        view.event(RuntimeEventKind::History {
            conversation_id: "main".into(),
            messages: vec![
                HistoryMessage {
                    entry_id: "call-entry".into(),
                    role: HistoryRole::Tool,
                    text: "read_source".into(),
                    continuation: false,
                    final_chunk: true,
                    tool: Some(ToolHistory {
                        call_id: "native-call".into(),
                        name: "read_source".into(),
                        status: ToolStatus::Running,
                    }),
                },
                HistoryMessage {
                    entry_id: "user".into(),
                    role: HistoryRole::User,
                    text: "NEW_REQUEST".into(),
                    continuation: false,
                    final_chunk: true,
                    tool: None,
                },
            ],
            next_cursor: None,
        });
        view.event(RuntimeEventKind::Done);
        view.event(RuntimeEventKind::Message {
            message: HistoryMessage {
                entry_id: "result-entry".into(),
                role: HistoryRole::Tool,
                text: "read_source finished".into(),
                continuation: false,
                final_chunk: true,
                tool: Some(ToolHistory {
                    call_id: "native-call".into(),
                    name: "read_source".into(),
                    status: ToolStatus::Failed,
                }),
            },
        });
        view.event(RuntimeEventKind::Activity {
            activity: ModelActivity::ToolFinished {
                call_id: "native-call".into(),
                name: "read_source".into(),
            },
        });
        let text = rendered(&mut view, 100, 30);
        assert_eq!(text.matches("read_source").count(), 1);
        assert!(text.find("✗ read_source").unwrap() < text.find("NEW_REQUEST").unwrap());
        assert!(!text.contains("✓ read_source"));
    }
    #[test]
    fn composer_expands_for_explicit_newlines_and_native_word_wrapping_on_small_terminals() {
        let mut view = state();
        view.input(Event::Paste("First line".into()));
        view.input(key(KeyCode::Enter, KeyModifiers::SHIFT));
        view.input(Event::Paste("Second line".into()));
        let text = rendered(&mut view, 40, 15);
        assert!(text.contains("First line"));
        assert!(text.contains("Second line"));
        assert_eq!(view.editor_height(40, 6), 4);
        view.editor = crate::tui::editor();
        view.input(Event::Paste("abcdefghijklmnopqrstuvwx".into()));
        rendered(&mut view, 16, 15);
        assert_eq!(
            view.editor_height(16, 6),
            4,
            "Long words must wrap using the actual editor's glyph fallback"
        );
        view.editor = crate::tui::editor();
        view.input(Event::Paste(
            "one\ntwo\nthree\nfour\nfive\nsix\nseven\nCURSOR_END".into(),
        ));
        let text = rendered(&mut view, 24, 10);
        assert!(text.contains("CURSOR_END"), "{text}");
        assert_eq!(view.editor.cursor().0, 7);
    }
    #[test]
    fn refreshed_history_keeps_overlapping_entries_and_distinct_blocks_once() {
        let mut view = state();
        let old = vec![
            HistoryMessage {
                entry_id: "old-user".into(),
                role: HistoryRole::User,
                text: "Original question".into(),
                continuation: false,
                final_chunk: true,
                tool: None,
            },
            HistoryMessage {
                entry_id: "old-answer".into(),
                role: HistoryRole::Thinking,
                text: "First thinking block".into(),
                continuation: false,
                final_chunk: true,
                tool: None,
            },
            HistoryMessage {
                entry_id: "old-answer".into(),
                role: HistoryRole::Thinking,
                text: "Second thinking block".into(),
                continuation: false,
                final_chunk: true,
                tool: None,
            },
            HistoryMessage {
                entry_id: "old-answer".into(),
                role: HistoryRole::Assistant,
                text: "Original answer".into(),
                continuation: false,
                final_chunk: true,
                tool: None,
            },
        ];
        view.event(RuntimeEventKind::History {
            conversation_id: "main".into(),
            messages: old.clone(),
            next_cursor: None,
        });
        view.event(RuntimeEventKind::Done);
        let mut refreshed = old;
        refreshed.push(HistoryMessage {
            entry_id: "late-answer".into(),
            role: HistoryRole::Assistant,
            text: "Finished while attaching".into(),
            continuation: false,
            final_chunk: true,
            tool: None,
        });
        for message in refreshed {
            view.event(RuntimeEventKind::History {
                conversation_id: "main".into(),
                messages: vec![message],
                next_cursor: None,
            });
        }
        view.event(RuntimeEventKind::Done);
        assert_eq!(
            view.messages
                .iter()
                .map(|message| message.text.as_str())
                .collect::<Vec<_>>(),
            [
                "Original question",
                "First thinking block",
                "Second thinking block",
                "Original answer",
                "Finished while attaching"
            ]
        );
        assert_eq!(
            rendered(&mut view, 110, 30)
                .matches("Finished while attaching")
                .count(),
            1
        );
    }

    #[test]
    fn scroll_stays_on_reading_position_while_new_activity_arrives() {
        let mut state = state();
        for index in 0..30 {
            state.push(crate::tui::Role::Agent, format!("Answer {index}"));
        }
        rendered(&mut state, 100, 14);
        state.input(key(KeyCode::PageUp, KeyModifiers::NONE));
        let before = rendered(&mut state, 100, 14);
        state.push(crate::tui::Role::Agent, "New answer while reading".into());
        let after = rendered(&mut state, 100, 14);
        assert_eq!(before, after);
        assert!(!after.contains("New answer while reading"));
    }

    #[tokio::test]
    #[ignore = "requires an isolated native PTY; no provider or model calls"]
    async fn native_terminal_restores_on_stop_and_setup_scope_error() {
        let (handle, _input, guard) = crate::tui::Tui::start(state().info).unwrap();
        assert!(crossterm::terminal::is_raw_mode_enabled().unwrap());
        assert_eq!(handle.draft().await.unwrap(), "");
        handle
            .event(RuntimeEventKind::Answer {
                entry_id: None,
                conversation_id: "synthetic".into(),
                text: "**Native terminal check**".into(),
            })
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        guard.stop().await.unwrap();
        assert!(!crossterm::terminal::is_raw_mode_enabled().unwrap());
        let scoped_failure = || -> anyhow::Result<()> {
            let _screen = crate::tui::Screen::open()?;
            anyhow::bail!("synthetic error after terminal setup");
        };
        assert!(scoped_failure().is_err());
        assert!(!crossterm::terminal::is_raw_mode_enabled().unwrap());
    }

    #[test]
    fn committed_input_identity_and_rejection_preserve_drafts_and_active_work() {
        let mut view = state();
        view.pending_input(
            "review".into(),
            "Review this complete input".into(),
            crate::protocol::InputMode::Steer,
        );
        view.event(RuntimeEventKind::InputPlaced {
            input_id: "review".into(),
            entry_id: "chief".into(),
        });
        view.event(RuntimeEventKind::Message {
            message: HistoryMessage {
                entry_id: "chief".into(),
                role: HistoryRole::User,
                text: "Review".into(),
                continuation: false,
                final_chunk: true,
                tool: None,
            },
        });
        assert_eq!(view.messages[0].text, "Review this complete input");
        view.event(RuntimeEventKind::InputRejected {
            input_id: "rejected".into(),
            message: "Another input could not be saved".into(),
        });
        view.input(Event::Paste("Draft correction".into()));
        assert_eq!(
            view.input(key(KeyCode::Esc, KeyModifiers::NONE)),
            Some(TuiInput::Interrupt)
        );
        assert_eq!(view.editor.lines().join("\n"), "Draft correction");
        view.event(RuntimeEventKind::Interrupted);
        assert!(rendered(&mut view, 100, 20).contains("Draft correction"));
        assert!(!view.working);
        let mut chunked = state();
        chunked.pending_input(
            "local-input".into(),
            "Complete local input".into(),
            crate::protocol::InputMode::Steer,
        );
        chunked.event(RuntimeEventKind::InputPlaced {
            input_id: "local-input".into(),
            entry_id: "local".into(),
        });
        for (text, continuation) in [("Complete ", false), ("local input", true)] {
            chunked.event(RuntimeEventKind::Message {
                message: HistoryMessage {
                    entry_id: "local".into(),
                    role: HistoryRole::User,
                    text: text.into(),
                    continuation,
                    final_chunk: true,
                    tool: None,
                },
            });
        }
        assert_eq!(chunked.messages.len(), 1);
        assert_eq!(chunked.messages[0].id.as_deref(), Some("local"));
        assert_eq!(chunked.messages[0].text, "Complete local input");
    }
}
