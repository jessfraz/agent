//! Display-only shell previews. Original command metadata remains untouched.
//! Codex 0.165 unwraps exact sh/bash/zsh -c/-lc argv before Bash highlighting.
//! Without its shlex/syntect dependencies, only literal wrappers are decoded;
//! token accents are lexical, never an interpretation of the command.

use crate::tui::markdown;
use ratatui::{
    style::{Color, Modifier, Style},
    text::{Line, Span},
};
use std::path::Path;

pub(super) fn command_lines(command: &str) -> Vec<Line<'static>> {
    let script = literal_words(command).and_then(|words| {
        let [shell, flag, script] = words.as_slice() else {
            return None;
        };
        (matches!(flag.as_str(), "-c" | "-lc")
            && Path::new(shell)
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| matches!(name, "sh" | "bash" | "zsh")))
        .then(|| script.clone())
    });
    highlight(&markdown::plain(script.as_deref().unwrap_or(command)))
}

#[derive(Clone, Copy)]
enum Quote {
    Single,
    Double,
}

/// Decode literal POSIX argv, rejecting expansions/operators whose evaluation
/// could change the wrapper or script. Extra argv deliberately prevents unwrap.
fn literal_words(command: &str) -> Option<Vec<String>> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut started = false;
    let mut quote = None;
    let mut chars = command.chars().peekable();
    while let Some(ch) = chars.next() {
        match (quote, ch) {
            (Some(Quote::Single), '\'') | (Some(Quote::Double), '"') => quote = None,
            (Some(Quote::Single), _) => word.push(ch),
            (Some(Quote::Double), '$' | '`') => return None,
            (Some(Quote::Double), '\\') => match chars.peek().copied()? {
                '\n' => {
                    chars.next();
                }
                '$' | '`' | '"' | '\\' => word.push(chars.next()?),
                _ => word.push(ch),
            },
            (Some(Quote::Double), _) => word.push(ch),
            (None, '\'' | '"') => {
                started = true;
                quote = Some(if ch == '\'' {
                    Quote::Single
                } else {
                    Quote::Double
                });
            }
            (None, '\\') => {
                let escaped = chars.next()?;
                if escaped != '\n' {
                    started = true;
                    word.push(escaped);
                }
            }
            (None, ' ' | '\t') => {
                if started {
                    words.push(std::mem::take(&mut word));
                    started = false;
                }
            }
            (
                None,
                '$' | '`' | '|' | '&' | ';' | '<' | '>' | '(' | ')' | '{' | '}' | '*' | '?' | '['
                | '~' | '#' | '!',
            ) => return None,
            (None, _) if ch.is_control() => return None,
            (None, _) => {
                started = true;
                word.push(ch);
            }
        }
    }
    if quote.is_some() {
        return None;
    }
    if started {
        words.push(word);
    }
    Some(words)
}

fn highlight(script: &str) -> Vec<Line<'static>> {
    let mut lines = vec![Line::default()];
    let mut chars = script.char_indices().peekable();
    let mut boundary = true;
    while let Some((start, ch)) = chars.next() {
        let style = match ch {
            '\'' | '"' => {
                while let Some((_, next)) = chars.next() {
                    if next == '\\' && ch == '"' {
                        chars.next();
                    } else if next == ch {
                        break;
                    }
                }
                Style::default().fg(Color::Green)
            }
            '\\' => {
                chars.next();
                Style::default()
            }
            '#' if boundary => {
                while chars.peek().is_some_and(|(_, ch)| *ch != '\n') {
                    chars.next();
                }
                Style::default().add_modifier(Modifier::DIM)
            }
            '$' => {
                if chars.peek().is_some_and(|(_, ch)| *ch == '{') {
                    for (_, next) in chars.by_ref() {
                        if next == '}' {
                            break;
                        }
                    }
                } else {
                    while chars.peek().is_some_and(|(_, ch)| {
                        ch.is_ascii_alphanumeric()
                            || matches!(ch, '_' | '?' | '@' | '*' | '#' | '$' | '!')
                    }) {
                        chars.next();
                    }
                }
                Style::default().fg(Color::Cyan)
            }
            '|' | '&' | ';' | '<' | '>' | '(' | ')' => Style::default().fg(Color::Cyan),
            _ => Style::default(),
        };
        let end = chars.peek().map_or(script.len(), |(offset, _)| *offset);
        let token = &script[start..end];
        for (index, part) in token.split('\n').enumerate() {
            if index > 0 {
                lines.push(Line::default());
            }
            if !part.is_empty()
                && let Some(line) = lines.last_mut()
            {
                // Coalesce unstyled word characters instead of allocating a
                // span for every glyph of a long command.
                if let Some(previous) = line.spans.last_mut()
                    && previous.style == style
                {
                    previous.content.to_mut().push_str(part);
                } else {
                    line.spans.push(Span::styled(part.to_owned(), style));
                }
            }
        }
        boundary = ch != '\\'
            && (token.ends_with(char::is_whitespace)
                || matches!(ch, '|' | '&' | ';' | '<' | '>' | '(' | ')'));
    }
    lines
}

