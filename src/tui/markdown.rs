use pulldown_cmark::{Alignment, Event, Options, Parser, Tag, TagEnd};
use ratatui::{
    style::{Color, Modifier, Style},
    text::{Line, Span},
};

struct Link {
    destination: String,
    label: String,
}

/// Render content as cells, never as terminal escape sequences.
pub(crate) fn plain(value: &str) -> String {
    value
        .chars()
        .filter(|ch| !ch.is_control() || matches!(ch, '\n' | '\t'))
        .collect()
}

fn parse(source: &str) -> Document {
    let source = plain(source);
    let mut lines = Vec::new();
    let mut line = Vec::new();
    let mut styles = vec![Style::default()];
    let mut lists: Vec<Option<u64>> = Vec::new();
    let mut code = false;
    let mut quote: usize = 0;
    let mut link: Option<Link> = None;
    let mut blocks = Vec::new();
    let mut table: Option<Table> = None;
    let flush = |lines: &mut Vec<Line<'static>>, line: &mut Vec<Span<'static>>| {
        if !line.is_empty() {
            lines.push(Line::from(std::mem::take(line)));
        }
    };
    for event in Parser::new_ext(
        &source,
        Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS | Options::ENABLE_TABLES,
    ) {
        let current = styles.last().copied().unwrap_or_default();
        match event {
            Event::Start(tag) => match tag {
                Tag::Table(alignments) => {
                    flush(&mut lines, &mut line);
                    blocks.push(Block::Text(std::mem::take(&mut lines)));
                    table = Some(Table {
                        alignments,
                        rows: Vec::new(),
                        current_row: Vec::new(),
                        prefix: "│ ".repeat(quote) + &"  ".repeat(lists.len()),
                    });
                }
                Tag::Heading { level, .. } => {
                    flush(&mut lines, &mut line);
                    styles.push(current.add_modifier(match level {
                        pulldown_cmark::HeadingLevel::H1 => Modifier::BOLD | Modifier::UNDERLINED,
                        pulldown_cmark::HeadingLevel::H2 => Modifier::BOLD,
                        pulldown_cmark::HeadingLevel::H3 => Modifier::BOLD | Modifier::ITALIC,
                        _ => Modifier::ITALIC,
                    }));
                }
                Tag::Emphasis => styles.push(current.add_modifier(Modifier::ITALIC)),
                Tag::Strong => styles.push(current.add_modifier(Modifier::BOLD)),
                Tag::Strikethrough => styles.push(current.add_modifier(Modifier::CROSSED_OUT)),
                Tag::Link { dest_url, .. } => {
                    link = Some(Link {
                        destination: dest_url.chars().filter(|ch| !ch.is_control()).collect(),
                        label: String::new(),
                    });
                    styles.push(current.fg(Color::Blue).add_modifier(Modifier::UNDERLINED));
                }
                Tag::CodeBlock(_) => {
                    flush(&mut lines, &mut line);
                    code = true;
                    styles.push(current);
                }
                Tag::BlockQuote(_) => {
                    flush(&mut lines, &mut line);
                    quote += 1;
                }
                Tag::List(start) => {
                    flush(&mut lines, &mut line);
                    lists.push(start);
                }
                Tag::Item => {
                    flush(&mut lines, &mut line);
                    let indent = "  ".repeat(lists.len().saturating_sub(1));
                    let bullet = match lists.last_mut() {
                        Some(Some(number)) => {
                            let label = format!("{number}. ");
                            *number += 1;
                            label
                        }
                        _ => "• ".into(),
                    };
                    line.push(Span::styled(indent + &bullet, current));
                }
                _ => {}
            },
            Event::End(tag) => match tag {
                TagEnd::TableCell => {
                    flush(&mut lines, &mut line);
                    if let Some(table) = &mut table {
                        table.current_row.push(std::mem::take(&mut lines));
                    }
                }
                TagEnd::TableHead | TagEnd::TableRow => {
                    if let Some(table) = &mut table {
                        table.rows.push(std::mem::take(&mut table.current_row));
                    }
                }
                TagEnd::Table => {
                    if let Some(table) = table.take() {
                        blocks.push(Block::Table(table));
                    }
                    lines.push(Line::default());
                }
                TagEnd::Heading(_) | TagEnd::CodeBlock => {
                    flush(&mut lines, &mut line);
                    styles.pop();
                    code = false;
                    lines.push(Line::default());
                }
                TagEnd::Link => {
                    if let Some(link) = link.take()
                        && !link.destination.is_empty()
                        && link.label.trim() != link.destination
                    {
                        line.push(Span::styled(format!(" ({})", link.destination), current));
                    }
                    styles.pop();
                }
                TagEnd::Emphasis | TagEnd::Strong | TagEnd::Strikethrough => {
                    styles.pop();
                }
                TagEnd::Paragraph | TagEnd::Item => {
                    flush(&mut lines, &mut line);
                    if lists.is_empty() {
                        lines.push(Line::default());
                    }
                }
                TagEnd::List(_) => {
                    lists.pop();
                    if lists.is_empty() {
                        lines.push(Line::default());
                    }
                }
                TagEnd::BlockQuote(_) => {
                    flush(&mut lines, &mut line);
                    quote = quote.saturating_sub(1);
                }
                _ => {}
            },
            Event::Text(value) | Event::Html(value) | Event::InlineHtml(value) => {
                if let Some(link) = &mut link {
                    link.label.push_str(&value);
                }
                for (index, segment) in value.split('\n').enumerate() {
                    if index > 0 {
                        flush(&mut lines, &mut line);
                    }
                    if table.is_none() && line.is_empty() && (code || quote > 0) {
                        line.push(Span::styled(
                            if code {
                                "  ".into()
                            } else {
                                "│ ".repeat(quote)
                            },
                            Style::default().fg(Color::DarkGray),
                        ));
                    }
                    if !segment.is_empty() {
                        line.push(Span::styled(segment.to_owned(), current));
                    }
                }
            }
            Event::Code(value) => {
                if let Some(link) = &mut link {
                    link.label.push_str(&value);
                }
                line.push(Span::styled(value.to_string(), current))
            }
            Event::SoftBreak => {
                if let Some(link) = &mut link {
                    link.label.push(' ');
                }
                line.push(Span::raw(" "));
            }
            Event::HardBreak => {
                if let Some(link) = &mut link {
                    link.label.push('\n');
                }
                flush(&mut lines, &mut line);
            }
            Event::Rule => {
                flush(&mut lines, &mut line);
                lines.push(Line::styled(
                    "────────────────",
                    Style::default().fg(Color::DarkGray),
                ));
            }
            Event::TaskListMarker(checked) => {
                line.push(Span::raw(if checked { "[x] " } else { "[ ] " }))
            }
            _ => {}
        }
    }
    flush(&mut lines, &mut line);
    while lines.last().is_some_and(|line| line.spans.is_empty()) {
        lines.pop();
    }
    blocks.push(Block::Text(lines));
    Document { blocks }
}

