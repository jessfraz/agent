//! Terminal presentation only. Request ownership, model calls and durable input stay outside this module.
mod markdown;
mod transcript;

use crate::tui::transcript::CachedText;
use crate::{
    chat_commands::{ChatCommand, command_help},
    models::ModelSelection,
    protocol::{HistoryMessage, HistoryRole, ModelActivity, RuntimeEventKind},
};
use anyhow::{Context, Result, anyhow, ensure};
use crossterm::{
    cursor::{MoveTo, Show},
    event::{
        self, DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, Event, KeyCode,
        KeyEventKind, KeyModifiers,
    },
    execute,
    terminal::{
        Clear, ClearType, EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode,
        enable_raw_mode,
    },
};
use ratatui::{
    Frame, Terminal,
    backend::CrosstermBackend,
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Wrap},
};
use ratatui_textarea::{TextArea, WrapMode};
use std::{
    collections::HashMap,
    io::{IsTerminal, Stdout},
    path::Path,
    sync::mpsc,
    thread,
    time::Duration,
};
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

enum Update {
    Event(Box<RuntimeEventKind>),
    User(String),
    QueuedUser(String),
    Status(TuiInfo),
    Working(bool),
    Draft(tokio::sync::oneshot::Sender<String>),
    Info(tokio::sync::oneshot::Sender<TuiInfo>),
    Notice(String),
    RestoreInput(String),
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
    pub fn say_user(&self, text: String) -> Result<()> {
        self.send(Update::User(text))
    }
    pub fn queued_user(&self, text: String) -> Result<()> {
        self.send(Update::QueuedUser(text))
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
                run(&mut screen.terminal, updates, inputs, State::new(info))
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
impl Drop for TerminalModes {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = execute!(
            std::io::stdout(),
            DisableMouseCapture,
            DisableBracketedPaste,
            LeaveAlternateScreen,
            WindowTitle(""),
            Show
        );
    }
}
struct Screen {
    terminal: Terminal<CrosstermBackend<Stdout>>,
    _modes: TerminalModes,
}

struct WindowTitle<'a>(&'a str);
impl crossterm::Command for WindowTitle<'_> {
    fn write_ansi(&self, output: &mut impl std::fmt::Write) -> std::fmt::Result {
        // BEL matches Codex's title framing; some terminal integrations display ST.
        write!(output, "\x1b]0;{}\x07", self.0)
    }
}
impl Screen {
    fn open() -> Result<Self> {
        enable_raw_mode().context("Could not enable terminal editing")?;
        let modes = TerminalModes;
        let mut output = std::io::stdout();
        execute!(
            output,
            EnterAlternateScreen,
            Clear(ClearType::All),
            MoveTo(0, 0),
            EnableBracketedPaste,
            // Leave drag selection to Rex and other native terminals.
            DisableMouseCapture
        )?;
        let terminal = Terminal::new(CrosstermBackend::new(output))?;
        Ok(Self {
            terminal,
            _modes: modes,
        })
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Role {
    User,
    QueuedUser,
    Agent,
    Thinking,
    Tool,
    Notice,
    Failure,
}
impl Role {
    fn from_history(role: &HistoryRole) -> Self {
        match role {
            HistoryRole::User => Self::User,
            HistoryRole::Assistant => Self::Agent,
            HistoryRole::Thinking => Self::Thinking,
            HistoryRole::Tool => Self::Tool,
        }
    }
    fn label(self) -> &'static str {
        match self {
            Self::User => "You",
            Self::QueuedUser => "You · queued, unsent",
            Self::Agent => "Agent",
            Self::Thinking => "Thinking",
            Self::Tool => "Tool",
            Self::Notice => "Update",
            Self::Failure => "Error",
        }
    }
    fn color(self) -> Color {
        match self {
            Self::User | Self::QueuedUser => Color::Cyan,
            Self::Agent => Color::Green,
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
}
impl Message {
    fn new(id: Option<String>, role: Role, text: String) -> Self {
        Self {
            id,
            role,
            text,
            rendered: None,
        }
    }
    fn cached(&mut self) -> &mut CachedText {
        self.rendered.get_or_insert_with(|| {
            let mut lines = Vec::new();
            append(&mut lines, self.role, &self.text);
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
struct Tool {
    name: String,
    done: bool,
}
struct State {
    info: TuiInfo,
    messages: Vec<Message>,
    row_ends: Vec<usize>,
    row_width: u16,
    dirty_from: Option<usize>,
    tail: CachedText,
    tail_dirty: bool,
    #[cfg(test)]
    layout_work: LayoutWork,
    editor: TextArea<'static>,
    thinking: String,
    tools: HashMap<String, Tool>,
    tool_order: Vec<String>,
    working: bool,
    compacting: bool,
    interrupting: bool,
    exiting: bool,
    worker: bool,
    history_offset: Option<usize>,
    history_entry: Option<(String, bool)>,
    loading_older: bool,
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
            row_ends: Vec::new(),
            row_width: 0,
            dirty_from: Some(0),
            tail: CachedText::new(Vec::new()),
            tail_dirty: true,
            #[cfg(test)]
            layout_work: LayoutWork::default(),
            editor: editor(),
            thinking: String::new(),
            tools: HashMap::new(),
            tool_order: Vec::new(),
            working: false,
            compacting: false,
            interrupting: false,
            exiting: false,
            worker: false,
            history_offset: Some(0),
            history_entry: None,
            loading_older: false,
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
        self.invalidate(self.messages.len());
        self.messages.push(Message::new(None, role, text));
        self.changed = true;
    }
    fn invalidate(&mut self, index: usize) {
        self.dirty_from = Some(self.dirty_from.map_or(index, |dirty| dirty.min(index)));
    }
    fn say_user(&mut self, text: String) {
        if let Some(index) = self
            .messages
            .iter()
            .position(|message| message.role == Role::QueuedUser && message.text == text)
        {
            self.messages[index].role = Role::User;
            self.messages[index].rendered = None;
            self.invalidate(index);
            self.changed = true;
        } else {
            self.push(Role::User, text);
        }
    }
    fn working(&mut self, working: bool) {
        self.working = working;
        if !working {
            self.interrupting = false;
        }
        self.changed = true;
    }
    fn committed(&mut self, message: HistoryMessage, historical: bool) {
        let role = Role::from_history(&message.role);
        if historical {
            self.history_changed = true;
            if self.loading_older {
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
                self.dirty_from = Some(self.dirty_from.map_or(index, |dirty| dirty.min(index)));
            } else {
                let index = *offset;
                self.messages.insert(
                    index,
                    Message::new(Some(message.entry_id), role, message.text),
                );
                *offset += 1;
                self.dirty_from = Some(self.dirty_from.map_or(index, |dirty| dirty.min(index)));
            }
        } else if message.continuation
            && self.messages.last().is_some_and(|previous| {
                previous.id.as_ref() == Some(&message.entry_id) && previous.role == role
            })
        {
            if let Some(last) = self.messages.last_mut() {
                last.append(&message.text);
            }
            self.invalidate(self.messages.len().saturating_sub(1));
        } else if role == Role::User
            && let Some(pending) = self.messages.iter_mut().find(|pending| {
                pending.role == Role::User && pending.id.is_none() && pending.text == message.text
            })
        {
            pending.id = Some(message.entry_id);
            pending.text = message.text;
        } else {
            self.invalidate(self.messages.len());
            self.messages
                .push(Message::new(Some(message.entry_id), role, message.text));
        }
        if !historical && role == Role::User {
            let acknowledged = self.messages.last().and_then(|last| {
                last.id.as_ref()?;
                self.messages.iter().position(|pending| {
                    pending.role == Role::User && pending.id.is_none() && pending.text == last.text
                })
            });
            if let Some(index) = acknowledged
                && let Some(committed) = self.messages.pop()
            {
                self.messages[index].id = committed.id;
                self.invalidate(self.messages.len());
            }
        }
        self.changed = true;
    }
    fn finish_thinking(&mut self) {
        if !self.thinking.is_empty() {
            let thinking = std::mem::take(&mut self.thinking);
            self.push(Role::Thinking, thinking);
        }
        self.tools.clear();
        self.tool_order.clear();
        self.tail_dirty = true;
    }
    fn event(&mut self, event: RuntimeEventKind) {
        match event {
            RuntimeEventKind::History { messages, .. } => {
                for message in messages {
                    self.committed(message, true);
                }
            }
            RuntimeEventKind::Message { message } => {
                if matches!(message.role, HistoryRole::User) {
                    self.working(true);
                }
                self.committed(message, false);
            }
            RuntimeEventKind::Answer { text, .. } => {
                self.finish_thinking();
                self.push(Role::Agent, text);
                self.working(false);
            }
            RuntimeEventKind::Activity { activity } => match activity {
                ModelActivity::Thinking { text } => {
                    self.working = true;
                    self.thinking.push_str(&text);
                    self.tail_dirty = true;
                }
                ModelActivity::ToolStarted { call_id, name } => {
                    self.working = true;
                    if !self.tools.contains_key(&call_id) {
                        self.tool_order.push(call_id.clone());
                    }
                    self.tools.insert(call_id, Tool { name, done: false });
                    self.tail_dirty = true;
                }
                ModelActivity::ToolFinished { call_id, name } => {
                    self.working = true;
                    if !self.tools.contains_key(&call_id) {
                        self.tool_order.push(call_id.clone());
                    }
                    self.tools.insert(call_id, Tool { name, done: true });
                    self.tail_dirty = true;
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
                self.loading_older = false;
                self.history_entry = None;
            }
            RuntimeEventKind::Failure { message, .. } => {
                self.compacting = false;
                self.push(Role::Failure, message);
                self.working(false);
            }
            RuntimeEventKind::InputRejected { message, .. } => self.push(Role::Failure, message),
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
        self.changed = true;
        if self.exiting {
            return None;
        }
        match event {
            Event::Key(key) if key.kind != KeyEventKind::Release => {
                let control = key.modifiers.contains(KeyModifiers::CONTROL);
                match key.code {
                    KeyCode::Char('?') if self.editor.lines().iter().all(String::is_empty) => {
                        self.help_open = !self.help_open;
                        self.help_scroll = 0;
                    }
                    KeyCode::Esc if self.help_open => self.help_open = false,
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
                        self.history_offset = Some(0);
                        self.loading_older = true;
                        return Some(TuiInput::History);
                    }
                    KeyCode::PageUp if self.help_open => {
                        self.help_scroll = self.help_scroll.saturating_sub(self.page)
                    }
                    KeyCode::PageDown if self.help_open => {
                        self.help_scroll = self.help_scroll.saturating_add(self.page)
                    }
                    KeyCode::Home if control && self.help_open => self.help_scroll = 0,
                    KeyCode::End if control && self.help_open => self.help_scroll = usize::MAX,
                    KeyCode::PageUp => self.scroll = self.scroll.saturating_add(self.page),
                    KeyCode::PageDown => self.scroll = self.scroll.saturating_sub(self.page),
                    KeyCode::Home if control => self.scroll = usize::MAX,
                    KeyCode::End if control => self.scroll = 0,
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
                                            self.history_offset = Some(0);
                                            self.loading_older = true;
                                            return Some(TuiInput::History);
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
                            self.editor = editor();
                            self.help_open = false;
                            self.scroll = 0;
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
    fn live_lines(&self) -> Vec<Line<'static>> {
        let mut lines = Vec::new();
        if !self.thinking.is_empty() {
            append(&mut lines, Role::Thinking, &self.thinking);
        }
        for id in &self.tool_order {
            if let Some(tool) = self.tools.get(id) {
                lines.push(Line::styled(
                    format!(
                        "{} {}",
                        if tool.done { "✓" } else { "•" },
                        markdown::plain(&tool.name)
                    ),
                    Style::default().fg(Color::DarkGray),
                ));
            }
        }
        lines
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
        if self.tail_dirty {
            self.tail = CachedText::new(self.live_lines());
            self.tail_dirty = false;
        }
        self.row_ends.last().copied().unwrap_or(0) + self.tail.layout(width)
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
        if drawn < area.height {
            let remaining = Rect::new(area.x, area.y + drawn, area.width, area.height - drawn);
            let messages_rows = self.row_ends.last().copied().unwrap_or(0);
            drawn += u16::try_from(self.tail.draw(
                frame,
                remaining,
                top.saturating_sub(messages_rows),
            ))
            .unwrap_or(remaining.height);
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
        let editor_rows = Paragraph::new(self.editor.lines().join("\n"))
            .wrap(Wrap { trim: false })
            .line_count(frame.area().width.saturating_sub(2));
        let height = u16::try_from(editor_rows).unwrap_or(6).clamp(1, 6) + 2;
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
            self.draw_transcript(frame, areas[1], top);
        }
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
        frame.render_widget(&self.editor, areas[2]);
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
                "Scroll messages or shortcuts; Ctrl+Home/End jumps to edges",
            ),
            Self::History => ("Ctrl+R", "older", "Load older saved messages"),
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
    if role == Role::Thinking || role == Role::Tool {
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
    terminal: &mut Terminal<CrosstermBackend<Stdout>>,
    updates: mpsc::Receiver<Update>,
    inputs: UnboundedSender<TuiInput>,
    mut state: State,
) -> Result<()> {
    let mut title = String::new();
    loop {
        if inputs.is_closed() {
            return Ok(());
        }
        for _ in 0..256 {
            match updates.try_recv() {
                Ok(Update::Stop) | Err(mpsc::TryRecvError::Disconnected) => return Ok(()),
                Err(mpsc::TryRecvError::Empty) => break,
                Ok(Update::Event(event)) => state.event(*event),
                Ok(Update::User(text)) => state.say_user(text),
                Ok(Update::QueuedUser(text)) => state.push(Role::QueuedUser, text),
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
            }
        }
        if state.changed {
            let next_title = terminal_title(&state.info);
            if title != next_title {
                execute!(std::io::stdout(), WindowTitle(&next_title))?;
                title = next_title;
            }
            terminal.draw(|frame| state.draw(frame))?;
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
        assert_eq!(view.layout_work.parsed_messages, initial.parsed_messages);
        assert_eq!(
            view.layout_work.measured_messages,
            initial.measured_messages
        );
        rendered(&mut view, 43, 20);
        assert_eq!(view.layout_work.parsed_messages, initial.parsed_messages);
        assert_eq!(
            view.layout_work.measured_messages,
            initial.measured_messages + 1_000
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
            }],
            next_cursor: None,
        };
        history.event(frame("Earlier ", false));
        rendered(&mut history, 80, 20);
        history.event(frame("context", true));
        assert!(rendered(&mut history, 80, 20).contains("Earlier context"));
        history.push(crate::tui::Role::QueuedUser, "Next request".into());
        assert!(rendered(&mut history, 80, 20).contains("queued, unsent"));
        history.say_user("Next request".into());
        assert!(!rendered(&mut history, 80, 20).contains("queued, unsent"));
        history.event(RuntimeEventKind::Message {
            message: HistoryMessage {
                entry_id: "next".into(),
                role: HistoryRole::Assistant,
                text: "Live ".into(),
                continuation: false,
            },
        });
        rendered(&mut history, 80, 20);
        history.event(RuntimeEventKind::Message {
            message: HistoryMessage {
                entry_id: "next".into(),
                role: HistoryRole::Assistant,
                text: "continuation".into(),
                continuation: true,
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
        view.push(crate::tui::Role::QueuedUser, "A later request".into());
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
    fn refreshed_history_keeps_overlapping_entries_and_distinct_blocks_once() {
        let mut view = state();
        let old = vec![
            HistoryMessage {
                entry_id: "old-user".into(),
                role: HistoryRole::User,
                text: "Original question".into(),
                continuation: false,
            },
            HistoryMessage {
                entry_id: "old-answer".into(),
                role: HistoryRole::Thinking,
                text: "First thinking block".into(),
                continuation: false,
            },
            HistoryMessage {
                entry_id: "old-answer".into(),
                role: HistoryRole::Thinking,
                text: "Second thinking block".into(),
                continuation: false,
            },
            HistoryMessage {
                entry_id: "old-answer".into(),
                role: HistoryRole::Assistant,
                text: "Original answer".into(),
                continuation: false,
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
        view.push(crate::tui::Role::User, "Review this complete input".into());
        view.event(RuntimeEventKind::Message {
            message: HistoryMessage {
                entry_id: "chief".into(),
                role: HistoryRole::User,
                text: "Review".into(),
                continuation: false,
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
        chunked.push(crate::tui::Role::User, "Complete local input".into());
        for (text, continuation) in [("Complete ", false), ("local input", true)] {
            chunked.event(RuntimeEventKind::Message {
                message: HistoryMessage {
                    entry_id: "local".into(),
                    role: HistoryRole::User,
                    text: text.into(),
                    continuation,
                },
            });
        }
        assert_eq!(chunked.messages.len(), 1);
        assert_eq!(chunked.messages[0].id.as_deref(), Some("local"));
        assert_eq!(chunked.messages[0].text, "Complete local input");
    }
}
