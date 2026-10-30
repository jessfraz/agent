//! Compact activity is a presentation of retained messages. Expansion never
//! starts model work; tool payloads come from the shared coordinator lookup.
use crate::{
    native::{ToolDetailContent, ToolDetailUnavailable, ToolDetails},
    protocol::{RuntimeCommand, TaskId, ToolStatus},
    tui::{
        Message, MessageKind, Role, State, inline::CellOutput, markdown, transcript::CachedText,
    },
};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::{
    Frame,
    layout::Rect,
    style::{Color, Modifier, Style},
    text::Line,
    widgets::{Block, Borders, Paragraph},
};
use std::{
    collections::{HashMap, HashSet},
    ops::Range,
};

/// The UI owns the local identity; the coordinator owns the tool identity.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolDetailRequest {
    pub id: uuid::Uuid,
    pub entry_id: String,
    pub call_id: String,
}
impl ToolDetailRequest {
    pub fn command(&self, task_id: Option<TaskId>, agent_id: Option<String>) -> RuntimeCommand {
        RuntimeCommand::ReadToolDetails {
            task_id,
            agent_id,
            entry_id: self.entry_id.clone(),
            call_id: self.call_id.clone(),
        }
    }
}

pub(super) fn is_activity(message: &Message) -> bool {
    matches!(message.role, Role::Thinking | Role::Tool)
}

pub(super) fn group(messages: &[Message], start: usize) -> Option<Range<usize>> {
    if !messages.get(start).is_some_and(is_activity) {
        return None;
    }
    let end = start
        + messages[start..]
            .iter()
            .take_while(|message| is_activity(message))
            .count();
    Some(start..end)
}

pub(super) fn summary(messages: &[Message], range: Range<usize>) -> String {
    let mut tools = 0;
    let mut reasoning = 0;
    let mut events = 0;
    let mut failed = 0;
    let mut running = 0;
    for message in messages.get(range).unwrap_or_default() {
        match &message.kind {
            MessageKind::Tool { status, .. } => {
                tools += 1;
                failed += usize::from(*status == ToolStatus::Failed);
                running += usize::from(*status == ToolStatus::Running);
            }
            _ if message.role == Role::Thinking => reasoning += 1,
            _ if message.role == Role::Tool => events += 1,
            _ => {}
        }
    }
    let mut parts = Vec::new();
    if reasoning > 0 {
        parts.push(format!(
            "{reasoning} reasoning {}",
            if reasoning == 1 { "block" } else { "blocks" }
        ));
    }
    if tools > 0 {
        parts.push(format!(
            "{tools} tool {}",
            if tools == 1 { "call" } else { "calls" }
        ));
    }
    if events > 0 {
        parts.push(format!(
            "{events} {}",
            if events == 1 { "event" } else { "events" }
        ));
    }
    if running > 0 {
        parts.push(format!("{running} running"));
    }
    if failed > 0 {
        parts.push(format!("{failed} failed"));
    }
    format!("Activity · {}", parts.join(" · "))
}

pub(super) fn compact(messages: &[Message], range: Range<usize>) -> CachedText {
    CachedText::new(vec![
        Line::styled(
            summary(messages, range),
            Style::default().fg(Color::DarkGray),
        ),
        Line::default(),
    ])
}

// A terminal cannot revise scrollback. Keep a live group mutable until its
// boundary closes, then emit one summary while retaining every source message.
pub(super) fn ready(messages: &[Message], range: &Range<usize>, working: bool) -> bool {
    (range.end < messages.len() || !working)
        && messages[range.clone()].iter().all(|message| {
            matches!(
                message.output,
                CellOutput::Ready | CellOutput::Printed | CellOutput::Retained
            )
        })
}

