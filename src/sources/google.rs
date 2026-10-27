//! Gmail intake through each explicitly scoped Switchboard namespace. New
//! adapters start at seven days; settled windows overlap by two minutes. This
//! discovers immutable messages, not historical label changes or a full archive.

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};

use crate::{
    protocol::SourceRef,
    sources::{
        ReadOutput, Source, SourceBatch, SourceCheckpoint, SourceCoverage, SourceEvent, SourceKey,
        now_seconds, read_command,
    },
};

#[derive(Debug)]
pub struct GoogleSource {
    namespace: String,
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
struct Window {
    account: String,
    since: u64,
    until: u64,
    cursor: Option<String>,
}

#[derive(Deserialize)]
struct Envelope {
    status: String,
    fields: Option<Fields>,
    coverage: Option<Coverage>,
}
#[derive(Deserialize)]
struct Fields {
    status: String,
    messages: Vec<Message>,
    has_more: bool,
    #[serde(default)]
    failures: Vec<serde_json::Value>,
}
#[derive(Deserialize)]
struct Coverage {
    status: String,
    next_cursor: Option<String>,
}
#[derive(Deserialize)]
struct Message {
    #[serde(default)]
    gmail_message_id: String,
    #[serde(default)]
    gmail_thread_id: String,
    #[serde(default)]
    subject: String,
    #[serde(default)]
    body_text: String,
    #[serde(default)]
    body_truncated: bool,
    from: Option<Sender>,
    #[serde(default)]
    date: String,
}
#[derive(Deserialize)]
struct Sender {
    email: String,
    name: Option<String>,
}

impl GoogleSource {
    pub fn new(namespace: String) -> Result<Self> {
        ensure!(
            !namespace.is_empty(),
            "Google source needs an explicit namespace"
        );
        Ok(Self { namespace })
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
            "Switchboard namespace discovery is unavailable"
        );
        Self::from_registry(&output.stdout, selected)
    }

    fn from_registry(output: &str, selected: Option<&[String]>) -> Result<Vec<Self>> {
        let registry: Registry =
            serde_json::from_str(output).context("Invalid Switchboard namespace registry")?;
        let namespaces: Vec<_> = registry
            .namespaces
            .into_iter()
            .filter(|item| item.provider == "google")
            .collect();
        if let Some(selected) = selected {
            for namespace in selected {
                ensure!(
                    namespaces.iter().any(|item| &item.id == namespace),
                    "Requested Google namespace is not configured"
                );
            }
        }
        namespaces
            .into_iter()
            .filter(|item| selected.is_none_or(|ids| ids.contains(&item.id)))
            .map(|item| Self::new(item.id))
            .collect()
    }

    fn window(&self, checkpoint: Option<&SourceCheckpoint>, now: u64) -> Result<Window> {
        let mut window = match checkpoint {
            Some(checkpoint) => serde_json::from_str(&checkpoint.value)
                .context("Invalid Gmail source checkpoint")?,
            None => Window {
                account: self.namespace.clone(),
                since: now.saturating_sub(7 * 86_400),
                until: 0,
                cursor: None,
            },
        };
        ensure!(
            window.account == self.namespace,
            "Gmail checkpoint belongs to another account"
        );
        if window.until == 0 {
            window.until = now.saturating_add(1);
        }
        ensure!(
            window.since < window.until,
            "Gmail checkpoint window is invalid; check the system clock"
        );
        Ok(window)
    }

