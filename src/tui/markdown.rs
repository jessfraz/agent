use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
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

pub(crate) fn render(source: &str) -> Vec<Line<'static>> {
    let source = plain(source);
    let mut lines = Vec::new();
    let mut line = Vec::new();
    let mut styles = vec![Style::default()];
    let mut lists: Vec<Option<u64>> = Vec::new();
    let mut code = false;
    let mut quote: usize = 0;
    let mut link: Option<Link> = None;
    let flush = |lines: &mut Vec<Line<'static>>, line: &mut Vec<Span<'static>>| {
        if !line.is_empty() {
            lines.push(Line::from(std::mem::take(line)));
        }
    };
    for event in Parser::new_ext(
        &source,
        Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS,
    ) {
        let current = styles.last().copied().unwrap_or_default();
        match event {
            Event::Start(tag) => match tag {
                Tag::Heading { .. } => {
                    flush(&mut lines, &mut line);
                    styles.push(current.fg(Color::Cyan).add_modifier(Modifier::BOLD));
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
                    styles.push(current.fg(Color::Yellow));
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
                    line.push(Span::styled(
                        indent + &bullet,
                        Style::default().fg(Color::DarkGray),
                    ));
                }
                _ => {}
            },
            Event::End(tag) => match tag {
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
                    if line.is_empty() && (code || quote > 0) {
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
                line.push(Span::styled(value.to_string(), current.fg(Color::Yellow)))
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
    lines
}

#[cfg(test)]
mod tests {
    use crate::tui::markdown::render;
    use ratatui::{Terminal, backend::TestBackend, style::Modifier, widgets::Paragraph};

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
