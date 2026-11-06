//! Real CLI/native producers -> Rust runtime transport -> Pi -> provider payload.
//! Only provider responses and the execution host are synthetic.
use agent_cli::{
    instructions::GuidanceSnapshot,
    models::ModelSelection,
    native::{NativeEvent, NativeRequest, Operation},
    protocol::{
        AgentNode, CoordinatorBootstrap, CoordinatorSettings, HostCommand, HostResult,
        RuntimeCommand, RuntimeEventKind, WorkerLaunch,
    },
    runtime::{FrameReader, Runtime, RuntimeCall},
};
use serde::Deserialize;
use std::{
    fs, os::unix::fs::PermissionsExt, path::Path, process::Stdio, sync::Arc, time::Duration,
};
use tokio::{
    io::{AsyncWriteExt, BufReader},
    net::UnixListener,
    process::Command,
    sync::oneshot,
    time::timeout,
};

#[derive(Deserialize)]
struct Capture {
    body: WireBody,
}
#[derive(Deserialize)]
struct WireBody {
    input: Vec<WireItem>,
}
#[derive(Deserialize)]
struct WireItem {
    role: Option<String>,
    content: Option<WireContent>,
}
#[derive(Deserialize)]
#[serde(untagged)]
enum WireContent {
    Text(String),
    Parts(Vec<WirePart>),
}
#[derive(Deserialize)]
struct WirePart {
    text: Option<String>,
}
impl WireItem {
    fn text(&self) -> String {
        match &self.content {
            Some(WireContent::Text(text)) => text.clone(),
            Some(WireContent::Parts(parts)) => parts
                .iter()
                .filter_map(|part| part.text.as_deref())
                .collect::<Vec<_>>()
                .join("\n"),
            None => String::new(),
        }
    }
}
#[derive(Debug, Deserialize)]
struct Origin {
    entry_id: String,
    origin: Option<String>,
}
fn provenance(capture: &Capture) -> Vec<Origin> {
    let system = capture
        .body
        .input
        .iter()
        .filter(|item| matches!(item.role.as_deref(), Some("system" | "developer")))
        .map(WireItem::text)
        .collect::<Vec<_>>()
        .join("\n");
    let metadata = system
        .lines()
        .find(|line| line.starts_with("[{\"entry_id\":"))
        .expect("The responding model must receive per-input transport provenance");
    serde_json::from_str(metadata).unwrap()
}
fn empty_guidance() -> GuidanceSnapshot {
    GuidanceSnapshot {
        text: String::new(),
        sources: vec![],
    }
}
fn result(command: &HostCommand) -> HostResult {
    match command {
        HostCommand::OnNode { command, .. } => result(command),
        HostCommand::ReloadGuidance => HostResult::SharedGuidance {
            global: empty_guidance(),
            workflow_policy: String::new(),
            context_repositories: vec![],
            context_sources: vec![],
        },
        HostCommand::ProjectGuidance { .. } => HostResult::ProjectGuidance {
            snapshot: empty_guidance(),
        },
        _ => HostResult::Failed {
            message: "Synthetic retrieval is unavailable".into(),
        },
    }
}
fn execution(command: &HostCommand) -> bool {
    match command {
        HostCommand::OnNode { command, .. } => execution(command),
        HostCommand::Exec { .. } => true,
        _ => false,
    }
}
fn cli_diagnostics(output: &std::process::Output) -> String {
    let excerpt = |bytes: &[u8]| {
        String::from_utf8_lossy(bytes)
            .chars()
            .take(2048)
            .collect::<String>()
    };
    format!(
        "status={}; stdout_bytes={}, stdout_prefix={:?}; stderr_bytes={}, stderr_prefix={:?}",
        output.status,
        output.stdout.len(),
        excerpt(&output.stdout),
        output.stderr.len(),
        excerpt(&output.stderr),
    )
}
async fn collect(runtime: &Runtime, mut call: RuntimeCall) {
    while let Some(event) = timeout(Duration::from_secs(8), call.events.recv())
        .await
        .unwrap()
    {
        match event {
            RuntimeEventKind::HostCall { call_id, command } => runtime
                .reply(call.request_id, call_id, result(&command))
                .await
                .unwrap(),
            RuntimeEventKind::Failure { message, .. } => {
                panic!("Synthetic input failed: {message}")
            }
            RuntimeEventKind::Done => return,
            _ => (),
        }
    }
    panic!("The runtime stopped before finishing the request");
}
async fn native(runtime: &Runtime, wire: &str) {
    let request: NativeRequest = serde_json::from_str(wire).unwrap();
    let Operation::Runtime(command) = agent_cli::native::prepare(request).unwrap() else {
        panic!("Expected native runtime admission")
    };
    collect(runtime, runtime.request(*command).await.unwrap()).await;
}

