//! Retain native text layout, then render only paragraphs intersecting the viewport.

use crate::tui::markdown;
use ratatui::{
    Frame,
    buffer::Buffer,
    layout::Rect,
    style::Style,
    text::{Line, Span},
    widgets::{Paragraph, Widget, Wrap},
};
use std::ops::Range;

struct MarkdownBody {
    heading: Option<Line<'static>>,
    content: markdown::Document,
    style: Style,
}

impl MarkdownBody {
    fn paragraphs(&self, width: u16) -> Vec<Paragraph<'static>> {
        let mut lines = self.content.lines(width);
        while lines.last().is_some_and(|line| line.width() == 0) {
            lines.pop();
        }
        lines.push(Line::default());
        self.heading
            .clone()
            .into_iter()
            .chain(lines)
            .map(|line| {
                if self.style == Style::default() {
                    line
                } else {
                    line.style(self.style)
                }
            })
            .map(|line| Paragraph::new(line).wrap(Wrap { trim: false }))
            .collect()
    }
}

pub(super) struct CachedText {
    markdown: Option<MarkdownBody>,
    paragraphs: Vec<Paragraph<'static>>,
    trailing: Vec<Paragraph<'static>>,
    row_ends: Vec<usize>,
    width: Option<u16>,
    gutter: Option<Span<'static>>,
    marker_row: usize,
    preview: Option<Preview>,
}
struct Preview {
    body: Range<usize>,
    notice: usize,
}

impl CachedText {
    pub(super) fn new(lines: Vec<Line<'static>>) -> Self {
        Self {
            markdown: None,
            paragraphs: lines
                .into_iter()
                .map(|line| Paragraph::new(line).wrap(Wrap { trim: false }))
                .collect(),
            trailing: Vec::new(),
            row_ends: Vec::new(),
            width: None,
            gutter: None,
            marker_row: 0,
            preview: None,
        }
    }

    pub(super) fn markdown(marker: Span<'static>, source: &str, style: Style) -> Self {
        Self::styled_markdown(None, marker, source, style)
    }
    pub(super) fn markdown_heading(
        heading: Line<'static>,
        marker: Span<'static>,
        source: &str,
        style: Style,
    ) -> Self {
        Self::styled_markdown(Some(heading), marker, source, style)
    }
    fn styled_markdown(
        heading: Option<Line<'static>>,
        marker: Span<'static>,
        source: &str,
        style: Style,
    ) -> Self {
        let body = MarkdownBody {
            heading,
            content: markdown::Document::parse(source),
            style,
        };
        let (markdown, paragraphs) = if body.content.has_tables() {
            (Some(body), Vec::new())
        } else {
            // Ordinary prose retains its native widgets through resize, as before.
            let paragraphs = body.paragraphs(u16::MAX);
            (None, paragraphs)
        };
        Self {
            markdown,
            paragraphs,
            trailing: Vec::new(),
            row_ends: Vec::new(),
            width: None,
            gutter: Some(marker),
            marker_row: 0,
            preview: None,
        }
    }

    pub(super) fn prompt(source: &str) -> Self {
        let mut result = Self::new(
            std::iter::once(Line::default())
                .chain(
                    markdown::plain(source)
                        .split('\n')
                        .map(|line| Line::from(line.to_owned())),
                )
                .chain(std::iter::once(Line::default()))
                .collect(),
        );
        result.gutter = Some(Span::styled(
            "› ",
            Style::default()
                .add_modifier(ratatui::style::Modifier::DIM | ratatui::style::Modifier::BOLD),
        ));
        result.marker_row = 1;
        result
    }

    pub(super) fn indented(lines: Vec<Line<'static>>, marker: Span<'static>) -> Self {
        let mut result = Self::new(lines);
        result.gutter = Some(marker);
        result
    }
    pub(super) fn tool_preview(
        lines: Vec<Line<'static>>,
        marker: Span<'static>,
        body: Range<usize>,
        notice: usize,
    ) -> Self {
        let mut result = Self::indented(lines, marker);
        result.preview = Some(Preview { body, notice });
        result
    }

    pub(super) fn append_line(&mut self, line: Line<'static>) {
        let paragraph = Paragraph::new(line).wrap(Wrap { trim: false });
        if self.markdown.is_some() {
            self.trailing.push(paragraph);
        } else {
            self.paragraphs.push(paragraph);
        }
        self.width = None;
    }

    #[cfg(test)]
    pub(super) fn width(&self) -> Option<u16> {
        self.width
    }

    pub(super) fn layout(&mut self, width: u16) -> usize {
        if self.width != Some(width) {
            let content_width = width.saturating_sub(if self.gutter.is_some() { 2 } else { 0 });
            if let Some(body) = &self.markdown {
                self.paragraphs = body.paragraphs(content_width);
                self.paragraphs.extend(self.trailing.iter().cloned());
            }
            self.row_ends.clear();
            let mut total = 0;
            let mut remaining = 5;
            let mut truncated = false;
            for (index, paragraph) in self.paragraphs.iter().enumerate() {
                let mut rows = paragraph.line_count(content_width);
                if let Some(preview) = &self.preview {
                    if preview.body.contains(&index) {
                        truncated |= rows > remaining;
                        rows = rows.min(remaining);
                        remaining = remaining.saturating_sub(rows);
                    } else if index == preview.notice && !truncated {
                        rows = 0;
                    }
                }
                total += rows;
                self.row_ends.push(total);
            }
            self.width = Some(width);
        }
        self.row_ends.last().copied().unwrap_or(0)
    }

