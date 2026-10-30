//! A local conversation picker. Selection changes the view, never model input.

use crate::{protocol::SavedConversation, tui::editor};
use crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers};
use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, List, ListItem, ListState, Padding, Paragraph},
};
use ratatui_textarea::TextArea;
use tokio::sync::oneshot;

pub(super) struct ConversationPicker {
    choices: Vec<SavedConversation>,
    query: TextArea<'static>,
    filtered: Vec<usize>,
    list: ListState,
    reply: Option<oneshot::Sender<Option<String>>>,
    page: usize,
}
impl ConversationPicker {
    pub(super) fn new(
        choices: Vec<SavedConversation>,
        query: String,
        reply: oneshot::Sender<Option<String>>,
    ) -> Self {
        let mut editor = editor();
        editor.insert_str(query);
        editor.set_block(Block::default().padding(Padding::new(2, 1, 1, 1)));
        editor.set_placeholder_text("Conversation title or ID");
        let mut picker = Self {
            choices,
            query: editor,
            filtered: Vec::new(),
            list: ListState::default(),
            reply: Some(reply),
            page: 1,
        };
        picker.filter();
        picker
    }

    fn filter(&mut self) {
        let query = self.query.lines().join(" ").to_lowercase();
        let words = query.split_whitespace().collect::<Vec<_>>();
        self.filtered = self
            .choices
            .iter()
            .enumerate()
            .filter_map(|(index, choice)| {
                let haystack = format!(
                    "{} {} {}",
                    choice.title,
                    choice.conversation_id,
                    choice.source_thread_id.as_deref().unwrap_or("")
                )
                .to_lowercase();
                words
                    .iter()
                    .all(|word| haystack.contains(word))
                    .then_some(index)
            })
            .collect();
        self.list.select((!self.filtered.is_empty()).then_some(0));
    }

    pub(super) fn input(&mut self, event: Event) -> bool {
        match event {
            Event::Key(key) if key.kind != KeyEventKind::Release => {
                match key.code {
                    KeyCode::Esc | KeyCode::Char('c')
                        if key.code == KeyCode::Esc
                            || key.modifiers.contains(KeyModifiers::CONTROL) =>
                    {
                        self.finish(None);
                        return true;
                    }
                    KeyCode::Enter => {
                        if let Some(index) = self
                            .list
                            .selected()
                            .and_then(|selected| self.filtered.get(selected))
                        {
                            self.finish(Some(self.choices[*index].conversation_id.clone()));
                            return true;
                        }
                    }
                    KeyCode::Up | KeyCode::PageUp => {
                        let step = if key.code == KeyCode::PageUp {
                            self.page
                        } else {
                            1
                        };
                        self.list
                            .select(self.list.selected().map(|index| index.saturating_sub(step)));
                    }
                    KeyCode::Down | KeyCode::PageDown => {
                        let step = if key.code == KeyCode::PageDown {
                            self.page
                        } else {
                            1
                        };
                        self.list.select(self.list.selected().map(|index| {
                            (index + step).min(self.filtered.len().saturating_sub(1))
                        }));
                    }
                    _ => {
                        let before = self.query.lines().join(" ");
                        self.query.input(key);
                        if before != self.query.lines().join(" ") {
                            self.filter();
                        }
                    }
                }
            }
            Event::Paste(text) => {
                self.query
                    .insert_str(text.split_whitespace().collect::<Vec<_>>().join(" "));
                self.filter();
            }
            _ => {}
        }
        false
    }

    fn finish(&mut self, selection: Option<String>) {
        if let Some(reply) = self.reply.take() {
            let _ = reply.send(selection);
        }
    }

