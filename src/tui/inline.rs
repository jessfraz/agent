//! Normal terminal scrollback owns completed output. Only mutable cells and the
//! composer remain in the inline viewport; native selection never needs mouse capture.

use crate::tui::{State, TerminalModes, WindowTitle, terminal_title};
use anyhow::{Context, Result};
use crossterm::{
    cursor::{MoveTo, Show},
    event::{
        DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, KeyboardEnhancementFlags,
        PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
    },
    execute,
    terminal::{Clear, ClearType, disable_raw_mode, enable_raw_mode},
};
use ratatui::{
    Terminal, TerminalOptions, Viewport,
    backend::{Backend, CrosstermBackend},
    layout::{Position, Size},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::Widget,
};
use std::{collections::HashSet, io::Stdout};

const BANNER_ROWS: u16 = 2;

struct OutputRows {
    ready: usize,
    pending: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CellOutput {
    Mutable,
    AwaitingIdle,
    Ready,
    Printed,
    // Older database pages are retained for the explicit history viewer. A
    // terminal cannot prepend them to scrollback that has already been emitted.
    Retained,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum View {
    #[default]
    Live,
    History,
}

#[derive(Default)]
pub(super) enum Banner {
    #[default]
    Waiting,
    Ready,
    Printed,
}

impl Banner {
    pub(super) fn ready(&mut self) {
        if matches!(self, Self::Waiting) {
            *self = Self::Ready;
        }
    }
}

#[derive(Default)]
pub(super) struct Output {
    pub(super) cursor: usize,
    pub(super) view: View,
    pub(super) collecting_history: bool,
    pub(super) historical_entries: HashSet<String>,
    pub(super) banner: Banner,
}

fn fresh_inline<B: Backend>(mut backend: B) -> std::result::Result<Terminal<B>, B::Error> {
    let size = backend.size()?;
    // Move the previous page into native scrollback, never erase it. Starting
    // at the last row makes this independent of the shell's cursor position.
    backend.set_cursor_position(Position::new(0, size.height.saturating_sub(1)))?;
    backend.append_lines(size.height)?;
    backend.set_cursor_position(Position::ORIGIN)?;
    backend.flush()?;
    Terminal::with_options(
        backend,
        TerminalOptions {
            viewport: Viewport::Inline(6),
        },
    )
}

pub(super) struct Screen {
    terminal: Terminal<CrosstermBackend<Stdout>>,
    height: u16,
    size: Size,
    title: String,
    _modes: TerminalModes,
}

impl Screen {
    pub(super) fn open() -> Result<Self> {
        enable_raw_mode().context("Could not enable terminal editing")?;
        let modes = TerminalModes;
        let mut output = std::io::stdout();
        execute!(
            output,
            EnableBracketedPaste,
            PushKeyboardEnhancementFlags(
                KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES
                    | KeyboardEnhancementFlags::REPORT_ALTERNATE_KEYS
            ),
            DisableMouseCapture
        )?;
        let terminal = fresh_inline(CrosstermBackend::new(output))?;
        let size = terminal.size()?;
        Ok(Self {
            terminal,
            height: 6,
            size,
            title: String::new(),
            _modes: modes,
        })
    }

    pub(super) fn draw(&mut self, state: &mut State) -> Result<()> {
        let size = self.terminal.size()?;
        let height = state.viewport_height(size, self.terminal.get_frame().area().y);
        if size != self.size || height != self.height {
            // Recreate only this viewport, once, including on resize. The
            // generic horizontal shrink path clears unrelated visible output.
            self.reframe(size, height)?;
        }
        // Shrink the mutable viewport before inserting closed cells. Otherwise
        // a formerly large stream pushes history offscreen unnecessarily and
        // leaves the smaller composer stranded above empty terminal rows.
        state.flush_output(&mut self.terminal, false)?;
        let title = terminal_title(&state.info);
        if self.title != title {
            execute!(std::io::stdout(), WindowTitle(&title))?;
            self.title = title;
        }
        self.terminal.draw(|frame| state.draw(frame))?;
        Ok(())
    }

    fn reframe(&mut self, size: Size, height: u16) -> Result<()> {
        reframe_inline(&mut self.terminal, size, height, |_| {
            CrosstermBackend::new(std::io::stdout())
        })?;
        self.size = size;
        self.height = height;
        Ok(())
    }

    pub(super) fn finish(&mut self, state: &mut State) -> Result<()> {
        // Detaching makes the final local snapshot immutable, including a
        // still-running tool. It does not claim that background work finished.
        self.reframe(self.terminal.size()?, 1)?;
        state.flush_output(&mut self.terminal, true)?;
        let top = self.terminal.get_frame().area().y;
        execute!(
            std::io::stdout(),
            MoveTo(0, top),
            Clear(ClearType::FromCursorDown),
            Show
        )?;
        Ok(())
    }
}

fn reframe_inline<B: Backend>(
    terminal: &mut Terminal<B>,
    size: Size,
    height: u16,
    reopen: impl FnOnce(&B) -> B,
) -> std::result::Result<(), B::Error> {
    let top = terminal
        .get_frame()
        .area()
        .y
        .min(size.height.saturating_sub(1));
    let backend = terminal.backend_mut();
    // CUP precedes the cursor query performed by Inline::with_options.
    backend.set_cursor_position(Position::new(0, top))?;
    backend.clear_region(ratatui::backend::ClearType::AfterCursor)?;
    backend.flush()?;
    *terminal = Terminal::with_options(
        reopen(terminal.backend()),
        TerminalOptions {
            viewport: Viewport::Inline(height.max(1)),
        },
    )?;
    Ok(())
}

impl Drop for Screen {
    fn drop(&mut self) {
        let top = self.terminal.get_frame().area().y;
        let _ = execute!(
            std::io::stdout(),
            MoveTo(0, top),
            Clear(ClearType::FromCursorDown)
        );
    }
}

impl Drop for TerminalModes {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = execute!(
            std::io::stdout(),
            DisableMouseCapture,
            DisableBracketedPaste,
            PopKeyboardEnhancementFlags,
            WindowTitle(""),
            Show
        );
    }
}

impl State {
    fn viewport_height(&mut self, size: Size, top: u16) -> u16 {
        if self.output.view == View::History || self.help_open {
            return size.height;
        }
        self.prepare_editor();
        let rows = self.output_rows(size.width);
        let body = rows
            .pending
            .max(if self.completion.is_some() { 6 } else { 1 });
        let chrome = self.editor_height(size.width, 6) + 2;
        let minimum = u16::try_from(body)
            .unwrap_or(u16::MAX)
            .saturating_add(chrome)
            .min(size.height);
        // Completed cells will be inserted above this viewport. Reserve their
        // exact cached rows first, then use every remaining row for the live
        // view so the composer ends at the pane bottom with any history size.
        let ready = u16::try_from(rows.ready).unwrap_or(u16::MAX);
        let after_insert = top
            .saturating_add(ready)
            .min(size.height.saturating_sub(minimum));
        size.height.saturating_sub(after_insert)
    }
    pub(super) fn flush_output<B: Backend>(
        &mut self,
        terminal: &mut Terminal<B>,
        ending: bool,
    ) -> std::result::Result<(), B::Error> {
        if matches!(self.output.banner, Banner::Waiting) && !ending {
            return Ok(());
        }
        if matches!(self.output.banner, Banner::Ready) {
            terminal.insert_before(BANNER_ROWS, |buffer| {
                Line::from(vec![
                    Span::styled(
                        "agent ",
                        Style::default()
                            .fg(Color::Cyan)
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::raw(crate::tui::markdown::plain(&self.info.title)),
                ])
                .render(buffer.area, buffer);
            })?;
            self.output.banner = Banner::Printed;
        }
        if self.output.collecting_history && !ending {
            return Ok(());
        }
        let width = terminal.size()?.width;
        while let Some(message) = self.messages.get_mut(self.output.cursor) {
            match message.output {
                CellOutput::Mutable | CellOutput::AwaitingIdle if !ending => break,
                CellOutput::Ready | CellOutput::Mutable | CellOutput::AwaitingIdle => {
                    let cached = message.cached();
                    let rows = cached.layout(width);
                    for top in (0..rows).step_by(256) {
                        let height = u16::try_from((rows - top).min(256)).unwrap_or(256);
                        // A failed write can have emitted a prefix. Returning
                        // ends this renderer; it must never retry that prefix.
                        terminal.insert_before(height, |buffer| {
                            cached.draw_buffer(buffer, top);
                        })?;
                    }
                    message.output = CellOutput::Printed;
                }
                CellOutput::Printed | CellOutput::Retained => {}
            }
            self.output.cursor += 1;
        }
        Ok(())
    }

    pub(super) fn live_base(&self) -> usize {
        if self.output.view == View::History {
            return 0;
        }
        self.output
            .cursor
            .checked_sub(1)
            .and_then(|index| self.row_ends.get(index))
            .copied()
            .unwrap_or(0)
    }

    #[cfg(test)]
    fn live_rows(&mut self, width: u16) -> usize {
        self.layout_transcript(width)
            .saturating_sub(self.live_base())
    }

    fn output_rows(&mut self, width: u16) -> OutputRows {
        let total = self.layout_transcript(width);
        let mut ready = if matches!(self.output.banner, Banner::Ready) {
            usize::from(BANNER_ROWS)
        } else {
            0
        };
        let mut frontier = self.output.cursor;
        if !self.output.collecting_history && !matches!(self.output.banner, Banner::Waiting) {
            while self.messages.get(frontier).is_some_and(|message| {
                !matches!(
                    message.output,
                    CellOutput::Mutable | CellOutput::AwaitingIdle
                )
            }) {
                if self.messages[frontier].output == CellOutput::Ready {
                    let before = frontier
                        .checked_sub(1)
                        .and_then(|index| self.row_ends.get(index))
                        .copied()
                        .unwrap_or(0);
                    ready = ready.saturating_add(self.row_ends[frontier].saturating_sub(before));
                }
                frontier += 1;
            }
        }
        let base = frontier
            .checked_sub(1)
            .and_then(|index| self.row_ends.get(index))
            .copied()
            .unwrap_or(0);
        OutputRows {
            ready,
            pending: total.saturating_sub(base),
        }
    }

    pub(super) fn settle_legacy_answer(&mut self) {
        let first = self.output.cursor.min(self.messages.len());
        for message in &mut self.messages[first..] {
            if message.output == CellOutput::AwaitingIdle {
                message.output = CellOutput::Ready;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::{
        models::ModelSelection,
        protocol::{
            HistoryMessage, HistoryRole, InputMode, ModelActivity, RuntimeEventKind, ToolHistory,
            ToolStatus,
        },
        tui::{
            State, TuiInfo,
            inline::{CellOutput, View},
        },
    };
    use ratatui::{
        Terminal, TerminalOptions, Viewport, backend::TestBackend, buffer::Buffer, layout::Position,
    };

    fn state() -> State {
        let mut state = State::new(TuiInfo {
            title: "Main agent".into(),
            model: ModelSelection::default(),
            cwd: "/workspace".into(),
        });
        state.output.banner.ready();
        state
    }

    fn terminal() -> Terminal<TestBackend> {
        let mut backend = TestBackend::new(70, 14);
        ratatui::backend::Backend::set_cursor_position(&mut backend, Position::new(0, 4)).unwrap();
        Terminal::with_options(
            backend,
            TerminalOptions {
                viewport: Viewport::Inline(7),
            },
        )
        .unwrap()
    }

    fn text(buffer: &Buffer) -> String {
        buffer
            .content
            .chunks(usize::from(buffer.area.width))
            .map(|row| {
                row.iter()
                    .map(|cell| cell.symbol())
                    .collect::<String>()
                    .trim_end()
                    .to_string()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn output(terminal: &Terminal<TestBackend>) -> String {
        format!(
            "{}\n{}",
            text(terminal.backend().scrollback()),
            text(terminal.backend().buffer())
        )
    }

    fn draw_inline(state: &mut State, terminal: &mut Terminal<TestBackend>) -> String {
        let size = terminal.size().unwrap();
        let area = terminal.get_frame().area();
        let height = state.viewport_height(size, area.y);
        if area.height != height || area.width != size.width || area.bottom() != size.height {
            crate::tui::inline::reframe_inline(terminal, size, height, Clone::clone).unwrap();
        }
        state.flush_output(terminal, false).unwrap();
        terminal.draw(|frame| state.draw(frame)).unwrap();
        let visible = text(terminal.backend().buffer());
        assert!(
            visible.lines().last().unwrap().contains("Enter steer"),
            "{visible}"
        );
        assert_eq!(terminal.get_frame().area().bottom(), size.height);
        visible
    }

    fn message(
        id: &str,
        role: HistoryRole,
        text: &str,
        continuation: bool,
        final_chunk: bool,
    ) -> HistoryMessage {
        HistoryMessage {
            entry_id: id.into(),
            role,
            text: text.into(),
            continuation,
            final_chunk,
            tool: None,
        }
    }

    #[test]
    fn reopened_history_enters_native_scrollback_once_after_complete_replay() {
        let mut state = state();
        let mut terminal = terminal();
        state.event(RuntimeEventKind::History {
            conversation_id: "main".into(),
            messages: vec![
                message("question", HistoryRole::User, "Saved question", false, true),
                message(
                    "answer",
                    HistoryRole::Final,
                    "Saved **answer** 界\n\n",
                    false,
                    false,
                ),
            ],
            next_cursor: Some("older".into()),
            page_complete: false,
        });
        state.flush_output(&mut terminal, false).unwrap();
        assert!(!output(&terminal).contains("Saved question"));
        state.event(RuntimeEventKind::History {
            conversation_id: "main".into(),
            messages: vec![message(
                "answer",
                HistoryRole::Final,
                "Final paragraph.",
                true,
                true,
            )],
            next_cursor: Some("older".into()),
            page_complete: false,
        });
        state.event(RuntimeEventKind::Done);
        state.flush_output(&mut terminal, false).unwrap();
        let saved = output(&terminal);
        assert_eq!(saved.matches("Saved question").count(), 1);
        assert_eq!(saved.matches("Saved answer 界").count(), 1);
        assert_eq!(saved.matches("Final paragraph.").count(), 1);
        assert!(saved.find("Saved question").unwrap() < saved.find("Saved answer").unwrap());
        for _ in 0..3 {
            state.flush_output(&mut terminal, false).unwrap();
        }
        assert_eq!(output(&terminal), saved);
        assert!(
            state
                .messages
                .iter()
                .all(|message| message.output == CellOutput::Printed)
        );
    }

    #[test]
    fn mutable_tool_and_exact_pending_input_hold_the_chronological_output_frontier() {
        let mut state = state();
        let mut terminal = terminal();
        state.event(RuntimeEventKind::Activity {
            activity: ModelActivity::Thinking {
                text: "Inspecting current evidence.".into(),
            },
        });
        state.event(RuntimeEventKind::Activity {
            activity: ModelActivity::ToolStarted {
                call_id: "inspect".into(),
                name: "inspect repository".into(),
            },
        });
        state.event(RuntimeEventKind::Notice {
            task_id: None,
            text: "Later notice".into(),
        });
        state.pending_input(
            "steer".into(),
            "Use the new context".into(),
            InputMode::Steer,
        );
        state.flush_output(&mut terminal, false).unwrap();
        let initial = output(&terminal);
        assert_eq!(initial.matches("Inspecting current evidence.").count(), 1);
        assert!(!initial.contains("inspect repository"));
        assert!(!initial.contains("Later notice"));
        state.event(RuntimeEventKind::Activity {
            activity: ModelActivity::ToolFinished {
                call_id: "inspect".into(),
                name: "inspect repository".into(),
            },
        });
        state.flush_output(&mut terminal, false).unwrap();
        assert_eq!(output(&terminal), initial);
        let mut canonical = message(
            "result",
            HistoryRole::Tool,
            "ignored tool body",
            false,
            true,
        );
        canonical.tool = Some(ToolHistory {
            call_id: "inspect".into(),
            name: "inspect repository".into(),
            status: ToolStatus::Failed,
        });
        state.event(RuntimeEventKind::Message { message: canonical });
        state.flush_output(&mut terminal, false).unwrap();
        let finished = output(&terminal);
        assert_eq!(finished.matches("✗ inspect repository").count(), 1);
        assert!(
            finished.find("inspect repository").unwrap() < finished.find("Later notice").unwrap()
        );
        assert!(!finished.contains("Use the new context"));
        state.event(RuntimeEventKind::InputPlaced {
            input_id: "steer".into(),
            entry_id: "user".into(),
        });
        state.flush_output(&mut terminal, false).unwrap();
        state.event(RuntimeEventKind::Message {
            message: message("user", HistoryRole::User, "Use the ", false, false),
        });
        state.event(RuntimeEventKind::Message {
            message: message("user", HistoryRole::User, "new context", true, true),
        });
        state.flush_output(&mut terminal, false).unwrap();
        let placed = output(&terminal);
        assert_eq!(placed.matches("Use the new context").count(), 1);
        assert!(placed.find("Later notice").unwrap() < placed.find("Use the new context").unwrap());
        assert!(!placed.contains("✓ inspect repository"));
    }

    #[test]
    fn live_native_chunks_seal_only_at_the_producers_last_chunk() {
        let mut state = state();
        let mut terminal = terminal();
        state.event(RuntimeEventKind::Message {
            message: message("update", HistoryRole::Commentary, "First ", false, false),
        });
        state.event(RuntimeEventKind::Notice {
            task_id: None,
            text: "Unrelated notice".into(),
        });
        state.flush_output(&mut terminal, false).unwrap();
        assert!(!output(&terminal).contains("First"));
        state.event(RuntimeEventKind::Message {
            message: message(
                "update",
                HistoryRole::Commentary,
                "complete update",
                true,
                true,
            ),
        });
        state.flush_output(&mut terminal, false).unwrap();
        let saved = output(&terminal);
        assert_eq!(saved.matches("First complete update").count(), 1);
        assert!(
            saved.find("First complete update").unwrap() < saved.find("Unrelated notice").unwrap()
        );
    }

    #[test]
    fn deeper_database_pages_remain_in_the_paginated_view_without_reprinting_native_history() {
        let mut state = state();
        let mut terminal = terminal();
        state.event(RuntimeEventKind::History {
            conversation_id: "main".into(),
            messages: vec![message(
                "recent",
                HistoryRole::Final,
                "Recent answer",
                false,
                true,
            )],
            next_cursor: Some("older".into()),
            page_complete: false,
        });
        state.event(RuntimeEventKind::Done);
        state.flush_output(&mut terminal, false).unwrap();
        let before = output(&terminal);
        assert!(state.load_history(crate::tui::HistoryLoad::Older).is_some());
        state.event(RuntimeEventKind::History {
            conversation_id: "main".into(),
            messages: vec![message(
                "older",
                HistoryRole::User,
                "Older question",
                false,
                true,
            )],
            next_cursor: None,
            page_complete: false,
        });
        state.event(RuntimeEventKind::Done);
        state.flush_output(&mut terminal, false).unwrap();
        assert_eq!(output(&terminal), before);
        assert_eq!(state.output.view, View::History);
        let mut viewer = Terminal::new(TestBackend::new(70, 20)).unwrap();
        viewer.draw(|frame| state.draw(frame)).unwrap();
        assert!(text(viewer.backend().buffer()).contains("Older question"));
        state.output.view = View::Live;
        state.push(crate::tui::Role::Agent, "New answer".into());
        state.flush_output(&mut terminal, false).unwrap();
        let saved = output(&terminal);
        assert_eq!(saved.matches("Recent answer").count(), 1);
        assert_eq!(saved.matches("New answer").count(), 1);
        assert!(!saved.contains("Older question"));
        assert_eq!(state.live_rows(70), 0);
    }

    #[test]
    fn canonical_answer_identity_merges_live_completion_with_replayed_history() {
        let mut state = state();
        let mut terminal = terminal();
        state.event(RuntimeEventKind::Answer {
            conversation_id: "main".into(),
            entry_id: Some("answer".into()),
            text: "One completed answer".into(),
        });
        state.flush_output(&mut terminal, false).unwrap();
        let before = output(&terminal);
        state.event(RuntimeEventKind::History {
            conversation_id: "main".into(),
            messages: vec![message(
                "answer",
                HistoryRole::Final,
                "One completed answer",
                false,
                true,
            )],
            next_cursor: None,
            page_complete: false,
        });
        state.event(RuntimeEventKind::Done);
        state.flush_output(&mut terminal, false).unwrap();
        state.event(RuntimeEventKind::Answer {
            conversation_id: "main".into(),
            entry_id: Some("answer".into()),
            text: "One completed answer".into(),
        });
        state.flush_output(&mut terminal, false).unwrap();
        assert_eq!(output(&terminal), before);
        assert_eq!(before.matches("One completed answer").count(), 1);
    }

    #[test]
    fn initial_history_done_does_not_seal_a_tool_that_is_still_running() {
        let mut state = state();
        let mut terminal = terminal();
        let mut call = message("call", HistoryRole::Tool, "run check", false, true);
        call.tool = Some(ToolHistory {
            call_id: "check".into(),
            name: "run check".into(),
            status: ToolStatus::Running,
        });
        state.event(RuntimeEventKind::History {
            conversation_id: "main".into(),
            messages: vec![call],
            next_cursor: None,
            page_complete: false,
        });
        state.event(RuntimeEventKind::Done);
        state.flush_output(&mut terminal, false).unwrap();
        assert!(!output(&terminal).contains("run check"));
        let mut result = message("result", HistoryRole::Tool, "failed", false, true);
        result.tool = Some(ToolHistory {
            call_id: "check".into(),
            name: "run check".into(),
            status: ToolStatus::Failed,
        });
        state.event(RuntimeEventKind::Message { message: result });
        state.flush_output(&mut terminal, false).unwrap();
        assert_eq!(output(&terminal).matches("✗ run check").count(), 1);
        assert!(!output(&terminal).contains("• run check"));
    }

    #[test]
    fn inline_insertion_preserves_output_above_its_nonzero_origin() {
        let mut lines = vec![String::new(); 14];
        lines[0] = "Existing shell output".into();
        lines[1] = " ".repeat(70);
        let mut backend = TestBackend::with_lines(lines);
        ratatui::backend::Backend::set_cursor_position(&mut backend, Position::new(0, 4)).unwrap();
        let mut terminal = Terminal::with_options(
            backend,
            TerminalOptions {
                viewport: Viewport::Inline(7),
            },
        )
        .unwrap();
        let mut state = state();
        for number in 0..8 {
            state.push(crate::tui::Role::Agent, format!("Saved answer {number}"));
        }
        state.flush_output(&mut terminal, false).unwrap();
        let saved = output(&terminal);
        assert_eq!(saved.matches("Existing shell output").count(), 1);
        for number in 0..8 {
            assert_eq!(saved.matches(&format!("Saved answer {number}")).count(), 1);
        }
        assert!(
            saved.find("Existing shell output").unwrap() < saved.find("Saved answer 0").unwrap()
        );
        assert!(!text(terminal.backend().scrollback()).is_empty());
    }

    #[test]
    fn early_answer_cannot_seal_a_tool_before_its_late_canonical_failure() {
        let mut state = state();
        let mut terminal = terminal();
        state.event(RuntimeEventKind::Activity {
            activity: ModelActivity::ToolStarted {
                call_id: "check".into(),
                name: "run check".into(),
            },
        });
        state.event(RuntimeEventKind::Activity {
            activity: ModelActivity::ToolFinished {
                call_id: "check".into(),
                name: "run check".into(),
            },
        });
        state.event(RuntimeEventKind::Answer {
            conversation_id: "main".into(),
            text: "Completed answer".into(),
            entry_id: Some("answer".into()),
        });
        state.flush_output(&mut terminal, false).unwrap();
        assert!(!output(&terminal).contains("run check"));
        assert!(!output(&terminal).contains("Completed answer"));
        let mut result = message("result", HistoryRole::Tool, "failed", false, true);
        result.tool = Some(ToolHistory {
            call_id: "check".into(),
            name: "run check".into(),
            status: ToolStatus::Failed,
        });
        state.event(RuntimeEventKind::Message { message: result });
        state.flush_output(&mut terminal, false).unwrap();
        let saved = output(&terminal);
        assert_eq!(saved.matches("✗ run check").count(), 1);
        assert_eq!(saved.matches("Completed answer").count(), 1);
        assert!(!saved.contains("✓ run check"));
        assert!(saved.find("run check").unwrap() < saved.find("Completed answer").unwrap());
    }

    #[test]
    fn early_answer_cannot_seal_a_native_text_before_its_last_chunk() {
        let mut state = state();
        let mut terminal = terminal();
        state.event(RuntimeEventKind::Message {
            message: message("update", HistoryRole::Commentary, "First ", false, false),
        });
        state.event(RuntimeEventKind::Answer {
            conversation_id: "main".into(),
            text: "Completed answer".into(),
            entry_id: Some("answer".into()),
        });
        state.flush_output(&mut terminal, false).unwrap();
        assert!(!output(&terminal).contains("First"));
        let tail = message(
            "update",
            HistoryRole::Commentary,
            "complete update",
            true,
            true,
        );
        state.event(RuntimeEventKind::Message { message: tail });
        state.flush_output(&mut terminal, false).unwrap();
        let saved = output(&terminal);
        assert_eq!(saved.matches("First complete update").count(), 1);
        assert_eq!(saved.matches("Completed answer").count(), 1);
        assert!(
            saved.find("First complete update").unwrap() < saved.find("Completed answer").unwrap()
        );
    }

    #[test]
    fn live_entry_replay_does_not_duplicate_completed_history_or_collapse_distinct_blocks() {
        let mut state = state();
        let mut terminal = terminal();
        let first = message(
            "saved",
            HistoryRole::Commentary,
            "First saved block",
            false,
            true,
        );
        let second = message(
            "saved",
            HistoryRole::Commentary,
            "Second saved block",
            false,
            true,
        );
        state.event(RuntimeEventKind::History {
            conversation_id: "main".into(),
            messages: vec![first.clone(), second.clone()],
            next_cursor: None,
            page_complete: false,
        });
        state.event(RuntimeEventKind::Done);
        state.flush_output(&mut terminal, false).unwrap();
        for frame in [first, second] {
            state.event(RuntimeEventKind::Message { message: frame });
            state.flush_output(&mut terminal, false).unwrap();
        }
        for body in ["First live block", "Second live block"] {
            state.event(RuntimeEventKind::Message {
                message: message("live", HistoryRole::Commentary, body, false, true),
            });
            state.flush_output(&mut terminal, false).unwrap();
        }
        let saved = output(&terminal);
        for body in [
            "First saved block",
            "Second saved block",
            "First live block",
            "Second live block",
        ] {
            assert_eq!(saved.matches(body).count(), 1, "{body}");
        }
    }

    #[test]
    fn session_banner_precedes_restored_history_and_only_the_footer_is_live() {
        let mut state = state();
        let mut terminal = Terminal::with_options(
            TestBackend::new(90, 24),
            TerminalOptions {
                viewport: Viewport::Inline(10),
            },
        )
        .unwrap();
        state.event(RuntimeEventKind::History {
            conversation_id: "main".into(),
            messages: vec![
                message("question", HistoryRole::User, "Saved question", false, true),
                message("answer", HistoryRole::Final, "Saved answer", false, true),
            ],
            next_cursor: None,
            page_complete: false,
        });
        state.event(RuntimeEventKind::Done);
        state.flush_output(&mut terminal, false).unwrap();
        state.pending_input("next".into(), "Continue this task".into(), InputMode::Steer);
        state.working(true);
        terminal.draw(|frame| state.draw(frame)).unwrap();
        let rendered = output(&terminal);
        let banner = rendered.find("agent Main agent").unwrap();
        let saved = rendered.find("Saved question").unwrap();
        let answer = rendered.find("Saved answer").unwrap();
        let pending = rendered.find("Continue this task").unwrap();
        let composer = rendered.find("Message the agent").unwrap();
        assert!(banner < saved, "{rendered}");
        assert!(
            saved < answer && answer < pending && pending < composer,
            "{rendered}"
        );
        assert_eq!(rendered.matches("agent Main agent").count(), 1);
        assert_eq!(rendered.matches("Working").count(), 1, "{rendered}");
    }

    #[test]
    fn fresh_session_moves_the_previous_page_into_scrollback_without_erasing_it() {
        let mut previous = vec![String::new(); 24];
        previous[0] = "Previous command".into();
        previous[1] = "Previous connection error".into();
        previous[2] = " ".repeat(90);
        let mut backend = TestBackend::with_lines(previous);
        ratatui::backend::Backend::set_cursor_position(&mut backend, Position::new(0, 4)).unwrap();
        let mut terminal = crate::tui::inline::fresh_inline(backend).unwrap();
        let mut state = state();
        state.event(RuntimeEventKind::History {
            conversation_id: "main".into(),
            messages: vec![message(
                "saved",
                HistoryRole::Final,
                "Saved answer",
                false,
                true,
            )],
            next_cursor: None,
            page_complete: false,
        });
        state.event(RuntimeEventKind::Done);
        state.flush_output(&mut terminal, false).unwrap();
        terminal.draw(|frame| state.draw(frame)).unwrap();
        let visible = text(terminal.backend().buffer());
        assert!(visible.starts_with("agent Main agent\n"), "{visible}");
        assert!(visible.contains("Saved answer"));
        assert!(!visible.contains("Previous command"));
        assert!(!visible.contains("Previous connection error"));
        let retained = text(terminal.backend().scrollback());
        assert_eq!(retained.matches("Previous command").count(), 1);
        assert_eq!(retained.matches("Previous connection error").count(), 1);
        let rendered = output(&terminal);
        assert!(
            rendered.find("Previous command").unwrap() < rendered.find("agent Main agent").unwrap()
        );
        assert!(
            rendered.find("agent Main agent").unwrap() < rendered.find("Saved answer").unwrap()
        );
    }

    #[test]
    fn session_banner_waits_for_the_native_task_title_and_prints_once() {
        let mut state = state();
        state.output.banner = crate::tui::inline::Banner::Waiting;
        state.info.title = "Connecting to task".into();
        let mut terminal = terminal();
        state.flush_output(&mut terminal, false).unwrap();
        assert!(!output(&terminal).contains("Connecting to task"));
        state.event(RuntimeEventKind::TaskReady {
            conversation_id: "task".into(),
            title: "Review device settings".into(),
        });
        state.flush_output(&mut terminal, false).unwrap();
        state.working(true);
        state.flush_output(&mut terminal, false).unwrap();
        state.working(false);
        state.flush_output(&mut terminal, false).unwrap();
        let rendered = output(&terminal);
        assert_eq!(rendered.matches("agent Review device settings").count(), 1);
        assert!(!rendered.contains("Connecting to task"));
    }

    #[test]
    fn early_watch_notice_waits_for_the_banner_and_restored_history() {
        let mut state = state();
        state.output.banner = crate::tui::inline::Banner::Waiting;
        let mut terminal = terminal();
        state.event(RuntimeEventKind::Notice {
            task_id: None,
            text: "New actionable update".into(),
        });
        state.flush_output(&mut terminal, false).unwrap();
        assert!(!output(&terminal).contains("New actionable update"));
        assert!(state.output_rows(70).pending > 1);
        state.event(RuntimeEventKind::History {
            conversation_id: "main".into(),
            messages: vec![message(
                "saved",
                HistoryRole::User,
                "Saved question",
                false,
                true,
            )],
            next_cursor: None,
            page_complete: false,
        });
        state.event(RuntimeEventKind::Done);
        state.flush_output(&mut terminal, false).unwrap();
        let rendered = output(&terminal);
        assert!(
            rendered.find("agent Main agent").unwrap() < rendered.find("Saved question").unwrap()
        );
        assert!(
            rendered.find("Saved question").unwrap()
                < rendered.find("New actionable update").unwrap()
        );
        assert_eq!(rendered.matches("New actionable update").count(), 1);
    }

    #[test]
    fn composer_stays_at_the_pane_bottom_with_visible_history_across_append_and_resize() {
        let mut state = state();
        let mut terminal = crate::tui::inline::fresh_inline(TestBackend::new(90, 48)).unwrap();
        state.event(RuntimeEventKind::History {
            conversation_id: "main".into(),
            messages: vec![
                message("question", HistoryRole::User, "Saved question", false, true),
                message("answer", HistoryRole::Final, "Saved answer", false, true),
            ],
            next_cursor: None,
            page_complete: false,
        });
        let loading = draw_inline(&mut state, &mut terminal);
        assert!(loading.contains("Saved question"));
        state.event(RuntimeEventKind::Done);
        let restored = draw_inline(&mut state, &mut terminal);
        assert!(restored.contains("agent Main agent"));
        assert!(restored.contains("Saved question") && restored.contains("Saved answer"));
        let saved = output(&terminal);
        for _ in 0..3 {
            draw_inline(&mut state, &mut terminal);
        }
        assert_eq!(output(&terminal), saved);
        state.event(RuntimeEventKind::Answer {
            conversation_id: "main".into(),
            text: "New completed answer".into(),
            entry_id: Some("new".into()),
        });
        assert!(draw_inline(&mut state, &mut terminal).contains("New completed answer"));
        terminal.backend_mut().resize(90, 32);
        let smaller = draw_inline(&mut state, &mut terminal);
        assert!(smaller.contains("Saved question") && smaller.contains("New completed answer"));
        terminal.backend_mut().resize(90, 60);
        assert!(draw_inline(&mut state, &mut terminal).contains("New completed answer"));
        let all = output(&terminal);
        assert_eq!(all.matches("Saved question").count(), 1);
        assert_eq!(all.matches("Saved answer").count(), 1);
        assert_eq!(all.matches("New completed answer").count(), 1);
    }

    #[test]
    fn substantial_native_scrollback_does_not_move_the_idle_composer_off_the_bottom() {
        let mut state = state();
        let mut terminal = crate::tui::inline::fresh_inline(TestBackend::new(90, 48)).unwrap();
        let messages = (0..200)
            .map(|index| {
                message(
                    &format!("entry-{index}"),
                    HistoryRole::Final,
                    &format!("Saved history item {index:03}"),
                    false,
                    true,
                )
            })
            .collect();
        state.event(RuntimeEventKind::History {
            conversation_id: "main".into(),
            messages,
            next_cursor: Some("older".into()),
            page_complete: false,
        });
        state.event(RuntimeEventKind::Done);
        let visible = draw_inline(&mut state, &mut terminal);
        assert!(visible.contains("Saved history item 199"));
        assert!(text(terminal.backend().scrollback()).contains("Saved history item 000"));
        let saved = output(&terminal);
        // Native wheel/trackpad reads scrollback without sending an app event.
        let _older = text(terminal.backend().scrollback());
        for _ in 0..3 {
            draw_inline(&mut state, &mut terminal);
        }
        assert_eq!(output(&terminal), saved);
        terminal.backend_mut().resize(90, 80);
        assert!(draw_inline(&mut state, &mut terminal).contains("Saved history item 199"));
        state.event(RuntimeEventKind::Answer {
            conversation_id: "main".into(),
            text: "Latest answer".into(),
            entry_id: Some("latest".into()),
        });
        assert!(draw_inline(&mut state, &mut terminal).contains("Latest answer"));
        let all = output(&terminal);
        for index in 0..200 {
            assert_eq!(
                all.matches(&format!("Saved history item {index:03}"))
                    .count(),
                1
            );
        }
        assert_eq!(all.matches("Latest answer").count(), 1);
    }

    #[test]
    fn attached_worker_history_finishes_its_page_without_ending_the_live_stream() {
        let mut state = state();
        let mut terminal = crate::tui::inline::fresh_inline(TestBackend::new(90, 48)).unwrap();
        state.event(RuntimeEventKind::TaskReady {
            conversation_id: "worker".into(),
            title: "Review device settings".into(),
        });
        state.event(RuntimeEventKind::History {
            conversation_id: "worker".into(),
            messages: vec![message(
                "question",
                HistoryRole::User,
                "Saved worker question",
                false,
                true,
            )],
            next_cursor: None,
            page_complete: false,
        });
        state.event(RuntimeEventKind::WorkerIdle);
        state.flush_output(&mut terminal, false).unwrap();
        assert!(!output(&terminal).contains("Saved worker question"));
        state.event(RuntimeEventKind::History {
            conversation_id: "worker".into(),
            messages: vec![message(
                "answer",
                HistoryRole::Final,
                "Saved worker answer",
                false,
                true,
            )],
            next_cursor: Some("older".into()),
            page_complete: true,
        });
        state.event(RuntimeEventKind::Activity {
            activity: ModelActivity::Thinking {
                text: "Reviewing the next request.".into(),
            },
        });
        state.event(RuntimeEventKind::WorkerIdle);
        state.flush_output(&mut terminal, false).unwrap();
        let saved = output(&terminal);
        assert_eq!(saved.matches("Saved worker question").count(), 1, "{saved}");
        assert_eq!(saved.matches("Saved worker answer").count(), 1);
        assert!(!state.output.collecting_history);
        assert!(state.history_entry.is_none());
        assert!(state.load_history(crate::tui::HistoryLoad::Older).is_some());
        state.event(RuntimeEventKind::History {
            conversation_id: "worker".into(),
            messages: vec![],
            next_cursor: None,
            page_complete: true,
        });
        assert!(state.loading_history.is_none());
        state.event(RuntimeEventKind::Done);
        state.event(RuntimeEventKind::Done);
        state.flush_output(&mut terminal, false).unwrap();
        assert_eq!(output(&terminal), saved);
    }

    #[test]
    fn worker_ready_holds_placed_input_until_the_initial_history_page_arrives() {
        let mut state = state();
        let mut terminal = crate::tui::inline::fresh_inline(TestBackend::new(90, 48)).unwrap();
        state.event(RuntimeEventKind::TaskReady {
            conversation_id: "worker".into(),
            title: "Review device settings".into(),
        });
        state.pending_input(
            "queued".into(),
            "Continue with this new context".into(),
            InputMode::Steer,
        );
        state.event(RuntimeEventKind::InputPlaced {
            input_id: "queued".into(),
            entry_id: "new-input".into(),
        });
        state.flush_output(&mut terminal, false).unwrap();
        assert!(!output(&terminal).contains("Continue with this new context"));
        assert!(state.output_rows(90).pending > 0);
        state.event(RuntimeEventKind::History {
            conversation_id: "worker".into(),
            messages: vec![message(
                "old",
                HistoryRole::Final,
                "Previously completed answer",
                false,
                true,
            )],
            next_cursor: None,
            page_complete: true,
        });
        state.event(RuntimeEventKind::WorkerIdle);
        state.flush_output(&mut terminal, false).unwrap();
        let rendered = output(&terminal);
        assert!(
            rendered.find("Previously completed answer").unwrap()
                < rendered.find("Continue with this new context").unwrap()
        );
        assert_eq!(
            rendered.matches("Continue with this new context").count(),
            1
        );
    }
}