    pub(super) fn draw(&mut self, frame: &mut Frame<'_>, area: Rect, top: usize) -> usize {
        self.paint(area, top, |paragraph, area| {
            frame.render_widget(paragraph, area);
        })
    }

    pub(super) fn draw_buffer(&mut self, buffer: &mut Buffer, top: usize) -> usize {
        self.paint(buffer.area, top, |paragraph, area| {
            paragraph.render(area, buffer);
        })
    }

    fn paint(
        &mut self,
        area: Rect,
        top: usize,
        mut draw: impl FnMut(&Paragraph<'static>, Rect),
    ) -> usize {
        let gutter = u16::from(self.gutter.is_some()) * 2;
        if let Some(marker) = &self.gutter
            && self.marker_row >= top
            && self.marker_row < top + usize::from(area.height)
        {
            draw(
                &Paragraph::new(Line::from(marker.clone())),
                Rect::new(
                    area.x,
                    area.y + u16::try_from(self.marker_row - top).unwrap_or(0),
                    gutter.min(area.width),
                    1,
                ),
            );
        }
        let first = self.row_ends.partition_point(|end| *end <= top);
        let mut start = first.checked_sub(1).map_or(0, |index| self.row_ends[index]);
        let mut drawn = 0;
        for (paragraph, end) in self.paragraphs[first..]
            .iter_mut()
            .zip(&self.row_ends[first..])
        {
            let offset = top.saturating_sub(start);
            let rows = (end - start)
                .saturating_sub(offset)
                .min(usize::from(area.height) - drawn);
            if rows == 0 {
                start = *end;
                continue;
            }
            // Moving the owned widget changes its viewport without cloning its text.
            *paragraph =
                std::mem::take(paragraph).scroll((u16::try_from(offset).unwrap_or(u16::MAX), 0));
            let height = u16::try_from(rows).unwrap_or(area.height);
            draw(
                &*paragraph,
                Rect::new(
                    area.x.saturating_add(gutter).min(area.right()),
                    area.y + u16::try_from(drawn).unwrap_or(0),
                    area.width.saturating_sub(gutter),
                    height,
                ),
            );
            drawn += rows;
            if drawn == usize::from(area.height) {
                break;
            }
            start = *end;
        }
        drawn
    }
}

#[cfg(test)]
mod tests {
    use crate::tui::{markdown, transcript::CachedText};
    use ratatui::{
        Terminal,
        backend::TestBackend,
        text::Line,
        widgets::{Paragraph, Wrap},
    };

    #[test]
    fn prompt_gutters_keep_literal_unicode_wrapping_and_paged_offsets_aligned_with_native_widgets()
    {
        use ratatui::{
            style::{Modifier, Style},
            text::Span,
            widgets::{Block, Padding, Widget},
        };
        let source = "Literal **markup** with 界界, 👩‍💻 and e\u{301} across wrapped lines.\nA second prompt line.";
        let mut cached = CachedText::prompt(source);
        for width in [12, 23, 48, 12] {
            let rows = cached.layout(width);
            for top in [0, 1, rows / 2, rows.saturating_sub(4)] {
                let mut actual =
                    ratatui::buffer::Buffer::empty(ratatui::layout::Rect::new(0, 0, width, 4));
                cached.draw_buffer(&mut actual, top);
                let mut expected = ratatui::buffer::Buffer::empty(actual.area);
                Paragraph::new(format!("\n{source}\n"))
                    .block(Block::default().padding(Padding::left(2)))
                    .wrap(Wrap { trim: false })
                    .scroll((u16::try_from(top).unwrap(), 0))
                    .render(expected.area, &mut expected);
                if top <= 1 {
                    Paragraph::new(Line::from(Span::styled(
                        "› ",
                        Style::default().add_modifier(Modifier::DIM | Modifier::BOLD),
                    )))
                    .render(
                        ratatui::layout::Rect::new(0, u16::try_from(1 - top).unwrap(), 2, 1),
                        &mut expected,
                    );
                }
                assert_eq!(actual, expected, "width {width}, top {top}");
            }
        }
    }

    #[test]
    fn viewport_matches_native_wrapping_with_styles_whitespace_and_wide_unicode() {
        let mut lines = markdown::render(
            "# Saved context\n\nA **bold** answer with `code`, 界 and 👩‍💻, and e\u{301}.\n\n- A long list item with enough context to cross the available width\n- Next\n\n```text\n  Indented code    keeps spaces and wide text 界界界\n```\n\nThe final paragraph is visible at the end.",
        );
        lines.push(Line::default());
        let mut cached = CachedText::new(lines.clone());
        for width in [16, 23, 61, 16] {
            let rows = cached.layout(width);
            for height in [1, 4, 12] {
                for top in [0, 1, rows / 2, rows.saturating_sub(usize::from(height))] {
                    let mut actual = Terminal::new(TestBackend::new(width, height)).unwrap();
                    actual
                        .draw(|frame| {
                            cached.draw(frame, frame.area(), top);
                        })
                        .unwrap();
                    let mut expected = Terminal::new(TestBackend::new(width, height)).unwrap();
                    expected
                        .draw(|frame| {
                            frame.render_widget(
                                Paragraph::new(lines.clone())
                                    .wrap(Wrap { trim: false })
                                    .scroll((u16::try_from(top).unwrap(), 0)),
                                frame.area(),
                            )
                        })
                        .unwrap();
                    assert_eq!(
                        actual.backend().buffer(),
                        expected.backend().buffer(),
                        "width={width}, height={height}, top={top}"
                    );
                }
            }
        }
    }
}
