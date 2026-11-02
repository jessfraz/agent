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
    gmail_thread_id: Option<String>,
    subject: Option<String>,
    body_text: Option<String>,
    #[serde(default)]
    body_truncated: bool,
    from: Option<Sender>,
    date: Option<String>,
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
        output.check_discovery()?;
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

    fn normalize(&self, output: ReadOutput, window: Window) -> SourceBatch {
        output.normalize(|output| self.normalize_output(output, window))
    }

    fn normalize_output(&self, output: ReadOutput, mut window: Window) -> SourceBatch {
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
                let (Some(thread_id), Some(body_text)) =
                    (message.gmail_thread_id, message.body_text)
                else {
                    // Failed native hydration rows retain IDs but omit content.
                    // Never admit those placeholders as immutable message events.
                    invalid = true;
                    return None;
                };
                if message.gmail_message_id.is_empty() || thread_id.is_empty() {
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
                if let Some(date) = message.date.filter(|date| !date.is_empty()) {
                    text.push_str(&format!("Date: {date}\n"));
                }
                text.push_str(&body_text);
                if message.body_truncated {
                    text.push_str("\n[Excerpt; read the source for the full message.]");
                }
                Some(SourceEvent {
                    id: message.gmail_message_id.clone(),
                    version: message.gmail_message_id,
                    source: SourceRef {
                        provider: key.provider.clone(),
                        account: key.account.clone(),
                        thread_id,
                    },
                    title: message.subject.unwrap_or_else(|| "(no subject)".into()),
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
            // Context coverage includes intentional body excerpts. Pagination
            // decides whether every message in this window has been visited.
            "complete" | "truncated" if !fields.has_more && coverage.next_cursor.is_none() => {
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
    const COMPLETE: &str = r#"{"status":"executed","fields":{"status":"ok","messages":[{"gmail_message_id":"m1","gmail_thread_id":"t1","coverage":"complete","subject":"Board revision","body_text":"Please check R2","body_truncated":false,"attachments_omitted":0}],"has_more":false,"failures":[]},"coverage":{"status":"complete","next_cursor":null}}"#;

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
    fn native_exhausted_page_with_body_excerpts_completes_the_window() {
        let source = GoogleSource::new("google.alpha".into()).unwrap();
        let native = r#"{"status":"executed","fields":{"status":"ok","messages":[
          {"gmail_message_id":"m1","gmail_thread_id":"t1","coverage":"complete","subject":"Board revision","body_text":"Please check R2","body_truncated":false,"attachments_omitted":0},
          {"gmail_message_id":"m2","gmail_thread_id":"t2","coverage":"truncated","subject":"Long message","body_text":"Message excerpt","body_truncated":true,"attachments_omitted":0}
        ],"has_more":false,"failures":[]},"coverage":{"status":"truncated","next_cursor":null}}"#;
        let batch = source.normalize(output(native), source.window(None, 800_000).unwrap());
        assert_eq!(batch.coverage, SourceCoverage::Complete);
        assert_eq!(batch.events.len(), 2);
        assert_eq!(batch.events[0].text, "Please check R2");
        assert_eq!(batch.events[1].id, "m2");
        assert_eq!(batch.events[1].source.thread_id, "t2");
        assert_eq!(
            batch.events[1].text,
            "Message excerpt\n[Excerpt; read the source for the full message.]"
        );
        let next = source.window(batch.checkpoint.as_ref(), 800_100).unwrap();
        assert_eq!(next.since, 799_881);
        assert_eq!(next.until, 800_101);
        assert!(next.cursor.is_none());

        let unknown = native.replace(
            "\"status\":\"truncated\",\"next_cursor\":null",
            "\"status\":\"unknown\",\"next_cursor\":null",
        );
        let batch = source.normalize(output(&unknown), source.window(None, 800_000).unwrap());
        assert!(matches!(batch.coverage, SourceCoverage::Partial { .. }));
        assert!(batch.checkpoint.is_none());
        assert_eq!(batch.events.len(), 2);
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
    fn native_nullable_date_and_missing_date_preserve_the_same_message() {
        let source = GoogleSource::new("google.alpha".into()).unwrap();
        let native = r#"{"status":"executed","fields":{"status":"ok","messages":[{"gmail_message_id":"m1","gmail_thread_id":"t1","coverage":"complete","from":{"email":"sender@example.net","name":null},"subject":"Board revision","date":null,"body_text":"Please check R2","body_truncated":false}],"has_more":false,"failures":[]},"coverage":{"status":"complete","next_cursor":null}}"#;
        let batch = source.normalize(output(native), source.window(None, 800_000).unwrap());
        assert_eq!(batch.coverage, SourceCoverage::Complete);
        assert_eq!(batch.events.len(), 1);
        let event = &batch.events[0];
        assert_eq!(event.id, "m1");
        assert_eq!(event.source.thread_id, "t1");
        assert_eq!(event.title, "Board revision");
        assert_eq!(event.text, "From:  <sender@example.net>\nPlease check R2");

        let replay = source.normalize(
            output(&native.replace("\"date\":null,", "")),
            source.window(None, 800_000).unwrap(),
        );
        assert_eq!(replay.coverage, SourceCoverage::Complete);
        assert_eq!(replay.events[0].version, event.version);
        assert_eq!(replay.events[0].text, event.text);
        assert_eq!(replay.checkpoint, batch.checkpoint);
    }

    #[test]
    fn native_mail_without_a_subject_keeps_its_content_identity_and_checkpoint() {
        let source = GoogleSource::new("google.alpha".into()).unwrap();
        let titled = source.normalize(output(COMPLETE), source.window(None, 800_000).unwrap());
        for (subject, title) in [
            (r#""subject":null,"#, "(no subject)"),
            ("", "(no subject)"),
            (r#""subject":"","#, ""),
            (r#""subject":"  \t  ","#, "  \t  "),
        ] {
            let native = COMPLETE.replace(r#""subject":"Board revision","#, subject);
            let batch = source.normalize(output(&native), source.window(None, 800_000).unwrap());
            assert_eq!(batch.events.len(), 1);
            let message = &batch.events[0];
            assert_eq!(message.title, title);
            assert_eq!(message.id, titled.events[0].id);
            assert_eq!(message.version, titled.events[0].version);
            assert_eq!(message.source.thread_id, titled.events[0].source.thread_id);
            assert_eq!(message.text, titled.events[0].text);
            assert_eq!(batch.coverage, SourceCoverage::Complete);
            assert_eq!(batch.checkpoint, titled.checkpoint);
        }
    }

    #[test]
    fn native_failed_rows_retain_hydrated_events_without_advancing_the_cursor() {
        let source = GoogleSource::new("google.alpha".into()).unwrap();
        let checkpoint = SourceCheckpoint {
            value: r#"{"account":"google.alpha","since":700000,"until":800001,"cursor":"current-page"}"#.into(),
        };
        let native = r#"{"status":"executed","fields":{"status":"partial","messages":[
          {"gmail_message_id":"m1","gmail_thread_id":"t1","coverage":"complete","from":{"email":"sender@example.net","name":null},"subject":"Board revision","date":null,"body_text":"Please check R2","body_truncated":false},
          {"gmail_message_id":"m2","gmail_thread_id":null,"coverage":"unknown","body_truncated":false,"failure":{"code":"execution"}},
          {"gmail_message_id":"m3","gmail_thread_id":"t3","coverage":"unknown","body_truncated":false,"failure":{"code":"execution"}},
          {"gmail_message_id":"m4","gmail_thread_id":"t4","coverage":"complete","subject":"Attachment only","body_text":"","body_truncated":false}
        ],"has_more":true,"failures":[{"code":"execution"}]},"coverage":{"status":"unknown","next_cursor":"later-page"}}"#;
        let batch = source.normalize(
            output(native),
            source.window(Some(&checkpoint), 900_000).unwrap(),
        );
        assert!(matches!(batch.coverage, SourceCoverage::Partial { .. }));
        assert!(batch.checkpoint.is_none());
        assert_eq!(batch.events.len(), 2);
        assert_eq!(batch.events[0].id, "m1");
        assert_eq!(
            batch.events[0].text,
            "From:  <sender@example.net>\nPlease check R2"
        );
        assert_eq!(batch.events[1].id, "m4");
        assert_eq!(batch.events[1].title, "Attachment only");
        assert_eq!(batch.events[1].text, "");
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

    #[test]
    fn helper_storage_failure_retains_the_account_checkpoint_and_successful_partial_messages() {
        let source = GoogleSource::new("google.alpha".into()).unwrap();
        let complete = source.normalize(output(COMPLETE), source.window(None, 800_000).unwrap());
        let checkpoint = complete.checkpoint.unwrap();
        let saved = checkpoint.value.clone();
        let failed = source.normalize(
            output(crate::sources::tests::STORAGE_FAILURE),
            source.window(Some(&checkpoint), 800_100).unwrap(),
        );
        assert!(failed.events.is_empty());
        assert_eq!(failed.source, source.key());
        assert!(failed.checkpoint.is_none());
        assert_eq!(failed.coverage, SourceCoverage::Unavailable {
            message: "Source helper storage failure during persistence; inspect its local database before retrying. Checkpoint retained.".into(),
        });
        assert_eq!(checkpoint.value, saved);
        let partial = COMPLETE.replace("\"status\":\"executed\"", "\"status\":\"partial\",\"failure\":{\"code\":\"storage\",\"phase\":\"persistence\",\"message\":\"private-token\"}");
        let partial = source.normalize(
            output(&partial),
            source.window(Some(&checkpoint), 800_100).unwrap(),
        );
        assert_eq!(partial.events.len(), 1);
        assert_eq!(partial.events[0].id, "m1");
        assert!(partial.checkpoint.is_none());
        assert!(
            matches!(partial.coverage, SourceCoverage::Partial { ref message } if message.contains("storage failure during persistence") && !message.contains("private-token"))
        );
        let other = GoogleSource::new("google.other".into()).unwrap();
        let other = other.normalize(output(COMPLETE), other.window(None, 800_100).unwrap());
        assert_eq!(other.source.account, "google.other");
        assert_eq!(other.events.len(), 1);
        assert_eq!(other.coverage, SourceCoverage::Complete);
        let empty = source.normalize(output(r#"{"status":"executed","fields":{"status":"ok","messages":[],"has_more":false,"failures":[]},"coverage":{"status":"complete","next_cursor":null}}"#), source.window(Some(&checkpoint), 800_100).unwrap());
        assert!(empty.events.is_empty());
        assert_eq!(empty.coverage, SourceCoverage::Complete);
        assert!(empty.checkpoint.is_some());
    }

    #[tokio::test]
    #[ignore = "requires the installed Switchboard CLI; uses no credentials or network"]
    async fn installed_cli_storage_failure_survives_source_normalization() {
        let directory = tempfile::tempdir().unwrap();
        let config = directory.path().join("config.toml");
        std::fs::write(
            &config,
            r#"[secret.google_oauth]
kind = "file"
path = "oauth.json"
[auth.google_example]
provider = "google"
kind = "google_oauth_file"
account = "reader@example.test"
credentials = "google_oauth"
[namespace.google.example]
provider = "google"
account = "reader@example.test"
auth = "google_example"
default_read = true
"#,
        )
        .unwrap();
        std::fs::write(
            directory.path().join("operations.sqlite3"),
            b"corrupt synthetic SQLite database",
        )
        .unwrap();
        let native = crate::sources::read_command(&[
            "env".into(),
            "-u".into(),
            "SWITCHBOARD_STATE_DB".into(),
            "-u".into(),
            "SWITCHBOARD_STATE_DIR".into(),
            "switchboard".into(),
            "--config".into(),
            config.to_str().unwrap().into(),
            "google.mail.search".into(),
            "--ns".into(),
            "google.example".into(),
            "--json".into(),
            "--query".into(),
            "after:1".into(),
        ])
        .await
        .unwrap();
        assert_ne!(native.exit_code, 0);
        let source = GoogleSource::new("google.example".into()).unwrap();
        let batch = source.normalize(native, source.window(None, 800_000).unwrap());
        assert!(batch.events.is_empty() && batch.checkpoint.is_none());
        assert_eq!(batch.coverage, SourceCoverage::Unavailable {
            message: "Source helper storage failure during persistence; inspect its local database before retrying. Checkpoint retained.".into(),
        });
    }
}
