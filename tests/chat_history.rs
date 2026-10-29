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
    models::ModelSelection,
    protocol::{
        ConversationSettings, HistoryMessage, HistoryRole, RuntimeCommand, RuntimeEventKind,
    },
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

#[tokio::test]
async fn chief_connecting_screen_keeps_early_draft_and_opens_known_history_without_catalog() {
    chief_startup(ChiefStartup::Ready).await;
}

#[tokio::test]
async fn chief_can_exit_while_its_initial_settings_are_still_unavailable() {
    chief_startup(ChiefStartup::Exit).await;
}

#[tokio::test]
async fn chief_retains_unsent_early_inputs_when_its_initial_settings_fail() {
    chief_startup(ChiefStartup::Failure).await;
}

#[derive(Clone, Copy)]
enum ChiefStartup {
    Ready,
    Exit,
    Failure,
}

async fn chief_startup(mode: ChiefStartup) {
    use agent_cli::protocol::SavedConversation;
    use tokio::io::AsyncReadExt;
    let directory = tempfile::tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let config = directory.path().join("config.toml");
    fs::write(&config, "").unwrap();
    let listener = UnixListener::bind(directory.path().join("agent.sock")).unwrap();
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let requested = Arc::new(tokio::sync::Notify::new());
    let catalog_reads = Arc::new(AtomicUsize::new(0));
    let admitted = Arc::new(AtomicUsize::new(0));
    let admitted_inputs = admitted.clone();
    let observed = catalog_reads.clone();
    let ready_gate = gate.clone();
    let settings_requested = requested.clone();
    let server = tokio::spawn(async move {
        loop {
            let (socket, _) = listener.accept().await.unwrap();
            let gate = ready_gate.clone();
            let requested = settings_requested.clone();
            let observed = observed.clone();
            let admitted = admitted_inputs.clone();
            tokio::spawn(async move {
                let (reader, mut writer) = socket.into_split();
                let mut reader = FrameReader::new(BufReader::new(reader));
                let Some(bytes) = reader.next_frame().await.unwrap() else {
                    return;
                };
                let command: RuntimeCommand = serde_json::from_slice(&bytes).unwrap();
                let summary = SavedConversation {
                    conversation_id: "saved-chief".into(),
                    title: "Main agent".into(),
                    updated_at: None,
                    task_id: None,
                    agent_id: None,
                    host: None,
                    source_thread_id: None,
                };
                let events = match command {
                    RuntimeCommand::ConversationSettings {
                        task_id: None,
                        agent_id: None,
                        conversation_id: None,
                        change: None,
                        catalog: false,
                    } => {
                        requested.notify_one();
                        tokio::select! {
                            permit = gate.acquire() => { permit.unwrap().forget(); }
                            closed = reader.next_frame() => { assert!(closed.unwrap().is_none()); return; }
                        }
                        if matches!(mode, ChiefStartup::Failure) {
                            vec![RuntimeEventKind::Failure {
                                code: agent_cli::protocol::ErrorCode::ProviderUnavailable,
                                message: "Synthetic settings connection failure".into(),
                            }]
                        } else {
                            vec![RuntimeEventKind::ConversationSettings {
                                settings: ConversationSettings {
                                    conversation_id: summary.conversation_id,
                                    task_id: None,
                                    agent_id: None,
                                    model: ModelSelection::default(),
                                    catalog: vec![],
                                },
                            }]
                        }
                    }
                    RuntimeCommand::AttachConversation {
                        conversation_id, ..
                    } => {
                        assert_eq!(conversation_id, summary.conversation_id);
                        let event = RuntimeEventKind::ConversationReady {
                            conversation: summary,
                            model: ModelSelection::default(),
                            cwd: "/example".into(),
                            working: false,
                        };
                        let mut bytes = serde_json::to_vec(&event).unwrap();
                        bytes.push(b'\n');
                        writer.write_all(&bytes).await.unwrap();
                        assert!(reader.next_frame().await.unwrap().is_none());
                        return;
                    }
                    RuntimeCommand::ReadConversation {
                        conversation_id,
                        cursor: None,
                    } => {
                        assert_eq!(conversation_id, summary.conversation_id);
                        vec![RuntimeEventKind::History {
                            conversation_id,
                            messages: vec![HistoryMessage {
                                entry_id: "saved-answer".into(),
                                role: HistoryRole::Final,
                                text: "The known chief history is visible.".into(),
                                continuation: false,
                                final_chunk: true,
                                tool: None,
                            }],
                            next_cursor: None,
                            page_complete: true,
                        }]
                    }
                    RuntimeCommand::ListConversations { .. } => {
                        observed.fetch_add(1, Ordering::SeqCst);
                        vec![RuntimeEventKind::Conversations {
                            items: vec![summary],
                            next_cursor: None,
                        }]
                    }
                    RuntimeCommand::ConversationInput {
                        conversation_id,
                        input_id,
                        input,
                        mode,
                        ..
                    } => {
                        assert_eq!(conversation_id, summary.conversation_id);
                        assert_eq!(input, "A draft before settings");
                        assert_eq!(mode, agent_cli::protocol::InputMode::Steer);
                        admitted.fetch_add(1, Ordering::SeqCst);
                        vec![
                            RuntimeEventKind::InputAccepted {
                                input_id: input_id.clone(),
                            },
                            RuntimeEventKind::InputPlaced {
                                input_id,
                                entry_id: "saved-input".into(),
                            },
                        ]
                    }
                    RuntimeCommand::Watch => {
                        let _ = reader.next_frame().await;
                        return;
                    }
                    other => panic!("Readonly chief startup unexpectedly requested {other:?}"),
                };
                for event in events.into_iter().chain([RuntimeEventKind::Done]) {
                    let mut bytes = serde_json::to_vec(&event).unwrap();
                    bytes.push(b'\n');
                    writer.write_all(&bytes).await.unwrap();
                }
            });
        }
    });
    let binary =
        std::env::var_os("AGENT_TEST_BINARY").unwrap_or_else(|| env!("CARGO_BIN_EXE_agent").into());
    let fixture = std::path::Path::new(env!("CARGO_BIN_EXE_agent"))
        .parent()
        .unwrap()
        .join("examples/terminal-fixture");
    let mut child = Command::new(fixture)
        .arg(binary)
        .arg("--state-dir")
        .arg(directory.path())
        .arg("--config")
        .arg(config)
        .arg("chat")
        .args(match mode {
            ChiefStartup::Ready => None,
            ChiefStartup::Exit => Some("Do the initial CLI request"),
            ChiefStartup::Failure => Some("/resume retained-target"),
        })
        .env("TERM", "xterm-256color")
        .env("AGENT_TEST_TERMINAL_REPLY", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = child.stdout.take().unwrap();
    timeout(Duration::from_secs(3), requested.notified())
        .await
        .unwrap();
    let mut bytes = Vec::new();
    timeout(Duration::from_secs(1), async {
        let mut chunk = [0; 4096];
        while !String::from_utf8_lossy(&bytes).contains("Message the agent") {
            let count = output.read(&mut chunk).await.unwrap();
            assert!(count > 0);
            bytes.extend_from_slice(&chunk[..count]);
        }
    })
    .await
    .expect("A coordinator response must not gate the first native composer");
    let connecting = String::from_utf8_lossy(&bytes);
    assert!(connecting.contains("Connecting"), "{connecting}");
    assert!(
        !connecting.contains(&ModelSelection::default().model_id),
        "A connecting client cannot guess its model"
    );
    if matches!(mode, ChiefStartup::Ready) {
        input.write_all(b"A draft before settings").await.unwrap();
        gate.add_permits(1);
        timeout(Duration::from_secs(3), async {
            let mut chunk = [0; 4096];
            loop {
                let count = output.read(&mut chunk).await.unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&chunk[..count]);
                let text = terminal_text(&bytes);
                if text.contains("The known chief history is visible.") {
                    break;
                }
            }
        })
        .await
        .unwrap_or_else(|error| {
            panic!(
                "Ready startup did not show saved history: {error}: {}",
                terminal_text(&bytes)
            )
        });
        assert_eq!(
            admitted.load(Ordering::SeqCst),
            0,
            "Opening a chat must not admit model input"
        );
        input.write_all(b"\r").await.unwrap();
        timeout(Duration::from_secs(3), async {
            while admitted.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        input.write_all(b"\x03").await.unwrap();
    } else {
        input
            .write_all(b"An early request\rA later request\tA partial draft")
            .await
            .unwrap();
        timeout(Duration::from_secs(3), async {
            let mut chunk = [0; 4096];
            loop {
                let count = output.read(&mut chunk).await.unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&chunk[..count]);
                if terminal_text(&bytes)
                    .chars()
                    .filter(|ch| !ch.is_whitespace())
                    .collect::<String>()
                    .contains("Apartialdraft")
                {
                    break;
                }
            }
        })
        .await
        .unwrap_or_else(|error| {
            panic!(
                "Held startup did not show typed draft: {error}: {}",
                terminal_text(&bytes)
            )
        });
        if matches!(mode, ChiefStartup::Exit) {
            input.write_all(b"\x03").await.unwrap();
        } else {
            gate.add_permits(1);
        }
    }
    let exited = timeout(Duration::from_secs(3), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        exited.status.success(),
        !matches!(mode, ChiefStartup::Failure),
        "{}",
        String::from_utf8_lossy(&exited.stderr)
    );
    if !matches!(mode, ChiefStartup::Ready) {
        #[derive(serde::Deserialize)]
        #[serde(tag = "kind", rename_all = "snake_case")]
        enum Owner {
            Main,
        }
        #[derive(serde::Deserialize)]
        struct Recovery {
            owner: Owner,
            draft: String,
            queued_inputs: Vec<String>,
        }
        let saved = fs::read_dir(directory.path().join("recovery"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>();
        assert_eq!(saved.len(), 1);
        let recovery: Recovery = serde_json::from_slice(&fs::read(&saved[0]).unwrap()).unwrap();
        assert!(matches!(recovery.owner, Owner::Main));
        assert_eq!(recovery.draft, "A partial draft");
        let initial = if matches!(mode, ChiefStartup::Exit) {
            "Do the initial CLI request"
        } else {
            "/resume retained-target"
        };
        assert_eq!(
            recovery.queued_inputs,
            [initial, "An early request", "A later request"]
        );
        assert_eq!(
            fs::metadata(&saved[0]).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(saved[0].parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
    assert_eq!(
        catalog_reads.load(Ordering::SeqCst),
        0,
        "The settings already identify the chief conversation"
    );
    assert_eq!(
        admitted.load(Ordering::SeqCst),
        usize::from(matches!(mode, ChiefStartup::Ready))
    );
    server.abort();
    let _ = server.await;
}

fn terminal_text(bytes: &[u8]) -> String {
    let value = String::from_utf8_lossy(bytes);
    let mut chars = value.chars();
    let mut text = String::new();
    while let Some(ch) = chars.next() {
        if ch != '\x1b' {
            text.push(ch);
            continue;
        }
        match chars.next() {
            Some('[') => {
                for code in chars.by_ref() {
                    if ('@'..='~').contains(&code) {
                        break;
                    }
                }
            }
            Some(']') => {
                let mut escape = false;
                for code in chars.by_ref() {
                    if code == '\x07' || (escape && code == '\\') {
                        break;
                    }
                    escape = code == '\x1b';
                }
            }
            _ => {}
        }
    }
    text
}

#[tokio::test]
async fn coordinator_decode_failure_reports_safe_metadata_without_private_values() {
    #[derive(serde::Serialize)]
    struct FutureEvent {
        #[serde(rename = "type")]
        tag: &'static str,
        content: &'static str,
    }
    let directory = tempfile::tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let config = directory.path().join("config.toml");
    fs::write(&config, "").unwrap();
    let listener = UnixListener::bind(directory.path().join("agent.sock")).unwrap();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (reader, mut writer) = stream.into_split();
        let mut reader = FrameReader::new(BufReader::new(reader));
        let command: RuntimeCommand =
            serde_json::from_slice(&reader.next_frame().await.unwrap().unwrap()).unwrap();
        assert!(
            matches!(command,RuntimeCommand::ReadConversation{conversation_id,..} if conversation_id=="saved")
        );
        let mut bytes = serde_json::to_vec(&FutureEvent {
            tag: "fixture_private_tag_573",
            content: "fixture_private_content_811",
        })
        .unwrap();
        bytes.push(b'\n');
        writer.write_all(&bytes).await.unwrap();
    });
    let binary =
        std::env::var_os("AGENT_TEST_BINARY").unwrap_or_else(|| env!("CARGO_BIN_EXE_agent").into());
    let output = Command::new(binary)
        .arg("--state-dir")
        .arg(directory.path())
        .arg("--config")
        .arg(config)
        .args(["--no-tui", "history", "read", "saved"])
        .output()
        .await
        .unwrap();
    server.await.unwrap();
    assert!(!output.status.success());
    let diagnostic = String::from_utf8(output.stderr).unwrap();
    assert!(
        diagnostic.contains("schema")
            && diagnostic.contains("bytes")
            && diagnostic.contains("update"),
        "{diagnostic}"
    );
    assert!(
        !diagnostic.contains("fixture_private_tag_573")
            && !diagnostic.contains("fixture_private_content_811"),
        "{diagnostic}"
    );
}

#[tokio::test]
async fn exact_resume_renders_history_without_fetching_fuzzy_catalog_pages() {
    use agent_cli::protocol::{RuntimeEventKind, SavedConversation};
    let directory = tempfile::tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let config = directory.path().join("config.toml");
    fs::write(&config, "").unwrap();
    let listener = UnixListener::bind(directory.path().join("agent.sock")).unwrap();
    let extra_pages = Arc::new(AtomicUsize::new(0));
    let observed = extra_pages.clone();
    let server = tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let observed = observed.clone();
            tokio::spawn(async move {
                let (read, mut write) = stream.into_split();
                let mut read = FrameReader::new(BufReader::new(read));
                let Some(frame) = read.next_frame().await.unwrap() else {
                    return;
                };
                let command: RuntimeCommand = serde_json::from_slice(&frame).unwrap();
                let events = match command {
                    RuntimeCommand::ConversationSettings {
                        task_id: None,
                        agent_id: None,
                        conversation_id: None,
                        change: None,
                        catalog: false,
                    } => vec![RuntimeEventKind::ConversationSettings {
                        settings: ConversationSettings {
                            conversation_id: "1".into(),
                            task_id: None,
                            agent_id: None,
                            model: ModelSelection::default(),
                            catalog: vec![],
                        },
                    }],
                    RuntimeCommand::Watch => {
                        let _ = read.next_frame().await;
                        return;
                    }
                    RuntimeCommand::ListConversations {
                        query,
                        cursor,
                        limit: 100,
                    } => {
                        assert_eq!(query, "1");
                        let items = if cursor.is_none() {
                            (0..100)
                                .map(|index| SavedConversation {
                                    conversation_id: if index == 0 {
                                        "1".into()
                                    } else {
                                        format!("10{index:03}")
                                    },
                                    title: if index == 0 {
                                        "Main agent".into()
                                    } else {
                                        format!("Fuzzy match {index}")
                                    },
                                    updated_at: None,
                                    task_id: None,
                                    agent_id: None,
                                    host: None,
                                    source_thread_id: None,
                                })
                                .collect()
                        } else {
                            observed.fetch_add(1, Ordering::SeqCst);
                            vec![]
                        };
                        vec![RuntimeEventKind::Conversations {
                            items,
                            next_cursor: cursor.is_none().then(|| "more-fuzzy-matches".into()),
                        }]
                    }
                    RuntimeCommand::AttachConversation {
                        conversation_id, ..
                    } => {
                        assert_eq!(conversation_id, "1");
                        let event = RuntimeEventKind::ConversationReady {
                            conversation: SavedConversation {
                                conversation_id: "1".into(),
                                title: "Main agent".into(),
                                updated_at: None,
                                task_id: None,
                                agent_id: None,
                                host: None,
                                source_thread_id: None,
                            },
                            model: ModelSelection::default(),
                            cwd: "/example".into(),
                            working: false,
                        };
                        let mut bytes = serde_json::to_vec(&event).unwrap();
                        bytes.push(b'\n');
                        write.write_all(&bytes).await.unwrap();
                        let _ = read.next_frame().await;
                        return;
                    }
                    RuntimeCommand::ReadConversation {
                        conversation_id,
                        cursor: None,
                    } => {
                        assert_eq!(conversation_id, "1");
                        vec![RuntimeEventKind::History {
                            conversation_id,
                            messages: vec![HistoryMessage {
                                entry_id: "saved-answer".into(),
                                role: HistoryRole::Final,
                                text: "The exact saved chat is visible.".into(),
                                continuation: false,
                                final_chunk: true,
                                tool: None,
                            }],
                            next_cursor: None,
                            page_complete: true,
                        }]
                    }
                    other => panic!("Readonly resume unexpectedly requested {other:?}"),
                };
                for event in events.into_iter().chain([RuntimeEventKind::Done]) {
                    let mut bytes = serde_json::to_vec(&event).unwrap();
                    bytes.push(b'\n');
                    write.write_all(&bytes).await.unwrap();
                }
            });
        }
    });
    let binary =
        std::env::var_os("AGENT_TEST_BINARY").unwrap_or_else(|| env!("CARGO_BIN_EXE_agent").into());
    let fixture = std::path::Path::new(env!("CARGO_BIN_EXE_agent"))
        .parent()
        .unwrap()
        .join("examples/terminal-fixture");
    let mut child = Command::new(fixture)
        .arg(binary)
        .arg("--state-dir")
        .arg(directory.path())
        .arg("--config")
        .arg(config)
        .args(["chat", "/resume 1"])
        .env("TERM", "xterm-256color")
        .env("AGENT_TEST_TERMINAL_REPLY", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut output = child.stdout.take().unwrap();
    let mut bytes = Vec::new();
    timeout(Duration::from_secs(10), async {
        use tokio::io::AsyncReadExt;
        let mut chunk = [0; 4096];
        loop {
            let count = output.read(&mut chunk).await.unwrap();
            assert!(count > 0, "The TUI exited before showing saved history");
            bytes.extend_from_slice(&chunk[..count]);
            if String::from_utf8_lossy(&bytes).contains("The exact saved chat is visible.") {
                break;
            }
        }
    })
    .await
    .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"/exit\r")
        .await
        .unwrap();
    let exited = timeout(Duration::from_secs(5), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert!(
        exited.status.success(),
        "{}",
        String::from_utf8_lossy(&exited.stderr)
    );
    server.abort();
    let _ = server.await;
    assert_eq!(
        extra_pages.load(Ordering::SeqCst),
        0,
        "Exact identity lookup must stop before unrelated catalog pages"
    );
}

async fn main_history(older: bool) {
    let directory = tempfile::tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let config = directory.path().join("config.toml");
    fs::write(&config, "").unwrap();
    let listener = UnixListener::bind(directory.path().join("agent.sock")).unwrap();
    let reads = Arc::new(AtomicUsize::new(0));
    let settings_reads = Arc::new(AtomicUsize::new(0));
    let observed = reads.clone();
    let observed_settings = settings_reads.clone();
    let server = tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let observed = observed.clone();
            let observed_settings = observed_settings.clone();
            tokio::spawn(async move {
                let (reader, mut writer) = stream.into_split();
                let mut reader = FrameReader::new(BufReader::new(reader));
                let Some(bytes) = reader.next_frame().await.unwrap() else {
                    return;
                };
                let command: RuntimeCommand = serde_json::from_slice(&bytes).unwrap();
                match command {
                    RuntimeCommand::ConversationSettings {
                        task_id: None,
                        agent_id: None,
                        change: None,
                        catalog: false,
                        conversation_id: None,
                    } => {
                        observed_settings.fetch_add(1, Ordering::SeqCst);
                        let event = RuntimeEventKind::ConversationSettings {
                            settings: ConversationSettings {
                                conversation_id: "persisted-main".into(),
                                task_id: None,
                                agent_id: None,
                                model: ModelSelection::default(),
                                catalog: vec![],
                            },
                        };
                        let mut frame = serde_json::to_vec(&event).unwrap();
                        frame.push(b'\n');
                        writer.write_all(&frame).await.unwrap();
                        writer.write_all(b"{\"type\":\"done\"}\n").await.unwrap();
                    }
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
                                    final_chunk: true,
                                    tool: None,
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
                                    final_chunk: true,
                                    tool: None,
                                },
                            ],
                            next_cursor: if older {
                                None
                            } else {
                                Some("older-root-page".into())
                            },
                            page_complete: false,
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
    assert_eq!(settings_reads.load(Ordering::SeqCst), 2);
    server.abort();
    let _ = server.await;
}