pub(super) struct Projection {
    cells: Vec<(usize, Option<CachedText>, usize)>,
    pub(super) height: usize,
}
impl Projection {
    pub(super) fn new(state: &mut State, start: usize, width: u16) -> Self {
        let messages = &mut state.messages;
        let mut cells = Vec::new();
        let mut height = 0;
        let mut index = start;
        while index < messages.len() {
            let mut text = group(messages, index).map(|range| compact(messages, range));
            let rows = match &mut text {
                Some(text) => text.layout(width),
                None => {
                    #[cfg(test)]
                    {
                        state.layout_work.parsed_messages +=
                            usize::from(messages[index].rendered.is_none());
                    }
                    let cached = messages[index].cached();
                    #[cfg(test)]
                    {
                        state.layout_work.measured_messages +=
                            usize::from(cached.width() != Some(width));
                    }
                    cached.layout(width)
                }
            };
            cells.push((index, text, rows));
            height += rows;
            index = group(messages, index).map_or(index + 1, |range| range.end);
        }
        Self { cells, height }
    }
    pub(super) fn draw(
        &mut self,
        messages: &mut [Message],
        frame: &mut Frame<'_>,
        area: Rect,
        top: usize,
    ) {
        let mut start = 0;
        let mut drawn = 0_u16;
        for (index, text, rows) in &mut self.cells {
            if start + *rows > top {
                let remaining = Rect::new(area.x, area.y + drawn, area.width, area.height - drawn);
                let cache = match text {
                    Some(text) => text,
                    None => messages[*index].cached(),
                };
                drawn += u16::try_from(cache.draw(frame, remaining, top.saturating_sub(start)))
                    .unwrap_or(remaining.height);
                if drawn == area.height {
                    break;
                }
            }
            start += *rows;
        }
    }
}

#[derive(Default)]
pub(super) struct ActivityPanel {
    open: bool,
    expanded: HashSet<String>,
    selected: Option<String>,
    reveal: bool,
    scroll: usize,
    page: usize,
    detail: Option<Detail>,
}
struct Detail {
    key: String,
    request: Option<ToolDetailRequest>,
    content: CachedText,
}
pub(super) enum PanelAction {
    Consumed,
    Closed,
    Request(ToolDetailRequest),
    Cancel,
    PassThrough,
}
enum Row {
    Group { key: String, range: Range<usize> },
    Message { key: String, index: usize },
}
impl Row {
    fn key(&self) -> &str {
        match self {
            Self::Group { key, .. } | Self::Message { key, .. } => key,
        }
    }
}