    fn normalize(&self, output: ReadOutput, mut window: Window) -> SourceBatch {
        let key = self.key();
        if output.truncated {
            return SourceBatch::unavailable(
                key,
                "Gmail helper output was truncated; checkpoint retained",
            );
        }
        let Ok(envelope) = serde_json::from_str::<Envelope>(&output.stdout) else {
            return SourceBatch::unavailable(
                key,
                "Gmail helper returned no valid result; check scoped provider access",
            );
        };
        let Some(fields) = envelope.fields else {
            return SourceBatch::unavailable(key, "Gmail result has no message coverage");
        };
        let mut invalid = false;
        let events = fields
            .messages
            .into_iter()
            .filter_map(|message| {
                if message.gmail_message_id.is_empty() || message.gmail_thread_id.is_empty() {
                    invalid = true;
                    return None;
                }
                let mut text = String::new();
                if let Some(sender) = message.from {
                    text.push_str(&format!(
                        "From: {} <{}>\n",
                        sender.name.unwrap_or_default(),
                        sender.email
                    ));
                }
                if !message.date.is_empty() {
                    text.push_str(&format!("Date: {}\n", message.date));
                }
                text.push_str(&message.body_text);
                if message.body_truncated {
                    text.push_str("\n[Excerpt; read the source for the full message.]");
                }
                Some(SourceEvent {
                    id: message.gmail_message_id.clone(),
                    version: message.gmail_message_id,
                    source: SourceRef {
                        provider: key.provider.clone(),
                        account: key.account.clone(),
                        thread_id: message.gmail_thread_id,
                    },
                    title: message.subject,
                    text,
                })
            })
            .collect();
        let mut batch = SourceBatch {
            source: key,
            events,
            checkpoint: None,
            coverage: SourceCoverage::Partial {
                message: "Gmail coverage is incomplete; checkpoint retained".into(),
            },
        };
        if output.exit_code != 0
            || envelope.status != "executed"
            || fields.status != "ok"
            || !fields.failures.is_empty()
            || invalid
        {
            return batch;
        }
        let Some(coverage) = envelope.coverage else {
            return batch;
        };
        match coverage.status.as_str() {
            "complete" if !fields.has_more && coverage.next_cursor.is_none() => {
                window.since = window.until.saturating_sub(120);
                window.until = 0;
                window.cursor = None;
                batch.coverage = SourceCoverage::Complete;
            }
            "truncated"
                if fields.has_more
                    && coverage
                        .next_cursor
                        .as_ref()
                        .is_some_and(|cursor| !cursor.is_empty()) =>
            {
                window.cursor = coverage.next_cursor;
                batch.coverage = SourceCoverage::More;
            }
            _ => return batch,
        }
        // Window contains only serializable primitive fields.
        if let Ok(value) = serde_json::to_string(&window) {
            batch.checkpoint = Some(SourceCheckpoint { value });
        }
        batch
    }
}

#[async_trait::async_trait]
impl Source for GoogleSource {
    fn key(&self) -> SourceKey {
        SourceKey {
            provider: "google".into(),
            account: self.namespace.clone(),
        }
    }

    async fn poll(&self, checkpoint: Option<&SourceCheckpoint>) -> Result<SourceBatch> {
        let window = self.window(checkpoint, now_seconds()?)?;
        let mut args = vec![
            "switchboard".into(),
            "google.mail.search".into(),
            "--ns".into(),
            self.namespace.clone(),
            "--json".into(),
            "--query".into(),
            format!("after:{} before:{} -in:drafts", window.since, window.until),
            "--hydrate".into(),
            "--max".into(),
            "25".into(),
            "--body-limit".into(),
            "4000".into(),
        ];
        if let Some(cursor) = &window.cursor {
            args.extend(["--cursor".into(), cursor.clone()]);
        }
        // The caller polls accounts serially; Switchboard alone owns refresh.
        Ok(match read_command(&args).await {
            Ok(output) => self.normalize(output, window),
            Err(_) => SourceBatch::unavailable(
                self.key(),
                "Gmail helper could not run; check scoped provider access",
            ),
        })
    }
}

#[cfg(test)]
mod tests {
    use crate::sources::{
        ReadOutput, Source, SourceCheckpoint, SourceCoverage, google::GoogleSource,
    };

