//! Read-only local Messages intake through Switchboard or the installed CLI.
//! Each scan reconciles seven days of locally available history. There is no
//! last-seen watermark: chat activity can move during discovery, and the next
//! complete lookback must revisit those chats rather than permanently skip them.

use std::collections::BTreeSet;

use anyhow::{Context, Result, ensure};
use chrono::{DateTime, SecondsFormat};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    protocol::SourceRef,
    sources::{
        ReadOutput, Source, SourceBatch, SourceCheckpoint, SourceCoverage, SourceEvent, SourceKey,
        now_seconds, read_command,
    },
};

const LOOKBACK: u64 = 7 * 86_400;
const PAGE_SIZE: usize = 25;
const MAX_CHATS: usize = 512;
const MAX_PAGES: u16 = 1024;

#[derive(Debug)]
pub struct MessagesSource {
    namespace: Option<String>,
}

#[derive(Deserialize)]
struct Registry {
    namespaces: Vec<Namespace>,
}
#[derive(Deserialize)]
struct Namespace {
    id: String,
    provider: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Window {
    version: u8,
    account: String,
    namespace: Option<String>,
    since: u64,
    until: u64,
    phase: Phase,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "stage", rename_all = "snake_case", deny_unknown_fields)]
enum Phase {
    Chats {
        chats: Vec<String>,
        cursor: Option<String>,
        page: u16,
    },
    Messages {
        chats: Vec<String>,
        index: usize,
        cursor: Option<String>,
        page: u16,
    },
    Settled,
}

