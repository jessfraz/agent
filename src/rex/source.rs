//! Bounded headless reads through Rex Server's existing permission context.
//! The helper owns its deadline even if this client disappears. Lua retains
//! only one job; native event/checkpoint identity makes a read safe to repeat.

use std::time::Duration;

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use tokio::time::{Instant, sleep, timeout};
use uuid::Uuid;

use crate::{
    config, host,
    protocol::HostResult,
    rex::RexClient,
    sources::{
        ReadOutput,
        messages_read::{Capture, Request},
    },
};

pub const MODULE: &str = include_str!("source.lua");
const MAX_HELPER_BYTES: usize = 32 * 1024 * 1024;

#[derive(Serialize)]
struct Start<'a> {
    id: Uuid,
    program: &'a str,
    argv: &'a [String],
    path: &'a str,
    timeout_seconds: u16,
}
#[derive(Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
enum Admission {
    Started { id: Uuid },
    Busy,
}
#[derive(Serialize)]
struct Read {
    id: Uuid,
    offset: usize,
}
#[derive(Serialize, Deserialize)]
struct Identity {
    id: Uuid,
}
#[derive(Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
enum State {
    Missing,
    Running {
        id: Uuid,
    },
    Finished {
        id: Uuid,
        code: i32,
        chunk: String,
        next_offset: usize,
        total_bytes: usize,
        overflow: bool,
    },
}

async fn action<T: Serialize, R: serde::de::DeserializeOwned>(
    client: &RexClient,
    name: &str,
    args: &T,
) -> Result<R> {
    let bytes = client
        .run(vec![
            "do".into(),
            name.into(),
            "--args".into(),
            serde_json::to_string(args)?,
            "--json".into(),
        ])
        .await
        .map_err(crate::rex::read_failure)
        .context(
            "Messages Rex actions are unavailable; run beep-boop rex install on this machine",
        )?;
    serde_json::from_slice(&bytes).context("Rex returned an invalid Messages read result")
}

struct ActiveRead {
    id: Uuid,
    client: RexClient,
}
impl Drop for ActiveRead {
    fn drop(&mut self) {
        let id = self.id;
        let client = self.client.clone();
        // Normal cancellation releases the native child. On abrupt shutdown,
        // its own deadline still bounds its lifetime and captured output.
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _: Result<Identity> =
                    action(&client, "agent_messages_cancel", &Identity { id }).await;
            });
        }
    }
}

pub(crate) async fn read_command(argv: &[String]) -> Result<ReadOutput> {
    match execute_request(Request {
        argv: argv.to_vec(),
        cwd: "/".into(),
        timeout_seconds: host::DEFAULT_TIMEOUT_SECONDS,
        capture: Capture::Source,
    })
    .await?
    {
        HostResult::Process {
            exit_code,
            stdout,
            truncated,
            ..
        } => Ok(ReadOutput {
            exit_code,
            stdout,
            truncated,
        }),
        _ => anyhow::bail!("Messages helper returned no process capture"),
    }
}

pub(crate) async fn execute(
    program: String,
    args: Vec<String>,
    cwd: String,
    timeout_seconds: u16,
) -> Result<HostResult> {
    let mut argv = vec![program];
    argv.extend(args);
    execute_request(Request {
        argv,
        cwd: cwd.into(),
        timeout_seconds,
        capture: Capture::Exec,
    })
    .await
}

async fn execute_request(request: Request) -> Result<HostResult> {
    request.validate()?;
    let program = config::program()?;
    let program = program.to_str().context("Beep Boop path is not UTF-8")?;
    let path = std::env::var("PATH").context("Source command PATH is unavailable")?;
    read_with(&RexClient::new(None), program, &path, &request).await
}

