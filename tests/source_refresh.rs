use std::{fs, os::unix::fs::PermissionsExt, path::Path};

use agent_cli::{
    background::{self, BackgroundRequest, BackgroundResponse},
    protocol::{HostResult, SourceState},
    runtime::MAX_FRAME_BYTES,
    sources::{Source, SourceConfig, SourceCoverage, slack::SlackSource},
};
use serde::Serialize;

#[derive(Serialize)]
struct SearchResponse {
    ok: bool,
    messages: SearchMessages,
}

#[derive(Serialize)]
struct SearchMessages {
    matches: Vec<SearchMessage>,
    paging: SearchPaging,
}

#[derive(Serialize)]
struct SearchMessage {
    ts: String,
    text: String,
    channel: SearchChannel,
}

#[derive(Serialize)]
struct SearchChannel {
    id: String,
    name: String,
}

#[derive(Serialize)]
struct SearchPaging {
    next_cursor: String,
}

fn response(page: usize, text_bytes: usize, next_cursor: &str) -> SearchResponse {
    SearchResponse {
        ok: true,
        messages: SearchMessages {
            matches: vec![SearchMessage {
                ts: format!("1700000000.{page:06}"),
                text: "x".repeat(text_bytes),
                channel: SearchChannel {
                    id: "CEXAMPLE".into(),
                    name: "example".into(),
                },
            }],
            paging: SearchPaging {
                next_cursor: next_cursor.into(),
            },
        },
    }
}

fn helper(directory: &Path, text_bytes: &[usize]) -> Vec<String> {
    for (page, length) in text_bytes.iter().enumerate() {
        let next = if page + 1 == text_bytes.len() {
            String::new()
        } else {
            format!("page-{}", page + 1)
        };
        fs::write(
            directory.join(format!("{page}.json")),
            serde_json::to_vec(&response(page, *length, &next)).unwrap(),
        )
        .unwrap();
    }
    let executable = directory.join("source-read");
    fs::write(
        &executable,
        r#"#!/bin/sh
for argument in "$@"; do
    case "$argument" in cursor=*) cursor="${argument#cursor=}" ;; esac
done
case "$cursor" in
    '*') page=0 ;;
    page-*) page="${cursor#page-}" ;;
    *) exit 1 ;;
esac
exec /bin/cat "$1/$page.json"
"#,
    )
    .unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    vec![
        executable.to_str().unwrap().to_owned(),
        directory.to_str().unwrap().to_owned(),
    ]
}

#[tokio::test]
async fn real_source_pages_cross_the_transport_individually_and_retain_account_checkpoints() {
    let directory = tempfile::tempdir().unwrap();
    let command = helper(directory.path(), &[1_500_000; 3]);
    let accounts = ["workspace-one", "workspace-two"];
    let config: Vec<_> = accounts
        .iter()
        .map(|account| SourceConfig::Slack {
            enabled: true,
            command: command.clone(),
            account: (*account).into(),
        })
        .collect();
    let mut states: Vec<SourceState> = Vec::new();
    let mut cursor = None;
    let mut total_bytes = 0;
    let mut pages = 0;
    loop {
        let response = background::execute(BackgroundRequest::PollSources {
            sources: config.clone(),
            states: states.clone(),
            cursor,
        })
        .await
        .unwrap();
        let wire = serde_json::to_vec(&HostResult::Background { response }).unwrap();
        assert!(wire.len() <= MAX_FRAME_BYTES);
        total_bytes += wire.len();
        let HostResult::Background {
            response:
                BackgroundResponse::Sources {
                    reads,
                    cursor: next,
                },
        } = serde_json::from_slice(&wire).unwrap()
        else {
            panic!("The source response did not survive the wire round trip");
        };
        assert_eq!(reads.len(), 1);
        let read = reads.into_iter().next().unwrap();
        let page = pages % 3;
        assert_eq!(read.batch.source.account, accounts[pages / 3]);
        assert_eq!(read.batch.events.len(), 1);
        assert_eq!(read.batch.events[0].text.len(), 1_500_000);
        assert_eq!(
            read.batch.events[0].id,
            format!("CEXAMPLE:1700000000.{page:06}")
        );
        assert_eq!(
            read.batch.coverage,
            if page == 2 {
                SourceCoverage::Complete
            } else {
                SourceCoverage::More
            }
        );
        let previous = states
            .iter_mut()
            .find(|state| state.source == read.batch.source);
        assert_eq!(
            read.expected_checkpoint,
            previous.as_ref().and_then(|state| state.checkpoint.clone())
        );
        assert!(read.batch.checkpoint.is_some());
        let admitted = SourceState {
            source: read.batch.source,
            checkpoint: read.batch.checkpoint,
            coverage: read.batch.coverage,
            checked_at: 0,
        };
        match previous {
            Some(previous) => *previous = admitted,
            None => states.push(admitted),
        }
        pages += 1;
        cursor = next;
        if cursor.is_none() {
            break;
        }
        assert!(
            pages < 6,
            "The source cursor did not finish the account scan"
        );
    }
    assert_eq!(pages, 6);
    assert!(total_bytes > MAX_FRAME_BYTES);
    assert_eq!(states.len(), 2);
    assert!(
        states
            .iter()
            .all(|state| state.coverage == SourceCoverage::Complete)
    );
}

#[tokio::test]
async fn normalization_that_exceeds_the_page_budget_preserves_the_supplied_checkpoint() {
    let directory = tempfile::tempdir().unwrap();
    let raw_overhead = serde_json::to_vec(&response(1, 0, "")).unwrap().len();
    let command = helper(
        directory.path(),
        &[32, MAX_FRAME_BYTES / 2 - raw_overhead - 1],
    );
    let account = "workspace-oversized".to_owned();
    let source = SlackSource::new(command.clone(), account.clone()).unwrap();
    let first = source.poll(None).await.unwrap();
    assert_eq!(first.coverage, SourceCoverage::More);
    let checkpoint = first.checkpoint.unwrap();
    let normalized = source.poll(Some(&checkpoint)).await.unwrap();
    assert_eq!(normalized.coverage, SourceCoverage::Complete);
    assert!(serde_json::to_vec(&normalized).unwrap().len() > MAX_FRAME_BYTES / 2);
    let response = background::execute(BackgroundRequest::PollSources {
        sources: vec![SourceConfig::Slack {
            enabled: true,
            command,
            account,
        }],
        states: vec![SourceState {
            source: source.key(),
            checkpoint: Some(checkpoint.clone()),
            coverage: SourceCoverage::More,
            checked_at: 0,
        }],
        cursor: None,
    })
    .await
    .unwrap();
    let wire = serde_json::to_vec(&HostResult::Background { response }).unwrap();
    assert!(wire.len() <= MAX_FRAME_BYTES);
    let HostResult::Background {
        response: BackgroundResponse::Sources { reads, cursor },
    } = serde_json::from_slice(&wire).unwrap()
    else {
        panic!("The source response did not survive the wire round trip");
    };
    assert!(cursor.is_none());
    assert_eq!(reads.len(), 1);
    let read = reads.into_iter().next().unwrap();
    assert_eq!(read.expected_checkpoint, Some(checkpoint));
    assert!(matches!(
        read.batch.coverage,
        SourceCoverage::Partial { .. }
    ));
    assert!(read.batch.events.is_empty());
    assert!(read.batch.checkpoint.is_none());
}