#[cfg(test)]
mod tests {
    use crate::tui::shell::command_lines;
    use ratatui::{
        Terminal,
        backend::TestBackend,
        style::{Color, Modifier},
        widgets::Paragraph,
    };

    fn text(lines: &[ratatui::text::Line<'_>]) -> String {
        lines
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn known_wrappers_preserve_nested_quoting_multiline_and_original_metadata() {
        for (command, script) in [
            ("bash -c 'git status --short'", "git status --short"),
            (
                "/usr/bin/zsh -lc 'printf one\nprintf two'",
                "printf one\nprintf two",
            ),
            (
                r#"/bin/bash -lc 'printf '\''%s\n'\'' "hello world"'"#,
                r#"printf '%s\n' "hello world""#,
            ),
            (
                r#"sh -c "printf \"%s\\n\" \"world\"""#,
                r#"printf "%s\n" "world""#,
            ),
            ("/nix/store/example-bash/bin/bash -lc ''", ""),
        ] {
            let original = command.to_owned();
            assert_eq!(text(&command_lines(command)), script);
            assert_eq!(command, original);
        }
    }

    #[test]
    fn ambiguous_dynamic_and_unknown_commands_stay_literal() {
        for command in [
            "fish -c 'git status'",
            "env bash -c 'git status'",
            "bash -cl 'git status'",
            "bash -c 'echo $0' custom",
            "bash -c 'echo ok' | cat",
            "bash -c 'echo ok'\necho after",
            r#"bash -c "echo $HOME""#,
            r#"bash -c "echo `pwd`""#,
            "bash -c *.sh",
            "bash -c 'unfinished",
            r"C:\bin\bash.exe -c 'echo ok'",
        ] {
            assert_eq!(text(&command_lines(command)), command, "{command}");
        }
    }

    #[test]
    fn native_paragraph_preserves_literal_code_and_lexical_accents() {
        let command = "bash -lc 'printf \"世界\" | cat # a comment\nprintf $HOME\\!'";
        // The trailing control makes outer argv uncertain: only terminal
        // controls are removed, without trying to execute/decode that command.
        assert_eq!(text(&command_lines(command)), command.replace('\u{1b}', ""));
        let lines = command_lines("bash -lc 'printf \"世界\" | cat # a comment\nprintf $HOME'");
        assert_eq!(
            text(&lines),
            "printf \"世界\" | cat # a comment\nprintf $HOME"
        );
        let mut terminal = Terminal::new(TestBackend::new(80, 4)).unwrap();
        terminal
            .draw(|frame| frame.render_widget(Paragraph::new(lines), frame.area()))
            .unwrap();
        let buffer = terminal.backend().buffer();
        assert_eq!(buffer[(7, 0)].fg, Color::Green);
        assert_eq!(buffer[(14, 0)].fg, Color::Cyan);
        assert!(buffer[(20, 0)].modifier.contains(Modifier::DIM));
        assert_eq!(buffer[(7, 1)].symbol(), "$");
        assert_eq!(buffer[(7, 1)].fg, Color::Cyan);
        assert_eq!(buffer[(7, 0)].symbol(), "\"");
    }

    #[test]
    fn only_unquoted_word_boundary_hash_starts_a_comment() {
        let source = r"printf \ #literal '#quoted' file#suffix # comment";
        let lines = command_lines(source);
        assert_eq!(text(&lines), source);
        assert_eq!(
            lines
                .iter()
                .flat_map(|line| &line.spans)
                .filter(|span| span.style.add_modifier.contains(Modifier::DIM))
                .map(|span| span.content.as_ref())
                .collect::<String>(),
            "# comment"
        );
    }
}