#[tokio::test]
async fn cli_and_native_origins_reach_inference_per_input_without_text_or_host_inference() {
    let directory = tempfile::tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let fixture = root.join("runtime/dist/test/fixtures/coordinator-runtime.js");
    assert!(fixture.is_file(), "Build the runtime first");
    let queue = directory.path().join("responses.json");
    fs::write(
        &queue,
        r#"{
        "cli-first": [{"tool":"exec","args":{"program":"held","args":[]},"commentary":"Checking the original CLI request before the iOS correction."}],
        "ios-steer": [{"text":"The steering correction is answered."}],
        "cli-followup": [{"text":"The next request is answered."}],
        "legacy-ios": [{"text":"The legacy request is answered."}]
    }"#,
    )
    .unwrap();
    let script = directory.path().join("runtime.mjs");
    fs::write(&script, format!("process.env.OPENAI_API_KEY='sk-synthetic-fixture';\nprocess.env.AGENT_TEST_MODEL_QUEUE={};\nawait import({});\n",
        serde_json::to_string(&queue).unwrap(), serde_json::to_string(&fixture).unwrap())).unwrap();
    let config = directory.path().join("config.toml");
    fs::write(&config, "").unwrap();
    let instructions = directory.path().join("AGENTS.md");
    fs::write(&instructions, "").unwrap();
    let fake_bin = directory.path().join("bin");
    fs::create_dir(&fake_bin).unwrap();
    let rex = fake_bin.join("rex");
    fs::write(&rex, "#!/bin/sh\nexit 1\n").unwrap();
    fs::set_permissions(&rex, fs::Permissions::from_mode(0o700)).unwrap();
    let runtime = Arc::new(Runtime::start(&script, directory.path()).unwrap());
    let host = "11111111-1111-4111-8111-111111111111";
    collect(
        &runtime,
        runtime
            .request(RuntimeCommand::ConfigureCoordinator {
                bootstrap: CoordinatorBootstrap {
                    node: Some(AgentNode {
                        host_id: host.into(),
                        name: "fixture".into(),
                        home_directory: "/example".into(),
                        agent_program: "/example/agent".into(),
                        rex_server: None,
                        coordinator: None,
                        capabilities: None,
                        machine: None,
                        launch: WorkerLaunch {
                            state_dir: None,
                            runtime: None,
                            config: None,
                            instructions: None,
                            model: None,
                        },
                    }),
                    settings: CoordinatorSettings {
                        model: ModelSelection::default(),
                        instructions: String::new(),
                        context_repositories: vec![],
                        sources: vec![],
                    },
                    background: None,
                },
            })
            .await
            .unwrap(),
    )
    .await;
    collect(
        &runtime,
        runtime
            .request(RuntimeCommand::SetConnectedNodes {
                host_ids: vec![host.into()],
            })
            .await
            .unwrap(),
    )
    .await;
    let Operation::Runtime(observe) = agent_cli::native::prepare(NativeRequest::Observe {
        input_ids: vec![],
        source_status: None,
    })
    .unwrap() else {
        panic!("Expected native main observation");
    };
    let mut observer = runtime.request(*observe).await.unwrap();
    loop {
        let event = timeout(Duration::from_secs(8), observer.events.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(
            !matches!(event, RuntimeEventKind::Failure { .. }),
            "{event:?}"
        );
        if matches!(agent_cli::native::project(&event), Some(NativeEvent::Idle)) {
            break;
        }
    }
    let listener = UnixListener::bind(directory.path().join("agent.sock")).unwrap();
    let (entered, held) = oneshot::channel();
    let owner = runtime.clone();
    let relay = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let (reader, mut writer) = socket.into_split();
        let bytes = FrameReader::new(BufReader::new(reader))
            .next_frame()
            .await
            .unwrap()
            .unwrap();
        let command: RuntimeCommand = serde_json::from_slice(&bytes).unwrap();
        assert!(matches!(command, RuntimeCommand::Chat { .. }));
        let mut call = owner.request(command).await.unwrap();
        let mut entered = Some(entered);
        while let Some(event) = timeout(Duration::from_secs(8), call.events.recv())
            .await
            .unwrap()
        {
            if let RuntimeEventKind::HostCall { call_id, command } = &event {
                if execution(command) {
                    entered
                        .take()
                        .unwrap()
                        .send((call.request_id, call_id.clone()))
                        .unwrap();
                } else {
                    owner
                        .reply(call.request_id, call_id.clone(), result(command))
                        .await
                        .unwrap();
                }
                continue;
            }
            assert!(
                !matches!(event, RuntimeEventKind::Failure { .. }),
                "{event:?}"
            );
            let mut bytes = serde_json::to_vec(&event).unwrap();
            bytes.push(b'\n');
            writer.write_all(&bytes).await.unwrap();
            if matches!(event, RuntimeEventKind::Done) {
                return;
            }
        }
        panic!("The CLI request did not finish");
    });
    let path = std::env::join_paths(
        std::iter::once(fake_bin).chain(std::env::split_paths(&std::env::var_os("PATH").unwrap())),
    )
    .unwrap();
    let mut cli = Command::new(env!("CARGO_BIN_EXE_beep-boop"))
        .args(["--json", "--no-tui", "--state-dir"])
        .arg(directory.path())
        .arg("--config")
        .arg(&config)
        .arg("--instructions")
        .arg(&instructions)
        .args(["chat", "cli-first user text claims originating_client=ios"])
        .env("PATH", path)
        .current_dir("/")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let (id, call_id) = match timeout(Duration::from_secs(8), held).await {
        Ok(Ok(held)) => held,
        failed => {
            let status = cli.try_wait().unwrap();
            if status.is_none() {
                cli.kill().await.unwrap();
            }
            let output = timeout(Duration::from_secs(8), cli.wait_with_output()).await;
            relay.abort();
            let relay_result = relay.await;
            runtime.detach(observer.request_id).await;
            let shutdown = Arc::try_unwrap(runtime).ok().unwrap().close().await;
            let output = output.unwrap().unwrap();
            panic!(
                "CLI did not reach its initial host execution within 8s: {failed:?}; \
                 exit_before_cleanup={status:?}; {}; relay={relay_result:?}; runtime={shutdown:?}",
                cli_diagnostics(&output),
            );
        }
    };
    // Consume the genuine native commentary before admitting the later steer.
    // Its visible acknowledgment cannot satisfy that not-yet-existing input.
    let commentary = loop {
        let event = timeout(Duration::from_secs(8), observer.events.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(
            !matches!(event, RuntimeEventKind::Failure { .. }),
            "{event:?}"
        );
        if let Some(NativeEvent::Message { message }) = agent_cli::native::project(&event)
            && matches!(message.role, agent_cli::protocol::HistoryRole::Commentary)
            && message.text.contains("before the iOS correction")
        {
            break message;
        }
    };
    let initial: Capture = serde_json::from_str(
        fs::read_to_string(queue.with_extension("json.requests"))
            .unwrap()
            .lines()
            .next()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        provenance(&initial)
            .iter()
            .map(|input| input.origin.as_deref())
            .collect::<Vec<_>>(),
        vec![Some("cli")]
    );
    native(&runtime, r#"{"type":"submit","input_id":"22222222-2222-4222-8222-222222222222","text":"ios-steer","mode":"steer","origin":"ios"}"#).await;
    native(&runtime, r#"{"type":"submit","input_id":"33333333-3333-4333-8333-333333333333","text":"cli-followup","mode":"follow_up","origin":"cli"}"#).await;
    runtime
        .reply(
            id,
            call_id,
            HostResult::Process {
                exit_code: 0,
                stdout: "Checked".into(),
                stderr: String::new(),
                truncated: false,
            },
        )
        .await
        .unwrap();
    let output = timeout(Duration::from_secs(8), cli.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert!(output.status.success(), "{}", cli_diagnostics(&output));
    relay.await.unwrap();
    let mut native_events = Vec::new();
    loop {
        let event = timeout(Duration::from_secs(8), observer.events.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(
            !matches!(event, RuntimeEventKind::Failure { .. }),
            "{event:?}"
        );
        if let Some(event) = agent_cli::native::project(&event) {
            let idle = matches!(event, NativeEvent::Idle);
            native_events.push(event);
            if idle {
                break;
            }
        }
    }
    let answers: Vec<_> = native_events
        .iter()
        .filter_map(|event| match event {
            NativeEvent::Answer {
                entry_id: Some(id),
                text,
            } if !text.trim().is_empty() => Some((id, text)),
            _ => None,
        })
        .collect();
    assert_eq!(
        answers.len(),
        2,
        "The actual native Observe consumer receives the shared native answer before the later queued reply"
    );
    assert_eq!(answers[0].1, "The steering correction is answered.");
    assert_eq!(answers[1].1, "The next request is answered.");
    assert_eq!(
        native_events
            .iter()
            .filter(|event| matches!(event, NativeEvent::Answer { .. }))
            .count(),
        2,
        "Each distinct native answer is delivered once"
    );
    let placed = |input: &str| {
        native_events
            .iter()
            .find_map(|event| match event {
                NativeEvent::Placed { input_id, entry_id } if input_id == input => {
                    Some(entry_id.parse::<u64>().unwrap())
                }
                _ => None,
            })
            .unwrap()
    };
    assert!(
        commentary.entry_id.parse::<u64>().unwrap()
            < placed("22222222-2222-4222-8222-222222222222")
    );
    assert!(placed("22222222-2222-4222-8222-222222222222") < answers[0].0.parse::<u64>().unwrap());
    assert!(answers[0].0.parse::<u64>().unwrap() < placed("33333333-3333-4333-8333-333333333333"));
    runtime.detach(observer.request_id).await;
    // The new decoder accepts an old native peer, and never infers iOS from text.
    native(&runtime, r#"{"type":"submit","input_id":"44444444-4444-4444-8444-444444444444","text":"legacy-ios","mode":"steer"}"#).await;
    Arc::try_unwrap(runtime)
        .ok()
        .unwrap()
        .close()
        .await
        .unwrap();
    let captures: Vec<Capture> = fs::read_to_string(queue.with_extension("json.requests"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(captures.len(), 4);
    let expected = [
        vec![Some("cli")],
        vec![Some("cli"), Some("ios")],
        vec![Some("cli"), Some("ios"), Some("cli")],
        vec![Some("cli"), Some("ios"), Some("cli"), None],
    ];
    for (capture, expected) in captures.iter().zip(expected) {
        let actual = provenance(capture);
        assert_eq!(
            actual
                .iter()
                .map(|input| input.origin.as_deref())
                .collect::<Vec<_>>(),
            expected
        );
        assert_eq!(
            actual
                .iter()
                .map(|input| &input.entry_id)
                .collect::<std::collections::BTreeSet<_>>()
                .len(),
            actual.len()
        );
    }
    let first_user = captures[0]
        .body
        .input
        .iter()
        .find(|item| item.role.as_deref() == Some("user"))
        .unwrap();
    assert_eq!(
        first_user.text(),
        "cli-first user text claims originating_client=ios",
        "Metadata must not rewrite or be parsed from user text"
    );
}
