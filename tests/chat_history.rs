use std::{
    fs,
    os::unix::fs::PermissionsExt,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use agent_cli::{
    protocol::{HistoryMessage, HistoryRole, RuntimeCommand, RuntimeEventKind},
    runtime::FrameReader,
};
use tokio::{
    io::{AsyncWriteExt, BufReader},
    net::UnixListener,
    process::Command,
    time::timeout,
};

#[tokio::test]
async fn bare_cli_reopens_the_main_history_before_exit() {
    main_history(false).await;
}

#[tokio::test]
async fn history_command_pages_older_main_turns_before_exit() {
    main_history(true).await;
}

async fn main_history(older: bool) {
    let directory = tempfile::tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let config = directory.path().join("config.toml");
    fs::write(&config, "").unwrap();
    let listener = UnixListener::bind(directory.path().join("agent.sock")).unwrap();
    let reads = Arc::new(AtomicUsize::new(0));
    let observed = reads.clone();
    let server = tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let observed = observed.clone();
            tokio::spawn(async move {
                let (reader, mut writer) = stream.into_split();
                let mut reader = FrameReader::new(BufReader::new(reader));
                let Some(bytes) = reader.next_frame().await.unwrap() else {
                    return;
                };
                let command: RuntimeCommand = serde_json::from_slice(&bytes).unwrap();
                match command {
                    RuntimeCommand::Watch => {
                        assert!(reader.next_frame().await.unwrap().is_none());
                    }
                    RuntimeCommand::ReadHistory {
                        task_id,
                        agent_id,
                        cursor,
                    } => {
                        assert!(task_id.is_none() && agent_id.is_none());
                        observed.fetch_add(1, Ordering::SeqCst);
                        let older = cursor.is_some();
                        if older {
                            assert_eq!(cursor.as_deref(), Some("older-root-page"));
                        }
                        let event = RuntimeEventKind::History {
                            conversation_id: "persisted-main".into(),
                            messages: vec![
                                HistoryMessage {
                                    entry_id: if older { "1" } else { "2" }.into(),
                                    role: HistoryRole::User,
                                    text: if older {
                                        "Earlier question"
                                    } else {
                                        "Saved question"
                                    }
                                    .into(),
                                    continuation: false,
                                },
                                HistoryMessage {
                                    entry_id: if older { "3" } else { "4" }.into(),
                                    role: HistoryRole::Assistant,
                                    text: if older {
                                        "Earlier answer"
                                    } else {
                                        "Saved answer"
                                    }
                                    .into(),
                                    continuation: false,
                                },
                            ],
                            next_cursor: if older {
                                None
                            } else {
                                Some("older-root-page".into())
                            },
                        };
                        let mut frame = serde_json::to_vec(&event).unwrap();
                        frame.push(b'\n');
                        writer.write_all(&frame).await.unwrap();
                        writer.write_all(b"{\"type\":\"done\"}\n").await.unwrap();
                    }
                    other => panic!(
                        "History-only startup must not invoke a model or mutate a conversation: {other:?}"
                    ),
                }
            });
        }
    });
    for _ in 0..2 {
        let binary = std::env::var_os("AGENT_TEST_BINARY")
            .unwrap_or_else(|| env!("CARGO_BIN_EXE_agent").into());
        let mut child = Command::new(binary)
            .arg("--state-dir")
            .arg(directory.path())
            .arg("--config")
            .arg(&config)
            .arg("--instructions")
            .arg(directory.path().join("AGENTS.md"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(if older {
                b"/history\n/exit\n"
            } else {
                b"/exit\n"
            })
            .await
            .unwrap();
        let output = timeout(Duration::from_secs(5), child.wait_with_output())
            .await
            .unwrap()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let visible = String::from_utf8(output.stdout).unwrap();
        assert!(
            visible.contains("user> Saved question\nagent> Saved answer"),
            "Bare agent must display the saved main conversation before exit; got {visible:?}"
        );
        assert!(
            !older || visible.contains("user> Earlier question\nagent> Earlier answer"),
            "{visible}"
        );
    }
    assert_eq!(reads.load(Ordering::SeqCst), if older { 4 } else { 2 });
    server.abort();
    let _ = server.await;
}
