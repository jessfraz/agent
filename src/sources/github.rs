//! GitHub notification intake through the existing Switchboard GitHub CLI.
//! Includes read threads in a seven-day initial window, then overlaps settled
//! windows by two minutes. GitHub's notification feed is not a repository archive.

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    protocol::SourceRef,
    sources::{
        ReadOutput, Source, SourceBatch, SourceCheckpoint, SourceCoverage, SourceEvent, SourceKey,
        now_seconds, read_command,
    },
};

#[derive(Debug)]
pub struct GitHubSource {
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
    before: u64,
    page: u32,
    not_before: u64,
}
#[derive(Deserialize, Serialize)]
struct Envelope {
    status: String,
    fields: Option<Fields>,
}
#[derive(Deserialize, Serialize)]
struct Fields {
    status: String,
    stdout_text: String,
}
#[derive(Deserialize)]
struct Notification {
    #[serde(default)]
    id: String,
    #[serde(default)]
    updated_at: String,
    #[serde(default)]
    reason: String,
    repository: Option<Repository>,
    subject: Option<Subject>,
}
#[derive(Deserialize)]
struct Repository {
    full_name: String,
}
#[derive(Deserialize)]
struct Subject {
    title: String,
    #[serde(rename = "type")]
    kind: String,
    url: Option<String>,
    latest_comment_url: Option<String>,
}
struct Page {
    notifications: Vec<Notification>,
    has_next: bool,
    poll_interval: u64,
}