fn keys(messages: &[Message]) -> Vec<String> {
    let mut seen = HashMap::new();
    messages
        .iter()
        .enumerate()
        .map(|(index, message)| match &message.kind {
            MessageKind::Tool { call_id, .. } => format!("tool:{call_id}"),
            MessageKind::Thinking(id) => format!("thinking:{id}"),
            _ => match message.id.as_deref() {
                Some(id) => {
                    let ordinal = seen.entry((id, message.role.label())).or_insert(0_usize);
                    let key = format!("entry:{id}:{}:{ordinal}", message.role.label());
                    *ordinal += 1;
                    key
                }
                None => format!("local:{index}"),
            },
        })
        .collect()
}
impl ActivityPanel {
    pub(super) fn is_open(&self) -> bool {
        self.open
    }
    pub(super) fn open(&mut self) {
        self.open = true;
        self.selected = None;
        self.reveal = true;
    }
    pub(super) fn close(&mut self) -> PanelAction {
        let pending = self
            .detail
            .as_ref()
            .is_some_and(|detail| detail.request.is_some());
        *self = Self::default();
        if pending {
            PanelAction::Cancel
        } else {
            PanelAction::Closed
        }
    }
    fn rows(&self, messages: &[Message]) -> Vec<Row> {
        let keys = keys(messages);
        let mut rows = Vec::new();
        let mut index = 0;
        while index < messages.len() {
            let Some(range) = group(messages, index) else {
                index += 1;
                continue;
            };
            let key = format!("group:{}", keys.get(index).map_or("", String::as_str));
            let expanded = self.expanded.contains(&key);
            rows.push(Row::Group {
                key,
                range: range.clone(),
            });
            if expanded {
                for item in range.clone() {
                    if let Some(key) = keys.get(item) {
                        rows.push(Row::Message {
                            key: key.clone(),
                            index: item,
                        });
                    }
                }
            }
            index = range.end;
        }
        rows
    }
    fn selection(&self, rows: &[Row]) -> usize {
        self.selected
            .as_ref()
            .and_then(|key| rows.iter().position(|row| row.key() == key))
            .unwrap_or(rows.len().saturating_sub(1))
    }
    pub(super) fn input(&mut self, key: KeyEvent, messages: &[Message]) -> PanelAction {
        if key.code == KeyCode::Esc
            || (key.code == KeyCode::Char('t') && key.modifiers.contains(KeyModifiers::CONTROL))
        {
            return self.close();
        }
        if key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL) {
            return PanelAction::PassThrough;
        }
        let rows = self.rows(messages);
        let selected = self.selection(&rows);
        match key.code {
            KeyCode::Up | KeyCode::Char('k') => {
                self.selected = rows
                    .get(selected.saturating_sub(1))
                    .map(|row| row.key().into());
                self.reveal = true;
            }
            KeyCode::Down | KeyCode::Char('j') => {
                self.selected = rows
                    .get((selected + 1).min(rows.len().saturating_sub(1)))
                    .map(|row| row.key().into());
                self.reveal = true;
            }
            KeyCode::PageUp => self.scroll = self.scroll.saturating_sub(self.page.max(1)),
            KeyCode::PageDown => self.scroll = self.scroll.saturating_add(self.page.max(1)),
            KeyCode::Home => self.scroll = 0,
            KeyCode::End => self.scroll = usize::MAX,
            KeyCode::Enter | KeyCode::Right | KeyCode::Char(' ') => match rows.get(selected) {
                Some(Row::Group { key, range }) => {
                    self.selected = Some(key.clone());
                    let collapsed = self.expanded.remove(key);
                    if !collapsed {
                        self.expanded.insert(key.clone());
                    }
                    self.reveal = true;
                    if collapsed
                        && self.detail.as_ref().is_some_and(|detail| {
                            keys(messages)[range.clone()].contains(&detail.key)
                        })
                    {
                        let pending = self
                            .detail
                            .take()
                            .is_some_and(|detail| detail.request.is_some());
                        if pending {
                            return PanelAction::Cancel;
                        }
                    }
                }
                Some(Row::Message { key, index }) => {
                    let Some(message) = messages.get(*index) else {
                        return PanelAction::Consumed;
                    };
                    let MessageKind::Tool { call_id, .. } = &message.kind else {
                        return PanelAction::Consumed;
                    };
                    if self
                        .detail
                        .as_ref()
                        .is_some_and(|detail| &detail.key == key)
                    {
                        let pending = self
                            .detail
                            .as_ref()
                            .is_some_and(|detail| detail.request.is_some());
                        self.detail = None;
                        return if pending {
                            PanelAction::Cancel
                        } else {
                            PanelAction::Consumed
                        };
                    }
                    let Some(entry_id) = &message.id else {
                        let pending = self
                            .detail
                            .as_ref()
                            .is_some_and(|detail| detail.request.is_some());
                        self.detail = Some(Detail {
                            key: key.clone(),
                            request: None,
                            content: CachedText::new(vec![Line::from(
                                "Tool details are pending a saved entry.",
                            )]),
                        });
                        return if pending {
                            PanelAction::Cancel
                        } else {
                            PanelAction::Consumed
                        };
                    };
                    let request = ToolDetailRequest {
                        id: uuid::Uuid::new_v4(),
                        entry_id: entry_id.clone(),
                        call_id: call_id.clone(),
                    };
                    self.detail = Some(Detail {
                        key: key.clone(),
                        request: Some(request.clone()),
                        content: CachedText::new(vec![Line::from("Loading tool details…")]),
                    });
                    return PanelAction::Request(request);
                }
                None => {}
            },
            _ => {}
        }
        PanelAction::Consumed
    }
    pub(super) fn receive(
        &mut self,
        request: &ToolDetailRequest,
        result: Result<ToolDetails, String>,
    ) {
        let Some(detail) = self
            .detail
            .as_mut()
            .filter(|detail| detail.request.as_ref() == Some(request))
        else {
            return;
        };
        detail.request = None;
        let mut lines = Vec::new();
        match result {
            Ok(ToolDetails::Available {
                call_id,
                name,
                status,
                input,
                output,
            }) if call_id == request.call_id => {
                lines.push(Line::styled(
                    format!("{} · {}", markdown::plain(&name), status_name(status)),
                    Style::default().add_modifier(Modifier::BOLD),
                ));
                lines.push(Line::from(format!("Call: {}", markdown::plain(&call_id))));
                content_lines("Input / arguments", input, &mut lines);
                content_lines("Output", output, &mut lines);
            }
            Ok(ToolDetails::Unavailable { call_id }) if call_id == request.call_id => {
                lines.push(Line::from("Tool details were not recorded."))
            }
            Ok(_) => lines.push(Line::from("The details response did not match this tool.")),
            Err(message) => lines.push(Line::from(markdown::plain(&message))),
        }
        detail.content = CachedText::new(lines);
    }
    fn header(&self, messages: &[Message], range: Range<usize>, key: &str) -> CachedText {
        let marker = if self.expanded.contains(key) {
            "▾"
        } else {
            "▸"
        };
        CachedText::new(vec![
            Line::styled(
                format!("{marker} {}", summary(messages, range)),
                Style::default().fg(Color::Cyan),
            ),
            Line::default(),
        ])
    }
    fn height(&mut self, row: &Row, messages: &mut [Message], width: u16) -> usize {
        match row {
            Row::Group { key, range } => self.header(messages, range.clone(), key).layout(width),
            Row::Message { key, index } => {
                let base = messages
                    .get_mut(*index)
                    .map_or(0, |message| message.cached().layout(width));
                base + self
                    .detail
                    .as_mut()
                    .filter(|detail| &detail.key == key)
                    .map_or(0, |detail| detail.content.layout(width))
            }
        }
    }
    fn paint(
        &mut self,
        row: &Row,
        messages: &mut [Message],
        frame: &mut Frame<'_>,
        area: Rect,
        top: usize,
    ) {
        match row {
            Row::Group { key, range } => {
                self.header(messages, range.clone(), key)
                    .draw(frame, area, top);
            }
            Row::Message { key, index } => {
                let Some(message) = messages.get_mut(*index) else {
                    return;
                };
                let cache = message.cached();
                let height = cache.layout(area.width);
                let drawn = cache.draw(frame, area, top);
                if drawn < usize::from(area.height)
                    && let Some(detail) = self.detail.as_mut().filter(|detail| &detail.key == key)
                {
                    let consumed = u16::try_from(drawn).unwrap_or(area.height);
                    detail.content.draw(
                        frame,
                        Rect::new(
                            area.x,
                            area.y + consumed,
                            area.width,
                            area.height - consumed,
                        ),
                        top.saturating_sub(height),
                    );
                }
            }
        }
    }
    pub(super) fn draw(&mut self, frame: &mut Frame<'_>, area: Rect, messages: &mut [Message]) {
        if area.width < 12 || area.height < 5 {
            frame.render_widget(Paragraph::new("Enlarge the terminal"), area);
            return;
        }
        let block = Block::new().borders(Borders::ALL).title("Activity");
        let inner = block.inner(area);
        frame.render_widget(block, area);
        let body = Rect::new(
            inner.x + 1,
            inner.y,
            inner.width.saturating_sub(1),
            inner.height.saturating_sub(2),
        );
        self.page = usize::from(body.height);
        let rows = self.rows(messages);
        if rows.is_empty() {
            frame.render_widget(Paragraph::new("No activity in this conversation."), body);
            return;
        }
        let selected = self.selection(&rows);
        self.selected = rows.get(selected).map(|row| row.key().into());
        let heights: Vec<_> = rows
            .iter()
            .map(|row| self.height(row, messages, body.width))
            .collect();
        let total: usize = heights.iter().sum();
        if self.reveal {
            self.scroll = heights.iter().take(selected).sum();
            self.reveal = false;
        }
        self.scroll = self.scroll.min(total.saturating_sub(self.page));
        let mut start = 0_usize;
        for (index, (row, height)) in rows.iter().zip(heights).enumerate() {
            let end = start + height;
            if end > self.scroll && start < self.scroll + self.page {
                let y = start.saturating_sub(self.scroll);
                let visible = (end - self.scroll.max(start)).min(self.page - y);
                let y = u16::try_from(y).unwrap_or(body.height);
                let height = u16::try_from(visible).unwrap_or(body.height);
                if index == selected {
                    frame.render_widget(
                        Paragraph::new("›").style(Style::default().fg(Color::Cyan)),
                        Rect::new(inner.x, body.y + y, 1, height),
                    );
                }
                self.paint(
                    row,
                    messages,
                    frame,
                    Rect::new(body.x, body.y + y, body.width, height),
                    self.scroll.saturating_sub(start),
                );
            }
            start = end;
        }
        frame.render_widget(
            Paragraph::new("↑/↓ select · Enter expand · PgUp/PgDn scroll · Esc close"),
            Rect::new(inner.x, inner.bottom().saturating_sub(1), inner.width, 1),
        );
    }
}
fn status_name(status: ToolStatus) -> &'static str {
    match status {
        ToolStatus::Running => "Running",
        ToolStatus::Finished => "Finished",
        ToolStatus::Failed => "Failed",
        ToolStatus::Declined => "Declined",
        ToolStatus::Interrupted => "Interrupted",
        ToolStatus::Unknown => "Status unavailable",
    }
}
fn content_lines(title: &'static str, content: ToolDetailContent, lines: &mut Vec<Line<'static>>) {
    lines.push(Line::default());
    lines.push(Line::styled(
        title,
        Style::default().add_modifier(Modifier::BOLD),
    ));
    match content {
        ToolDetailContent::Text { text, truncated } => {
            lines.extend(
                markdown::plain(&text)
                    .split('\n')
                    .map(|line| Line::from(line.to_owned())),
            );
            if truncated {
                lines.push(Line::from(
                    "[Display limit reached; full content remains on the coordinator.]",
                ));
            }
        }
        ToolDetailContent::Unavailable { reason } => lines.push(Line::from(match reason {
            ToolDetailUnavailable::Pending => "Pending",
            ToolDetailUnavailable::NotRecorded => "Not recorded",
            ToolDetailUnavailable::LookupLimit => "Lookup limit reached",
            ToolDetailUnavailable::Unsupported => "Unsupported payload",
        })),
    }
}