async fn read_with(
    client: &RexClient,
    program: &str,
    path: &str,
    request: &Request,
) -> Result<HostResult> {
    request.validate()?;
    let id = Uuid::new_v4();
    let _owned = ActiveRead {
        id,
        client: client.clone(),
    };
    let deadline = Instant::now() + Duration::from_secs(request.timeout_seconds.into());
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(HostResult::Process {
                exit_code: 124,
                stdout: String::new(),
                stderr: "Messages reader was busy until the command deadline.".into(),
                truncated: false,
            });
        }
        let seconds = u16::try_from(remaining.as_secs() + u64::from(remaining.subsec_nanos() != 0))
            .context("Messages deadline is out of range")?;
        let pending = Request {
            argv: request.argv.clone(),
            cwd: request.cwd.clone(),
            timeout_seconds: seconds,
            capture: request.capture,
        };
        let arguments = pending.arguments()?;
        // Only an explicit busy response permits another admission attempt.
        // A lost start reply may already own a child and is never replayed.
        let admitted: Admission = action(
            client,
            "agent_messages_start",
            &Start {
                id,
                program,
                argv: &arguments,
                path,
                timeout_seconds: seconds,
            },
        )
        .await?;
        match admitted {
            Admission::Started { id: started } => {
                ensure!(started == id, "Rex returned another Messages read identity");
                break;
            }
            Admission::Busy => sleep(Duration::from_millis(100).min(remaining)).await,
        }
    }
    timeout(
        deadline.saturating_duration_since(Instant::now())
            + Duration::from_secs(match request.capture {
                Capture::Exec => 8,
                Capture::Source => 30,
            }),
        collect(client, id),
    )
    .await
    .context("Messages read exceeded its helper deadline")?
}

