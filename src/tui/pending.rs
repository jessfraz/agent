//! Ephemeral, compact input previews, following Codex 0.165's
//! bottom_pane/pending_input_preview.rs. The messages retain delivery ownership.

use crate::{
    protocol::InputMode,
    tui::{InputDelivery, Message, MessageKind, markdown},
};
use ratatui::{
    Frame,
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Paragraph, Wrap},
};
use std::borrow::Cow;

const PREVIEW_ROWS: usize = 3;

pub(super) struct Preview<'a> {
    groups: Vec<Group<'a>>,
}

struct Group<'a> {
    mode: InputMode,
    delivery: &'a InputDelivery,
    messages: Vec<&'a Message>,
}

impl Group<'_> {
    fn header(&self) -> Paragraph<'static> {
        let label = match (self.mode, self.delivery) {
            (InputMode::Steer, InputDelivery::Submitting) => "Sending steering messages",
            (InputMode::FollowUp, InputDelivery::Submitting) => "Sending follow-up inputs",
            (InputMode::Steer, InputDelivery::Waiting) => "Steering messages, waiting",
            (InputMode::FollowUp, InputDelivery::Waiting) => "Queued follow-up inputs",
            (InputMode::Steer, InputDelivery::Uncertain) => {
                "Steering delivery unconfirmed; not resent"
            }
            (InputMode::FollowUp, InputDelivery::Uncertain) => {
                "Follow-up delivery unconfirmed; not resent"
            }
            (_, InputDelivery::Placed { .. }) => "",
        };
        Paragraph::new(Line::from(vec![
            Span::styled("• ", Style::default().add_modifier(Modifier::DIM)),
            Span::raw(label),
        ]))
        .wrap(Wrap { trim: false })
    }

    fn body<'a>(&self, message: &'a Message, width: u16) -> (Paragraph<'a>, usize, bool) {
        let mut lines = Vec::new();
        let mut truncated = false;
        let mut source = message.text.split('\n');
        for line in source.by_ref().take(PREVIEW_ROWS + 1) {
            // Bound repeated preview work even for one huge logical line.
            // Native Paragraph still owns wrapping, including wide glyphs.
            let prefix = line
                .char_indices()
                .nth(usize::from(width) * PREVIEW_ROWS + 1)
                .map_or(line, |(end, _)| {
                    truncated = true;
                    &line[..end]
                });
            let literal = if prefix.chars().any(|ch| ch.is_control() && ch != '\t') {
                Cow::Owned(markdown::plain(prefix))
            } else {
                Cow::Borrowed(prefix)
            };
            let style = Style::default().add_modifier(if self.mode == InputMode::FollowUp {
                Modifier::DIM | Modifier::ITALIC
            } else {
                Modifier::DIM
            });
            lines.push(Line::styled(literal, style));
        }
        truncated |= source.next().is_some();
        if message.text.is_empty()
            && !message.attachments.is_empty()
            && let Some(first) = lines.first_mut()
        {
            *first = Line::styled(
                attachment_label(message),
                Style::default().add_modifier(Modifier::DIM),
            );
        }
        let paragraph = Paragraph::new(lines).wrap(Wrap { trim: false });
        let full_rows = paragraph.line_count(width);
        (
            paragraph,
            full_rows.min(PREVIEW_ROWS),
            truncated || full_rows > PREVIEW_ROWS,
        )
    }
}

impl<'a> Preview<'a> {
    pub(super) fn new(messages: &'a [Message]) -> Self {
        let mut groups: Vec<Group<'a>> = Vec::new();
        for message in messages {
            let MessageKind::Input { mode, delivery, .. } = &message.kind else {
                continue;
            };
            if matches!(delivery, InputDelivery::Placed { .. }) {
                continue;
            }
            let group = groups.iter_mut().find(|group| {
                group.mode == *mode
                    && std::mem::discriminant(group.delivery) == std::mem::discriminant(delivery)
            });
            if let Some(group) = group {
                group.messages.push(message);
            } else {
                groups.push(Group {
                    mode: *mode,
                    delivery,
                    messages: vec![message],
                });
            }
        }
        Self { groups }
    }

    pub(super) fn height(&self, width: u16) -> usize {
        if width < 4 {
            return 0;
        }
        self.groups
            .iter()
            .enumerate()
            .map(|(index, group)| {
                usize::from(index > 0)
                    + group.header().line_count(width)
                    + group
                        .messages
                        .iter()
                        .map(|message| {
                            let (_, rows, more) = group.body(message, width.saturating_sub(4));
                            rows + usize::from(more)
                                + usize::from(
                                    !message.attachments.is_empty() && !message.text.is_empty(),
                                )
                        })
                        .sum::<usize>()
            })
            .sum()
    }

    pub(super) fn draw(&self, frame: &mut Frame<'_>, area: Rect) {
        if area.width < 4 || area.height == 0 {
            return;
        }
        let overflow = self.height(area.width) > usize::from(area.height);
        let bottom = area.bottom().saturating_sub(u16::from(overflow));
        let mut y = area.y;
        for (index, group) in self.groups.iter().enumerate() {
            y = y.saturating_add(u16::from(index > 0));
            if y >= bottom {
                break;
            }
            let header = group.header();
            let rows = u16::try_from(header.line_count(area.width))
                .unwrap_or(u16::MAX)
                .min(bottom - y);
            frame.render_widget(header, Rect::new(area.x, y, area.width, rows));
            y += rows;
            for message in &group.messages {
                if y >= bottom {
                    break;
                }
                let width = area.width.saturating_sub(4);
                let (body, rows, more) = group.body(message, width);
                let rows = u16::try_from(rows).unwrap_or(u16::MAX).min(bottom - y);
                frame.render_widget(Line::styled("  ↳ ", dim()), Rect::new(area.x, y, 4, 1));
                frame.render_widget(body, Rect::new(area.x + 4, y, width, rows));
                y += rows;
                if more && y < bottom {
                    frame.render_widget(
                        Line::styled("    …", dim()),
                        Rect::new(area.x, y, area.width, 1),
                    );
                    y += 1;
                }
                if !message.attachments.is_empty() && !message.text.is_empty() && y < bottom {
                    frame.render_widget(
                        Line::styled(format!("    {}", attachment_label(message)), dim()),
                        Rect::new(area.x, y, area.width, 1),
                    );
                    y += 1;
                }
            }
        }
        if overflow {
            frame.render_widget(
                Line::styled("  … more pending content", dim()),
                Rect::new(area.x, bottom, area.width, 1),
            );
        }
    }
}

fn dim() -> Style {
    Style::default().add_modifier(Modifier::DIM)
}

fn attachment_label(message: &Message) -> String {
    format!(
        "{} {}",
        message.attachments.len(),
        if message.attachments.len() == 1 {
            "attachment"
        } else {
            "attachments"
        }
    )
}