#[derive(Deserialize)]
struct Envelope {
    schema_version: u8,
    namespace: String,
    tool: String,
    status: String,
    fields: Fields,
    coverage: Coverage,
}
#[derive(Deserialize)]
struct Fields {
    response: Response,
}
#[derive(Deserialize)]
struct Coverage {
    status: String,
    next_cursor: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Response {
    Chats {
        chats: Vec<Chat>,
        next_cursor: Option<String>,
        unsupported_bodies: u64,
    },
    Messages {
        messages: Vec<Message>,
        next_cursor: Option<String>,
        scanned_messages: u64,
        unsupported_bodies: u64,
    },
}
#[derive(Deserialize, Serialize)]
struct Chat {
    id: String,
}
#[derive(Deserialize, Serialize)]
struct Message {
    id: String,
    chat_id: String,
    date: Option<String>,
    sender: Option<Participant>,
    is_from_me: bool,
    text: Option<String>,
    body_status: BodyStatus,
    kind: MessageKind,
    associated_message_id: Option<String>,
    attachments: Vec<Attachment>,
}
#[derive(Deserialize, Serialize)]
struct Participant {
    handle: String,
}
#[derive(Deserialize, Serialize)]
struct Attachment {
    id: String,
    filename: Option<String>,
    mime_type: Option<String>,
    size_bytes: u64,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum BodyStatus {
    Plain,
    Decoded,
    Empty,
    Unsupported,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum MessageKind {
    Message,
    Reaction,
    System,
}

fn timestamp(seconds: u64) -> Result<String> {
    Ok(DateTime::from_timestamp(i64::try_from(seconds)?, 0)
        .context("Messages timestamp is out of range")?
        .to_rfc3339_opts(SecondsFormat::Secs, true))
}
fn valid_id(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 1024 && !value.contains('\0')
}
fn valid_cursor(cursor: &Option<String>, previous: &Option<String>) -> bool {
    cursor.as_ref().is_none_or(|value| {
        !value.is_empty()
            && value.len() <= 4096
            && !value.contains('\0')
            && previous.as_ref() != Some(value)
    })
}

impl MessagesSource {
    pub fn new(namespace: String) -> Result<Self> {
        ensure!(valid_id(&namespace), "Messages needs an explicit namespace");
        Ok(Self {
            namespace: Some(namespace),
        })
    }

    pub fn local() -> Self {
        Self { namespace: None }
    }

    pub async fn discover(selected: Option<&[String]>) -> Result<Vec<Self>> {
        let output = read_command(&[
            "switchboard".into(),
            "ns".into(),
            "list".into(),
            "--json".into(),
        ])
        .await?;
        ensure!(
            output.exit_code == 0 && !output.truncated,
            "Messages account discovery is unavailable"
        );
        Self::from_registry(&output.stdout, selected)
    }

    fn from_registry(output: &str, selected: Option<&[String]>) -> Result<Vec<Self>> {
        let registry: Registry =
            serde_json::from_str(output).context("Invalid Switchboard namespace registry")?;
        let namespaces: Vec<_> = registry
            .namespaces
            .into_iter()
            .filter(|namespace| namespace.provider == "messages")
            .collect();
        if let Some(selected) = selected {
            for namespace in selected {
                ensure!(
                    namespaces.iter().any(|entry| &entry.id == namespace),
                    "Requested Messages namespace is not configured"
                );
            }
        } else if namespaces.is_empty() {
            return Ok(vec![Self::local()]);
        }
        namespaces
            .into_iter()
            .filter(|namespace| selected.is_none_or(|ids| ids.contains(&namespace.id)))
            .map(|namespace| Self::new(namespace.id))
            .collect()
    }

    fn window(&self, checkpoint: Option<&SourceCheckpoint>, now: u64) -> Result<Window> {
        let saved: Option<Window> = checkpoint
            .map(|checkpoint| serde_json::from_str(&checkpoint.value))
            .transpose()
            .context("Invalid Messages checkpoint")?;
        if let Some(saved) = &saved {
            ensure!(
                saved.version == 1
                    && saved.account == self.key().account
                    && saved.namespace == self.namespace,
                "Messages checkpoint belongs to another account, transport or version"
            );
        }
        let window = match saved {
            Some(saved) if !matches!(saved.phase, Phase::Settled) => saved,
            _ => Window {
                version: 1,
                account: self.key().account,
                namespace: self.namespace.clone(),
                since: now.saturating_sub(LOOKBACK),
                until: now
                    .checked_add(1)
                    .context("Messages window is out of range")?,
                phase: Phase::Chats {
                    chats: Vec::new(),
                    cursor: None,
                    page: 1,
                },
            },
        };
        ensure!(
            window.since < window.until && window.until - window.since <= LOOKBACK + 1,
            "Messages checkpoint window is invalid"
        );
        timestamp(window.since)?;
        timestamp(window.until)?;
        match &window.phase {
            Phase::Chats {
                chats,
                cursor,
                page,
            }
            | Phase::Messages {
                chats,
                cursor,
                page,
                ..
            } => {
                let unique: BTreeSet<_> = chats.iter().collect();
                ensure!(
                    chats.len() <= MAX_CHATS
                        && unique.len() == chats.len()
                        && chats.iter().all(|id| valid_id(id))
                        && (1..=MAX_PAGES).contains(page)
                        && cursor.as_ref().is_none_or(|value| {
                            !value.is_empty() && value.len() <= 4096 && !value.contains('\0')
                        }),
                    "Messages checkpoint page is invalid"
                );
                if let Phase::Messages { index, .. } = window.phase {
                    ensure!(index < chats.len(), "Messages checkpoint chat is invalid");
                }
            }
            Phase::Settled => {}
        }
        Ok(window)
    }

    fn argv(&self, window: &Window) -> Result<Vec<String>> {
        let (tool, native, cursor, chat) = match &window.phase {
            Phase::Chats { cursor, .. } => ("messages.chats.list", "chats", cursor, None),
            Phase::Messages {
                chats,
                index,
                cursor,
                ..
            } => (
                "messages.chats.read",
                "read",
                cursor,
                Some(
                    chats
                        .get(*index)
                        .context("Messages checkpoint chat is invalid")?,
                ),
            ),
            Phase::Settled => anyhow::bail!("The Messages scan is already settled"),
        };
        let mut argv = if let Some(namespace) = &self.namespace {
            vec![
                "switchboard".into(),
                tool.into(),
                format!("--ns={namespace}"),
                "--json".into(),
            ]
        } else {
            vec!["messages".into(), native.into(), "--json".into()]
        };
        argv.extend([
            format!("--since={}", timestamp(window.since)?),
            format!("--limit={PAGE_SIZE}"),
        ]);
        if let Some(cursor) = cursor {
            argv.push(format!("--cursor={cursor}"));
        }
        if let Some(chat) = chat {
            argv.push(format!("--until={}", timestamp(window.until)?));
            if self.namespace.is_some() {
                argv.push(format!("--chat-id={chat}"));
            } else {
                argv.extend(["--".into(), chat.clone()]);
            }
        }
        Ok(argv)
    }

    fn response(&self, output: &ReadOutput, window: &Window) -> Result<(Response, bool)> {
        ensure!(!output.truncated, "Messages CLI output was truncated");
        if let Some(namespace) = &self.namespace {
            let envelope: Envelope = serde_json::from_str(&output.stdout)
                .context("Messages returned no valid Switchboard result")?;
            let tool = match window.phase {
                Phase::Chats { .. } => "messages.chats.list",
                Phase::Messages { .. } => "messages.chats.read",
                Phase::Settled => anyhow::bail!("The Messages scan is already settled"),
            };
            ensure!(
                envelope.schema_version == 1
                    && &envelope.namespace == namespace
                    && envelope.tool == tool,
                "Messages CLI returned another account or operation"
            );
            let native_cursor = match &envelope.fields.response {
                Response::Chats { next_cursor, .. } | Response::Messages { next_cursor, .. } => {
                    next_cursor
                }
            };
            ensure!(
                &envelope.coverage.next_cursor == native_cursor,
                "Messages CLI coverage does not match its native cursor"
            );
            // This phase owns chat identities, not the preview body. The native
            // provider marks unsupported previews partial even though every ID
            // is present; full message reads retain their own body coverage.
            let preview_only = matches!(&envelope.fields.response,
                Response::Chats { unsupported_bodies, .. } if *unsupported_bodies > 0)
                && envelope.coverage.status == "unknown"
                && envelope.status == "partial"
                && output.exit_code == 1;
            let complete = preview_only
                || (output.exit_code == 0
                    && envelope.status == "executed"
                    && matches!(
                        (envelope.coverage.status.as_str(), native_cursor),
                        ("complete", None) | ("truncated", Some(_))
                    ));
            Ok((envelope.fields.response, complete))
        } else {
            Ok((
                serde_json::from_str(&output.stdout)
                    .context("Messages returned no valid local result")?,
                output.exit_code == 0,
            ))
        }
    }

    fn normalize(&self, output: ReadOutput, mut window: Window) -> Result<SourceBatch> {
        let (response, complete) = self.response(&output, &window)?;
        let mut partial = !complete;
        let mut events = Vec::new();
        match (&mut window.phase, response) {
            (
                Phase::Chats {
                    chats,
                    cursor,
                    page,
                },
                Response::Chats {
                    chats: found,
                    next_cursor,
                    unsupported_bodies: _,
                },
            ) => {
                partial |= found.len() > PAGE_SIZE || !valid_cursor(&next_cursor, cursor);
                for chat in found {
                    if !valid_id(&chat.id) {
                        partial = true;
                        continue;
                    }
                    if !chats.contains(&chat.id) {
                        chats.push(chat.id);
                    }
                }
                partial |= chats.len() > MAX_CHATS || (*page == MAX_PAGES && next_cursor.is_some());
                if !partial {
                    if next_cursor.is_some() {
                        *cursor = next_cursor;
                        *page += 1;
                    } else if chats.is_empty() {
                        window.phase = Phase::Settled;
                    } else {
                        window.phase = Phase::Messages {
                            chats: chats.clone(),
                            index: 0,
                            cursor: None,
                            page: 1,
                        };
                    }
                }
            }
            (
                Phase::Messages {
                    chats,
                    index,
                    cursor,
                    page,
                },
                Response::Messages {
                    messages,
                    next_cursor,
                    scanned_messages,
                    unsupported_bodies,
                },
            ) => {
                partial |= unsupported_bodies > 0
                    || messages.len() > PAGE_SIZE
                    || scanned_messages > PAGE_SIZE as u64
                    || scanned_messages < messages.len() as u64
                    || !valid_cursor(&next_cursor, cursor)
                    || (*page == MAX_PAGES && next_cursor.is_some());
                let chat = chats
                    .get(*index)
                    .context("Messages checkpoint chat is invalid")?;
                for message in messages {
                    // Native chat paging filters the join timestamp, which can
                    // differ from this optional visible message date.
                    if !valid_id(&message.id) || &message.chat_id != chat {
                        partial = true;
                        continue;
                    }
                    partial |= matches!(message.body_status, BodyStatus::Unsupported);
                    let title = if message.is_from_me {
                        "Sent message"
                    } else {
                        "Incoming message"
                    }
                    .to_owned();
                    let text = serde_json::to_string(&message)?;
                    let version =
                        hex::encode(Sha256::digest(serde_json::to_vec(&(&title, &text))?));
                    events.push(SourceEvent {
                        id: message.id,
                        version,
                        source: SourceRef {
                            provider: "messages".into(),
                            account: self.key().account,
                            thread_id: chat.clone(),
                        },
                        title,
                        text,
                    });
                }
                if !partial {
                    if next_cursor.is_some() {
                        *cursor = next_cursor;
                        *page += 1;
                    } else if *index + 1 < chats.len() {
                        *index += 1;
                        *cursor = None;
                        *page = 1;
                    } else {
                        window.phase = Phase::Settled;
                    }
                }
            }
            _ => anyhow::bail!("Messages CLI returned another resource kind"),
        }
        let coverage = if partial {
            SourceCoverage::Partial {
                message: "Messages local history could not be read completely; checkpoint retained"
                    .into(),
            }
        } else if matches!(window.phase, Phase::Settled) {
            SourceCoverage::Complete
        } else {
            SourceCoverage::More
        };
        let checkpoint = if partial {
            None
        } else {
            Some(SourceCheckpoint {
                value: serde_json::to_string(&window)?,
            })
        };
        Ok(SourceBatch {
            source: self.key(),
            events,
            checkpoint,
            coverage,
        })
    }
}

#[async_trait::async_trait]
impl Source for MessagesSource {
    fn key(&self) -> SourceKey {
        SourceKey {
            provider: "messages".into(),
            account: self.namespace.clone().unwrap_or_else(|| "local".into()),
        }
    }

    async fn poll(&self, checkpoint: Option<&SourceCheckpoint>) -> Result<SourceBatch> {
        let result = async {
            let window = self.window(checkpoint, now_seconds()?)?;
            let output = crate::rex::source::read_command(&self.argv(&window)?).await?;
            self.normalize(output, window)
        }
        .await;
        Ok(result.unwrap_or_else(|_| SourceBatch::unavailable(
            self.key(),
            "Messages reads are unavailable; run agent rex install and check Rex Server's Full Disk Access",
        )))
    }
}

#[cfg(test)]
mod tests {
    use crate::sources::{
        ReadOutput, Source, SourceCheckpoint, SourceCoverage,
        messages::{
            BodyStatus, Chat, MAX_PAGES, Message, MessageKind, MessagesSource, Phase, Response,
            Window,
        },
    };

    const NOW: u64 = 1_800_000_000;

    fn output(response: &Response) -> ReadOutput {
        ReadOutput {
            exit_code: 0,
            stdout: serde_json::to_string(response).unwrap(),
            truncated: false,
        }
    }
    fn messages(chats: &[&str], cursor: Option<&str>) -> Window {
        let mut window = MessagesSource::local().window(None, NOW).unwrap();
        window.phase = Phase::Messages {
            chats: chats.iter().map(|id| (*id).to_owned()).collect(),
            index: 0,
            cursor: cursor.map(str::to_owned),
            page: if cursor.is_some() { 2 } else { 1 },
        };
        window
    }
    fn message(id: &str, chat: &str) -> Message {
        Message {
            id: id.into(),
            chat_id: chat.into(),
            date: Some("2027-01-15T07:59:00.000Z".into()),
            sender: None,
            is_from_me: false,
            text: Some("The example component arrived.".into()),
            body_status: BodyStatus::Plain,
            kind: MessageKind::Message,
            associated_message_id: None,
            attachments: Vec::new(),
        }
    }

    #[test]
    fn discovery_prefers_configured_namespaces_and_never_falls_back_after_an_explicit_selection() {
        let configured = r#"{"namespaces":[{"id":"messages.example","provider":"messages"},{"id":"google.example","provider":"google"}]}"#;
        let sources = MessagesSource::from_registry(configured, None).unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].key().account, "messages.example");
        assert!(sources[0].namespace.is_some());
        assert!(
            MessagesSource::from_registry(configured, Some(&["messages.missing".into()])).is_err()
        );
        assert!(
            MessagesSource::from_registry(configured, Some(&[]))
                .unwrap()
                .is_empty()
        );
        let local = MessagesSource::from_registry(r#"{"namespaces":[]}"#, None).unwrap();
        assert_eq!(local.len(), 1);
        assert_eq!(local[0].key().account, "local");
        assert!(local[0].namespace.is_none());
        assert!(
            MessagesSource::from_registry(
                r#"{"namespaces":[]}"#,
                Some(&["messages.example".into()])
            )
            .is_err()
        );
        assert!(MessagesSource::from_registry("not a registry", None).is_err());
    }

    #[test]
    fn native_cursors_keep_the_frozen_window_and_completed_scans_reconcile_the_whole_lookback() {
        let source = MessagesSource::local();
        let start = source.window(None, NOW).unwrap();
        assert!(
            !source
                .argv(&start)
                .unwrap()
                .iter()
                .any(|argument| argument.starts_with("--until="))
        );
        let first = source
            .normalize(
                output(&Response::Chats {
                    chats: vec![Chat {
                        id: "chat-example".into(),
                    }],
                    next_cursor: Some("native-chat-page".into()),
                    unsupported_bodies: 0,
                }),
                start,
            )
            .unwrap();
        assert_eq!(first.coverage, SourceCoverage::More);
        let next = source.window(first.checkpoint.as_ref(), NOW + 300).unwrap();
        assert_eq!(next.until, NOW + 1);
        assert!(
            source
                .argv(&next)
                .unwrap()
                .iter()
                .any(|argument| argument == "--cursor=native-chat-page")
        );
        let discovered = source
            .normalize(
                output(&Response::Chats {
                    chats: Vec::new(),
                    next_cursor: None,
                    unsupported_bodies: 0,
                }),
                next,
            )
            .unwrap();
        let read = source
            .window(discovered.checkpoint.as_ref(), NOW + 600)
            .unwrap();
        let argv = source.argv(&read).unwrap();
        assert!(argv.iter().any(|argument| argument.starts_with("--until=")));
        assert_eq!(argv.last().unwrap(), "chat-example");
        assert_eq!(&argv[argv.len() - 2], "--");
        let result = source
            .normalize(
                output(&Response::Messages {
                    messages: vec![message("message-example", "chat-example")],
                    next_cursor: None,
                    scanned_messages: 1,
                    unsupported_bodies: 0,
                }),
                read,
            )
            .unwrap();
        assert_eq!(result.coverage, SourceCoverage::Complete);
        assert_eq!(result.events[0].id, "message-example");
        assert_eq!(result.events[0].source.thread_id, "chat-example");
        let reopened = source
            .window(result.checkpoint.as_ref(), NOW + 900)
            .unwrap();
        assert_eq!(reopened.since, NOW + 900 - 7 * 86_400);
        assert_eq!(reopened.until, NOW + 901);
        assert!(matches!(
            reopened.phase,
            Phase::Chats {
                cursor: None,
                page: 1,
                ..
            }
        ));
        assert!(
            MessagesSource::new("messages.example".into())
                .unwrap()
                .window(result.checkpoint.as_ref(), NOW)
                .is_err()
        );
    }

    #[test]
    fn partial_bodies_invalid_identities_and_cursor_loops_preserve_good_events_without_advancing() {
        let source = MessagesSource::local();
        let mut unsupported = message("unsupported", "chat-example");
        unsupported.text = None;
        unsupported.body_status = BodyStatus::Unsupported;
        let result = source
            .normalize(
                output(&Response::Messages {
                    messages: vec![
                        message("good", "chat-example"),
                        message("wrong-chat", "chat-other"),
                        unsupported,
                    ],
                    next_cursor: Some("same-cursor".into()),
                    scanned_messages: 3,
                    unsupported_bodies: 1,
                }),
                messages(&["chat-example"], Some("same-cursor")),
            )
            .unwrap();
        assert_eq!(result.events.len(), 2);
        assert!(matches!(result.coverage, SourceCoverage::Partial { .. }));
        assert!(result.checkpoint.is_none());
        let mut window = messages(&["chat-example"], Some("earlier"));
        if let Phase::Messages { page, .. } = &mut window.phase {
            *page = MAX_PAGES;
        }
        let capped = source
            .normalize(
                output(&Response::Messages {
                    messages: Vec::new(),
                    next_cursor: Some("next".into()),
                    scanned_messages: 0,
                    unsupported_bodies: 0,
                }),
                window,
            )
            .unwrap();
        assert!(matches!(capped.coverage, SourceCoverage::Partial { .. }));
        assert!(capped.checkpoint.is_none());
        let mut clipped = output(&Response::Chats {
            chats: Vec::new(),
            next_cursor: None,
            unsupported_bodies: 0,
        });
        clipped.truncated = true;
        assert!(
            source
                .normalize(clipped, source.window(None, NOW).unwrap())
                .is_err()
        );
    }

    #[test]
    fn source_versions_follow_owned_message_content_and_ignore_read_state_and_contact_names() {
        let source = MessagesSource::local();
        let wire = r#"{"type":"messages","messages":[{"id":"message-example","chat_id":"chat-example","date":"2027-01-15T07:59:00.000Z","sender":{"handle":"person@example.invalid","name":"Old contact"},"is_from_me":false,"is_unread":true,"text":"The quote arrived.","body_status":"plain","kind":"message","associated_message_id":null,"attachments":[{"id":"attachment-example","filename":"quote.pdf","mime_type":"application/pdf","size_bytes":120,"available_locally":false}]}],"next_cursor":null,"scanned_messages":1,"unsupported_bodies":0}"#;
        let normalize = |wire: &str| {
            source
                .normalize(
                    ReadOutput {
                        exit_code: 0,
                        stdout: wire.into(),
                        truncated: false,
                    },
                    messages(&["chat-example"], None),
                )
                .unwrap()
                .events
                .remove(0)
        };
        let first = normalize(wire);
        let read = normalize(
            &wire
                .replace("\"is_unread\":true", "\"is_unread\":false")
                .replace("Old contact", "New contact")
                .replace("\"available_locally\":false", "\"available_locally\":true"),
        );
        assert_eq!(read.version, first.version);
        assert_eq!(read.text, first.text);
        let changed = normalize(&wire.replace("The quote arrived.", "The revised quote arrived."));
        assert_eq!(changed.id, first.id);
        assert_ne!(changed.version, first.version);
        assert_ne!(changed.text, first.text);
    }

    #[test]
    fn native_chat_selection_does_not_require_a_matching_visible_message_date() {
        let source = MessagesSource::local();
        let mut older = message("older-visible-date", "chat-example");
        older.date = Some("2020-01-01T00:00:00.000Z".into());
        let mut undated = message("undated", "chat-example");
        undated.date = None;
        let result = source
            .normalize(
                output(&Response::Messages {
                    messages: vec![older, undated],
                    next_cursor: None,
                    scanned_messages: 2,
                    unsupported_bodies: 0,
                }),
                messages(&["chat-example"], None),
            )
            .unwrap();
        assert_eq!(result.coverage, SourceCoverage::Complete);
        assert_eq!(result.events.len(), 2);
        assert_eq!(result.events[0].id, "older-visible-date");
        assert_eq!(result.events[1].id, "undated");
    }

    #[test]
    fn switchboard_envelopes_require_the_selected_account_operation_and_matching_cursor() {
        let source = MessagesSource::new("messages.example".into()).unwrap();
        let wire = r#"{"schema_version":1,"namespace":"messages.example","tool":"messages.chats.list","status":"executed","fields":{"response":{"type":"chats","chats":[{"id":"chat-example"}],"next_cursor":"native-page","unsupported_bodies":0}},"coverage":{"status":"truncated","next_cursor":"native-page"}}"#;
        let normalize = |wire: &str| {
            source.normalize(
                ReadOutput {
                    exit_code: 0,
                    stdout: wire.into(),
                    truncated: false,
                },
                source.window(None, NOW).unwrap(),
            )
        };
        assert_eq!(normalize(wire).unwrap().coverage, SourceCoverage::More);
        assert!(normalize(&wire.replace("messages.example", "messages.other")).is_err());
        assert!(normalize(&wire.replace("messages.chats.list", "messages.search")).is_err());
        assert!(
            normalize(&wire.replace(
                "\"coverage\":{\"status\":\"truncated\",\"next_cursor\":\"native-page\"}",
                "\"coverage\":{\"status\":\"complete\",\"next_cursor\":null}"
            ))
            .is_err()
        );
        let partial =
            normalize(&wire.replace("\"status\":\"truncated\"", "\"status\":\"unknown\"")).unwrap();
        assert!(matches!(partial.coverage, SourceCoverage::Partial { .. }));
        assert!(partial.checkpoint.is_none());
    }

    #[test]
    fn unsupported_chat_previews_do_not_prevent_full_message_reads_for_discovered_ids() {
        let source = MessagesSource::local();
        let discovered = source
            .normalize(
                output(&Response::Chats {
                    chats: vec![Chat {
                        id: "chat-example".into(),
                    }],
                    next_cursor: None,
                    unsupported_bodies: 1,
                }),
                source.window(None, NOW).unwrap(),
            )
            .unwrap();
        assert_eq!(discovered.coverage, SourceCoverage::More);
        let window = source.window(discovered.checkpoint.as_ref(), NOW).unwrap();
        assert!(matches!(window.phase, Phase::Messages { .. }));
        let read = source
            .normalize(
                output(&Response::Messages {
                    messages: vec![message("message-example", "chat-example")],
                    next_cursor: None,
                    scanned_messages: 1,
                    unsupported_bodies: 0,
                }),
                window,
            )
            .unwrap();
        assert_eq!(read.coverage, SourceCoverage::Complete);
        assert_eq!(read.events.len(), 1);
        let source = MessagesSource::new("messages.example".into()).unwrap();
        let wire = r#"{"schema_version":1,"namespace":"messages.example","tool":"messages.chats.list","status":"partial","fields":{"response":{"type":"chats","chats":[{"id":"chat-example"}],"next_cursor":null,"unsupported_bodies":1}},"coverage":{"status":"unknown","next_cursor":null}}"#;
        let discovered = source
            .normalize(
                ReadOutput {
                    exit_code: 1,
                    stdout: wire.into(),
                    truncated: false,
                },
                source.window(None, NOW).unwrap(),
            )
            .unwrap();
        assert_eq!(discovered.coverage, SourceCoverage::More);
        assert!(discovered.checkpoint.is_some());
        let other_failure = source
            .normalize(
                ReadOutput {
                    exit_code: 2,
                    stdout: wire.into(),
                    truncated: false,
                },
                source.window(None, NOW).unwrap(),
            )
            .unwrap();
        assert!(matches!(
            other_failure.coverage,
            SourceCoverage::Partial { .. }
        ));
        assert!(other_failure.checkpoint.is_none());
    }

    /// Exercises the installed producer and this adapter against a synthetic DB.
    #[test]
    #[ignore = "requires the installed Messages CLI and sqlite3; uses only synthetic local history"]
    fn installed_cli_pages_native_guids_and_preserves_unread_state() {
        use std::process::Command;

        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("chat.db");
        let mut sql = String::from(
            "CREATE TABLE chat(guid TEXT,display_name TEXT,service_name TEXT); CREATE TABLE handle(id TEXT); CREATE TABLE message(guid TEXT,text TEXT,attributedBody BLOB,date INTEGER,handle_id INTEGER,is_from_me INTEGER,is_read INTEGER,is_finished INTEGER DEFAULT 1,item_type INTEGER DEFAULT 0,associated_message_guid TEXT,associated_message_type INTEGER DEFAULT 0); CREATE TABLE chat_message_join(chat_id INTEGER,message_id INTEGER,message_date INTEGER); CREATE TABLE chat_handle_join(chat_id INTEGER,handle_id INTEGER); CREATE TABLE attachment(guid TEXT,filename TEXT,transfer_name TEXT,mime_type TEXT,total_bytes INTEGER); CREATE TABLE message_attachment_join(message_id INTEGER,attachment_id INTEGER); INSERT INTO chat VALUES('chat-example','Example','iMessage'); INSERT INTO handle VALUES('person@example.invalid'); INSERT INTO chat_handle_join VALUES(1,1);",
        );
        for index in 1..=27 {
            let ticks = (NOW - 978_307_200 - 60 - index) * 1_000_000_000;
            sql.push_str(&format!("INSERT INTO message(ROWID,guid,text,date,handle_id,is_from_me,is_read) VALUES({index},'message-{index}','Example item {index}',{ticks},1,0,0); INSERT INTO chat_message_join VALUES(1,{index},{ticks});"));
        }
        let visible = (NOW - 978_307_200 - 30 * 86_400) * 1_000_000_000;
        let joined = (NOW - 978_307_200 - 120) * 1_000_000_000;
        sql.push_str(&format!("INSERT INTO message(ROWID,guid,text,date,handle_id,is_from_me,is_read) VALUES(28,'message-28','A locally joined older message',{visible},1,0,0); INSERT INTO chat_message_join VALUES(1,28,{joined});"));
        assert!(
            Command::new("sqlite3")
                .arg(&database)
                .arg(&sql)
                .status()
                .unwrap()
                .success()
        );
        let source = MessagesSource::local();
        let scan = || {
            let mut checkpoint: Option<SourceCheckpoint> = None;
            let mut versions = Vec::new();
            let mut pages = 0;
            loop {
                let window = source.window(checkpoint.as_ref(), NOW).unwrap();
                let argv = source.argv(&window).unwrap();
                let output = Command::new(&argv[0])
                    .arg("--db")
                    .arg(&database)
                    .args(&argv[1..])
                    .output()
                    .unwrap();
                assert!(
                    output.status.success(),
                    "Synthetic Messages CLI read failed"
                );
                let batch = source
                    .normalize(
                        ReadOutput {
                            exit_code: output.status.code().unwrap(),
                            stdout: String::from_utf8(output.stdout).unwrap(),
                            truncated: false,
                        },
                        window,
                    )
                    .unwrap();
                versions.extend(
                    batch
                        .events
                        .into_iter()
                        .map(|event| (event.id, event.version, event.source.thread_id)),
                );
                pages += 1;
                match batch.coverage {
                    SourceCoverage::Complete => break,
                    SourceCoverage::More => {}
                    other => panic!("Incomplete synthetic Messages scan: {other:?}"),
                }
                checkpoint = batch.checkpoint;
                assert!(pages < 10, "Synthetic Messages scan did not settle");
            }
            assert_eq!(pages, 3);
            versions.sort();
            versions
        };
        let first = scan();
        assert_eq!(first.len(), 28);
        assert!(first.iter().all(|(_, _, chat)| chat == "chat-example"));
        let unread = Command::new("sqlite3")
            .arg(&database)
            .arg("SELECT COUNT(*) FROM message WHERE is_read=0")
            .output()
            .unwrap();
        assert!(unread.status.success());
        assert_eq!(String::from_utf8(unread.stdout).unwrap().trim(), "28");
        assert!(
            Command::new("sqlite3")
                .arg(&database)
                .arg("UPDATE message SET is_read=1")
                .status()
                .unwrap()
                .success()
        );
        assert_eq!(scan(), first);
        assert!(
            Command::new("sqlite3")
                .arg(&database)
                .arg("UPDATE message SET text='A revised example' WHERE guid='message-1'")
                .status()
                .unwrap()
                .success()
        );
        let updated = scan();
        assert_eq!(
            updated
                .iter()
                .zip(&first)
                .filter(|(after, before)| after != before)
                .count(),
            1
        );
    }
}