/// Parsed once per message; only table layout depends on the available width.
pub(super) struct Document {
    blocks: Vec<Block>,
}
enum Block {
    Text(Vec<Line<'static>>),
    Table(Table),
}
struct Table {
    alignments: Vec<Alignment>,
    rows: Vec<Vec<Vec<Line<'static>>>>,
    current_row: Vec<Vec<Line<'static>>>,
    prefix: String,
}

impl Document {
    pub(super) fn parse(source: &str) -> Self {
        parse(source)
    }

    pub(super) fn has_tables(&self) -> bool {
        self.blocks
            .iter()
            .any(|block| matches!(block, Block::Table(_)))
    }

    pub(super) fn lines(&self, width: u16) -> Vec<Line<'static>> {
        self.blocks
            .iter()
            .flat_map(|block| match block {
                Block::Text(lines) => lines.clone(),
                Block::Table(table) => table.lines(usize::from(width)),
            })
            .collect()
    }
}

impl Table {
    fn lines(&self, width: usize) -> Vec<Line<'static>> {
        let columns = self.alignments.len();
        if columns == 0 {
            return Vec::new();
        }
        let available = width.saturating_sub(Span::raw(&self.prefix).width());
        let budget = available.saturating_sub(columns.saturating_sub(1) * 3);
        let mut lines = if budget < columns * 3 {
            self.records(available.max(1))
        } else {
            let natural = (0..columns)
                .map(|column| {
                    self.rows
                        .iter()
                        .filter_map(|row| row.get(column))
                        .flat_map(|cell| cell.iter().map(Line::width))
                        .max()
                        .unwrap_or(0)
                        .max(3)
                })
                .collect::<Vec<_>>();
            let mut low = 3;
            let mut high = natural.iter().copied().max().unwrap_or(3);
            while low < high {
                let cap = low + (high - low).div_ceil(2);
                if natural.iter().map(|width| (*width).min(cap)).sum::<usize>() <= budget {
                    low = cap;
                } else {
                    high = cap - 1;
                }
            }
            let mut widths = natural
                .iter()
                .map(|width| (*width).min(low))
                .collect::<Vec<_>>();
            let mut remaining = budget.saturating_sub(widths.iter().sum());
            for (width, natural) in widths.iter_mut().zip(natural) {
                if remaining > 0 && *width < natural {
                    *width += 1;
                    remaining -= 1;
                }
            }
            let mut lines = Vec::new();
            for (index, row) in self.rows.iter().enumerate() {
                let cells = (0..columns)
                    .map(|column| {
                        row.get(column)
                            .map(|cell| {
                                cell.iter()
                                    .flat_map(|line| wrap(line, widths[column]))
                                    .collect::<Vec<_>>()
                            })
                            .unwrap_or_default()
                    })
                    .collect::<Vec<_>>();
                let height = cells.iter().map(Vec::len).max().unwrap_or(1).max(1);
                // A blank line separates logical rows only when a cell wrapped.
                if index > 1
                    && height > 1
                    && !lines
                        .last()
                        .is_some_and(|line: &Line<'_>| line.spans.is_empty())
                {
                    lines.push(Line::default());
                }
                for y in 0..height {
                    let mut line = Line::default();
                    for (column, cell) in cells.iter().enumerate() {
                        if column > 0 {
                            line.spans
                                .push(Span::styled(" │ ", Style::default().fg(Color::DarkGray)));
                        }
                        let cell = cell.get(y).cloned().unwrap_or_default();
                        let padding = widths[column].saturating_sub(cell.width());
                        let before = match self.alignments[column] {
                            Alignment::Right => padding,
                            Alignment::Center => padding / 2,
                            _ => 0,
                        };
                        line.spans.push(Span::raw(" ".repeat(before)));
                        let style = if index == 0 {
                            Style::default().add_modifier(Modifier::BOLD)
                        } else {
                            Style::default()
                        };
                        line.spans.extend(cell.spans.into_iter().map(|span| {
                            Span::styled(span.content, style.patch(cell.style).patch(span.style))
                        }));
                        if column + 1 < columns {
                            line.spans.push(Span::raw(" ".repeat(padding - before)));
                        }
                    }
                    lines.push(line);
                }
                if index == 0 {
                    lines.push(Line::styled(
                        widths
                            .iter()
                            .map(|width| "─".repeat(*width))
                            .collect::<Vec<_>>()
                            .join("─┼─"),
                        Style::default().fg(Color::DarkGray),
                    ));
                } else if height > 1 {
                    lines.push(Line::default());
                }
            }
            while lines.last().is_some_and(|line| line.spans.is_empty()) {
                lines.pop();
            }
            lines
        };
        if !self.prefix.is_empty() {
            for line in &mut lines {
                line.spans.insert(
                    0,
                    Span::styled(self.prefix.clone(), Style::default().fg(Color::DarkGray)),
                );
            }
        }
        lines
    }