impl GitHubSource {
    pub fn new(namespace: String) -> Result<Self> {
        ensure!(
            !namespace.trim().is_empty(),
            "GitHub source needs an explicit namespace"
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
            .filter(|item| item.provider == "github")
            .collect();
        if let Some(selected) = selected {
            for namespace in selected {
                ensure!(
                    namespaces.iter().any(|item| &item.id == namespace),
                    "Requested GitHub namespace is not configured"
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
                .context("Invalid GitHub source checkpoint")?,
            None => Window {
                account: self.namespace.clone(),
                since: now.saturating_sub(7 * 86_400),
                until: 0,
                before: 0,
                page: 1,
                not_before: 0,
            },
        };
        ensure!(
            window.account == self.namespace,
            "GitHub checkpoint belongs to another account"
        );
        if window.until == 0 {
            window.until = now.saturating_add(1);
        }
        if window.before == 0 {
            window.before = window.until;
        }
        ensure!(
            window.since < window.before
                && window.before <= window.until
                && (1..=100).contains(&window.page),
            "GitHub checkpoint window is invalid"
        );
        Ok(window)
    }

    fn normalize(&self, output: ReadOutput, mut window: Window, now: u64) -> SourceBatch {
        let key = self.key();
        if output.truncated {
            return SourceBatch::unavailable(
                key,
                "GitHub helper output was truncated; checkpoint retained",
            );
        }
        let Ok(envelope) = serde_json::from_str::<Envelope>(&output.stdout) else {
            return SourceBatch::unavailable(
                key,
                "GitHub helper returned no valid result; check scoped provider access",
            );
        };
        let Some(fields) = envelope.fields else {
            return SourceBatch::unavailable(key, "GitHub result has no notification coverage");
        };
        let Ok(page) = parse_page(&fields.stdout_text) else {
            return SourceBatch::unavailable(
                key,
                "GitHub notifications could not be read completely; checkpoint retained",
            );
        };
        let mut invalid = page.notifications.len() > 50;
        let mut oldest = None;
        let events = page
            .notifications
            .into_iter()
            .filter_map(|notification| {
                let (Some(repository), Some(subject)) =
                    (notification.repository, notification.subject)
                else {
                    invalid = true;
                    return None;
                };
                let Ok(updated) = parse_timestamp(&notification.updated_at) else {
                    invalid = true;
                    return None;
                };
                if notification.id.is_empty()
                    || updated < window.since
                    || updated >= window.before
                    || repository.full_name.is_empty()
                    || subject.title.is_empty()
                {
                    invalid = true;
                    return None;
                }
                oldest = Some(oldest.map_or(updated, |previous: u64| previous.min(updated)));
                let mut text = format!(
                    "Repository: {}\nType: {}\nReason: {}\nUpdated: {}\nSubject: {}",
                    repository.full_name,
                    subject.kind,
                    notification.reason,
                    notification.updated_at,
                    subject.title
                );
                if let Some(url) = subject.url {
                    text.push_str(&format!("\nSubject API: {url}"));
                }
                if let Some(url) = subject.latest_comment_url {
                    text.push_str(&format!("\nLatest comment API: {url}"));
                }
                let title = format!("{}: {}", repository.full_name, subject.title);
                // Journal versions identify all normalized content; pagination
                // continues to use the native updated_at clock.
                let mut digest = Sha256::new();
                for part in [&title, &text] {
                    digest.update((part.len() as u64).to_be_bytes());
                    digest.update(part.as_bytes());
                }
                let version = format!("{}:{:x}", notification.updated_at, digest.finalize());
                Some(SourceEvent {
                    id: notification.id.clone(),
                    version,
                    source: SourceRef {
                        provider: key.provider.clone(),
                        account: key.account.clone(),
                        thread_id: notification.id,
                    },
                    title,
                    text,
                })
            })
            .collect();
        let mut batch = SourceBatch {
            source: key,
            events,
            checkpoint: None,
            coverage: SourceCoverage::Partial {
                message: "GitHub notification coverage is incomplete; checkpoint retained".into(),
            },
        };
        if output.exit_code != 0
            || envelope.status != "executed"
            || fields.status != "ok"
            || invalid
        {
            return batch;
        }
        window.not_before = now.saturating_add(page.poll_interval.max(60));
        if page.has_next {
            if window.page == 100 {
                return batch;
            }
            let Some(before) = oldest.map(|updated| updated.saturating_add(1)) else {
                return batch;
            };
            if before >= window.before {
                return batch;
            }
            // Offset pages skip records when other notifications are updated.
            // Re-read the boundary second instead; unpageable ties remain a gap.
            window.before = before;
            window.page += 1;
            batch.coverage = SourceCoverage::More;
        } else {
            window.since = window.until.saturating_sub(120);
            window.until = 0;
            window.before = 0;
            window.page = 1;
            batch.coverage = SourceCoverage::Complete;
        }
        if let Ok(value) = serde_json::to_string(&window) {
            batch.checkpoint = Some(SourceCheckpoint { value });
        }
        batch
    }
}

#[async_trait::async_trait]
impl Source for GitHubSource {
    fn key(&self) -> SourceKey {
        SourceKey {
            provider: "github".into(),
            account: self.namespace.clone(),
        }
    }

    async fn poll(&self, checkpoint: Option<&SourceCheckpoint>) -> Result<SourceBatch> {
        let now = now_seconds()?;
        let window = self.window(checkpoint, now)?;
        if now < window.not_before {
            let settled: Window = serde_json::from_str(
                &checkpoint
                    .context("GitHub poll interval requires a checkpoint")?
                    .value,
            )?;
            return Ok(SourceBatch {
                source: self.key(),
                events: Vec::new(),
                checkpoint: checkpoint.cloned(),
                coverage: if settled.until == 0 {
                    SourceCoverage::Complete
                } else {
                    SourceCoverage::More
                },
            });
        }
        // Keep headers for pagination/polling limits, and project native JSON
        // before capture so repository metadata cannot crowd out notifications.
        let argv = vec![
            "switchboard".into(), "github.cli.read".into(), "--ns".into(), self.namespace.clone(), "--json".into(), "--".into(),
            "api".into(), "notifications".into(), "--method".into(), "GET".into(), "--include".into(),
            "-F".into(), "all=true".into(), "-F".into(), "per_page=50".into(),
            "-F".into(), format!("since={}", utc_timestamp(window.since)?),
            "-F".into(), format!("before={}", utc_timestamp(window.before)?),
            "-F".into(), "page=1".into(),
            "--jq".into(), "map({id,updated_at,reason,repository:{full_name:.repository.full_name},subject:{title:.subject.title,url:.subject.url,latest_comment_url:.subject.latest_comment_url,type:.subject.type}})".into(),
        ];
        Ok(match read_command(&argv).await {
            Ok(output) => self.normalize(output, window, now),
            Err(_) => SourceBatch::unavailable(
                self.key(),
                "GitHub helper could not run; check scoped read-only authorization",
            ),
        })
    }
}

fn parse_page(output: &str) -> Result<Page> {
    let (headers, body) = output
        .split_once("\r\n\r\n")
        .or_else(|| output.split_once("\n\n"))
        .context("Missing native GitHub response headers")?;
    let status = headers
        .lines()
        .next()
        .context("Missing GitHub HTTP status")?;
    ensure!(
        status.starts_with("HTTP/") && status.split_whitespace().nth(1) == Some("200"),
        "GitHub notification request failed"
    );
    let mut has_next = false;
    let mut poll_interval = 60;
    for line in headers.lines().skip(1) {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.eq_ignore_ascii_case("x-poll-interval") {
            poll_interval = value
                .trim()
                .parse()
                .context("Invalid GitHub poll interval")?;
        }
        if name.eq_ignore_ascii_case("link") {
            for link in value.split(',') {
                let (target, params) = link
                    .split_once('>')
                    .context("Invalid GitHub pagination link")?;
                ensure!(
                    target.trim_start().starts_with('<'),
                    "Invalid GitHub pagination target"
                );
                let relation = params
                    .split(';')
                    .find_map(|param| param.trim().strip_prefix("rel="))
                    .context("Missing GitHub pagination relation")?;
                has_next |= relation
                    .trim_matches('"')
                    .split_whitespace()
                    .any(|relation| relation == "next");
            }
        }
    }
    Ok(Page {
        notifications: serde_json::from_str(body).context("Invalid GitHub notification array")?,
        has_next,
        poll_interval,
    })
}

fn utc_timestamp(seconds: u64) -> Result<String> {
    let date = chrono::DateTime::from_timestamp(seconds.try_into()?, 0)
        .context("GitHub checkpoint date is invalid")?;
    Ok(date.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}

fn parse_timestamp(value: &str) -> Result<u64> {
    Ok(chrono::DateTime::parse_from_rfc3339(value)?
        .timestamp()
        .try_into()?)
}

#[cfg(test)]
mod tests {
    use crate::sources::{
        ReadOutput, Source, SourceCoverage,
        github::{Envelope, Fields, GitHubSource, Window, utc_timestamp},
    };

    const NOTIFICATION: &str = r#"[{"id":"123456","updated_at":"2023-11-14T21:00:00Z","reason":"review_requested","repository":{"full_name":"example/board"},"subject":{"title":"Verify board change","type":"PullRequest","url":"https://api.github.com/repos/example/board/pulls/7","latest_comment_url":null}}]"#;
    fn source() -> GitHubSource {
        GitHubSource::new("github.example".into()).unwrap()
    }
    fn output(body: &str, next: bool) -> ReadOutput {
        let link = if next {
            "Link: <https://api.github.com/notifications?page=2>; rel=\"next\", <https://api.github.com/notifications?page=4>; rel=\"last\"\r\n"
        } else {
            ""
        };
        ReadOutput {
            exit_code: 0,
            truncated: false,
            stdout: serde_json::to_string(&Envelope {
                status: "executed".into(),
                fields: Some(Fields {
                    status: "ok".into(),
                    stdout_text: format!("HTTP/2.0 200 OK\n{link}X-Poll-Interval: 120\r\n\n{body}"),
                }),
            })
            .unwrap(),
        }
    }

    #[test]
    fn native_cli_notification_preserves_identity_version_and_frozen_window() {
        let source = source();
        let batch = source.normalize(
            output(NOTIFICATION, true),
            source.window(None, 1_700_000_000).unwrap(),
            1_700_000_000,
        );
        assert_eq!(batch.coverage, SourceCoverage::More);
        let event = &batch.events[0];
        assert_eq!(event.id, "123456");
        assert_eq!(event.source.thread_id, "123456");
        assert!(event.version.starts_with("2023-11-14T21:00:00Z:"));
        assert_eq!(event.source.provider, "github");
        assert_eq!(event.source.account, "github.example");
        assert!(event.text.contains("review_requested") && event.text.contains("/pulls/7"));
        let next = source
            .window(batch.checkpoint.as_ref(), 1_710_000_000)
            .unwrap();
        assert_eq!(next.page, 2);
        assert_eq!(next.until, 1_700_000_001);
        assert_eq!(next.before, 1_699_995_601);
        assert_eq!(next.not_before, 1_700_000_120);
        assert!(
            GitHubSource::new("github.other".into())
                .unwrap()
                .window(batch.checkpoint.as_ref(), 1_710_000_000)
                .is_err()
        );
    }

    #[test]
    fn changed_projected_content_gets_a_distinct_version_without_moving_the_cursor() {
        let source = source();
        let normalize = |body: &str| {
            source.normalize(
                output(body, true),
                source.window(None, 1_700_000_000).unwrap(),
                1_700_000_000,
            )
        };
        let original = normalize(NOTIFICATION);
        let replay = normalize(NOTIFICATION);
        let read = normalize(&NOTIFICATION.replace(
            "\"reason\":",
            "\"unread\":false,\"last_read_at\":\"2023-11-14T21:01:00Z\",\"reason\":",
        ));
        assert_eq!(
            serde_json::to_string(&original.events).unwrap(),
            serde_json::to_string(&replay.events).unwrap()
        );
        assert_eq!(
            serde_json::to_string(&original.events).unwrap(),
            serde_json::to_string(&read.events).unwrap()
        );
        for changed in [
            NOTIFICATION.replace("Verify board change", "Review board change"),
            NOTIFICATION.replace("example/board", "example/renamed-board"),
            NOTIFICATION.replace("/pulls/7", "/pulls/8"),
        ] {
            let changed = normalize(&changed);
            assert_ne!(original.events[0].text, changed.events[0].text);
            assert_ne!(original.events[0].version, changed.events[0].version);
            assert_eq!(original.events[0].id, changed.events[0].id);
            assert_eq!(
                serde_json::to_string(&original.events[0].source).unwrap(),
                serde_json::to_string(&changed.events[0].source).unwrap()
            );
            assert_eq!(original.checkpoint, changed.checkpoint);
        }
    }

    #[test]
    fn empty_array_is_complete_and_next_window_keeps_overlap_from_the_frozen_cutoff() {
        let source = source();
        let batch = source.normalize(
            output("[]", false),
            source.window(None, 1_700_000_000).unwrap(),
            1_710_000_000,
        );
        assert_eq!(batch.coverage, SourceCoverage::Complete);
        assert!(batch.events.is_empty());
        let saved: Window = serde_json::from_str(&batch.checkpoint.unwrap().value).unwrap();
        assert_eq!(saved.since, 1_700_000_001 - 120);
        assert_eq!(saved.until, 0);
        assert_eq!(saved.page, 1);
        assert_eq!(
            utc_timestamp(1_700_000_000).unwrap(),
            "2023-11-14T22:13:20Z"
        );
    }

    #[test]
    fn updated_notifications_cannot_shift_offset_pages_and_timestamp_ties_remain_a_gap() {
        let source = source();
        let first = source.normalize(
            output(NOTIFICATION, true),
            source.window(None, 1_700_000_000).unwrap(),
            1_700_000_000,
        );
        let window = source
            .window(first.checkpoint.as_ref(), 1_700_000_200)
            .unwrap();
        // Re-reading the boundary second does not skip other notifications after
        // a previously seen thread moves to a newer update outside this window.
        let older = NOTIFICATION
            .replace("123456", "123457")
            .replace("21:00:00Z", "20:59:59Z");
        let second = source.normalize(output(&older, true), window, 1_700_000_200);
        let next = source
            .window(second.checkpoint.as_ref(), 1_700_000_400)
            .unwrap();
        assert_eq!(next.before, 1_699_995_600);
        assert_eq!(next.until, 1_700_000_001);
        let tied = source.normalize(output(&older, true), next, 1_700_000_400);
        assert!(matches!(tied.coverage, SourceCoverage::Partial { .. }));
        assert!(tied.checkpoint.is_none());
        assert_eq!(tied.events[0].id, "123457");
    }

    #[test]
    fn failed_partial_and_truncated_reads_never_advance() {
        let source = source();
        let mut partial = output(NOTIFICATION, true);
        partial.exit_code = 1;
        let batch = source.normalize(
            partial,
            source.window(None, 1_700_000_000).unwrap(),
            1_700_000_000,
        );
        assert_eq!(batch.events.len(), 1);
        assert!(matches!(batch.coverage, SourceCoverage::Partial { .. }));
        assert!(batch.checkpoint.is_none());
        let mut truncated = output(NOTIFICATION, true);
        truncated.truncated = true;
        let batch = source.normalize(
            truncated,
            source.window(None, 1_700_000_000).unwrap(),
            1_700_000_000,
        );
        assert!(matches!(batch.coverage, SourceCoverage::Unavailable { .. }));
        assert!(batch.checkpoint.is_none());
        let mut denied = output("[]", false);
        denied.stdout = denied.stdout.replace("200 OK", "403 Forbidden");
        let batch = source.normalize(
            denied,
            source.window(None, 1_700_000_000).unwrap(),
            1_700_000_000,
        );
        assert!(matches!(batch.coverage, SourceCoverage::Unavailable { .. }));
        assert!(batch.checkpoint.is_none());
        let batch = source.normalize(
            output(&NOTIFICATION.replace("\"123456\"", "\"\""), false),
            source.window(None, 1_700_000_000).unwrap(),
            1_700_000_000,
        );
        assert!(matches!(batch.coverage, SourceCoverage::Partial { .. }));
        assert!(batch.checkpoint.is_none());
        let mut window = source.window(None, 1_700_000_000).unwrap();
        window.page = 100;
        let batch = source.normalize(output(NOTIFICATION, true), window, 1_700_000_000);
        assert!(matches!(batch.coverage, SourceCoverage::Partial { .. }));
        assert!(batch.checkpoint.is_none());
    }

    #[test]
    fn namespace_discovery_is_optional_and_rejects_other_provider_accounts() {
        let registry = r#"{"namespaces":[{"id":"github.one","provider":"github"},{"id":"github.two","provider":"github"},{"id":"google.example","provider":"google"}]}"#;
        assert_eq!(
            GitHubSource::from_registry(registry, None).unwrap().len(),
            2
        );
        let selected = GitHubSource::from_registry(registry, Some(&["github.two".into()])).unwrap();
        assert_eq!(selected[0].key().account, "github.two");
        assert!(GitHubSource::from_registry(registry, Some(&["google.example".into()])).is_err());
        assert!(
            GitHubSource::from_registry(r#"{"namespaces":[]}"#, None)
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn server_poll_interval_defers_the_native_read_without_forging_new_progress() {
        let source = source();
        let mut window = source
            .window(None, crate::sources::now_seconds().unwrap())
            .unwrap();
        window.not_before = u64::MAX;
        let checkpoint = crate::sources::SourceCheckpoint {
            value: serde_json::to_string(&window).unwrap(),
        };
        let batch = source.poll(Some(&checkpoint)).await.unwrap();
        assert!(batch.events.is_empty());
        assert_eq!(batch.coverage, SourceCoverage::More);
        assert_eq!(batch.checkpoint.as_ref(), Some(&checkpoint));
    }

    #[tokio::test]
    #[ignore = "requires an existing scoped Switchboard GitHub namespace with notification read access"]
    async fn live_notification_read_uses_the_existing_github_cli_namespace() {
        let namespace = std::env::var("AGENT_TEST_GITHUB_NAMESPACE")
            .expect("Set AGENT_TEST_GITHUB_NAMESPACE to an existing namespace");
        let source = GitHubSource::discover(Some(&[namespace]))
            .await
            .unwrap()
            .pop()
            .unwrap();
        let batch = source.poll(None).await.unwrap();
        assert!(
            matches!(
                batch.coverage,
                SourceCoverage::Complete | SourceCoverage::More
            ),
            "Native notification coverage was incomplete"
        );
        assert!(batch.checkpoint.is_some());
        eprintln!(
            "Native GitHub CLI read verified: {} notifications normalized with durable checkpoint candidate.",
            batch.events.len()
        );
    }
}