    pub(super) fn draw(&mut self, frame: &mut Frame<'_>, area: Rect) {
        let areas = Layout::vertical([
            Constraint::Length(1),
            Constraint::Length(3),
            Constraint::Min(1),
            Constraint::Length(1),
        ])
        .split(area);
        frame.render_widget(
            Line::styled(
                "Resume conversation",
                Style::default().add_modifier(Modifier::BOLD),
            ),
            areas[0],
        );
        frame.render_widget(&self.query, areas[1]);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .and_then(|time| i64::try_from(time.as_millis()).ok());
        self.page = (usize::from(areas[2].height) / 2).max(1);
        if self.filtered.is_empty() {
            frame.render_widget(Paragraph::new("No matching conversations"), areas[2]);
        } else {
            let items = self
                .filtered
                .iter()
                .map(|index| {
                    let choice = &self.choices[*index];
                    let detail = choice
                        .host
                        .iter()
                        .cloned()
                        .chain(age(choice.updated_at, now))
                        .collect::<Vec<_>>()
                        .join(" · ");
                    ListItem::new(vec![
                        Line::raw(choice.title.clone()),
                        Line::styled(detail, Style::default().add_modifier(Modifier::DIM)),
                    ])
                })
                .collect::<Vec<_>>();
            frame.render_stateful_widget(
                List::new(items)
                    .highlight_symbol("› ")
                    .highlight_style(Style::default().add_modifier(Modifier::BOLD)),
                areas[2],
                &mut self.list,
            );
        }
        frame.render_widget(
            Line::from(vec![
                Span::styled("↑↓", Style::default().add_modifier(Modifier::DIM)),
                Span::raw(" choose · Enter resume · Esc cancel"),
            ]),
            areas[3],
        );
    }
}
impl Drop for ConversationPicker {
    fn drop(&mut self) {
        self.finish(None);
    }
}

fn age(timestamp: Option<i64>, now: Option<i64>) -> Option<String> {
    let minutes = now?.saturating_sub(timestamp?).max(0) / 60_000;
    Some(if minutes < 1 {
        "now".into()
    } else if minutes < 60 {
        format!("{minutes}m ago")
    } else if minutes < 1_440 {
        format!("{}h ago", minutes / 60)
    } else {
        format!("{}d ago", minutes / 1_440)
    })
}

#[cfg(test)]
mod tests {
    use crate::{
        protocol::SavedConversation,
        tui::conversations::{ConversationPicker, age},
    };
    use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
    use ratatui::{Terminal, backend::TestBackend};

    fn choices() -> Vec<SavedConversation> {
        [
            ("main", "Main agent", "desktop"),
            ("board", "Board review", "desktop"),
            ("firmware", "Board firmware", "laptop"),
        ]
        .into_iter()
        .map(|(id, title, host)| SavedConversation {
            conversation_id: id.into(),
            title: title.into(),
            updated_at: None,
            task_id: None,
            agent_id: None,
            host: Some(host.into()),
            source_thread_id: None,
        })
        .collect()
    }

    #[test]
    fn picker_filters_native_rows_and_returns_the_selected_existing_identity() {
        let (reply, mut selected) = tokio::sync::oneshot::channel();
        let mut picker = ConversationPicker::new(choices(), "board".into(), reply);
        let mut terminal = Terminal::new(TestBackend::new(60, 14)).unwrap();
        terminal
            .draw(|frame| picker.draw(frame, frame.area()))
            .unwrap();
        let text = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(text.contains("Board review"));
        assert!(text.contains("Board firmware"));
        assert!(text.contains("desktop"));
        assert!(text.contains("laptop"));
        assert!(!text.contains("Main agent"));
        assert!(!picker.input(Event::Key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE))));
        assert!(!picker.input(Event::Key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE))));
        assert!(picker.input(Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::NONE
        ))));
        assert_eq!(selected.try_recv().unwrap().as_deref(), Some("firmware"));
    }

    #[test]
    fn empty_picker_does_not_select_another_conversation_and_escape_cancels() {
        let (reply, mut selected) = tokio::sync::oneshot::channel();
        let mut picker = ConversationPicker::new(choices(), "missing".into(), reply);
        assert!(!picker.input(Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::NONE
        ))));
        assert!(matches!(
            selected.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
        assert!(picker.input(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE))));
        assert_eq!(selected.try_recv().unwrap(), None);
        assert_eq!(age(None, Some(3_600_000)), None);
        assert_eq!(
            age(Some(3_540_000), Some(3_600_000)).as_deref(),
            Some("1m ago")
        );
        assert_eq!(
            age(Some(3_600_001), Some(3_600_000)).as_deref(),
            Some("now")
        );
    }
}