    fn records(&self, width: usize) -> Vec<Line<'static>> {
        let mut lines = Vec::new();
        let Some(header) = self.rows.first() else {
            return lines;
        };
        if self.rows.len() == 1 {
            for cell in header {
                for line in cell {
                    lines.extend(wrap(line, width));
                }
            }
            return lines;
        }
        for row in self.rows.iter().skip(1) {
            if !lines.is_empty() {
                lines.push(Line::default());
            }
            for (column, label) in header.iter().enumerate() {
                let mut line = Line::default();
                for (index, part) in label.iter().enumerate() {
                    if index > 0 {
                        line.spans.push(Span::raw(" "));
                    }
                    line.spans.extend(part.spans.iter().map(|span| {
                        Span::styled(
                            span.content.clone(),
                            part.style.patch(span.style).add_modifier(Modifier::BOLD),
                        )
                    }));
                }
                line.spans.push(Span::raw(": "));
                if let Some(cell) = row.get(column) {
                    if let Some(first) = cell.first() {
                        line.spans.extend(first.spans.clone());
                    }
                    lines.extend(wrap(&line, width));
                    for part in cell.iter().skip(1) {
                        lines.extend(wrap(part, width));
                    }
                } else {
                    lines.extend(wrap(&line, width));
                }
            }
        }
        lines
    }
}

