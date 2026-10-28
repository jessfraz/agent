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
    layout::Size,
};
use std::{collections::HashSet, io::Stdout};

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
pub(super) struct Output {
    pub(super) cursor: usize,
    pub(super) view: View,
    pub(super) collecting_history: bool,
    pub(super) historical_entries: HashSet<String>,
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
        let terminal = Terminal::with_options(
            CrosstermBackend::new(output),
            TerminalOptions {
                viewport: Viewport::Inline(7),
            },
        )?;
        let size = terminal.size()?;
        Ok(Self {
            terminal,
            height: 7,
            size,
            title: String::new(),
            _modes: modes,
        })
    }

    pub(super) fn draw(&mut self, state: &mut State) -> Result<()> {
        let size = self.terminal.size()?;
        if size != self.size {
            // Recreate only the owned viewport. Ratatui's generic horizontal
            // shrink path clears the whole visible screen, including output
            // above the composer, so it must not own this transition.
            self.reframe(size, self.height.min(size.height))?;
        }
        let height = if state.output.view == View::History || state.help_open {
            size.height
        } else {
            state.prepare_editor();
            let body = state
                .pending_rows(size.width)
                .max(if state.completion.is_some() { 6 } else { 1 });
            let chrome = state.editor_height(size.width, 6) + 3;
            u16::try_from(body)
                .unwrap_or(u16::MAX)
                .saturating_add(chrome)
                .min(size.height)
        };
        if height != self.height {
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
        let top = self
            .terminal
            .get_frame()
            .area()
            .y
            .min(size.height.saturating_sub(1));
        // CUP precedes the cursor query performed by Inline::with_options, so
        // both real terminals and PTY consumers observe the same origin.
        execute!(
            std::io::stdout(),
            MoveTo(0, top),
            Clear(ClearType::FromCursorDown)
        )?;
        self.terminal = Terminal::with_options(
            CrosstermBackend::new(std::io::stdout()),
            TerminalOptions {
                viewport: Viewport::Inline(height.max(1)),
            },
        )?;
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
    pub(super) fn flush_output<B: Backend>(
        &mut self,
        terminal: &mut Terminal<B>,
        ending: bool,
    ) -> std::result::Result<(), B::Error> {
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

    fn pending_rows(&mut self, width: u16) -> usize {
        let total = self.layout_transcript(width);
        let mut frontier = self.output.cursor;
        if !self.output.collecting_history {
            while self.messages.get(frontier).is_some_and(|message| {
                !matches!(
                    message.output,
                    CellOutput::Mutable | CellOutput::AwaitingIdle
                )
            }) {
                frontier += 1;
            }
        }
        let base = frontier
            .checked_sub(1)
            .and_then(|index| self.row_ends.get(index))
            .copied()
            .unwrap_or(0);
        total.saturating_sub(base)
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
        State::new(TuiInfo {
            title: "Main agent".into(),
            model: ModelSelection::default(),
            cwd: "/workspace".into(),
        })
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
}