async fn collect(client: &RexClient, expected: Uuid) -> Result<HostResult> {
    let mut output = String::new();
    let mut total = None;
    loop {
        let state: State = action(
            client,
            "agent_messages_read",
            &Read {
                id: expected,
                offset: output.len(),
            },
        )
        .await?;
        match state {
            State::Running { id } => {
                ensure!(
                    id == expected && output.is_empty(),
                    "Messages read identity changed"
                );
                sleep(Duration::from_millis(100)).await;
            }
            State::Missing => anyhow::bail!("Rex lost the Messages read; checkpoint retained"),
            State::Finished {
                id,
                code,
                chunk,
                next_offset,
                total_bytes,
                overflow,
            } => {
                ensure!(
                    id == expected && code == 0 && !overflow,
                    "Messages helper did not complete"
                );
                ensure!(
                    total_bytes <= MAX_HELPER_BYTES,
                    "Messages helper output is too large"
                );
                ensure!(
                    total.is_none_or(|value| value == total_bytes),
                    "Messages output changed"
                );
                ensure!(
                    next_offset
                        == output
                            .len()
                            .checked_add(chunk.len())
                            .context("Messages offset overflow")?
                        && next_offset <= total_bytes
                        && (!chunk.is_empty() || next_offset == total_bytes),
                    "Messages output offset is invalid"
                );
                total = Some(total_bytes);
                output.push_str(&chunk);
                if next_offset == total_bytes {
                    let result = serde_json::from_str(&output)
                        .context("Messages helper returned no valid capture")?;
                    ensure!(
                        matches!(result, HostResult::Process { .. }),
                        "Messages helper returned no process capture"
                    );
                    return Ok(result);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use crate::{
        protocol::HostResult,
        rex::{
            RexClient,
            source::{MODULE, Start, read_with},
        },
        sources::messages_read::{Capture, Request},
    };

    #[test]
    #[ignore = "requires the native Rex CLI; runs local Lua only, without installing actions or connecting to a server"]
    fn native_admission_serializes_readers_and_retains_finished_output_until_release() {
        #[derive(serde::Serialize)]
        struct Inputs<'a> {
            first: Start<'a>,
            second: Start<'a>,
        }
        #[derive(serde::Deserialize)]
        struct Proof {
            first: String,
            busy: String,
            retained: String,
            second: String,
            first_bytes: usize,
            second_code: i32,
        }
        let directory = tempfile::tempdir().unwrap();
        let producer = directory.path().join("capture-producer");
        std::fs::write(
            &producer,
            "#!/usr/bin/env node\nsetTimeout(() => process.stdout.write('native capture'), 200);\n",
        )
        .unwrap();
        std::fs::set_permissions(&producer, std::fs::Permissions::from_mode(0o700)).unwrap();
        let program = producer.to_str().unwrap();
        let path = std::env::var("PATH").unwrap();
        let arguments = vec!["literal".into()];
        let first = uuid::Uuid::new_v4();
        let second = uuid::Uuid::new_v4();
        let inputs = Inputs {
            first: Start {
                id: first,
                program,
                argv: &arguments,
                path: &path,
                timeout_seconds: 65535,
            },
            second: Start {
                id: second,
                program,
                argv: &arguments,
                path: &path,
                timeout_seconds: 1,
            },
        };
        let script = format!(
            "{MODULE}\n{}",
            r#"
local a = rex.invoke('agent_messages_start', rex.args.first)
local b = rex.invoke('agent_messages_start', rex.args.second)
local result
repeat
  result = rex.invoke('agent_messages_read', {id=rex.args.first.id,offset=0})
until result.state == 'finished'
local retained = rex.invoke('agent_messages_start', rex.args.second)
rex.invoke('agent_messages_cancel', {id=rex.args.first.id})
local c = rex.invoke('agent_messages_start', rex.args.second)
-- A delayed cancellation from the previous owner cannot cancel its successor.
rex.invoke('agent_messages_cancel', {id=rex.args.first.id})
local last
repeat
  last = rex.invoke('agent_messages_read', {id=rex.args.second.id,offset=0})
until last.state == 'finished'
rex.invoke('agent_messages_cancel', {id=rex.args.second.id})
return {first=a.state,busy=b.state,retained=retained.state,second=c.state,first_bytes=result.total_bytes,second_code=last.code}
"#
        );
        let output = std::process::Command::new("rex")
            .args([
                "--autostart=false",
                "do",
                "-e",
                &script,
                "--args",
                &serde_json::to_string(&inputs).unwrap(),
                "--json",
            ])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let proof: Proof = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(proof.first, "started");
        assert_eq!(proof.busy, "busy");
        assert_eq!(proof.retained, "busy");
        assert_eq!(proof.second, "started");
        assert_eq!(proof.first_bytes, "native capture".len());
        assert_eq!(proof.second_code, 0);
    }

    #[test]
    #[ignore = "requires the native Rex CLI; runs local Lua only, without installing actions or connecting to a server"]
    fn native_running_cancellation_releases_the_slot_after_cleanup() {
        #[derive(serde::Serialize)]
        struct Inputs<'a> {
            first: Start<'a>,
            second: Start<'a>,
            marker: &'a str,
        }
        #[derive(serde::Deserialize)]
        struct Proof {
            busy_during_cleanup: String,
            successor: String,
            old_stopped: bool,
            successor_code: Option<i32>,
        }
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("cleanup");
        let marker = marker.to_str().unwrap();
        let producer = directory.path().join("capture-producer");
        std::fs::write(
            &producer,
            r#"#!/usr/bin/env node
const fs = require('node:fs');
const marker = process.argv.at(-1);
if (marker === 'successor') {
  setTimeout(() => process.stdout.write('successor capture'), 50);
} else {
  process.on('SIGTERM', () => {
    fs.writeFileSync(marker + '.cancelled', 'received');
    const cleanup = setInterval(() => {
      if (fs.existsSync(marker + '.release')) {
        clearInterval(cleanup);
        fs.writeFileSync(marker + '.stopped', 'complete');
        process.exit(0);
      }
    }, 10);
  });
  fs.writeFileSync(marker + '.ready', 'ready');
  setInterval(() => {}, 1000);
}
"#,
        )
        .unwrap();
        std::fs::set_permissions(&producer, std::fs::Permissions::from_mode(0o700)).unwrap();
        let path = std::env::var("PATH").unwrap();
        let arguments = vec![marker.into()];
        let successor = vec!["successor".into()];
        let inputs = Inputs {
            first: Start {
                id: uuid::Uuid::new_v4(),
                program: producer.to_str().unwrap(),
                argv: &arguments,
                path: &path,
                timeout_seconds: 900,
            },
            second: Start {
                id: uuid::Uuid::new_v4(),
                program: producer.to_str().unwrap(),
                argv: &successor,
                path: &path,
                timeout_seconds: 1,
            },
            marker,
        };
        let script = format!(
            "{MODULE}\n{}",
            r#"
local function exists(path)
  local file = io.open(path, 'r')
  if file then file:close(); return true end
  return false
end
local function wait_for(path)
  for _ = 1, 500 do
    if exists(path) then return true end
    rex.sleep(0.01)
  end
  error('Native fixture did not reach its barrier')
end
rex.invoke('agent_messages_start', rex.args.first)
wait_for(rex.args.marker .. '.ready')
rex.invoke('agent_messages_cancel', {id=rex.args.first.id})
wait_for(rex.args.marker .. '.cancelled')
local busy = rex.invoke('agent_messages_start', rex.args.second)
local release = assert(io.open(rex.args.marker .. '.release', 'w'))
release:write('release'); release:close()
local next
for _ = 1, 500 do
  next = rex.invoke('agent_messages_start', rex.args.second)
  if next.state == 'started' then break end
  rex.sleep(0.01)
end
local code = nil
if next.state == 'started' then
  rex.invoke('agent_messages_cancel', {id=rex.args.first.id})
  local result
  repeat
    result = rex.invoke('agent_messages_read', {id=rex.args.second.id,offset=0})
  until result.state == 'finished'
  code = result.code
  rex.invoke('agent_messages_cancel', {id=rex.args.second.id})
end
return {busy_during_cleanup=busy.state,successor=next.state,old_stopped=exists(rex.args.marker .. '.stopped'),successor_code=code}
"#
        );
        let output = std::process::Command::new("rex")
            .args([
                "--autostart=false",
                "do",
                "-e",
                &script,
                "--args",
                &serde_json::to_string(&inputs).unwrap(),
                "--json",
            ])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let proof: Proof = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(proof.busy_during_cleanup, "busy");
        assert_eq!(proof.successor, "started");
        assert!(proof.old_stopped);
        assert_eq!(proof.successor_code, Some(0));
    }

    #[tokio::test]
    #[ignore = "requires a local Rex server with agent rex install"]
    async fn native_headless_read_survives_action_deadline_and_round_trips_large_unicode_capture() {
        let directory = tempfile::tempdir().unwrap();
        let payload = directory.path().join("capture.json");
        let expected = HostResult::Process {
            exit_code: 7,
            stdout: "\"\\\n🐢".repeat(250_000),
            stderr: "native diagnostic".into(),
            truncated: true,
        };
        std::fs::write(&payload, serde_json::to_vec(&expected).unwrap()).unwrap();
        let producer = directory.path().join("capture-producer");
        std::fs::write(&producer, "#!/usr/bin/env node\nsetTimeout(() => process.stdout.write(require('node:fs').readFileSync(JSON.parse(process.argv.at(-1)).argv.at(-1))), 31000);\n").unwrap();
        std::fs::set_permissions(&producer, std::fs::Permissions::from_mode(0o700)).unwrap();
        let actual = read_with(
            &RexClient::new(None),
            producer.to_str().unwrap(),
            &std::env::var("PATH").unwrap(),
            &Request {
                argv: vec![
                    "messages".into(),
                    "doctor".into(),
                    payload.to_str().unwrap().into(),
                ],
                cwd: "/".into(),
                timeout_seconds: 900,
                capture: Capture::Source,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            serde_json::to_value(actual).unwrap(),
            serde_json::to_value(expected).unwrap()
        );
    }

    #[tokio::test]
    #[ignore = "requires local agent Rex actions; run separately from other headless-read tests"]
    async fn native_cancellation_stops_the_owned_headless_process() {
        use tokio::{
            net::TcpStream,
            time::{Duration, sleep, timeout},
        };

        let directory = tempfile::tempdir().unwrap();
        let port_file = directory.path().join("port");
        let producer = directory.path().join("capture-producer");
        std::fs::write(&producer, "#!/usr/bin/env node\nconst server = require('node:net').createServer(socket => socket.end());\nserver.listen(0, '127.0.0.1', () => require('node:fs').writeFileSync(JSON.parse(process.argv.at(-1)).argv.at(-1), String(server.address().port)));\n").unwrap();
        std::fs::set_permissions(&producer, std::fs::Permissions::from_mode(0o700)).unwrap();
        let program = producer.to_str().unwrap().to_owned();
        let path = std::env::var("PATH").unwrap();
        let request = Request {
            argv: vec![
                "messages".into(),
                "doctor".into(),
                port_file.to_str().unwrap().to_owned(),
            ],
            cwd: "/".into(),
            timeout_seconds: 900,
            capture: Capture::Source,
        };
        let read = tokio::spawn(async move {
            read_with(&RexClient::new(None), &program, &path, &request).await
        });
        timeout(Duration::from_secs(10), async {
            while !port_file.exists() {
                sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .unwrap();
        let port: u16 = std::fs::read_to_string(port_file).unwrap().parse().unwrap();
        TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        read.abort();
        assert!(read.await.unwrap_err().is_cancelled());
        timeout(Duration::from_secs(5), async {
            while TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
                sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .unwrap();
    }
}
