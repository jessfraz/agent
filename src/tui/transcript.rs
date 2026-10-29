//! Retain native text layout, then render only paragraphs intersecting the viewport.

use crate::tui::markdown;
use ratatui::{
    Frame,
    buffer::Buffer,
    layout::Rect,
    style::Style,
    text::Line,
    widgets::{Paragraph, Widget, Wrap},
};

struct MarkdownBody {
    header: Line<'static>,
    content: markdown::Document,
    style: Style,
}

impl MarkdownBody {
    fn paragraphs(&self, width: u16) -> Vec<Paragraph<'static>> {
        std::iter::once(self.header.clone())
            .chain(self.content.lines(width).into_iter().map(|line| {
                if self.style == Style::default() {
                    line
                } else {
                    line.style(self.style)
                }
            }))
            .chain(std::iter::once(Line::default()))
            .map(|line| Paragraph::new(line).wrap(Wrap { trim: false }))
            .collect()
    }
}

pub(super) struct CachedText {
    markdown: Option<MarkdownBody>,
    paragraphs: Vec<Paragraph<'static>>,
    row_ends: Vec<usize>,
    width: Option<u16>,
}

impl CachedText {
    pub(super) fn new(lines: Vec<Line<'static>>) -> Self {
        Self {
            markdown: None,
            paragraphs: lines
                .into_iter()
                .map(|line| Paragraph::new(line).wrap(Wrap { trim: false }))
                .collect(),
            row_ends: Vec::new(),
            width: None,
        }
    }

    pub(super) fn markdown(header: Line<'static>, source: &str, style: Style) -> Self {
        let body = MarkdownBody {
            header,
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
            row_ends: Vec::new(),
            width: None,
        }
    }

    #[cfg(test)]
    pub(super) fn width(&self) -> Option<u16> {
        self.width
    }

    pub(super) fn layout(&mut self, width: u16) -> usize {
        if self.width != Some(width) {
            if let Some(body) = &self.markdown {
                self.paragraphs = body.paragraphs(width);
            }
            self.row_ends.clear();
            let mut total = 0;
            for paragraph in &self.paragraphs {
                total += paragraph.line_count(width);
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
                break;
            }
            // Moving the owned widget changes its viewport without cloning its text.
            *paragraph =
                std::mem::take(paragraph).scroll((u16::try_from(offset).unwrap_or(u16::MAX), 0));
            let height = u16::try_from(rows).unwrap_or(area.height);
            draw(
                &*paragraph,
                Rect::new(
                    area.x,
                    area.y + u16::try_from(drawn).unwrap_or(0),
                    area.width,
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
