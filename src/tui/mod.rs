//! Terminal presentation only. Request ownership, model calls and durable input stay outside this module.
pub mod attachments;
mod conversations;
mod inline;
mod markdown;
mod transcript;

use crate::tui::{
    attachments::{ComposerFile, ComposerInput, dropped_files},
    conversations::ConversationPicker,
    inline::{CellOutput, Output, Screen, View},
    transcript::CachedText,
};
use crate::{
    chat_commands::{ChatCommand, Completion, command_help, completions},
    models::{ModelProvider, ModelSelection},
    protocol::{
        ErrorCode, HistoryMessage, HistoryRole, InputMode, ModelActivity, RuntimeEventKind,
        SavedConversation, ToolStatus,
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
    pub model: Option<ModelSelection>,
    pub cwd: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum TuiInput {
    Submit(ComposerInput),
    Queue(ComposerInput),
    Feedback(ComposerInput),
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ObservationState {
    Connecting,
    Connected,
    Reconnecting,
    Disconnected,
}

enum Update {
    Event(Box<RuntimeEventKind>),
    Status(TuiInfo),
    Working(bool),
    Observation(ObservationState),
    InputUncertain(String),
    Draft(tokio::sync::oneshot::Sender<ComposerInput>),
    Info(tokio::sync::oneshot::Sender<TuiInfo>),
    Notice(String),
    RestoreInput(ComposerInput),
    SetDraft(ComposerInput),
    PendingInput {
        input_id: String,
        text: String,
        attachments: Vec<AttachmentLabel>,
        mode: InputMode,
    },
    HistoryReplay(HistoryUpdate),
    ChooseConversation {
        choices: Vec<SavedConversation>,
        query: String,
        reply: tokio::sync::oneshot::Sender<Option<String>>,
    },
    ResetConversation(TuiInfo),
    Stop,
}

enum HistoryUpdate {
    Begin(uuid::Uuid),
    Reconcile(uuid::Uuid),
    Page {
        id: uuid::Uuid,
        events: Vec<RuntimeEventKind>,
    },
    End {
        id: uuid::Uuid,
        complete: bool,
    },
}

/// Owns one initial replay. Cancelled reads cannot append to a replacement view.
pub struct HistoryReplay {
    sender: mpsc::Sender<Update>,
    id: uuid::Uuid,
    finished: bool,
}
impl HistoryReplay {
    pub fn page(&self, events: Vec<RuntimeEventKind>) -> Result<()> {
        self.sender
            .send(Update::HistoryReplay(HistoryUpdate::Page {
                id: self.id,
                events,
            }))
            .context("The terminal history view is closed")
    }
    pub fn finish(mut self) -> Result<()> {
        self.sender
            .send(Update::HistoryReplay(HistoryUpdate::End {
                id: self.id,
                complete: true,
            }))
            .context("The terminal history view is closed")?;
        self.finished = true;
        Ok(())
    }
}
impl Drop for HistoryReplay {
    fn drop(&mut self) {
        if !self.finished {
            let _ = self.sender.send(Update::HistoryReplay(HistoryUpdate::End {
                id: self.id,
                complete: false,
            }));
        }
    }
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
    pub fn begin_history_replay(&self) -> Result<HistoryReplay> {
        self.history_replay(false)
    }
    pub fn begin_history_reconciliation(&self) -> Result<HistoryReplay> {
        self.history_replay(true)
    }
    fn history_replay(&self, reconcile: bool) -> Result<HistoryReplay> {
        let id = uuid::Uuid::new_v4();
        self.send(Update::HistoryReplay(if reconcile {
            HistoryUpdate::Reconcile(id)
        } else {
            HistoryUpdate::Begin(id)
        }))?;
        Ok(HistoryReplay {
            sender: self.sender.clone(),
            id,
            finished: false,
        })
    }
    pub async fn choose_conversation(
        &self,
        choices: Vec<SavedConversation>,
        initial_query: String,
    ) -> Result<Option<String>> {
        let (reply, selection) = tokio::sync::oneshot::channel();
        self.send(Update::ChooseConversation {
            choices,
            query: initial_query,
            reply,
        })?;
        selection.await.context("The conversation picker closed")
    }
    pub fn reset_conversation(&self, info: TuiInfo) -> Result<()> {
        self.send(Update::ResetConversation(info))
    }
    pub fn set_status(&self, info: TuiInfo) -> Result<()> {
        self.send(Update::Status(info))
    }
    pub fn working(&self, working: bool) -> Result<()> {
        self.send(Update::Working(working))
    }
    pub fn observation(&self, state: ObservationState) -> Result<()> {
        self.send(Update::Observation(state))
    }
    pub fn input_uncertain(&self, input_id: String) -> Result<()> {
        self.send(Update::InputUncertain(input_id))
    }
    pub async fn draft(&self) -> Result<String> {
        Ok(self.composer_draft().await?.text)
    }
    pub async fn composer_draft(&self) -> Result<ComposerInput> {
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
    pub fn restore_composer(&self, input: ComposerInput) -> Result<()> {
        self.send(Update::RestoreInput(input))
    }
    pub fn set_composer(&self, input: ComposerInput) -> Result<()> {
        self.send(Update::SetDraft(input))
    }
    pub fn pending_composer(
        &self,
        input_id: String,
        input: &ComposerInput,
        mode: InputMode,
    ) -> Result<()> {
        self.send(Update::PendingInput {
            input_id,
            text: input.text.clone(),
            attachments: input
                .attachments
                .iter()
                .map(AttachmentLabel::uploaded)
                .chain(input.files.iter().map(|file| AttachmentLabel {
                    id: None,
                    name: file.name.clone(),
                    size_bytes: file.size_bytes,
                }))
                .collect(),
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
    pub fn connecting(
        title: String,
        cwd: String,
    ) -> Result<(TuiHandle, UnboundedReceiver<TuiInput>, TuiGuard)> {
        Self::start(TuiInfo {
            title,
            model: None,
            cwd,
        })
    }
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
                let mut state = State::new(info);
                if let Err(error) = screen.draw(&mut state) {
                    let _ = ready.send(Err(error));
                    return Ok(());
                }
                let _ = ready.send(Ok(()));
                run(&mut screen, updates, inputs, state)
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
    attachments: Vec<AttachmentLabel>,
}

#[derive(Clone)]
struct AttachmentLabel {
    id: Option<String>,
    name: String,
    size_bytes: u32,
}
impl AttachmentLabel {
    fn uploaded(file: &crate::attachments::AttachmentRef) -> Self {
        Self {
            id: Some(file.id.clone()),
            name: file.name.clone(),
            size_bytes: file.size_bytes,
        }
    }
}

enum InputDelivery {
    Submitting,
    Uncertain,
    Waiting,
    Placed { entry_id: String },
}
enum MessageKind {
    Text,
    Answer,
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

struct HistoryEntry {
    id: String,
    whole: bool,
    blocks: Vec<(Role, usize)>,
}

struct HistoryAnchor {
    position: usize,
    entry_id: Option<String>,
}
impl HistoryEntry {
    fn block(&mut self, role: Role, continuation: bool) -> usize {
        match self.blocks.iter_mut().find(|(saved, _)| *saved == role) {
            Some((_, count)) => {
                if !continuation {
                    *count += 1;
                }
                count.saturating_sub(1)
            }
            None => {
                self.blocks.push((role, 1));
                0
            }
        }
    }
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
            attachments: Vec::new(),
        }
    }
    fn with_output(mut self, output: CellOutput) -> Self {
        self.output = output;
        self
    }
    fn cached(&mut self) -> &mut CachedText {
        self.rendered.get_or_insert_with(|| {
            if let MessageKind::Tool { status, .. } = &self.kind {
                return CachedText::new(vec![
                    Line::styled(
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
                    ),
                    Line::default(),
                ]);
            }
            let label = if let MessageKind::Input { mode, delivery, .. } = &self.kind {
                match (mode, delivery) {
                    (_, InputDelivery::Submitting) => "You · sending",
                    (_, InputDelivery::Uncertain) => "You · delivery unconfirmed; not resent",
                    (InputMode::Steer, InputDelivery::Waiting) => "You · steering, waiting",
                    (InputMode::FollowUp, InputDelivery::Waiting) => "You · queued",
                    (_, InputDelivery::Placed { .. }) => "You",
                }
            } else {
                self.role.label()
            };
            let header = Line::styled(
                label,
                Style::default()
                    .fg(self.role.color())
                    .add_modifier(Modifier::BOLD),
            );
            let style = if matches!(self.role, Role::Thinking | Role::Tool | Role::Commentary) {
                Style::default().fg(Color::DarkGray)
            } else {
                Style::default()
            };
            let mut rendered = CachedText::markdown(header, &self.text, style);
            for file in &self.attachments {
                rendered.append_line(Line::styled(
                    format!(
                        "Attachment: {} · {} bytes",
                        markdown::plain(&file.name),
                        file.size_bytes
                    ),
                    Style::default().fg(Color::Cyan),
                ));
            }
            rendered
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
    files: Vec<ComposerFile>,
    attachments: Vec<crate::attachments::AttachmentRef>,
    input_history: InputHistory,
    completion: Option<CompletionMenu>,
    dismissed_completion: Option<String>,
    thinking: Option<u64>,
    unbound_thinking: Vec<u64>,
    next_thinking: u64,
    working: bool,
    compacting: bool,
    interrupting: bool,
    exiting: bool,
    worker: bool,
    observation: Option<ObservationState>,
    history_offset: Option<usize>,
    history_entry: Option<HistoryEntry>,
    loading_history: Option<HistoryLoad>,
    more_history: bool,
    history_replay: Option<uuid::Uuid>,
    history_reconciliation: Option<HistoryAnchor>,
    picker: Option<ConversationPicker>,
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
            files: Vec::new(),
            attachments: Vec::new(),
            input_history: InputHistory::default(),
            completion: None,
            dismissed_completion: None,
            thinking: None,
            unbound_thinking: Vec::new(),
            next_thinking: 0,
            working: false,
            compacting: false,
            interrupting: false,
            exiting: false,
            worker: false,
            observation: None,
            history_offset: Some(0),
            history_entry: None,
            loading_history: None,
            more_history: false,
            history_replay: None,
            history_reconciliation: None,
            picker: None,
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
    fn error_context(&self, detail: String) -> String {
        let mut context = Vec::new();
        if !self.info.title.is_empty() {
            context.push(format!("Chat: {}", self.info.title));
        }
        if !self.info.cwd.is_empty() {
            context.push(format!("Directory: {}", self.info.cwd));
        }
        if let Some(model) = &self.info.model {
            context.push(format!(
                "Model: {}/{}",
                model.provider.as_str(),
                model.model_id
            ));
        }
        format!(
            "{detail}\n\n{}\n\nRun `/feedback Investigate this error` to start a debugging task with this chat's context.",
            context.join("\n")
        )
    }
    fn invalidate(&mut self, index: usize) {
        self.output.cursor = self.output.cursor.min(index);
        self.dirty_from = Some(self.dirty_from.map_or(index, |dirty| dirty.min(index)));
    }
    fn working(&mut self, working: bool) {
        self.working = working;
        if !working {
            let pending = std::mem::take(&mut self.unbound_thinking);
            for (index, message) in self.messages.iter_mut().enumerate() {
                if matches!(message.kind, MessageKind::Thinking(id) if pending.contains(&id))
                    && message.output == CellOutput::Mutable
                {
                    message.output = CellOutput::Ready;
                    self.output.cursor = self.output.cursor.min(index);
                }
            }
            self.thinking = None;
            self.settle_legacy_answer();
            self.interrupting = false;
        }
        self.changed = true;
    }
    fn committed(&mut self, mut message: HistoryMessage, historical: bool) {
        let entry_id = message.entry_id.clone();
        let attachments = message.attachments.take().unwrap_or_default();
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
            // Live reasoning aggregates native blocks. Once its assistant entry
            // is known, that presentation owns the entry's whole reasoning section.
            if role == Role::Thinking
                && let Some(index) = self.messages.iter().rposition(|saved| {
                    saved.id.as_ref() == Some(&message.entry_id)
                        && matches!(saved.kind, MessageKind::Thinking(_))
                })
            {
                *offset = (*offset).max(index + 1);
                self.changed = true;
                return;
            }
            if self
                .history_entry
                .as_ref()
                .is_none_or(|entry| entry.id != message.entry_id)
            {
                // A legacy answer or placed input owns its whole entry. Native
                // messages own individual blocks, and may still be in flight.
                let existing = self
                    .messages
                    .iter()
                    .position(|saved| saved.id.as_ref() == Some(&message.entry_id));
                if let Some(index) = existing {
                    *offset = (*offset).max(index);
                }
                let whole = self.messages.iter().any(|saved| {
                    saved.id.as_ref() == Some(&message.entry_id)
                        && matches!(saved.kind, MessageKind::Answer | MessageKind::Input { .. })
                });
                self.history_entry = Some(HistoryEntry {
                    id: message.entry_id.clone(),
                    whole,
                    blocks: Vec::new(),
                });
            }
            if self.history_entry.as_ref().is_some_and(|entry| entry.whole) {
                if let Some(index) = self
                    .messages
                    .iter()
                    .rposition(|saved| saved.id.as_ref() == Some(&message.entry_id))
                {
                    *offset = (*offset).max(index + 1);
                }
                self.changed = true;
                return;
            }
            let block = self
                .history_entry
                .as_mut()
                .map(|entry| entry.block(role, message.continuation))
                .unwrap_or(0);
            let existing = self
                .messages
                .iter()
                .enumerate()
                .filter(|(_, saved)| {
                    saved.id.as_ref() == Some(&message.entry_id) && saved.role == role
                })
                .nth(block)
                .map(|(index, _)| index);
            if let Some(index) = existing {
                *offset = (*offset).max(index + 1);
                let saved = &mut self.messages[index];
                if saved.output != CellOutput::Printed {
                    if message.continuation {
                        saved.append(&message.text);
                    } else {
                        saved.text = message.text;
                        saved.rendered = None;
                    }
                    saved.output = output;
                    self.invalidate(index);
                }
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
        if !attachments.is_empty()
            && let Some(index) = self
                .messages
                .iter()
                .rposition(|saved| saved.id.as_ref() == Some(&entry_id) && saved.role == role)
        {
            let saved = &mut self.messages[index];
            for attachment in &attachments {
                if !saved
                    .attachments
                    .iter()
                    .any(|label| label.id.as_ref() == Some(&attachment.id))
                {
                    saved
                        .attachments
                        .push(AttachmentLabel::uploaded(attachment));
                }
            }
            saved.rendered = None;
            self.invalidate(index);
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
            && !self.unbound_thinking.contains(&id)
        {
            message.output = CellOutput::Ready;
        }
    }
    fn bind_thinking(&mut self, entry_id: &str) {
        let pending = std::mem::take(&mut self.unbound_thinking);
        if pending.is_empty() {
            return;
        }
        self.thinking = None;
        let historical = self.messages.iter().any(|message| {
            message.id.as_deref() == Some(entry_id)
                && message.role == Role::Thinking
                && !matches!(message.kind, MessageKind::Thinking(_))
        });
        if historical {
            // The other wire may have supplied canonical history first. Anonymous
            // previews are still mutable, so retiring them cannot duplicate scrollback.
            let mut first = None;
            for index in (0..self.messages.len()).rev() {
                if matches!(self.messages[index].kind, MessageKind::Thinking(id) if pending.contains(&id))
                {
                    self.messages.remove(index);
                    if let Some(offset) = &mut self.history_offset
                        && index < *offset
                    {
                        *offset -= 1;
                    }
                    first = Some(index);
                }
            }
            if let Some(index) = first {
                self.invalidate(index);
            }
        } else {
            let mut first = None;
            for (index, message) in self.messages.iter_mut().enumerate() {
                if matches!(message.kind, MessageKind::Thinking(id) if pending.contains(&id)) {
                    message.id = Some(entry_id.into());
                    if message.output == CellOutput::Mutable {
                        message.output = CellOutput::Ready;
                    }
                    first.get_or_insert(index);
                }
            }
            if let Some(index) = first {
                self.invalidate(index);
            }
        }
    }
    fn reset_observed_activity(&mut self) {
        // Every attach starts a fresh activity snapshot. Only anonymous,
        // uncommitted previews are replaced; canonical history remains owned.
        let pending = std::mem::take(&mut self.unbound_thinking);
        self.thinking = None;
        self.compacting = false;
        for index in (0..self.messages.len()).rev() {
            if self.messages[index].id.is_none()
                && matches!(self.messages[index].kind, MessageKind::Thinking(id) if pending.contains(&id))
            {
                self.messages.remove(index);
                if let Some(offset) = &mut self.history_offset
                    && index < *offset
                {
                    *offset -= 1;
                }
                self.invalidate(index);
            }
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
    fn input_uncertain(&mut self, input_id: &str) {
        if let Some(index) = self.messages.iter().position(|message| {
            matches!(&message.kind, MessageKind::Input {
                input_id: id, delivery: InputDelivery::Submitting, ..
            } if id == input_id)
        }) {
            if let MessageKind::Input { delivery, .. } = &mut self.messages[index].kind {
                *delivery = InputDelivery::Uncertain;
            }
            self.messages[index].rendered = None;
            self.invalidate(index);
            self.changed = true;
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
            RuntimeEventKind::ConversationReady { conversation, model, cwd, working } => {
                self.reset_observed_activity();
                self.info = TuiInfo { title: conversation.title, model: Some(model), cwd };
                self.worker = false;
                self.output.banner.ready();
                self.working(working);
            }
            RuntimeEventKind::ConversationState { working } => self.working(working),
            RuntimeEventKind::History {
                messages,
                next_cursor,
                page_complete,
                ..
            } => {
                self.output.banner.ready();
                self.output.collecting_history = true;
                self.more_history = next_cursor.is_some();
                for message in messages {
                    self.output.historical_entries.insert(message.entry_id.clone());
                    self.committed(message, true);
                }
                self.input_history.sync(&self.messages, None);
                if page_complete { self.finish_history_page(); }
            }
            RuntimeEventKind::Message { message } => {
                self.output.banner.ready();
                if matches!(message.role, HistoryRole::Assistant | HistoryRole::Final | HistoryRole::Commentary | HistoryRole::PartialAnswer)
                    || (matches!(message.role, HistoryRole::Tool) && message.tool.as_ref().is_some_and(|tool| tool.status == ToolStatus::Running))
                {
                    self.bind_thinking(&message.entry_id);
                }
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
                self.output.banner.ready();
                if let Some(entry_id) = &entry_id { self.bind_thinking(entry_id); }
                self.finish_thinking();
                self.working(false);
                if entry_id.as_ref().is_none_or(|id| !self.messages.iter().any(|message| message.id.as_ref() == Some(id)
                    && matches!(message.role, Role::Agent | Role::PartialAnswer | Role::Commentary))) {
                    self.push(Role::Agent, text);
                    if let Some(message) = self.messages.last_mut() {
                        message.kind = MessageKind::Answer;
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
                        self.unbound_thinking.push(id);
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
                self.output.banner.ready();
                // Initial history is fetched after readiness. Keep newly
                // placed input behind that page while the fetch is in flight.
                self.output.collecting_history = true;
                self.info.title = title;
                self.worker = true;
                self.history_offset = Some(0);
            }
            RuntimeEventKind::ConversationSettings { settings } => self.info.model = Some(settings.model),
            RuntimeEventKind::MainReady { model, cwd, .. } => {
                self.output.banner.ready();
                self.info.model = Some(model);
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
                self.finish_history_page();
                if !self.working { self.settle_legacy_answer(); }
            }
            RuntimeEventKind::Failure { code, message } => {
                self.compacting = false;
                let recovery = if matches!(&code, ErrorCode::AuthenticationRequired | ErrorCode::AuthenticationFailed) {
                    self.info.model.as_ref().map_or_else(String::new, |model| {
                        if model.provider == ModelProvider::OpenAiCodex { "\n\nRun `agent login` to reconnect ChatGPT.".into() }
                        else { format!("\n\nCheck the configured authentication for `{}`.", model.provider.as_str()) }
                    })
                } else { String::new() };
                let label = match code {
                    ErrorCode::CoordinatorUnavailable => "Coordinator connection lost",
                    ErrorCode::InvalidRequest => "Code: invalid_request",
                    ErrorCode::AuthenticationRequired => "Code: authentication_required",
                    ErrorCode::AuthenticationFailed => "Code: authentication_failed",
                    ErrorCode::ProviderUnavailable => "Code: provider_unavailable",
                    ErrorCode::StorageUnavailable => "Code: storage_unavailable",
                    ErrorCode::Internal => "Code: internal",
                };
                self.push(Role::Failure, self.error_context(format!("{label}\n\n{message}{recovery}")));
                self.working(false);
            }
            RuntimeEventKind::InputAccepted { input_id } => {
                if let Some(index) = self.messages.iter().position(|message| matches!(&message.kind, MessageKind::Input { input_id: id, delivery: InputDelivery::Submitting | InputDelivery::Uncertain, .. } if id == &input_id)) {
                    if let MessageKind::Input { delivery, .. } = &mut self.messages[index].kind { *delivery = InputDelivery::Waiting; }
                    self.messages[index].rendered = None;
                    self.invalidate(index);
                }
            }
            RuntimeEventKind::InputPlaced { input_id, entry_id } => {
                if let Some(mut index) = self.messages.iter().position(|message| matches!(&message.kind, MessageKind::Input { input_id: id, .. } if id == &input_id)) {
                    if self.messages.iter().enumerate().any(|(other, message)|
                        other != index && message.id.as_ref() == Some(&entry_id) && message.role == Role::User)
                    {
                        // A reconnect history page may beat its placement receipt.
                        // The exact native ID merges the complete local preview at
                        // the canonical position, without comparing user text.
                        let mut preview = self.messages.remove(index);
                        if let Some(offset) = &mut self.history_offset { *offset = offset.saturating_sub(usize::from(index < *offset)); }
                        let first = self.messages.iter().position(|message| message.id.as_ref() == Some(&entry_id) && message.role == Role::User).unwrap_or(index.min(self.messages.len()));
                        self.invalidate(index.min(first));
                        for other in (first..self.messages.len()).rev() {
                            if self.messages[other].id.as_ref() == Some(&entry_id) && self.messages[other].role == Role::User {
                                if self.messages[other].output == CellOutput::Printed { preview.output = CellOutput::Printed; }
                                self.messages.remove(other);
                                if let Some(offset) = &mut self.history_offset { *offset = offset.saturating_sub(usize::from(other < *offset)); }
                            }
                        }
                        index = first;
                        self.messages.insert(index, preview);
                        if let Some(offset) = &mut self.history_offset { *offset += usize::from(index <= *offset); }
                    }
                    let message = &mut self.messages[index];
                    message.id = Some(entry_id.clone());
                    if message.output != CellOutput::Printed { message.output = CellOutput::Ready; }
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
                let pending = self.messages.iter().position(|message| matches!(&message.kind, MessageKind::Input { input_id: id, .. } if id == &input_id));
                let receipt = pending.map_or_else(|| "No local delivery receipt is available for this input.".into(), |index| {
                    let saved = &self.messages[index];
                    match &saved.kind {
                        MessageKind::Input { delivery: InputDelivery::Placed { entry_id }, .. } =>
                            format!("Saved entry: {entry_id}\nThe input is already present in this conversation."),
                        MessageKind::Input { delivery, .. } => format!("Last delivery receipt: {}.\n\nPending input:\n> {}",
                            match delivery {
                                InputDelivery::Submitting => "sending",
                                InputDelivery::Uncertain => "unconfirmed; not resent",
                                _ => "accepted, awaiting placement",
                            },
                            saved.text.replace('\n', "\n> ")),
                        _ => "No local delivery receipt is available for this input.".into(),
                    }
                });
                let text = self.error_context(format!("Input rejected: {input_id}\n\n{message}\n\n{receipt}"));
                if let Some(index) = pending
                    && matches!(self.messages[index].kind, MessageKind::Input { delivery: InputDelivery::Submitting | InputDelivery::Uncertain | InputDelivery::Waiting, .. }) {
                    self.messages.remove(index);
                    self.invalidate(index);
                }
                self.push(Role::Failure, text);
            }
            _ => {}
        }
        self.changed = true;
    }
    fn status(&self) -> &'static str {
        if self.exiting {
            "Closing"
        } else if self.observation == Some(ObservationState::Disconnected) {
            "Disconnected"
        } else if self.observation == Some(ObservationState::Reconnecting) {
            "Reconnecting"
        } else if self.observation == Some(ObservationState::Connecting)
            || self.info.model.is_none()
        {
            "Connecting"
        } else if self.interrupting {
            "Interrupting"
        } else if self.compacting {
            "Compacting context"
        } else if self.working {
            "Working"
        } else if self.history_replay.is_some() {
            "Loading history"
        } else {
            "Ready"
        }
    }
    fn finish_history_page(&mut self) {
        self.output.collecting_history = false;
        self.loading_history = None;
        self.history_entry = None;
    }
    fn history_update(&mut self, update: HistoryUpdate) {
        match update {
            HistoryUpdate::Begin(id) => self.begin_history_replay(id),
            HistoryUpdate::Reconcile(id) => {
                self.begin_history_replay(id);
                self.history_reconciliation = Some(HistoryAnchor {
                    position: self.messages.len(),
                    entry_id: None,
                });
            }
            HistoryUpdate::Page { id, events } => self.history_replay_page(id, events),
            HistoryUpdate::End { id, complete } => self.end_history_replay(id, complete),
        }
    }
    fn begin_history_replay(&mut self, id: uuid::Uuid) {
        self.history_replay = Some(id);
        self.history_reconciliation = None;
        self.changed = true;
    }
    fn choose_conversation(
        &mut self,
        choices: Vec<SavedConversation>,
        query: String,
        reply: tokio::sync::oneshot::Sender<Option<String>>,
    ) {
        self.picker = Some(ConversationPicker::new(choices, query, reply));
        self.changed = true;
    }
    fn reset_conversation(&mut self, info: TuiInfo) {
        *self = Self::new(info);
    }
    fn history_replay_page(&mut self, id: uuid::Uuid, events: Vec<RuntimeEventKind>) {
        if self.history_replay != Some(id) {
            return;
        }
        self.history_offset = Some(self.history_reconciliation.as_ref().map_or(0, |anchor| {
            anchor
                .entry_id
                .as_ref()
                .and_then(|id| {
                    self.messages
                        .iter()
                        .position(|message| message.id.as_ref() == Some(id))
                })
                .unwrap_or(anchor.position.min(self.messages.len()))
        }));
        self.history_entry = None;
        let first_entry = events.iter().find_map(|event| match event {
            RuntimeEventKind::History { messages, .. } => {
                messages.first().map(|message| message.entry_id.clone())
            }
            _ => None,
        });
        for event in events {
            if matches!(event, RuntimeEventKind::History { .. }) {
                self.event(event);
            }
        }
        if let Some(anchor) = &mut self.history_reconciliation
            && let Some(first_entry) = first_entry
        {
            anchor.entry_id = Some(first_entry);
        }
    }
    fn end_history_replay(&mut self, id: uuid::Uuid, complete: bool) {
        if self.history_replay != Some(id) {
            return;
        }
        self.history_replay = None;
        self.history_reconciliation = None;
        self.finish_history_page();
        if !complete {
            self.push(
                Role::Notice,
                "History loading stopped; displayed history is partial.".into(),
            );
        }
        self.changed = true;
    }
    fn input(&mut self, event: Event) -> Option<TuiInput> {
        self.sync_completion();
        let input = self.input_event(event);
        self.sync_completion();
        input
    }
    fn set_draft(&mut self, text: String) {
        self.editor = editor();
        self.editor.insert_str(markdown::plain(&text));
        self.changed = true;
    }
    fn composer_draft(&self) -> ComposerInput {
        ComposerInput {
            text: self.editor.lines().join("\n"),
            files: self.files.clone(),
            attachments: self.attachments.clone(),
        }
    }
    fn take_composer(&mut self, text: String) -> ComposerInput {
        ComposerInput {
            text,
            files: std::mem::take(&mut self.files),
            attachments: std::mem::take(&mut self.attachments),
        }
    }
    fn restore_composer(&mut self, input: ComposerInput) {
        if !input.text.is_empty() {
            if self.editor.lines().iter().any(|line| !line.is_empty()) {
                self.editor.insert_newline();
            }
            self.editor.insert_str(markdown::plain(&input.text));
        }
        self.files.extend(input.files);
        self.attachments.extend(input.attachments);
        self.changed = true;
    }
    fn attachment_count(&self) -> usize {
        self.files.len() + self.attachments.len()
    }
    fn load_history(&mut self, mode: HistoryLoad) -> Option<TuiInput> {
        self.output.view = View::History;
        self.changed = true;
        if self.loading_history.is_some() {
            return None;
        }
        if self.history_replay.is_some() {
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
            || self.picker.is_some()
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
        if let Some(picker) = self.picker.as_mut() {
            if picker.input(event) {
                self.picker = None;
            }
            self.changed = true;
            return None;
        }
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
                    KeyCode::Backspace
                        if self.editor.lines().iter().all(String::is_empty)
                            && self.attachment_count() > 0 =>
                    {
                        if self.files.pop().is_none() {
                            self.attachments.pop();
                        }
                    }
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
                        if self.working
                            || self.messages.iter().any(|message| {
                                matches!(
                                    &message.kind,
                                    MessageKind::Input {
                                        delivery: InputDelivery::Submitting
                                            | InputDelivery::Waiting,
                                        ..
                                    }
                                )
                            })
                        {
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
                                            return Some(TuiInput::Feedback(
                                                self.take_composer(description.join(" ")),
                                            ));
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
                        if !value.trim().is_empty() || self.attachment_count() > 0 {
                            self.input_history.remember(value.clone());
                            self.editor = editor();
                            self.help_open = false;
                            self.scroll = 0;
                            self.output.view = View::Live;
                            let input = self.take_composer(value);
                            if key.code == KeyCode::Tab {
                                return Some(TuiInput::Queue(input));
                            }
                            self.working = true;
                            return Some(TuiInput::Submit(input));
                        }
                    }
                    _ if !self.exiting => {
                        self.editor.input(key);
                    }
                    _ => {}
                }
            }
            Event::Paste(text) if !self.exiting => {
                let dropped = std::env::current_dir()
                    .map_err(anyhow::Error::from)
                    .and_then(|directory| dropped_files(&text, &directory));
                match dropped {
                    Ok(Some(files))
                        if self.attachment_count() + files.len()
                            <= crate::attachments::MAX_ATTACHMENTS =>
                    {
                        self.files.extend(files);
                    }
                    Ok(Some(_)) => {
                        self.editor.insert_str(markdown::plain(&text));
                        self.push(
                            Role::Failure,
                            "Attach at most 8 files. The pasted paths remain in the draft.".into(),
                        );
                    }
                    Err(error) => {
                        self.editor.insert_str(markdown::plain(&text));
                        self.push(Role::Failure, error.to_string());
                    }
                    Ok(None) => {
                        self.editor.insert_str(markdown::plain(&text));
                    }
                }
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
        if frame.area().width < 16 || frame.area().height < 6 {
            frame.render_widget(Paragraph::new("Enlarge the terminal"), frame.area());
            self.changed = false;
            return;
        }
        if let Some(picker) = self.picker.as_mut() {
            picker.draw(frame, frame.area());
            self.changed = false;
            return;
        }
        self.prepare_editor();
        let attachment_height = u16::try_from(self.attachment_count()).unwrap_or(u16::MAX);
        let height = self.editor_height(
            frame.area().width,
            frame
                .area()
                .height
                .saturating_sub(5u16.saturating_add(attachment_height))
                .clamp(1, 6),
        );
        let areas = Layout::vertical([
            Constraint::Min(1),
            Constraint::Length(attachment_height),
            Constraint::Length(height),
            Constraint::Length(1),
            Constraint::Length(1),
        ])
        .split(frame.area());
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
            let visible = usize::from(areas[0].height);
            self.help_scroll = self
                .help_scroll
                .min(paragraph.line_count(areas[0].width).saturating_sub(visible));
            self.page = visible.saturating_sub(1).max(1);
            frame.render_widget(
                paragraph.scroll((u16::try_from(self.help_scroll).unwrap_or(u16::MAX), 0)),
                areas[0],
            );
        } else {
            let total = self.layout_transcript(areas[0].width);
            let base = self.live_base();
            let total = total.saturating_sub(base);
            let visible = usize::from(areas[0].height);
            let maximum = total.saturating_sub(visible);
            if self.scroll > 0 && self.previous_width == areas[0].width && !self.history_changed {
                self.scroll = self
                    .scroll
                    .saturating_add(total.saturating_sub(self.previous_rows));
            }
            self.scroll = self.scroll.min(maximum);
            self.previous_rows = total;
            self.previous_width = areas[0].width;
            self.history_changed = false;
            self.page = visible.saturating_sub(1).max(1);
            let top = maximum.saturating_sub(self.scroll);
            self.draw_transcript(frame, areas[0], top + base);
        }
        let files = self
            .attachments
            .iter()
            .map(|file| (&file.name, file.size_bytes))
            .chain(self.files.iter().map(|file| (&file.name, file.size_bytes)))
            .enumerate()
            .map(|(index, (name, size))| {
                Line::from(vec![
                    Span::styled(
                        format!("[{}] ", index + 1),
                        Style::default().fg(Color::Cyan),
                    ),
                    Span::raw(markdown::plain(name)),
                    Span::styled(
                        format!(" · {} bytes", size),
                        Style::default().fg(Color::DarkGray),
                    ),
                ])
            })
            .collect::<Vec<_>>();
        frame.render_widget(Paragraph::new(files), areas[1]);
        frame.render_widget(&self.editor, areas[2]);
        if let Some(menu) = &self.completion {
            let height = usize::from(areas[0].height).min(6).min(menu.items.len());
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
                areas[0].x,
                areas[0].bottom().saturating_sub(height),
                areas[0].width,
                height,
            );
            frame.render_widget(ClearWidget, area);
            frame.render_widget(Paragraph::new(lines), area);
        }
        let mut status = Vec::new();
        if let Some(model) = &self.info.model {
            let reasoning = model
                .reasoning
                .map(|value| value.as_str())
                .unwrap_or("default");
            status.extend([
                Span::styled(
                    markdown::plain(&model.model_id),
                    Style::default()
                        .fg(Color::Cyan)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(" · ", Style::default().fg(Color::DarkGray)),
                Span::styled(reasoning, Style::default().fg(Color::Magenta)),
                Span::styled(
                    if model.fast { " · fast" } else { "" },
                    Style::default().fg(Color::Yellow),
                ),
                Span::styled(" · ", Style::default().fg(Color::DarkGray)),
            ]);
        }
        status.extend([
            Span::styled(
                markdown::plain(&self.info.cwd),
                Style::default().fg(Color::Blue),
            ),
            Span::styled(" · ", Style::default().fg(Color::DarkGray)),
            Span::styled(
                self.status(),
                Style::default().fg(
                    if self.observation == Some(ObservationState::Disconnected) {
                        Color::Red
                    } else if self.observation == Some(ObservationState::Reconnecting)
                        || self.interrupting
                    {
                        Color::Yellow
                    } else if self.working || self.compacting || self.info.model.is_none() {
                        Color::Cyan
                    } else {
                        Color::Green
                    },
                ),
            ),
        ]);
        frame.render_widget(Paragraph::new(Line::from(status)), areas[3]);
        frame.render_widget(
            Paragraph::new(Line::from(
                [
                    Shortcut::Steer,
                    Shortcut::Queue,
                    Shortcut::Help,
                    Shortcut::RemoveFile,
                ]
                .into_iter()
                .filter(|shortcut| {
                    !matches!(shortcut, Shortcut::RemoveFile) || self.attachment_count() > 0
                })
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
    RemoveFile,
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
            Self::RemoveFile => (
                "Backspace",
                "remove file",
                "Remove the last staged file when the message is empty",
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
                Ok(Update::Observation(observation)) => {
                    state.observation = Some(observation);
                    state.changed = true;
                }
                Ok(Update::Draft(sender)) => {
                    let _ = sender.send(state.composer_draft());
                }
                Ok(Update::Info(sender)) => {
                    let _ = sender.send(state.info.clone());
                }
                Ok(Update::Notice(text)) => state.push(Role::Notice, text),
                Ok(Update::InputUncertain(input_id)) => state.input_uncertain(&input_id),
                Ok(Update::RestoreInput(input)) => {
                    state.restore_composer(input);
                    state.push(Role::Notice, "Unsent input returned to the draft.".into());
                }
                Ok(Update::SetDraft(input)) => {
                    state.set_draft(input.text);
                    state.files = input.files;
                    state.attachments = input.attachments;
                }
                Ok(Update::PendingInput {
                    input_id,
                    text,
                    attachments,
                    mode,
                }) => {
                    state.pending_input(input_id.clone(), text, mode);
                    if let Some(index)=state.messages.iter().position(|message|matches!(&message.kind, MessageKind::Input {input_id:id,..} if id==&input_id)) {
                        state.messages[index].attachments = attachments;
                        state.messages[index].rendered = None;
                        state.invalidate(index);
                    }
                }
                Ok(Update::HistoryReplay(update)) => state.history_update(update),
                Ok(Update::ChooseConversation {
                    choices,
                    query,
                    reply,
                }) => {
                    state.choose_conversation(choices, query, reply);
                }
                Ok(Update::ResetConversation(info)) => {
                    screen.reset()?;
                    state.reset_conversation(info);
                }
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
        tui::{InputDelivery, MessageKind, State, TuiInfo, TuiInput},
    };
    use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
    use ratatui::{Terminal, backend::TestBackend};

    fn state() -> State {
        State::new(TuiInfo {
            title: "Main agent".into(),
            model: Some(ModelSelection {
                reasoning: Some(Reasoning::High),
                ..ModelSelection::default()
            }),
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
    fn connecting_paints_without_a_guessed_model_and_preserves_the_draft_when_ready() {
        let mut view = State::new(TuiInfo {
            title: "Main agent".into(),
            model: None,
            cwd: "/workspace/local".into(),
        });
        view.input(Event::Paste("An early draft".into()));
        let text = rendered(&mut view, 120, 24);
        assert_eq!(view.status(), "Connecting");
        assert!(view.info.model.is_none());
        assert!(
            text.contains("Connecting")
                && text.contains("An early draft")
                && text.contains("/workspace/local"),
            "{text}"
        );
        assert!(
            !text.contains("gpt-") && !text.contains("default"),
            "{text}"
        );
        assert_eq!(view.input(key(KeyCode::Esc, KeyModifiers::NONE)), None);
        let model = ModelSelection {
            provider: crate::models::ModelProvider::Anthropic,
            model_id: "authoritative-model".into(),
            reasoning: Some(Reasoning::Low),
            fast: false,
        };
        view.event(RuntimeEventKind::ConversationReady {
            conversation: crate::protocol::SavedConversation {
                conversation_id: "saved-chief".into(),
                title: "Main agent".into(),
                updated_at: None,
                task_id: None,
                agent_id: None,
                host: None,
                source_thread_id: None,
            },
            model: model.clone(),
            cwd: "/workspace/authoritative".into(),
            working: true,
        });
        assert_eq!(view.info.model, Some(model));
        assert_eq!(view.editor.lines().join("\n"), "An early draft");
        let text = rendered(&mut view, 120, 24);
        assert!(
            text.contains("authoritative-model")
                && text.contains("/workspace/authoritative")
                && text.contains("Working"),
            "{text}"
        );
        assert_eq!(
            view.input(key(KeyCode::Esc, KeyModifiers::NONE)),
            Some(TuiInput::Interrupt)
        );
        view.event(RuntimeEventKind::Interrupted);
        assert!(
            !view
                .messages
                .iter()
                .any(|message| message.role == crate::tui::Role::Failure)
        );
        assert_eq!(view.editor.lines().join("\n"), "An early draft");
    }

    #[test]
    fn a_connecting_failure_keeps_known_context_without_inventing_a_provider() {
        let mut view = State::new(TuiInfo {
            title: "Main agent".into(),
            model: None,
            cwd: "/workspace/local".into(),
        });
        view.event(RuntimeEventKind::Failure {
            code: crate::protocol::ErrorCode::AuthenticationRequired,
            message: "Coordinator setup did not finish.".into(),
        });
        let text = rendered(&mut view, 130, 35);
        assert!(
            text.contains("authentication_required")
                && text.contains("Coordinator setup did not finish.")
                && text.contains("/workspace/local")
                && text.contains("/feedback Investigate this error"),
            "{text}"
        );
        assert!(view.info.model.is_none());
        assert!(
            !text.contains("Model:") && !text.contains("agent login"),
            "{text}"
        );
    }

    #[test]
    fn escape_cancels_a_pending_input_before_ready_and_restoring_a_view_draft_is_quiet() {
        let mut view = state();
        view.pending_input(
            "not-admitted".into(),
            "Keep this request".into(),
            crate::protocol::InputMode::Steer,
        );
        assert!(!view.working);
        assert_eq!(
            view.input(key(KeyCode::Esc, KeyModifiers::NONE)),
            Some(TuiInput::Interrupt)
        );
        view.set_draft("Saved draft\nsecond line".into());
        assert_eq!(view.editor.lines().join("\n"), "Saved draft\nsecond line");
        assert!(
            !view
                .messages
                .iter()
                .any(|message| message.text.contains("returned to the draft"))
        );
    }

    #[test]
    fn resumed_conversation_metadata_is_authoritative_and_run_state_keeps_model_changes() {
        let mut view = state();
        view.worker = true;
        view.event(RuntimeEventKind::History {
            conversation_id: "selected".into(),
            messages: vec![HistoryMessage {
                entry_id: "saved".into(),
                role: HistoryRole::Final,
                text: "Saved reply loaded before attachment".into(),
                continuation: false,
                final_chunk: true,
                attachments: None,
                tool: None,
            }],
            next_cursor: None,
            page_complete: true,
        });
        let model = ModelSelection {
            model_id: "saved-model".into(),
            ..ModelSelection::default()
        };
        view.event(RuntimeEventKind::ConversationReady {
            conversation: crate::protocol::SavedConversation {
                conversation_id: "selected".into(),
                title: "Selected conversation".into(),
                updated_at: None,
                task_id: None,
                agent_id: None,
                host: Some("desktop".into()),
                source_thread_id: None,
            },
            model: model.clone(),
            cwd: "/workspace/selected".into(),
            working: true,
        });
        assert!(
            !view.worker,
            "An observing CLI detaches on Ctrl+C even for a Rex-owned task"
        );
        assert!(view.working);
        assert_eq!(view.info.title, "Selected conversation");
        assert_eq!(view.info.model, Some(model));
        assert_eq!(view.info.cwd, "/workspace/selected");
        let mut terminal = Terminal::with_options(
            TestBackend::new(100, 20),
            ratatui::TerminalOptions {
                viewport: ratatui::Viewport::Inline(6),
            },
        )
        .unwrap();
        view.flush_output(&mut terminal, false).unwrap();
        let output = terminal
            .backend()
            .scrollback()
            .content
            .iter()
            .chain(&terminal.backend().buffer().content)
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert_eq!(
            output
                .matches("Saved reply loaded before attachment")
                .count(),
            1
        );
        view.event(RuntimeEventKind::ConversationState { working: false });
        let text = rendered(&mut view, 100, 20);
        assert!(text.contains("saved-model"));
        assert!(text.contains("/workspace/selected"));
        assert!(text.contains("Ready"));
    }

    #[test]
    fn resume_picker_preserves_the_composer_and_cannot_steer_or_stop_the_model() {
        let mut view = state();
        view.input(Event::Paste("Keep this unsent draft".into()));
        view.working(true);
        let (reply, mut selected) = tokio::sync::oneshot::channel();
        view.choose_conversation(Vec::new(), String::new(), reply);
        assert_eq!(view.input(key(KeyCode::Esc, KeyModifiers::NONE)), None);
        assert!(view.picker.is_none());
        assert!(view.working);
        assert_eq!(view.editor.lines().join("\n"), "Keep this unsent draft");
        assert_eq!(selected.try_recv().unwrap(), None);
    }

    #[test]
    fn live_and_reopened_tables_share_cached_width_aware_layout() {
        let text = "| Item | Detail |\n| :--- | ---: |\n| **Board** | ready now |\n| 界界 | pending work |";
        let mut live = state();
        live.event(RuntimeEventKind::Answer {
            conversation_id: "main".into(),
            entry_id: Some("table".into()),
            text: text.into(),
        });
        let mut reopened = state();
        reopened.event(RuntimeEventKind::History {
            conversation_id: "main".into(),
            messages: vec![HistoryMessage {
                entry_id: "table".into(),
                role: HistoryRole::Final,
                text: text.into(),
                continuation: false,
                final_chunk: true,
                attachments: None,
                tool: None,
            }],
            next_cursor: None,
            page_complete: true,
        });
        for width in [48, 18, 32, 48] {
            let actual = rendered(&mut live, width, 30);
            assert_eq!(actual, rendered(&mut reopened, width, 30), "width {width}");
            assert!(actual.contains('│'));
            assert!(!actual.contains('|'));
            let before = live.layout_work;
            assert_eq!(actual, rendered(&mut live, width, 30));
            assert_eq!(live.layout_work.parsed_messages, before.parsed_messages);
            assert_eq!(live.layout_work.measured_messages, before.measured_messages);
        }
        assert_eq!(live.layout_work.parsed_messages, 1);
        assert_eq!(reopened.layout_work.parsed_messages, 1);
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
        assert!(view.layout_work.painted_rows <= 15);
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
                attachments: None,
                tool: None,
            }],
            next_cursor: None,
            page_complete: false,
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
                attachments: None,
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
                attachments: None,
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
        assert_eq!(compacting.matches("Compacting context").count(), 1);
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
    fn typed_failures_show_the_code_chat_and_recovery_action_without_changing_the_draft() {
        let mut view = state();
        view.info.title = "Hardware review".into();
        view.info.cwd = "/workspace/board".into();
        view.editor.insert_str("An unfinished correction");
        view.working(true);
        view.event(RuntimeEventKind::Failure {
            code: crate::protocol::ErrorCode::ProviderUnavailable,
            message: "The worker connection closed before it returned a result.".into(),
        });
        let text = rendered(&mut view, 130, 35);
        for expected in [
            "provider_unavailable",
            "The worker connection closed",
            "Hardware review",
            "/workspace/board",
            "openai/gpt-6.1-sol",
            "/feedback Investigate this error",
        ] {
            assert!(text.contains(expected), "{expected}: {text}");
        }
        assert_eq!(view.editor.lines().join("\n"), "An unfinished correction");
        assert!(!view.working);
    }

    #[test]
    fn reconnecting_is_ephemeral_and_preserves_the_composer_and_pending_input() {
        use crate::{protocol::InputMode, tui::ObservationState};
        let mut view = state();
        view.editor.insert_str("An unfinished correction");
        view.pending_input(
            "offline-input".into(),
            "Queued context".into(),
            InputMode::FollowUp,
        );
        let rows = view.messages.len();
        view.observation = Some(ObservationState::Reconnecting);
        view.event(RuntimeEventKind::ConversationState { working: true });
        assert_eq!(view.status(), "Reconnecting");
        assert!(rendered(&mut view, 130, 35).contains("Reconnecting"));
        assert_eq!(view.messages.len(), rows);
        assert_eq!(view.composer_draft().text, "An unfinished correction");
        view.observation = Some(ObservationState::Connected);
        view.event(RuntimeEventKind::ConversationState { working: false });
        let recovered = rendered(&mut view, 130, 35);
        assert!(!recovered.contains("Reconnecting"));
        assert_eq!(view.messages.len(), rows);
        assert_eq!(view.composer_draft().text, "An unfinished correction");
    }

    #[test]
    fn uncertain_input_uses_authoritative_receipts_without_replacing_the_editor() {
        let mut view = state();
        view.editor.insert_str("An unfinished correction");
        view.pending_input(
            "pending".into(),
            "Context".into(),
            crate::protocol::InputMode::Steer,
        );
        view.input_uncertain("pending");
        assert!(rendered(&mut view, 130, 35).contains("delivery unconfirmed; not resent"));
        view.event(RuntimeEventKind::InputAccepted {
            input_id: "pending".into(),
        });
        assert!(rendered(&mut view, 130, 35).contains("steering, waiting"));
        view.event(RuntimeEventKind::InputPlaced {
            input_id: "pending".into(),
            entry_id: "native".into(),
        });
        view.input_uncertain("pending");
        assert!(!rendered(&mut view, 130, 35).contains("unconfirmed"));
        assert_eq!(view.composer_draft().text, "An unfinished correction");
    }

    #[test]
    fn history_before_placement_merges_the_exact_native_entry_at_its_saved_position() {
        let mut view = state();
        view.editor.insert_str("An unfinished correction");
        view.pending_input(
            "pending".into(),
            "Same context".into(),
            crate::protocol::InputMode::Steer,
        );
        let replay = uuid::Uuid::new_v4();
        view.begin_history_replay(replay);
        view.history_replay_page(
            replay,
            vec![RuntimeEventKind::History {
                conversation_id: "saved".into(),
                messages: vec![
                    HistoryMessage {
                        entry_id: "unrelated".into(),
                        role: HistoryRole::User,
                        text: "Same context".into(),
                        continuation: false,
                        final_chunk: true,
                        tool: None,
                        attachments: None,
                    },
                    HistoryMessage {
                        entry_id: "native".into(),
                        role: HistoryRole::User,
                        text: "Same context".into(),
                        continuation: false,
                        final_chunk: true,
                        tool: None,
                        attachments: None,
                    },
                    HistoryMessage {
                        entry_id: "answer".into(),
                        role: HistoryRole::Final,
                        text: "A saved response".into(),
                        continuation: false,
                        final_chunk: true,
                        tool: None,
                        attachments: None,
                    },
                ],
                next_cursor: None,
                page_complete: true,
            }],
        );
        assert_eq!(view.messages.len(), 4);
        view.event(RuntimeEventKind::InputPlaced {
            input_id: "pending".into(),
            entry_id: "native".into(),
        });
        view.end_history_replay(replay, true);
        assert_eq!(view.messages.len(), 3);
        assert_eq!(
            view.messages
                .iter()
                .filter(|message| message.text == "Same context")
                .count(),
            2
        );
        assert_eq!(
            view.messages
                .iter()
                .map(|message| message.id.as_deref())
                .collect::<Vec<_>>(),
            [Some("unrelated"), Some("native"), Some("answer")]
        );
        assert!(
            matches!(&view.messages[1].kind, MessageKind::Input { delivery: InputDelivery::Placed { entry_id }, .. } if entry_id == "native")
        );
        assert_eq!(view.composer_draft().text, "An unfinished correction");
    }

    #[test]
    fn reconnect_backfill_keeps_a_disjoint_newest_page_after_the_retained_history() {
        let mut view = state();
        let saved = |index| HistoryMessage {
            entry_id: format!("user-{index:02}"),
            role: HistoryRole::User,
            text: format!("Input {index:02}"),
            continuation: false,
            final_chunk: true,
            tool: None,
            attachments: None,
        };
        for index in 1..=2 {
            view.event(RuntimeEventKind::Message {
                message: saved(index),
            });
        }
        let replay = uuid::Uuid::new_v4();
        view.history_update(crate::tui::HistoryUpdate::Reconcile(replay));
        for range in [21..=40, 1..=20] {
            view.history_replay_page(
                replay,
                vec![RuntimeEventKind::History {
                    conversation_id: "saved".into(),
                    messages: range.map(saved).collect(),
                    next_cursor: Some("older".into()),
                    page_complete: true,
                }],
            );
        }
        view.end_history_replay(replay, true);
        assert_eq!(
            view.messages
                .iter()
                .map(|message| message.text.clone())
                .collect::<Vec<_>>(),
            (1..=40)
                .map(|index| format!("Input {index:02}"))
                .collect::<Vec<_>>()
        );
        view.input(key(KeyCode::Up, KeyModifiers::NONE));
        assert_eq!(view.composer_draft().text, "Input 40");
    }

    #[test]
    fn disconnected_observation_stays_disconnected_through_late_work_and_history_updates() {
        use crate::{protocol::ErrorCode, tui::ObservationState};
        use ratatui::style::Color;
        let mut view = state();
        view.editor.insert_str("An unfinished correction");
        view.observation = Some(ObservationState::Disconnected);
        view.event(RuntimeEventKind::Failure {
            code: ErrorCode::CoordinatorUnavailable,
            message: "Reconnect with `/resume saved-chief`. Saved work may still be running."
                .into(),
        });
        view.event(RuntimeEventKind::ConversationState { working: true });
        view.event(RuntimeEventKind::History {
            conversation_id: "saved-chief".into(),
            messages: vec![],
            next_cursor: None,
            page_complete: true,
        });
        assert_eq!(view.status(), "Disconnected");
        assert_eq!(view.editor.lines(), &["An unfinished correction"]);
        let mut terminal = Terminal::new(TestBackend::new(110, 30)).unwrap();
        terminal.draw(|frame| view.draw(frame)).unwrap();
        let buffer = terminal.backend().buffer();
        let footer = (0..110)
            .map(|x| buffer[(x, 28)].symbol())
            .collect::<String>();
        assert!(!footer.contains("Ready"));
        let column = footer[..footer.find("Disconnected").unwrap()]
            .chars()
            .count();
        assert_eq!(buffer[(u16::try_from(column).unwrap(), 28)].fg, Color::Red);
        let text = rendered(&mut view, 130, 35);
        assert!(text.contains("Coordinator connection lost"), "{text}");
        assert!(text.contains("/resume saved-chief"), "{text}");
        assert!(!text.contains("Code: internal"), "{text}");
        view.observation = Some(ObservationState::Connected);
        assert_eq!(view.status(), "Working");
    }

    #[test]
    fn rejected_inputs_show_only_their_known_receipts_and_preserve_the_draft_and_saved_entry() {
        for delivery in ["sending", "waiting", "placed", "unknown"] {
            let mut view = state();
            view.editor.insert_str("An unrelated draft");
            view.working(true);
            if delivery != "unknown" {
                view.pending_input(
                    "input-reference".into(),
                    "Known submitted input".into(),
                    crate::protocol::InputMode::FollowUp,
                );
                if delivery != "sending" {
                    view.event(RuntimeEventKind::InputAccepted {
                        input_id: "input-reference".into(),
                    });
                }
                if delivery == "placed" {
                    view.event(RuntimeEventKind::InputPlaced {
                        input_id: "input-reference".into(),
                        entry_id: "saved-entry-reference".into(),
                    });
                }
            }
            view.event(RuntimeEventKind::InputRejected {
                input_id: "input-reference".into(),
                message: "The input could not continue.".into(),
            });
            let text = rendered(&mut view, 130, 40);
            assert!(
                text.contains("input-reference")
                    && text.contains("The input could not continue.")
                    && text.contains("/feedback Investigate this error"),
                "{text}"
            );
            match delivery {
                "sending" | "waiting" => {
                    let receipt = if delivery == "sending" {
                        "sending"
                    } else {
                        "accepted, awaiting placement"
                    };
                    assert!(
                        text.contains(receipt) && text.contains("Known submitted input"),
                        "{text}"
                    );
                    assert!(!view.messages.iter().any(|message| matches!(
                        message.kind,
                        crate::tui::MessageKind::Input { .. }
                    )));
                }
                "placed" => {
                    assert!(
                        text.contains("Saved entry: saved-entry-reference"),
                        "{text}"
                    );
                    assert_eq!(view.messages.iter().filter(|message| message.id.as_deref() == Some("saved-entry-reference")).count(), 1);
                    assert_eq!(text.matches("Known submitted input").count(), 1);
                }
                _ => assert!(
                    text.contains("No local delivery receipt is available"),
                    "{text}"
                ),
            }
            assert_eq!(view.editor.lines().join("\n"), "An unrelated draft");
            assert!(
                view.working,
                "Rejecting one input must not stop unrelated active work"
            );
        }
    }

    #[test]
    fn authentication_failures_offer_the_recovery_for_the_selected_provider() {
        for (provider, recovery) in [
            (crate::models::ModelProvider::OpenAiCodex, "agent login"),
            (
                crate::models::ModelProvider::Anthropic,
                "Check the configured authentication for anthropic",
            ),
        ] {
            let mut view = state();
            view.info.model.as_mut().unwrap().provider = provider;
            view.event(RuntimeEventKind::Failure {
                code: crate::protocol::ErrorCode::AuthenticationRequired,
                message: "No credentials are available.".into(),
            });
            let text = rendered(&mut view, 130, 35);
            assert!(
                text.contains("authentication_required") && text.contains(recovery),
                "{text}"
            );
        }
    }

    #[test]
    fn malformed_wire_failures_keep_safe_metadata_and_normal_interrupts_are_not_errors() {
        #[derive(serde::Serialize)]
        struct FutureEvent {
            #[serde(rename = "type")]
            tag: &'static str,
            content: &'static str,
        }
        let frame = serde_json::to_vec(&FutureEvent {
            tag: "fixture_private_event",
            content: "fixture_private_protocol_body",
        })
        .unwrap();
        let failure = crate::runtime::decode_coordinator_event(&frame).unwrap_err();
        let mut view = state();
        view.event(RuntimeEventKind::Failure {
            code: crate::protocol::ErrorCode::Internal,
            message: failure.to_string(),
        });
        let text = rendered(&mut view, 130, 35);
        assert!(
            text.contains("internal")
                && text.contains("event schema")
                && text.contains("bytes")
                && text.contains("/workspace/example"),
            "{text}"
        );
        assert!(
            !text.contains("fixture_private_event")
                && !text.contains("fixture_private_protocol_body"),
            "{text}"
        );
        let mut stopped = state();
        stopped.editor.insert_str("Keep this draft");
        stopped.working(true);
        stopped.event(RuntimeEventKind::Interrupted);
        assert!(rendered(&mut stopped, 130, 20).contains("Interrupted"));
        assert!(
            !stopped
                .messages
                .iter()
                .any(|message| message.role == crate::tui::Role::Failure)
        );
        assert_eq!(stopped.editor.lines().join("\n"), "Keep this draft");
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
        let mut model = view.info.model.clone().unwrap();
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
        assert_eq!(view.info.model, Some(model));
        assert_eq!(view.info.title, "Review device configuration");
        assert_eq!(view.info.cwd, "/workspace/example");
        let mut terminal = Terminal::with_options(
            TestBackend::new(110, 24),
            ratatui::TerminalOptions {
                viewport: ratatui::Viewport::Inline(9),
            },
        )
        .unwrap();
        view.flush_output(&mut terminal, false).unwrap();
        terminal.draw(|frame| view.draw(frame)).unwrap();
        let text = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
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
            page_complete: false,
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
                    attachments: None,
                    tool: None,
                }],
                next_cursor: None,
                page_complete: false,
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
            page_complete: false,
        };
        let message = |id: &str, role, text: &str, continuation| HistoryMessage {
            entry_id: id.into(),
            role,
            text: text.into(),
            continuation,
            final_chunk: true,
            attachments: None,
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
                attachments: None,
                tool: None,
            })
            .collect(),
            next_cursor: None,
            page_complete: false,
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
                attachments: None,
                tool: None,
            }],
            next_cursor: Some("older".into()),
            page_complete: false,
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
                attachments: None,
                tool: None,
            }],
            next_cursor: Some("older".into()),
            page_complete: false,
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
                attachments: None,
                tool: None,
            }],
            next_cursor: None,
            page_complete: false,
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
                attachments: None,
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
                    attachments: None,
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
                    attachments: None,
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
                    attachments: None,
                    tool: None,
                },
            ],
            next_cursor: None,
            page_complete: false,
        });
        view.event(RuntimeEventKind::Done);
        view.event(RuntimeEventKind::Message {
            message: HistoryMessage {
                entry_id: "result-entry".into(),
                role: HistoryRole::Tool,
                text: "read_source finished".into(),
                continuation: false,
                final_chunk: true,
                attachments: None,
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
                attachments: None,
                tool: None,
            },
            HistoryMessage {
                entry_id: "old-answer".into(),
                role: HistoryRole::Thinking,
                text: "First thinking block".into(),
                continuation: false,
                final_chunk: true,
                attachments: None,
                tool: None,
            },
            HistoryMessage {
                entry_id: "old-answer".into(),
                role: HistoryRole::Thinking,
                text: "Second thinking block".into(),
                continuation: false,
                final_chunk: true,
                attachments: None,
                tool: None,
            },
            HistoryMessage {
                entry_id: "old-answer".into(),
                role: HistoryRole::Assistant,
                text: "Original answer".into(),
                continuation: false,
                final_chunk: true,
                attachments: None,
                tool: None,
            },
        ];
        view.event(RuntimeEventKind::History {
            conversation_id: "main".into(),
            messages: old.clone(),
            next_cursor: None,
            page_complete: false,
        });
        view.event(RuntimeEventKind::Done);
        let mut refreshed = old;
        refreshed.push(HistoryMessage {
            entry_id: "late-answer".into(),
            role: HistoryRole::Assistant,
            text: "Finished while attaching".into(),
            continuation: false,
            final_chunk: true,
            attachments: None,
            tool: None,
        });
        for message in refreshed {
            view.event(RuntimeEventKind::History {
                conversation_id: "main".into(),
                messages: vec![message],
                next_cursor: None,
                page_complete: false,
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
                attachments: None,
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
                    attachments: None,
                    tool: None,
                },
            });
        }
        assert_eq!(chunked.messages.len(), 1);
        assert_eq!(chunked.messages[0].id.as_deref(), Some("local"));
        assert_eq!(chunked.messages[0].text, "Complete local input");
    }

    #[test]
    fn dropped_files_are_previewed_before_send_and_restoration_preserves_new_typing() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("plot image.png");
        std::fs::write(&file, b"image bytes").unwrap();
        let mut view = state();
        view.input(Event::Paste("Explain this plot".into()));
        assert!(
            view.input(Event::Paste(format!("'{}'", file.display())))
                .is_none()
        );
        assert_eq!(view.editor.lines().join("\n"), "Explain this plot");
        let preview = rendered(&mut view, 100, 20);
        assert!(preview.contains("plot image.png"));
        assert!(preview.contains("11 bytes"));
        let Some(TuiInput::Submit(input)) = view.input(key(KeyCode::Enter, KeyModifiers::NONE))
        else {
            panic!("Expected explicit attachment send")
        };
        assert_eq!(input.text, "Explain this plot");
        assert_eq!(input.files[0].path, file);
        assert!(view.composer_draft().is_empty());
        view.input(Event::Paste("New typing".into()));
        view.restore_composer(input);
        assert_eq!(
            view.editor.lines().join("\n"),
            "New typing\nExplain this plot"
        );
        assert_eq!(view.files[0].path, file);
    }

    #[test]
    fn file_only_input_can_be_removed_queued_or_added_to_feedback_without_losing_chips() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("report.txt");
        std::fs::write(&file, b"report").unwrap();
        let drop = format!("'{}'", file.display());
        let mut view = state();
        view.input(Event::Paste(drop.clone()));
        view.input(key(KeyCode::Backspace, KeyModifiers::NONE));
        assert!(view.files.is_empty());
        view.input(Event::Paste(drop.clone()));
        let Some(TuiInput::Queue(input)) = view.input(key(KeyCode::Tab, KeyModifiers::NONE)) else {
            panic!("Expected file-only follow-up")
        };
        assert!(input.text.is_empty());
        assert_eq!(input.files[0].path, file);
        view.input(Event::Paste(drop));
        view.input(Event::Paste("/status".into()));
        assert!(matches!(
            view.input(key(KeyCode::Enter, KeyModifiers::NONE)),
            Some(TuiInput::Command(_))
        ));
        assert_eq!(
            view.files.len(),
            1,
            "Read-only controls must not discard staged files"
        );
        view.input(Event::Paste("/feedback the view is clipped".into()));
        let Some(TuiInput::Feedback(input)) = view.input(key(KeyCode::Enter, KeyModifiers::NONE))
        else {
            panic!("Expected feedback with staged file")
        };
        assert_eq!(input.text, "the view is clipped");
        assert_eq!(input.files[0].path, file);
        assert!(view.files.is_empty());
    }

    #[test]
    fn attachment_history_keeps_first_chunk_metadata_separate_from_continuations() {
        let attachment = crate::attachments::AttachmentRef {
            id: uuid::Uuid::new_v4().to_string(),
            name: "plot image.png".into(),
            media_type: "image/png".into(),
            size_bytes: 11,
            sha256: "a".repeat(64),
        };
        let mut view = state();
        for (text, continuation, final_chunk, attachments) in [
            ("Review ", false, false, Some(vec![attachment.clone()])),
            ("this image", true, true, None),
        ] {
            view.event(RuntimeEventKind::Message {
                message: HistoryMessage {
                    entry_id: "saved-file-input".into(),
                    role: HistoryRole::User,
                    text: text.into(),
                    continuation,
                    final_chunk,
                    tool: None,
                    attachments,
                },
            });
        }
        assert_eq!(view.messages.len(), 1);
        assert_eq!(view.messages[0].text, "Review this image");
        assert_eq!(view.messages[0].attachments.len(), 1);
        let visible = rendered(&mut view, 100, 20);
        assert!(visible.contains("Review this image"));
        assert_eq!(visible.matches("plot image.png").count(), 1);
        view.event(RuntimeEventKind::History {
            conversation_id: "fixture".into(),
            messages: vec![HistoryMessage {
                entry_id: "saved-file-input".into(),
                role: HistoryRole::User,
                text: "Review this image".into(),
                continuation: false,
                final_chunk: true,
                tool: None,
                attachments: Some(vec![attachment]),
            }],
            next_cursor: None,
            page_complete: true,
        });
        assert_eq!(view.messages.len(), 1);
        assert_eq!(view.messages[0].attachments.len(), 1);
        assert_eq!(
            rendered(&mut view, 100, 20)
                .matches("plot image.png")
                .count(),
            1
        );
    }
}