/// Wrap styled graphemes at word boundaries, splitting only overlong words.
/// Ratatui owns their display widths, including wide and combining characters.
fn wrap(source: &Line<'_>, width: usize) -> Vec<Line<'static>> {
    let width = width.max(1);
    let mut graphemes = source.styled_graphemes(Style::default()).peekable();
    let mut lines = Vec::new();
    let mut line = Line::default();
    let mut used = 0;
    let mut spaces = Vec::new();
    while let Some(first) = graphemes.next() {
        let whitespace = first.symbol.chars().all(char::is_whitespace);
        let mut word = vec![first];
        while graphemes
            .peek()
            .is_some_and(|next| next.symbol.chars().all(char::is_whitespace) == whitespace)
        {
            if let Some(next) = graphemes.next() {
                word.push(next);
            }
        }
        if whitespace {
            spaces = word;
            continue;
        }
        let word_width = word
            .iter()
            .map(|part| Span::raw(part.symbol).width())
            .sum::<usize>();
        let space_width = spaces
            .iter()
            .map(|part| Span::raw(part.symbol).width())
            .sum::<usize>();
        if used > 0 && used + space_width + word_width > width {
            lines.push(std::mem::take(&mut line));
            used = 0;
        }
        if used > 0 {
            for part in spaces.drain(..) {
                push_span(&mut line, part.symbol, part.style);
            }
            used += space_width;
        } else {
            spaces.clear();
        }
        for part in word {
            let size = Span::raw(part.symbol).width();
            if used > 0 && used + size > width {
                lines.push(std::mem::take(&mut line));
                used = 0;
            }
            push_span(&mut line, part.symbol, part.style);
            used += size;
        }
    }
    if !line.spans.is_empty() || lines.is_empty() {
        lines.push(line);
    }
    lines
}
fn push_span(line: &mut Line<'static>, text: &str, style: Style) {
    if let Some(previous) = line
        .spans
        .last_mut()
        .filter(|previous| previous.style == style)
    {
        previous.content.to_mut().push_str(text);
    } else {
        line.spans.push(Span::styled(text.to_owned(), style));
    }
}

#[cfg(test)]
pub(super) fn render(source: &str) -> Vec<Line<'static>> {
    Document::parse(source).lines(u16::MAX)
}

#[cfg(test)]
mod tests {
    use crate::tui::markdown::{Document, render};
    use ratatui::{Terminal, backend::TestBackend, style::Modifier, widgets::Paragraph};

    #[test]
    fn markdown_tables_render_aligned_headers_and_styled_body_cells() {
        let lines = render("| Item | Cost |\n| :--- | ---: |\n| **Board** | `12` |\n| Wire | 3 |");
        let mut terminal = Terminal::new(TestBackend::new(40, 8)).unwrap();
        terminal
            .draw(|frame| frame.render_widget(Paragraph::new(lines), frame.area()))
            .unwrap();
        let buffer = terminal.backend().buffer();
        let row = |y| {
            (0..40)
                .map(|x| buffer[(x, y)].symbol())
                .collect::<String>()
                .trim_end()
                .to_owned()
        };
        assert_eq!(row(0), "Item  │ Cost");
        assert_eq!(row(1), "──────┼─────");
        assert_eq!(row(2), "Board │   12");
        assert_eq!(row(3), "Wire  │    3");
        assert!(buffer[(0, 0)].modifier.contains(Modifier::BOLD));
        assert!(buffer[(0, 2)].modifier.contains(Modifier::BOLD));
        assert_eq!(buffer[(10, 2)].fg, ratatui::style::Color::Reset);
    }