    fn output(stdout: &str) -> ReadOutput {
        ReadOutput {
            exit_code: 0,
            stdout: stdout.into(),
            truncated: false,
        }
    }
    const COMPLETE: &str = r#"{"status":"executed","fields":{"status":"ok","messages":[{"gmail_message_id":"m1","gmail_thread_id":"t1","subject":"Board revision","body_text":"Please check R2","body_truncated":true}],"has_more":false,"failures":[]},"coverage":{"status":"complete","next_cursor":null}}"#;

    #[test]
    fn discovers_every_google_account_and_rejects_wrong_provider_selection() {
        let registry = r#"{"namespaces":[{"id":"google.alpha","provider":"google"},{"id":"other.beta","provider":"other"},{"id":"google.gamma","provider":"google"}]}"#;
        let sources = GoogleSource::from_registry(registry, None).unwrap();
        assert_eq!(
            sources
                .iter()
                .map(|source| source.key().account)
                .collect::<Vec<_>>(),
            ["google.alpha", "google.gamma"]
        );
        assert!(GoogleSource::from_registry(registry, Some(&["other.beta".into()])).is_err());
    }

    #[test]
    fn native_mail_normalization_preserves_thread_and_overlap_checkpoint() {
        let source = GoogleSource::new("google.alpha".into()).unwrap();
        let batch = source.normalize(output(COMPLETE), source.window(None, 800_000).unwrap());
        assert_eq!(batch.coverage, SourceCoverage::Complete);
        assert_eq!(batch.events[0].id, "m1");
        assert_eq!(batch.events[0].source.account, "google.alpha");
        assert_eq!(batch.events[0].source.thread_id, "t1");
        let next = source.window(batch.checkpoint.as_ref(), 800_100).unwrap();
        assert_eq!(next.since, 799_881);
        assert_eq!(next.until, 800_101);
    }

    #[test]
    fn partial_hydration_retains_events_but_not_checkpoint() {
        let source = GoogleSource::new("google.alpha".into()).unwrap();
        let batch = source.normalize(
            output(&COMPLETE.replace("\"status\":\"ok\"", "\"status\":\"partial\"")),
            source.window(None, 800_000).unwrap(),
        );
        assert_eq!(batch.events.len(), 1);
        assert!(matches!(batch.coverage, SourceCoverage::Partial { .. }));
        assert!(batch.checkpoint.is_none());
    }

    #[test]
    fn continuation_freezes_search_window_and_is_account_bound() {
        let source = GoogleSource::new("google.alpha".into()).unwrap();
        let page = COMPLETE
            .replace("\"has_more\":false", "\"has_more\":true")
            .replace(
                "\"status\":\"complete\",\"next_cursor\":null",
                "\"status\":\"truncated\",\"next_cursor\":\"next-page\"",
            );
        let batch = source.normalize(output(&page), source.window(None, 800_000).unwrap());
        assert_eq!(batch.coverage, SourceCoverage::More);
        let checkpoint = batch.checkpoint.unwrap();
        let next = source.window(Some(&checkpoint), 900_000).unwrap();
        assert_eq!(next.until, 800_001);
        assert_eq!(next.cursor.as_deref(), Some("next-page"));
        assert!(
            GoogleSource::new("google.beta".into())
                .unwrap()
                .window(Some(&checkpoint), 900_000)
                .is_err()
        );
        assert!(
            source
                .window(
                    Some(&SourceCheckpoint {
                        value: "invalid".into()
                    }),
                    900_000
                )
                .is_err()
        );
    }

    #[test]
    fn unknown_and_truncated_outputs_never_look_like_empty_complete_mail() {
        let source = GoogleSource::new("google.alpha".into()).unwrap();
        let mut truncated = output(COMPLETE);
        truncated.truncated = true;
        for result in [output(r#"{"status":"failed"}"#), truncated] {
            let batch = source.normalize(result, source.window(None, 800_000).unwrap());
            assert!(matches!(batch.coverage, SourceCoverage::Unavailable { .. }));
            assert!(batch.checkpoint.is_none());
        }
    }
}
