//! Terminal presentation only. Request ownership, model calls and durable input stay outside this module.
mod markdown;

use crate::{
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
    layout::{Constraint, Layout},
    style::{Color, Modifier, Style},
    text::{Line, Span, Text},
    widgets::{Block, Borders, Paragraph, Wrap},
};
use ratatui_textarea::{TextArea, WrapMode};
use std::{
    collections::HashMap,
    io::{IsTerminal, Stdout},
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
            Show
        );
    }
}
struct Screen {
    terminal: Terminal<CrosstermBackend<Stdout>>,
    _modes: TerminalModes,
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
}
struct Tool {
    name: String,
    done: bool,
}
struct State {
    info: TuiInfo,
    messages: Vec<Message>,
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
    loading_older: bool,
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
            loading_older: false,
            history_changed: false,
            scroll: 0,
            page: 10,
            previous_rows: 0,
            previous_width: 0,
            changed: true,
        }
    }
    fn push(&mut self, role: Role, text: String) {
        self.messages.push(Message {
            id: None,
            role,
            text,
        });
        self.changed = true;
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
            if message.continuation
                && *offset > 0
                && self.messages.get(*offset - 1).is_some_and(|previous| {
                    previous.id.as_ref() == Some(&message.entry_id) && previous.role == role
                })
            {
                self.messages[*offset - 1].text.push_str(&message.text);
            } else {
                self.messages.insert(
                    *offset,
                    Message {
                        id: Some(message.entry_id),
                        role,
                        text: message.text,
                    },
                );
                *offset += 1;
            }
        } else if message.continuation
            && self.messages.last().is_some_and(|previous| {
                previous.id.as_ref() == Some(&message.entry_id) && previous.role == role
            })
        {
            if let Some(last) = self.messages.last_mut() {
                last.text.push_str(&message.text);
            }
        } else if role == Role::User
            && let Some(pending) = self.messages.iter_mut().find(|pending| {
                pending.role == Role::User && pending.id.is_none() && pending.text == message.text
            })
        {
            pending.id = Some(message.entry_id);
            pending.text = message.text;
        } else {
            self.messages.push(Message {
                id: Some(message.entry_id),
                role,
                text: message.text,
            });
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
                }
                ModelActivity::ToolStarted { call_id, name } => {
                    self.working = true;
                    if !self.tools.contains_key(&call_id) {
                        self.tool_order.push(call_id.clone());
                    }
                    self.tools.insert(call_id, Tool { name, done: false });
                }
                ModelActivity::ToolFinished { call_id, name } => {
                    self.working = true;
                    if !self.tools.contains_key(&call_id) {
                        self.tool_order.push(call_id.clone());
                    }
                    self.tools.insert(call_id, Tool { name, done: true });
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
            RuntimeEventKind::WorkerIdle => self.working(false),
            RuntimeEventKind::Interrupted => {
                self.finish_thinking();
                self.working(false);
                self.push(Role::Notice, "Interrupted".into());
            }
            RuntimeEventKind::Notice { text, .. } if !self.worker => self.push(Role::Notice, text),
            RuntimeEventKind::Done => self.loading_older = false,
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
                    KeyCode::Esc => {
                        if self.working {
                            self.interrupting = true;
                            return Some(TuiInput::Interrupt);
                        }
                    }
                    KeyCode::Char('c') if control => {
                        if self.working && !self.interrupting {
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
                        if let Some(description) = crate::feedback::command(&value) {
                            self.editor = editor();
                            return Some(TuiInput::Feedback(description.to_owned()));
                        }
                        if value.trim() == "/history" {
                            self.editor = editor();
                            self.history_offset = Some(0);
                            self.loading_older = true;
                            return Some(TuiInput::History);
                        }
                        if value.trim() == "/exit" {
                            self.exiting = true;
                            return Some(TuiInput::Exit);
                        }
                        if !value.trim().is_empty() {
                            self.editor = editor();
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
    fn lines(&self) -> Vec<Line<'static>> {
        let mut lines = Vec::new();
        for message in &self.messages {
            append(&mut lines, message.role, &message.text);
        }
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
        let paragraph = Paragraph::new(Text::from(self.lines())).wrap(Wrap { trim: false });
        let total = paragraph.line_count(areas[1].width);
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
        frame.render_widget(
            paragraph.scroll((u16::try_from(top).unwrap_or(u16::MAX), 0)),
            areas[1],
        );
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
            Paragraph::new(format!(
                "{} · {}{} · {} · {}",
                markdown::plain(&self.info.model.model_id),
                reasoning,
                if self.info.model.fast { " · fast" } else { "" },
                markdown::plain(&self.info.cwd),
                self.status()
            ))
            .style(Style::default().fg(Color::DarkGray)),
            areas[3],
        );
        frame.render_widget(
            Paragraph::new(
                "Enter steer · Tab queue · Shift+Enter newline · Esc stop · PgUp/PgDn scroll · ^R older",
            )
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
    loop {
        if inputs.is_closed() {
            return Ok(());
        }
        for _ in 0..256 {
            match updates.try_recv() {
                Ok(Update::Stop) | Err(mpsc::TryRecvError::Disconnected) => return Ok(()),
                Err(mpsc::TryRecvError::Empty) => break,
                Ok(Update::Event(event)) => state.event(*event),
                Ok(Update::User(text)) => {
                    if let Some(queued) = state
                        .messages
                        .iter_mut()
                        .find(|message| message.role == Role::QueuedUser && message.text == text)
                    {
                        queued.role = Role::User;
                        state.changed = true;
                    } else {
                        state.push(Role::User, text);
                    }
                }
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