    #[test]
    fn narrow_tables_wrap_styled_cells_with_unicode_display_widths() {
        let document = Document::parse(
            "| Label | Note | Count |\n| :--- | :---: | ---: |\n| 界界 | **ready now** | 12 |\n| 👩‍💻 e\u{301} | pending work | 3 |",
        );
        let lines = document.lines(22);
        assert!(lines.iter().all(|line| line.width() <= 22));
        let mut terminal = Terminal::new(TestBackend::new(22, 14)).unwrap();
        terminal
            .draw(|frame| frame.render_widget(Paragraph::new(lines), frame.area()))
            .unwrap();
        let buffer = terminal.backend().buffer();
        for y in [0, 2, 3, 5, 6] {
            assert_eq!(buffer[(6, y)].symbol(), "│", "first divider row {y}");
            assert_eq!(buffer[(15, y)].symbol(), "│", "second divider row {y}");
        }
        assert_eq!(buffer[(0, 2)].symbol(), "界");
        assert_eq!(buffer[(2, 2)].symbol(), "界");
        assert_eq!(buffer[(0, 5)].symbol(), "👩‍💻");
        assert_eq!(buffer[(3, 5)].symbol(), "e\u{301}");
        assert!(buffer[(8, 2)].modifier.contains(Modifier::BOLD));
        assert!(buffer[(9, 3)].modifier.contains(Modifier::BOLD));
        assert_eq!(buffer[(20, 2)].symbol(), "1");
        assert_eq!(buffer[(21, 2)].symbol(), "2");
    }

    #[test]
    fn very_narrow_tables_keep_labelled_values_and_complete_link_destinations() {
        let lines = Document::parse("| Item | Details | Price | Source |\n| --- | --- | ---: | --- |\n| 界 | long description | 12 | [spec](https://example.com/spec) |").lines(16);
        assert!(lines.iter().all(|line| line.width() <= 16));
        let mut terminal = Terminal::new(TestBackend::new(16, 24)).unwrap();
        terminal
            .draw(|frame| frame.render_widget(Paragraph::new(lines), frame.area()))
            .unwrap();
        let buffer = terminal.backend().buffer();
        let text = buffer
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(text.contains("Item: 界"));
        assert!(text.contains("Price: 12"));
        assert!(!text.contains('│'));
        let compact = text
            .chars()
            .filter(|ch| !ch.is_whitespace())
            .collect::<String>();
        assert!(compact.contains("Details:longdescription"));
        assert!(compact.contains("Source:spec(https://example.com/spec)"));
    }

    #[test]
    fn markdown_links_keep_copyable_destinations_without_repeating_autolinks() {
        let lines = render(
            "Read [the **source**](https://example.com/source) and [reference][ref].\n\n<https://example.com/direct>\n\n[ref]: https://example.com/reference",
        );
        let mut terminal = Terminal::new(TestBackend::new(120, 8)).unwrap();
        terminal
            .draw(|frame| frame.render_widget(Paragraph::new(lines), frame.area()))
            .unwrap();
        let text = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(text.contains("the source (https://example.com/source)"));
        assert!(text.contains("reference (https://example.com/reference)"));
        assert_eq!(text.matches("https://example.com/direct").count(), 1);
        assert_eq!(
            render("[https://example.com](https://example.com)")[0].to_string(),
            "https://example.com"
        );
    }

    #[test]
    fn markdown_has_native_styles_and_code_is_literal() {
        let lines = render(
            "# Heading\n\nA **bold** and *quiet* `value`.\n\n- first\n- second\n\n```rust\nlet x = **literal**;\n```",
        );
        let mut terminal = Terminal::new(TestBackend::new(60, 16)).unwrap();
        terminal
            .draw(|frame| frame.render_widget(Paragraph::new(lines), frame.area()))
            .unwrap();
        let buffer = terminal.backend().buffer();
        let text = buffer
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(text.contains("Heading"));
        assert!(text.contains("• first"));
        assert!(text.contains("• second"));
        assert!(text.contains("let x = **literal**;"));
        let bold = buffer
            .content
            .iter()
            .filter(|cell| cell.modifier.contains(Modifier::BOLD))
            .count();
        let italic = buffer
            .content
            .iter()
            .filter(|cell| cell.modifier.contains(Modifier::ITALIC))
            .count();
        assert!(bold >= 11);
        assert!(italic >= 5);
    }
}
