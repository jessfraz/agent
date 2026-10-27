//! Bounded Messages reads for the existing trusted Rex process. This helper
//! does not load agent state, choose credentials or evaluate shell commands.

use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use tokio::signal::unix::{SignalKind, signal};

use crate::{host, protocol::HostResult, runtime::MAX_FRAME_BYTES};

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Capture {
    Exec,
    Source,
}

impl Capture {
    fn limit(self) -> usize {
        match self {
            Self::Exec => 256 * 1024,
            Self::Source => MAX_FRAME_BYTES / 2,
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Request {
    pub argv: Vec<String>,
    pub cwd: PathBuf,
    pub timeout_seconds: u16,
    pub capture: Capture,
}

impl Request {
    pub fn validate(&self) -> Result<()> {
        command(&self.argv)?;
        ensure!(
            self.cwd.is_absolute(),
            "Messages working directory must be absolute"
        );
        ensure!(
            self.timeout_seconds > 0,
            "Messages timeout must be positive"
        );
        Ok(())
    }

    pub fn arguments(&self) -> Result<Vec<String>> {
        self.validate()?;
        Ok(vec!["--request".into(), serde_json::to_string(self)?])
    }
}

pub(crate) fn is_read(program: &str, args: &[String]) -> bool {
    let method = args.first().map(String::as_str);
    match Path::new(program)
        .file_name()
        .and_then(|name| name.to_str())
    {
        Some("messages") => matches!(method, Some("chats" | "read" | "doctor")),
        Some("switchboard") => matches!(
            method,
            Some("messages.chats.list" | "messages.chats.read" | "messages.doctor")
        ),
        _ => false,
    }
}

fn command(argv: &[String]) -> Result<(&str, &[String])> {
    let (program, args) = argv
        .split_first()
        .context("Messages read command is empty")?;
    ensure!(
        is_read(program, args),
        "Only read-only Messages commands are supported"
    );
    Ok((program, args))
}

pub async fn capture(argv: &[String]) -> Result<HostResult> {
    let request = match argv {
        [flag, value] if flag == "--request" => {
            serde_json::from_str(value).context("Invalid Messages capture request")?
        }
        _ => Request {
            argv: argv.to_vec(),
            cwd: PathBuf::from("/"),
            timeout_seconds: host::DEFAULT_TIMEOUT_SECONDS,
            capture: Capture::Source,
        },
    };
    request.validate()?;
    let (program, args) = command(&request.argv)?;
    // Install both handlers before the child exists. A signal follows the
    // runner's ordinary cleanup path rather than abandoning a detached child.
    let mut terminate = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    host::run_process_until(
        program,
        args,
        &request.cwd,
        Duration::from_secs(request.timeout_seconds.into()),
        request.capture.limit(),
        async move {
            tokio::select! {
                _ = terminate.recv() => {},
                _ = interrupt.recv() => {},
            }
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use std::{os::unix::fs::PermissionsExt, path::Path};

    use serde::{Deserialize, Serialize};

    use crate::sources::messages_read::{capture, command};

    #[derive(Serialize)]
    struct FixtureRequest<'a> {
        argv: Vec<String>,
        cwd: &'a Path,
        timeout_seconds: u16,
        capture: &'static str,
    }

    #[derive(Deserialize)]
    struct ProcessCapture {
        #[serde(rename = "type")]
        kind: String,
        exit_code: i32,
        stdout: String,
        stderr: String,
        truncated: bool,
    }

    fn producer(directory: &Path, script: &str) -> String {
        let program = directory.join("messages");
        std::fs::write(&program, format!("#!/usr/bin/env node\n{script}\n")).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        program.to_str().unwrap().to_owned()
    }

    async fn run(request: &FixtureRequest<'_>) -> ProcessCapture {
        let output = capture(&["--request".into(), serde_json::to_string(request).unwrap()])
            .await
            .unwrap();
        serde_json::from_str(&serde_json::to_string(&output).unwrap()).unwrap()
    }

    #[tokio::test]
    async fn doctor_capture_keeps_literal_arguments_cwd_stderr_and_native_exit() {
        #[derive(Deserialize)]
        struct Evidence {
            cwd: String,
            args: Vec<String>,
        }
        let directory = tempfile::tempdir().unwrap();
        let program = producer(
            directory.path(),
            "process.stdout.write(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)})); process.stderr.write('native diagnostic'); process.exitCode=7;",
        );
        let args = vec![program, "doctor".into(), "$(literal);*.chat".into()];
        let result = run(&FixtureRequest {
            argv: args.clone(),
            cwd: directory.path(),
            timeout_seconds: 900,
            capture: "exec",
        })
        .await;
        assert_eq!(result.kind, "process");
        assert_eq!(result.exit_code, 7);
        assert_eq!(result.stderr, "native diagnostic");
        assert!(!result.truncated);
        let evidence: Evidence = serde_json::from_str(&result.stdout).unwrap();
        assert_eq!(
            std::fs::canonicalize(evidence.cwd).unwrap(),
            std::fs::canonicalize(directory.path()).unwrap()
        );
        assert_eq!(evidence.args, args[1..]);
    }

    #[tokio::test]
    async fn captures_keep_exec_and_source_budgets_and_short_deadlines() {
        let directory = tempfile::tempdir().unwrap();
        let program = producer(
            directory.path(),
            "process.stdout.write('x'.repeat(600000)); process.stderr.write('y'.repeat(600000));",
        );
        for (mode, limit, truncated) in [("exec", 256 * 1024, true), ("source", 600000, false)] {
            let result = run(&FixtureRequest {
                argv: vec![program.clone(), "read".into()],
                cwd: directory.path(),
                timeout_seconds: 60,
                capture: mode,
            })
            .await;
            assert_eq!(result.stdout.len(), limit);
            assert_eq!(result.stderr.len(), limit);
            assert_eq!(result.truncated, truncated);
        }
        producer(
            directory.path(),
            "process.stdout.write('started'); setInterval(() => {}, 1000);",
        );
        let started = std::time::Instant::now();
        let result = run(&FixtureRequest {
            argv: vec![program, "doctor".into()],
            cwd: directory.path(),
            timeout_seconds: 1,
            capture: "exec",
        })
        .await;
        assert_eq!(result.exit_code, 124);
        assert_eq!(result.stdout, "started");
        assert!(result.stderr.contains("timed out"));
        assert!(started.elapsed() < std::time::Duration::from_secs(8));
    }

    #[test]
    fn read_methods_preserve_literal_arguments_and_reject_other_programs_or_methods() {
        for (program, methods) in [
            ("messages", ["chats", "read", "doctor"]),
            (
                "/example/bin/switchboard",
                [
                    "messages.chats.list",
                    "messages.chats.read",
                    "messages.doctor",
                ],
            ),
        ] {
            for method in methods {
                let argv = vec![
                    program.into(),
                    method.into(),
                    "--json".into(),
                    "--".into(),
                    "$(literal);*.chat".into(),
                ];
                let (selected, args) = command(&argv).unwrap();
                assert_eq!(selected, program);
                assert_eq!(args, &argv[1..]);
            }
        }
        for argv in [
            vec![],
            vec!["messages".into()],
            vec!["messages".into(), "send".into()],
            vec!["switchboard".into(), "messages.send".into()],
            vec!["switchboard".into(), "google.mail.send".into()],
            vec!["sh".into(), "-c".into(), "messages doctor".into()],
        ] {
            assert!(command(&argv).is_err());
        }
    }
}
