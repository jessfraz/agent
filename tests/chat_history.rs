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

#[tokio::test]
async fn disconnected_chief_reconnects_and_reconciles_accepted_input_without_resending() {
    observer_recovery(RecoveryCase::AcceptedChief).await;
}

#[tokio::test]
async fn failed_worker_attach_reconnects_and_delivers_proven_unsent_input_once() {
    observer_recovery(RecoveryCase::WaitingWorker).await;
}

#[tokio::test]
async fn uncertain_worker_input_is_not_replayed_after_automatic_reconnect() {
    observer_recovery(RecoveryCase::UncertainWorker).await;
}

#[tokio::test]
async fn permanent_observer_domain_failure_stays_an_error_without_retrying() {
    observer_recovery(RecoveryCase::PermanentChief).await;
}

#[tokio::test]
async fn repeated_control_c_detaches_while_admission_is_held_and_retains_its_original_id() {
    use agent_cli::protocol::{InputMode, SavedConversation};
    use tokio::io::AsyncReadExt;

    let directory = tempfile::tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let config = directory.path().join("config.toml");
    fs::write(&config, "").unwrap();
    let listener = UnixListener::bind(directory.path().join("agent.sock")).unwrap();
    let (admitted, mut admissions) = tokio::sync::mpsc::unbounded_channel();
    let (detached, mut detachments) = tokio::sync::mpsc::unbounded_channel();
    let (completed, mut completions) = tokio::sync::mpsc::unbounded_channel();
    let finish = Arc::new(tokio::sync::Semaphore::new(0));
    let release = finish.clone();
    let server = tokio::spawn(async move {
        let mut connections = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                socket = listener.accept() => {
                    let (socket, _) = socket.unwrap();
                    let admitted = admitted.clone();
                    let detached = detached.clone();
                    let completed = completed.clone();
                    let finish = finish.clone();
                    connections.spawn(async move {
                        let (reader, mut writer) = socket.into_split();
                        let mut reader = FrameReader::new(BufReader::new(reader));
                        let Some(bytes) = reader.next_frame().await.unwrap() else { return; };
                        let command: RuntimeCommand = serde_json::from_slice(&bytes).unwrap();
                        let summary = SavedConversation {
                            conversation_id: "saved-chief".into(), title: "Main agent".into(), updated_at: None,
                            task_id: None, agent_id: None, host: None, source_thread_id: None,
                        };
                        let events = match command {
                            RuntimeCommand::ConversationSettings { .. } => vec![RuntimeEventKind::ConversationSettings {
                                settings: ConversationSettings { conversation_id: summary.conversation_id,
                                    task_id: None, agent_id: None, model: ModelSelection::default(), catalog: vec![] },
                            }],
                            RuntimeCommand::AttachConversation { conversation_id, .. } => {
                                assert_eq!(conversation_id, summary.conversation_id);
                                write_events(&mut writer, [RuntimeEventKind::ConversationReady {
                                    conversation: summary, model: ModelSelection::default(), cwd: "/example".into(), working: false,
                                }]).await.unwrap();
                                retired_observer_closed(&mut reader).await.unwrap();
                                return;
                            }
                            RuntimeCommand::ReadConversation { conversation_id, cursor: None } => vec![RuntimeEventKind::History {
                                conversation_id, messages: vec![HistoryMessage {
                                    entry_id: "saved-answer".into(), role: HistoryRole::Final,
                                    text: "The saved chief transcript is ready.".into(), continuation: false,
                                    final_chunk: true, tool: None, presentation: None, attachments: None,
                                }], next_cursor: None, page_complete: true,
                            }],
                            RuntimeCommand::ConversationInput { conversation_id, input_id, input, mode, .. } => {
                                assert_eq!(conversation_id, summary.conversation_id);
                                assert_eq!(input, "Work retained by the coordinator");
                                assert_eq!(mode, InputMode::Steer);
                                admitted.send(input_id.clone()).unwrap();
                                // The coordinator owns this input, but its receipt has not
                                // reached the client. Closing the socket cannot stop that work.
                                retired_observer_closed(&mut reader).await.unwrap();
                                detached.send(()).unwrap();
                                finish.acquire().await.unwrap().forget();
                                completed.send(input_id).unwrap();
                                return;
                            }
                            other => panic!("Closing cannot interrupt or resubmit coordinator work: {other:?}"),
                        };
                        write_events(&mut writer, events.into_iter().chain([RuntimeEventKind::Done])).await.unwrap();
                    });
                }
                done = connections.join_next(), if !connections.is_empty() => { done.unwrap().unwrap(); }
            }
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
        .current_dir("/")
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
    let mut bytes = Vec::new();
    read_terminal_until(
        &mut output,
        &mut bytes,
        "The saved chief transcript is ready.",
    )
    .await;
    input
        .write_all(b"Work retained by the coordinator\r")
        .await
        .unwrap();
    let id = timeout(Duration::from_secs(3), admissions.recv())
        .await
        .unwrap()
        .unwrap();
    input.write_all(b"\x03").await.unwrap();
    read_terminal_until(&mut output, &mut bytes, "Closing").await;
    assert!(
        child.try_wait().unwrap().is_none(),
        "The first exit still waits for the admission receipt"
    );
    input.write_all(b"\x03").await.unwrap();
    let exited = timeout(Duration::from_secs(3), async {
        let (exited, drained) =
            tokio::join!(child.wait_with_output(), output.read_to_end(&mut bytes));
        drained.unwrap();
        exited.unwrap()
    })
    .await
    .expect(
        "A repeated Ctrl+C must close only the local client without waiting for the coordinator",
    );
    assert!(
        exited.status.success(),
        "{}",
        String::from_utf8_lossy(&exited.stderr)
    );
    timeout(Duration::from_secs(3), detachments.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(completions.try_recv().is_err());
    assert!(
        admissions.try_recv().is_err(),
        "No second input was admitted"
    );
    #[derive(serde::Deserialize)]
    #[serde(tag = "kind", rename_all = "snake_case")]
    enum Owner {
        Conversation { conversation_id: String },
    }
    #[derive(serde::Deserialize)]
    struct RetainedInput {
        id: String,
        input: agent_cli::tui::attachments::ComposerInput,
        mode: InputMode,
    }
    #[derive(serde::Deserialize)]
    struct Recovery {
        owner: Owner,
        queued_inputs: Vec<RetainedInput>,
    }
    let files = fs::read_dir(directory.path().join("recovery"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect::<Vec<_>>();
    assert_eq!(files.len(), 1);
    let recovery: Recovery = serde_json::from_slice(&fs::read(&files[0]).unwrap()).unwrap();
    assert!(
        matches!(recovery.owner, Owner::Conversation { conversation_id } if conversation_id == "saved-chief")
    );
    assert_eq!(recovery.queued_inputs.len(), 1);
    assert_eq!(recovery.queued_inputs[0].id, id);
    assert_eq!(
        recovery.queued_inputs[0].input.text,
        "Work retained by the coordinator"
    );
    assert_eq!(recovery.queued_inputs[0].mode, InputMode::Steer);
    release.add_permits(1);
    assert_eq!(
        timeout(Duration::from_secs(3), completions.recv())
            .await
            .unwrap()
            .unwrap(),
        id
    );
    server.abort();
    assert!(server.await.unwrap_err().is_cancelled());
}

#[tokio::test]
async fn known_chief_history_renders_while_its_observer_readiness_is_held() {
    use tokio::io::AsyncReadExt;
    let directory = tempfile::tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let config = directory.path().join("config.toml");
    fs::write(&config, "").unwrap();
    let listener = UnixListener::bind(directory.path().join("agent.sock")).unwrap();
    let hold = Arc::new(tokio::sync::Semaphore::new(0));
    let observation = hold.clone();
    let (ready, mut readiness) = tokio::sync::mpsc::unbounded_channel();
    let reads = Arc::new(AtomicUsize::new(0));
    let server_reads = reads.clone();
    let server = tokio::spawn(async move {
        let mut connections = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                socket = listener.accept() => {
                    let (socket, _) = socket.unwrap();
                    let hold = hold.clone(); let ready = ready.clone(); let reads = server_reads.clone();
                    connections.spawn(async move {
                        let (reader, mut writer) = socket.into_split();
                        let mut reader = FrameReader::new(BufReader::new(reader));
                        let Some(bytes) = reader.next_frame().await.unwrap() else { return; };
                        let command: RuntimeCommand = serde_json::from_slice(&bytes).unwrap();
                        let summary = RecoveryCase::AcceptedChief.summary();
                        let events = match command {
                            RuntimeCommand::ConversationSettings { .. } => vec![RuntimeEventKind::ConversationSettings {
                                settings: ConversationSettings { conversation_id: summary.conversation_id, task_id: None, agent_id: None,
                                    model: ModelSelection::default(), catalog: vec![] },
                            }],
                            RuntimeCommand::AttachConversation { conversation_id, .. } => {
                                assert_eq!(conversation_id, summary.conversation_id);
                                hold.acquire().await.unwrap().forget();
                                write_events(&mut writer, [RuntimeEventKind::ConversationReady {
                                    conversation: summary, model: ModelSelection::default(), cwd: "/example".into(), working: false,
                                }]).await.unwrap();
                                ready.send(()).unwrap();
                                retired_observer_closed(&mut reader).await.unwrap();
                                return;
                            }
                            RuntimeCommand::ReadConversation { conversation_id, cursor: None } => {
                                let mut messages = vec![HistoryMessage {
                                    entry_id: "saved-answer".into(), role: HistoryRole::Final,
                                    text: "Saved conversation text can appear before observation is ready.".into(), continuation: false,
                                    final_chunk: true, tool: None, presentation: None, attachments: None,
                                }];
                                if reads.fetch_add(1, Ordering::SeqCst) > 0 {
                                    messages.push(HistoryMessage {
                                        entry_id: "answer-during-attach".into(), role: HistoryRole::Final,
                                        text: "The entry committed during attachment remains visible.".into(), continuation: false,
                                        final_chunk: true, tool: None, presentation: None, attachments: None,
                                    });
                                }
                                vec![RuntimeEventKind::History { conversation_id, messages,
                                    next_cursor: None, page_complete: true }]
                            }
                            other => panic!("Opening saved history cannot submit model input or read a catalog: {other:?}"),
                        };
                        write_events(&mut writer, events.into_iter().chain([RuntimeEventKind::Done])).await.unwrap();
                    });
                }
                done = connections.join_next(), if !connections.is_empty() => { done.unwrap().unwrap(); }
            }
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
        .current_dir("/")
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
    let mut bytes = Vec::new();
    read_terminal_until(
        &mut output,
        &mut bytes,
        "Saved conversation text can appear before observation is ready.",
    )
    .await;
    assert!(
        readiness.try_recv().is_err(),
        "Readiness remains held while actual history is visible"
    );
    input
        .write_all(b"\x1b[200~Retained startup draft\x1b[201~")
        .await
        .unwrap();
    read_terminal_until(&mut output, &mut bytes, "Retained startup draft").await;
    observation.add_permits(1);
    timeout(Duration::from_secs(3), readiness.recv())
        .await
        .unwrap()
        .unwrap();
    read_terminal_until(
        &mut output,
        &mut bytes,
        "The entry committed during attachment remains visible.",
    )
    .await;
    assert_eq!(
        reads.load(Ordering::SeqCst),
        2,
        "The attached snapshot closes the preview's observation gap"
    );
    input.write_all(b"\x03").await.unwrap();
    let exited = timeout(Duration::from_secs(3), async {
        let (exited, drained) =
            tokio::join!(child.wait_with_output(), output.read_to_end(&mut bytes));
        drained.unwrap();
        exited.unwrap()
    })
    .await
    .unwrap();
    assert!(
        exited.status.success(),
        "{}",
        String::from_utf8_lossy(&exited.stderr)
    );
    assert_eq!(
        terminal_history_text(&bytes)
            .matches("Saved conversation text can appear before observation is ready.")
            .count(),
        1
    );
    server.abort();
    assert!(server.await.unwrap_err().is_cancelled());
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RecoveryCase {
    AcceptedChief,
    WaitingWorker,
    UncertainWorker,
    PermanentChief,
}
impl RecoveryCase {
    fn summary(self) -> agent_cli::protocol::SavedConversation {
        let worker = matches!(self, Self::WaitingWorker | Self::UncertainWorker);
        agent_cli::protocol::SavedConversation {
            conversation_id: if worker {
                "saved-worker"
            } else {
                "saved-chief"
            }
            .into(),
            title: if worker {
                "Synthetic worker"
            } else {
                "Main agent"
            }
            .into(),
            updated_at: None,
            task_id: worker.then(|| "33333333-3333-4333-8333-333333333333".parse().unwrap()),
            agent_id: None,
            host: worker.then(|| "Synthetic machine".into()),
            source_thread_id: None,
        }
    }
}

#[derive(Debug)]
struct ObservedInput {
    id: String,
    text: String,
    mode: agent_cli::protocol::InputMode,
    placed: bool,
}

async fn write_events(
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    events: impl IntoIterator<Item = RuntimeEventKind>,
) -> std::io::Result<()> {
    let mut bytes = Vec::new();
    for event in events {
        serde_json::to_writer(&mut bytes, &event).unwrap();
        bytes.push(b'\n');
    }
    writer.write_all(&bytes).await
}

async fn retired_observer_closed<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut FrameReader<R>,
) -> anyhow::Result<()> {
    match reader.next_frame().await {
        Ok(None) => Ok(()),
        // A retiring client can close with unread readiness. Linux reports a
        // reset for that close; other framing failures must still fail the test.
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::ConnectionReset) =>
        {
            Ok(())
        }
        Ok(Some(_)) => anyhow::bail!("A retired observer sent another frame"),
        Err(error) => Err(error),
    }
}

#[derive(Clone)]
struct RecoveryEndpoint {
    disconnect: Arc<tokio::sync::Semaphore>,
    recover: Arc<tokio::sync::Semaphore>,
    lose_receipt: Arc<tokio::sync::Semaphore>,
    attached: Arc<AtomicUsize>,
    inputs: Arc<tokio::sync::Mutex<Vec<ObservedInput>>>,
    queried: Arc<tokio::sync::Mutex<Vec<Vec<String>>>>,
}

async fn recovery_connection(
    socket: tokio::net::UnixStream,
    case: RecoveryCase,
    endpoint: RecoveryEndpoint,
) {
    let RecoveryEndpoint {
        disconnect,
        recover,
        lose_receipt,
        attached,
        inputs,
        queried,
    } = endpoint;
    let (reader, mut writer) = socket.into_split();
    let mut reader = FrameReader::new(BufReader::new(reader));
    let Some(bytes) = reader.next_frame().await.unwrap() else {
        return;
    };
    let command: RuntimeCommand = serde_json::from_slice(&bytes).unwrap();
    let summary = case.summary();
    let events = match command {
        RuntimeCommand::ConversationSettings { .. } => {
            vec![RuntimeEventKind::ConversationSettings {
                settings: ConversationSettings {
                    conversation_id: "saved-chief".into(),
                    task_id: None,
                    agent_id: None,
                    model: ModelSelection::default(),
                    catalog: vec![],
                },
            }]
        }
        RuntimeCommand::ListConversations { query, .. } => {
            assert_eq!(query, summary.conversation_id);
            vec![RuntimeEventKind::Conversations {
                items: vec![summary],
                next_cursor: None,
            }]
        }
        RuntimeCommand::AttachConversation {
            conversation_id,
            input_ids,
        } => {
            if conversation_id == "saved-chief" && summary.conversation_id == "saved-worker" {
                // /resume can retire the old view before its first ready
                // response. Exercise that ordering, not a favorable race.
                retired_observer_closed(&mut reader).await.unwrap();
                let late_ready = write_events(
                    &mut writer,
                    [RuntimeEventKind::ConversationReady {
                        conversation: RecoveryCase::AcceptedChief.summary(),
                        model: ModelSelection::default(),
                        cwd: "/example".into(),
                        working: false,
                    }],
                )
                .await;
                if let Err(error) = late_ready {
                    assert!(
                        matches!(
                            error.kind(),
                            std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset
                        ),
                        "Retired observer failed for another reason: {error}"
                    );
                }
                return;
            }
            assert_eq!(conversation_id, summary.conversation_id);
            let index = attached.fetch_add(1, Ordering::SeqCst);
            queried.lock().await.push(input_ids.clone());
            if case == RecoveryCase::PermanentChief {
                disconnect.acquire().await.unwrap().forget();
                write_events(
                    &mut writer,
                    [
                        RuntimeEventKind::Failure {
                            code: agent_cli::protocol::ErrorCode::InvalidRequest,
                            message: "Synthetic saved conversation was removed.".into(),
                        },
                        RuntimeEventKind::Done,
                    ],
                )
                .await
                .unwrap();
                return;
            }
            if index == 0 && case == RecoveryCase::WaitingWorker {
                disconnect.acquire().await.unwrap().forget();
                return;
            }
            if index > 0 {
                recover.acquire().await.unwrap().forget();
            }
            write_events(
                &mut writer,
                [RuntimeEventKind::ConversationReady {
                    conversation: summary,
                    model: ModelSelection::default(),
                    cwd: "/example".into(),
                    working: index == 0,
                }],
            )
            .await
            .unwrap();
            if index == 0 {
                disconnect.acquire().await.unwrap().forget();
                if case == RecoveryCase::UncertainWorker {
                    writer.write_all(b"{\"type\":\"message\"").await.unwrap();
                }
            } else {
                let known = inputs.lock().await;
                let mut receipts = Vec::new();
                for input in known
                    .iter()
                    .filter(|input| input.placed && input_ids.contains(&input.id))
                {
                    receipts.push(RuntimeEventKind::InputAccepted {
                        input_id: input.id.clone(),
                    });
                    receipts.push(RuntimeEventKind::InputPlaced {
                        input_id: input.id.clone(),
                        entry_id: format!("native-{}", input.id),
                    });
                }
                drop(known);
                receipts.push(RuntimeEventKind::Message {
                    message: HistoryMessage {
                        presentation: None,
                        entry_id: "recovered-answer".into(),
                        role: HistoryRole::Final,
                        text: "Automatic recovery is ready.".into(),
                        continuation: false,
                        final_chunk: true,
                        tool: None,
                        attachments: None,
                    },
                });
                write_events(&mut writer, receipts).await.unwrap();
                assert!(reader.next_frame().await.unwrap().is_none());
            }
            return;
        }
        RuntimeCommand::ReadConversation {
            conversation_id, ..
        } => {
            if conversation_id == "saved-chief" && summary.conversation_id == "saved-worker" {
                write_events(
                    &mut writer,
                    [
                        RuntimeEventKind::History {
                            conversation_id,
                            messages: vec![],
                            next_cursor: None,
                            page_complete: true,
                        },
                        RuntimeEventKind::Done,
                    ],
                )
                .await
                .unwrap();
                return;
            }
            assert_eq!(conversation_id, summary.conversation_id);
            let messages = inputs
                .lock()
                .await
                .iter()
                .filter(|input| input.placed)
                .map(|input| HistoryMessage {
                    presentation: None,
                    entry_id: format!("native-{}", input.id),
                    role: HistoryRole::User,
                    text: input.text.clone(),
                    continuation: false,
                    final_chunk: true,
                    tool: None,
                    attachments: None,
                })
                .collect();
            vec![RuntimeEventKind::History {
                conversation_id,
                messages,
                next_cursor: None,
                page_complete: true,
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
            let initial = input == "One owned execution";
            let unknown = case == RecoveryCase::UncertainWorker && initial;
            let mut known = inputs.lock().await;
            assert!(
                known.iter().all(|existing| existing.id != input_id),
                "A reconnect must never resend an already written input identity"
            );
            known.push(ObservedInput {
                id: input_id.clone(),
                text: input,
                mode,
                placed: !unknown,
            });
            drop(known);
            if unknown {
                lose_receipt.acquire().await.unwrap().forget();
                return;
            }
            let mut receipts = vec![RuntimeEventKind::InputAccepted {
                input_id: input_id.clone(),
            }];
            // The first chief input is durable, but its view misses placement.
            if !initial || case != RecoveryCase::AcceptedChief {
                receipts.push(RuntimeEventKind::InputPlaced {
                    entry_id: format!("native-{input_id}"),
                    input_id,
                });
            }
            receipts
        }
        other => panic!("Observer recovery unexpectedly requested {other:?}"),
    };
    write_events(
        &mut writer,
        events.into_iter().chain([RuntimeEventKind::Done]),
    )
    .await
    .unwrap();
}

async fn observer_recovery(case: RecoveryCase) {
    use agent_cli::protocol::InputMode;
    let directory = tempfile::tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let config = directory.path().join("config.toml");
    fs::write(&config, "").unwrap();
    let listener = UnixListener::bind(directory.path().join("agent.sock")).unwrap();
    let disconnect = Arc::new(tokio::sync::Semaphore::new(0));
    let recover = Arc::new(tokio::sync::Semaphore::new(0));
    let lose_receipt = Arc::new(tokio::sync::Semaphore::new(0));
    let attached = Arc::new(AtomicUsize::new(0));
    let inputs = Arc::new(tokio::sync::Mutex::new(Vec::<ObservedInput>::new()));
    let queried = Arc::new(tokio::sync::Mutex::new(Vec::<Vec<String>>::new()));
    let fixture = RecoveryEndpoint {
        disconnect: disconnect.clone(),
        recover: recover.clone(),
        lose_receipt: lose_receipt.clone(),
        attached: attached.clone(),
        inputs: inputs.clone(),
        queried: queried.clone(),
    };
    let server = tokio::spawn(async move {
        let mut connections = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    let (socket, _) = accepted.unwrap();
                    connections.spawn(recovery_connection(socket, case, fixture.clone()));
                }
                finished = connections.join_next(), if !connections.is_empty() => { finished.unwrap().unwrap(); }
            }
        }
    });
    let binary =
        std::env::var_os("AGENT_TEST_BINARY").unwrap_or_else(|| env!("CARGO_BIN_EXE_agent").into());
    let fixture = std::path::Path::new(env!("CARGO_BIN_EXE_agent"))
        .parent()
        .unwrap()
        .join("examples/terminal-fixture");
    let mut command = Command::new(fixture);
    command
        .arg(binary)
        .arg("--state-dir")
        .arg(directory.path())
        .arg("--config")
        .arg(config)
        .arg("chat");
    if matches!(
        case,
        RecoveryCase::WaitingWorker | RecoveryCase::UncertainWorker
    ) {
        command.arg("/resume saved-worker");
    }
    let mut child = command
        .current_dir("/")
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
    let mut bytes = Vec::new();
    read_terminal_until(&mut output, &mut bytes, "Ask Agent to do anything").await;
    if matches!(
        case,
        RecoveryCase::WaitingWorker | RecoveryCase::UncertainWorker
    ) {
        timeout(Duration::from_secs(3), async {
            while attached.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        // The socket can attach while the renderer still applies the previous
        // chief view's reset. Type only after this target owns the terminal.
        read_terminal_observation(
            &mut output,
            &mut bytes,
            "the selected worker title",
            |bytes| terminal_title(bytes).starts_with("Synthetic worker |"),
        )
        .await;
    }
    if case == RecoveryCase::PermanentChief {
        input
            .write_all(b"\x1b[200~A retained draft\x1b[201~")
            .await
            .unwrap();
        read_terminal_until(&mut output, &mut bytes, "A retained draft").await;
        disconnect.add_permits(1);
        read_terminal_observation(
            &mut output,
            &mut bytes,
            "the permanent error and retained editor draft",
            |bytes| {
                let visible = terminal_text(bytes);
                visible.contains("Synthetic saved conversation was removed.")
                    && visible.contains("A retained draft")
            },
        )
        .await;
        assert!(!terminal_text(&bytes).contains("Reconnecting"));
        assert!(terminal_text(&bytes).contains("A retained draft"));
        close_observer(child, &mut input, &mut output, &mut bytes).await;
        assert_eq!(attached.load(Ordering::SeqCst), 1);
        assert!(inputs.lock().await.is_empty());
        server.abort();
        assert!(server.await.unwrap_err().is_cancelled());
        return;
    }
    if case != RecoveryCase::WaitingWorker {
        read_terminal_until(&mut output, &mut bytes, "Working").await;
    }
    input.write_all(b"One owned execution\r").await.unwrap();
    if case == RecoveryCase::WaitingWorker {
        read_terminal_until(&mut output, &mut bytes, "Sending steering messages").await;
        assert!(inputs.lock().await.is_empty());
    } else {
        timeout(Duration::from_secs(3), async {
            while inputs.lock().await.is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    if case == RecoveryCase::AcceptedChief {
        read_terminal_until(&mut output, &mut bytes, "Steering messages, waiting").await;
    }
    input
        .write_all(b"\x1b[200~A retained draft\x1b[201~")
        .await
        .unwrap();
    read_terminal_until(&mut output, &mut bytes, "A retained draft").await;
    disconnect.add_permits(1);
    read_terminal_until(&mut output, &mut bytes, "Reconnecting").await;
    assert!(!terminal_text(&bytes).contains("Code: internal"));
    assert!(terminal_text(&bytes).contains("A retained draft"));
    input.write_all(&[0x7f; 16]).await.unwrap();
    input.write_all(b"Offline correction\r").await.unwrap();
    input.write_all(b"Separate queued turn\t").await.unwrap();
    read_terminal_until(&mut output, &mut bytes, "Separate queued turn").await;
    input
        .write_all(b"\x1b[200~A retained draft\x1b[201~")
        .await
        .unwrap();
    read_terminal_until(&mut output, &mut bytes, "A retained draft").await;
    timeout(Duration::from_secs(3), async {
        while attached.load(Ordering::SeqCst) < 2 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    if case == RecoveryCase::UncertainWorker {
        // The old input socket can fail after observer recovery has begun.
        // Its late failure must not retire the replacement attachment.
        lose_receipt.add_permits(1);
    }
    assert_eq!(
        inputs.lock().await.len(),
        usize::from(case != RecoveryCase::WaitingWorker)
    );
    recover.add_permits(1);
    read_terminal_until(&mut output, &mut bytes, "Automatic recovery is ready.").await;
    timeout(Duration::from_secs(3), async {
        while inputs.lock().await.len() < 3 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let observed = inputs.lock().await;
    assert_eq!(observed.len(), 3);
    for (text, mode) in [
        ("One owned execution", InputMode::Steer),
        ("Offline correction", InputMode::Steer),
        ("Separate queued turn", InputMode::FollowUp),
    ] {
        assert_eq!(
            observed
                .iter()
                .filter(|input| input.text == text && input.mode == mode)
                .count(),
            1,
            "Unexpected native inputs: {observed:?}"
        );
    }
    if case != RecoveryCase::WaitingWorker {
        assert!(
            queried.lock().await[1].contains(&observed[0].id),
            "Reattach must reconcile the original written input identity"
        );
    }
    drop(observed);
    read_terminal_until(&mut output, &mut bytes, "A retained draft").await;
    let recovered = terminal_history_text(&bytes);
    assert!(
        !recovered.contains("Reconnecting"),
        "Recovery progress must never become a saved transcript row: {recovered}"
    );
    if case != RecoveryCase::UncertainWorker {
        assert!(!recovered.contains("Coordinator connection lost"));
    }
    assert!(!recovered.contains("Unsent input returned to the draft"));
    assert_eq!(attached.load(Ordering::SeqCst), 2);
    // Readback of the next native input proves the editor draft survived,
    // independently of incremental terminal repaint boundaries.
    input.write_all(b"\r").await.unwrap();
    timeout(Duration::from_secs(3), async {
        while inputs.lock().await.len() < 4 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let observed = inputs.lock().await;
    assert_eq!(observed.len(), 4);
    assert_eq!(observed[3].text, "A retained draft");
    assert_eq!(observed[3].mode, InputMode::Steer);
    drop(observed);
    close_observer(child, &mut input, &mut output, &mut bytes).await;
    assert_eq!(
        inputs.lock().await.len(),
        4,
        "Closing the client cannot replay uncertain or accepted input"
    );
    server.abort();
    assert!(server.await.unwrap_err().is_cancelled());
}

async fn close_observer(
    child: tokio::process::Child,
    input: &mut tokio::process::ChildStdin,
    output: &mut tokio::process::ChildStdout,
    bytes: &mut Vec<u8>,
) {
    input.write_all(b"\x03").await.unwrap();
    let exited = timeout(Duration::from_secs(3), async {
        use tokio::io::AsyncReadExt;
        let (exited, drained) = tokio::join!(child.wait_with_output(), output.read_to_end(bytes));
        drained.unwrap();
        exited.unwrap()
    })
    .await
    .unwrap();
    assert!(
        exited.status.success(),
        "{}",
        String::from_utf8_lossy(&exited.stderr)
    );
}

fn terminal_history_text(bytes: &[u8]) -> String {
    let mut terminal = vt100::Parser::new(
        std::num::NonZeroU16::new(32).unwrap(),
        std::num::NonZeroU16::new(100).unwrap(),
        1_000,
    );
    terminal.process(bytes);
    let mut formatted = String::new();
    terminal
        .screen()
        .write_contents_formatted_basic(
            &mut formatted,
            vt100::capture::BasicFormattedCaptureRange::Full(&mut Default::default()),
        )
        .unwrap();
    vt100::capture::basic_formatted_to_plain(&formatted).collect()
}

async fn read_terminal_until(
    output: &mut tokio::process::ChildStdout,
    bytes: &mut Vec<u8>,
    expected: &str,
) {
    let needle = expected
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect::<String>();
    read_terminal_observation(output, bytes, expected, |bytes| {
        terminal_text(bytes)
            .chars()
            .filter(|ch| !ch.is_whitespace())
            .collect::<String>()
            .contains(&needle)
    })
    .await;
}

fn terminal_title(bytes: &[u8]) -> String {
    #[derive(Default)]
    struct Title(String);
    impl vt100::Callbacks for Title {
        fn set_window_title(&mut self, _: &mut vt100::Screen, title: &[u8]) {
            self.0 = String::from_utf8(title.to_vec()).unwrap();
        }
    }
    let mut terminal = vt100::Parser::new_with_callbacks(
        std::num::NonZeroU16::new(32).unwrap(),
        std::num::NonZeroU16::new(100).unwrap(),
        0,
        Title::default(),
    );
    terminal.process(bytes);
    terminal.callbacks().0.clone()
}

async fn read_terminal_observation(
    output: &mut tokio::process::ChildStdout,
    bytes: &mut Vec<u8>,
    expected: &str,
    observed: impl Fn(&[u8]) -> bool,
) {
    use tokio::io::AsyncReadExt;
    timeout(Duration::from_secs(3), async {
        let mut chunk = [0; 4096];
        while !observed(bytes) {
            let count = output.read(&mut chunk).await.unwrap();
            assert!(
                count > 0,
                "Terminal closed before {expected}: {}",
                terminal_text(bytes)
            );
            bytes.extend_from_slice(&chunk[..count]);
        }
    })
    .await
    .unwrap_or_else(|error| {
        panic!(
            "Terminal did not show {expected}: {error}: {}",
            terminal_text(bytes)
        )
    });
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
                                presentation: None,
                                attachments: None,
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
        while !String::from_utf8_lossy(&bytes).contains("Ask Agent to do anything") {
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
        struct RecoveryInput {
            id: String,
            input: agent_cli::tui::attachments::ComposerInput,
            mode: agent_cli::protocol::InputMode,
        }
        #[derive(serde::Deserialize)]
        struct Recovery {
            owner: Owner,
            draft: agent_cli::tui::attachments::ComposerInput,
            queued_inputs: Vec<RecoveryInput>,
        }
        let saved = fs::read_dir(directory.path().join("recovery"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>();
        assert_eq!(saved.len(), 1);
        let recovery: Recovery = serde_json::from_slice(&fs::read(&saved[0]).unwrap()).unwrap();
        assert!(matches!(recovery.owner, Owner::Main));
        assert_eq!(recovery.draft, "A partial draft".into());
        let initial = if matches!(mode, ChiefStartup::Exit) {
            "Do the initial CLI request"
        } else {
            "/resume retained-target"
        };
        assert_eq!(
            recovery
                .queued_inputs
                .iter()
                .map(|queued| queued.input.text.as_str())
                .collect::<Vec<_>>(),
            [initial, "An early request", "A later request"]
        );
        assert_eq!(
            recovery
                .queued_inputs
                .iter()
                .map(|queued| queued.mode)
                .collect::<Vec<_>>(),
            [
                agent_cli::protocol::InputMode::Steer,
                agent_cli::protocol::InputMode::Steer,
                agent_cli::protocol::InputMode::FollowUp
            ]
        );
        let ids = recovery
            .queued_inputs
            .iter()
            .map(|queued| {
                let id = uuid::Uuid::parse_str(&queued.id).unwrap();
                assert!(!id.is_nil());
                assert!(queued.input.files.is_empty());
                assert!(queued.input.attachments.is_empty());
                id
            })
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(ids.len(), recovery.queued_inputs.len());
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
    // Match the existing PTY fixture's actual geometry. Cursor movement and
    // clearing determine the visible text; concatenated repaint bytes do not.
    let mut terminal = vt100::Parser::new(
        std::num::NonZeroU16::new(32).unwrap(),
        std::num::NonZeroU16::new(100).unwrap(),
        0,
    );
    terminal.process(bytes);
    terminal.screen().contents()
}

#[test]
fn terminal_observations_apply_native_cursor_redraws_and_do_not_keep_overwritten_text() {
    use crossterm::{
        cursor::MoveTo,
        queue,
        style::Print,
        terminal::{Clear, ClearType},
    };
    let mut frames = Vec::new();
    queue!(frames, MoveTo(4, 31), Print("Connecting")).unwrap();
    // A terminal diff reuses unchanged cells instead of printing the whole
    // new label. These are native cursor/print commands, not stripped prose.
    queue!(
        frames,
        MoveTo(1, 31),
        Print("Disc"),
        MoveTo(11, 31),
        Print("ed"),
        Clear(ClearType::UntilNewLine)
    )
    .unwrap();
    assert!(terminal_text(&frames).contains("Disconnected"));
    queue!(
        frames,
        MoveTo(0, 31),
        Print("Ready"),
        Clear(ClearType::UntilNewLine)
    )
    .unwrap();
    let visible = terminal_text(&frames);
    assert!(visible.contains("Ready"));
    assert!(!visible.contains("Disconnected"));
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
    use tokio::io::AsyncReadExt;
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
                                presentation: None,
                                attachments: None,
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
    let exited = timeout(Duration::from_secs(5), async {
        // The PTY carries both CLI stdout and stderr. Keep draining its taken
        // output through exit so rendering cannot block the terminal driver.
        let (exited, drained) =
            tokio::join!(child.wait_with_output(), output.read_to_end(&mut bytes));
        drained.unwrap();
        exited.unwrap()
    })
    .await
    .unwrap();
    assert!(
        exited.status.success(),
        "PTY: {}\nFixture stderr: {}",
        terminal_text(&bytes),
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
                                    presentation: None,
                                    attachments: None,
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
                                    presentation: None,
                                    attachments: None,
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

#[tokio::test]
async fn retired_observer_close_accepts_native_reset_without_hiding_frames_or_truncation() {
    use std::io::ErrorKind;
    use tokio::net::{TcpListener, TcpStream, UnixStream};

    async fn reset_reader() -> FrameReader<BufReader<TcpStream>> {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        let (mut server, _) = listener.accept().await.unwrap();
        server
            .write_all(b"Unread observer readiness\n")
            .await
            .unwrap();
        client.set_zero_linger().unwrap();
        drop(client);
        FrameReader::new(BufReader::new(server))
    }

    // A retiring client can abandon unread readiness. Linux Unix sockets report
    // reset rather than EOF; native TCP abortive close reproduces that error on
    // both supported platforms without depending on scheduler timing.
    let error = reset_reader().await.next_frame().await.unwrap_err();
    assert_eq!(
        error.downcast_ref::<std::io::Error>().unwrap().kind(),
        ErrorKind::ConnectionReset
    );
    timeout(
        Duration::from_secs(3),
        retired_observer_closed(&mut reset_reader().await),
    )
    .await
    .unwrap()
    .unwrap();

    let (peer, socket) = UnixStream::pair().unwrap();
    drop(peer);
    retired_observer_closed(&mut FrameReader::new(BufReader::new(socket)))
        .await
        .unwrap();

    for frame in [b"{}\n".as_slice(), b"{".as_slice()] {
        let (mut peer, socket) = UnixStream::pair().unwrap();
        peer.write_all(frame).await.unwrap();
        drop(peer);
        let error = retired_observer_closed(&mut FrameReader::new(BufReader::new(socket)))
            .await
            .unwrap_err();
        if frame.ends_with(b"\n") {
            assert!(
                error
                    .to_string()
                    .contains("A retired observer sent another frame")
            );
        } else {
            assert_eq!(
                error.downcast_ref::<std::io::Error>().unwrap().kind(),
                ErrorKind::UnexpectedEof
            );
        }
    }
}