#[cfg(test)]
mod tests {
    use crate::{
        native::{ToolDetailContent, ToolDetailUnavailable, ToolDetails},
        protocol::{
            HistoryMessage, HistoryRole, ModelActivity, RuntimeCommand, RuntimeEventKind,
            ToolHistory, ToolStatus,
        },
        tui::{
            State, TuiInfo, TuiInput,
            activity::{PanelAction, ToolDetailRequest},
            inline::CellOutput,
        },
    };
    use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
    use ratatui::{Terminal, backend::TestBackend};

    fn state() -> State {
        State::new(TuiInfo {
            title: "Example agent".into(),
            model: None,
            cwd: "/workspace/example".into(),
        })
    }
    fn message(
        id: &str,
        role: HistoryRole,
        text: &str,
        tool: Option<ToolHistory>,
    ) -> HistoryMessage {
        HistoryMessage {
            presentation: None,
            entry_id: id.into(),
            role,
            text: text.into(),
            continuation: false,
            final_chunk: true,
            tool,
            attachments: None,
        }
    }
    fn history(state: &mut State, messages: Vec<HistoryMessage>) {
        state.event(RuntimeEventKind::History {
            conversation_id: "conversation-example".into(),
            messages,
            next_cursor: None,
            page_complete: true,
        });
        state.event(RuntimeEventKind::Done);
    }
    fn tool() -> HistoryMessage {
        message(
            "42",
            HistoryRole::Tool,
            "",
            Some(ToolHistory {
                call_id: "call-example".into(),
                name: "exec".into(),
                status: ToolStatus::Finished,
            }),
        )
    }
    fn key(state: &mut State, code: KeyCode) -> Option<TuiInput> {
        state.input(Event::Key(KeyEvent::new(code, KeyModifiers::NONE)))
    }
    fn open(state: &mut State) {
        assert!(
            state
                .input(Event::Key(KeyEvent::new(
                    KeyCode::Char('t'),
                    KeyModifiers::CONTROL
                )))
                .is_none()
        );
    }
    fn draw(state: &mut State, width: u16, height: u16) -> String {
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
    fn request(state: &mut State) -> ToolDetailRequest {
        open(state);
        key(state, KeyCode::Enter); // group
        key(state, KeyCode::Down); // tool
        let Some(TuiInput::ToolDetails(Some(request))) = key(state, KeyCode::Enter) else {
            panic!("tool expansion must request native details")
        };
        request
    }
    fn available() -> ToolDetails {
        ToolDetails::Available {
            call_id: "call-example".into(),
            name: "exec".into(),
            status: ToolStatus::Finished,
            input: ToolDetailContent::Text {
                text: "printf 'example command'".into(),
                truncated: false,
            },
            output: ToolDetailContent::Text {
                text: "example command\nProcess exited with code 0".into(),
                truncated: true,
            },
        }
    }

    #[test]
    fn live_activity_is_compact_but_commentary_and_failure_status_remain_visible() {
        let mut view = state();
        history(
            &mut view,
            vec![
                message(
                    "reasoning",
                    HistoryRole::Thinking,
                    "Complete retained reasoning",
                    None,
                ),
                tool(),
                message(
                    "update",
                    HistoryRole::Commentary,
                    "Checking the remaining configuration.",
                    None,
                ),
                message(
                    "failed-tool",
                    HistoryRole::Tool,
                    "",
                    Some(ToolHistory {
                        call_id: "failed-call".into(),
                        name: "read_file".into(),
                        status: ToolStatus::Failed,
                    }),
                ),
                message("answer", HistoryRole::Final, "Final answer.", None),
            ],
        );
        let text = draw(&mut view, 120, 28);
        assert_eq!(text.matches("Activity ·").count(), 2, "{text}");
        assert!(
            text.contains("Checking the remaining configuration.")
                && text.contains("Final answer."),
            "{text}"
        );
        assert!(
            text.contains("1 failed") && !text.contains("Complete retained reasoning"),
            "{text}"
        );
        assert_eq!(view.messages[0].text, "Complete retained reasoning");
        open(&mut view);
        key(&mut view, KeyCode::Up);
        key(&mut view, KeyCode::Enter);
        let expanded = draw(&mut view, 120, 28);
        assert!(
            expanded.contains("Complete retained reasoning"),
            "{expanded}"
        );
    }

    #[test]
    fn explicit_tool_expansion_uses_shared_identity_and_renders_arguments_output_and_limits() {
        let mut view = state();
        view.input(Event::Paste("A protected unsent draft".into()));
        history(&mut view, vec![tool()]);
        let request = request(&mut view);
        assert!(
            matches!(request.command(None, None), RuntimeCommand::ReadToolDetails { task_id: None, agent_id: None, entry_id, call_id } if entry_id == "42" && call_id == "call-example")
        );
        // Consume the actual shared event payload rather than a separate UI wire shape.
        let bytes = serde_json::to_vec(&RuntimeEventKind::ToolDetails {
            details: available(),
        })
        .unwrap();
        let RuntimeEventKind::ToolDetails { details } = serde_json::from_slice(&bytes).unwrap()
        else {
            panic!("typed tool details event")
        };
        view.activity.receive(&request, Ok(details));
        let text = draw(&mut view, 120, 30);
        for expected in [
            "Finished",
            "Input / arguments",
            "printf 'example command'",
            "Output",
            "Process exited with code 0",
            "Display limit reached",
        ] {
            assert!(text.contains(expected), "missing {expected}: {text}");
        }
        key(&mut view, KeyCode::Esc);
        assert_eq!(view.composer_draft().text, "A protected unsent draft");
        assert!(draw(&mut view, 120, 20).contains("A protected unsent draft"));
    }

    #[test]
    fn closing_or_collapsing_cancels_lookup_and_ignores_late_or_previous_responses() {
        let mut view = state();
        history(&mut view, vec![tool()]);
        let first = request(&mut view);
        assert!(matches!(
            key(&mut view, KeyCode::Esc),
            Some(TuiInput::ToolDetails(None))
        ));
        view.activity.receive(&first, Ok(available()));
        let second = request(&mut view);
        assert_ne!(first.id, second.id);
        view.activity.receive(&first, Ok(available()));
        assert!(draw(&mut view, 120, 24).contains("Loading tool details"));
        key(&mut view, KeyCode::Up);
        assert!(matches!(
            key(&mut view, KeyCode::Enter),
            Some(TuiInput::ToolDetails(None))
        ));
        assert!(view.activity.detail.is_none());
        view.activity.receive(&second, Ok(available()));
        assert!(!draw(&mut view, 120, 24).contains("printf"));
        view.reset_conversation(TuiInfo {
            title: "Another chat".into(),
            model: None,
            cwd: "/workspace/other".into(),
        });
        view.activity.receive(&second, Ok(available()));
        assert!(!view.activity.is_open());
    }

    #[test]
    fn unsaved_tool_never_guesses_entry_identity_and_unavailable_content_is_explicit() {
        let mut view = state();
        view.event(RuntimeEventKind::Activity {
            activity: ModelActivity::ToolStarted {
                call_id: "stream-call".into(),
                name: "exec".into(),
            },
        });
        open(&mut view);
        key(&mut view, KeyCode::Enter);
        key(&mut view, KeyCode::Down);
        assert!(key(&mut view, KeyCode::Enter).is_none());
        assert!(draw(&mut view, 120, 24).contains("pending a saved entry"));
        let mut view = state();
        history(&mut view, vec![tool()]);
        let req = request(&mut view);
        view.activity.receive(
            &req,
            Ok(ToolDetails::Available {
                call_id: req.call_id.clone(),
                name: "exec".into(),
                status: ToolStatus::Running,
                input: ToolDetailContent::Unavailable {
                    reason: ToolDetailUnavailable::NotRecorded,
                },
                output: ToolDetailContent::Unavailable {
                    reason: ToolDetailUnavailable::Pending,
                },
            }),
        );
        let text = draw(&mut view, 120, 28);
        assert!(
            text.contains("Not recorded") && text.contains("Pending") && text.contains("Running"),
            "{text}"
        );
    }

    #[test]
    fn switching_from_a_pending_lookup_to_an_unsaved_tool_cancels_the_old_read() {
        let mut view = state();
        history(&mut view, vec![tool()]);
        view.event(RuntimeEventKind::Activity {
            activity: ModelActivity::ToolStarted {
                call_id: "unsaved-call".into(),
                name: "read_file".into(),
            },
        });
        let old = request(&mut view);
        key(&mut view, KeyCode::Down);
        assert!(matches!(
            key(&mut view, KeyCode::Enter),
            Some(TuiInput::ToolDetails(None))
        ));
        view.activity.receive(&old, Ok(available()));
        let text = draw(&mut view, 120, 24);
        assert!(
            text.contains("pending a saved entry") && !text.contains("printf"),
            "{text}"
        );
    }

    #[test]
    fn group_is_emitted_once_only_after_a_real_boundary_and_keeps_full_reasoning() {
        let mut view = state();
        view.output.banner.ready();
        view.working(true);
        history(
            &mut view,
            vec![
                message(
                    "reasoning",
                    HistoryRole::Thinking,
                    "First reasoning paragraph.\n\nLast retained paragraph.",
                    None,
                ),
                tool(),
            ],
        );
        let mut terminal = Terminal::with_options(
            TestBackend::new(100, 20),
            ratatui::TerminalOptions {
                viewport: ratatui::Viewport::Inline(7),
            },
        )
        .unwrap();
        view.flush_output(&mut terminal, false).unwrap();
        assert_eq!(view.output.cursor, 0, "open activity must stay mutable");
        view.event(RuntimeEventKind::Message {
            message: message("answer", HistoryRole::Final, "Visible answer.", None),
        });
        view.flush_output(&mut terminal, false).unwrap();
        let before = terminal.backend().scrollback().clone();
        view.flush_output(&mut terminal, false).unwrap();
        assert_eq!(terminal.backend().scrollback(), &before);
        let text: String = before
            .content
            .iter()
            .chain(terminal.backend().buffer().content.iter())
            .map(|cell| cell.symbol())
            .collect();
        assert_eq!(text.matches("Activity ·").count(), 1, "{text}");
        assert!(
            text.contains("Visible answer.") && !text.contains("Last retained paragraph"),
            "{text}"
        );
        assert!(
            view.messages
                .iter()
                .all(|message| message.output == CellOutput::Printed)
        );
        open(&mut view);
        key(&mut view, KeyCode::Enter);
        assert!(draw(&mut view, 120, 28).contains("Last retained paragraph."));
    }

    #[test]
    fn reasoning_scroll_uses_full_cached_text_beyond_terminal_u16_rows() {
        let mut view = state();
        let mut reasoning = "reasoning line\n\n".repeat(33_000);
        reasoning.push_str("Final exposed reasoning line");
        history(
            &mut view,
            vec![message(
                "long-reasoning",
                HistoryRole::Thinking,
                &reasoning,
                None,
            )],
        );
        open(&mut view);
        key(&mut view, KeyCode::Enter);
        draw(&mut view, 100, 20);
        key(&mut view, KeyCode::End);
        let text = draw(&mut view, 100, 20);
        assert!(text.contains("Final exposed reasoning line"), "{text}");
        assert!(view.activity.scroll > usize::from(u16::MAX));
        assert_eq!(view.messages[0].text, reasoning);
        assert!(matches!(
            view.activity.input(
                KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL),
                &view.messages
            ),
            PanelAction::PassThrough
        ));
    }
}
