//! Bounded headless reads through Rex Server's existing permission context.
//! The helper owns its deadline even if this client disappears. Lua retains
//! only one job; native event/checkpoint identity makes a read safe to repeat.

use std::time::Duration;

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use tokio::time::{sleep, timeout};
use uuid::Uuid;

use crate::{config, host, rex::RexClient, sources::ReadOutput};

pub const MODULE: &str = include_str!("source.lua");
const MAX_HELPER_BYTES: usize = 16 * 1024 * 1024;

#[derive(Serialize)]
struct Start<'a> {
    id: Uuid,
    program: &'a str,
    argv: &'a [String],
    path: &'a str,
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
        .context("Messages Rex actions are unavailable; run agent rex install on this machine")?;
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
    let program = config::program()?;
    let program = program.to_str().context("Agent path is not UTF-8")?;
    let path = std::env::var("PATH").context("Source command PATH is unavailable")?;
    read_with(&RexClient::new(None), program, &path, argv).await
}

async fn read_with(
    client: &RexClient,
    program: &str,
    path: &str,
    argv: &[String],
) -> Result<ReadOutput> {
    let id = Uuid::new_v4();
    let _owned = ActiveRead {
        id,
        client: client.clone(),
    };
    let started: Identity = action(
        client,
        "agent_messages_start",
        &Start {
            id,
            program,
            argv,
            path,
        },
    )
    .await?;
    ensure!(
        started.id == id,
        "Rex returned another Messages read identity"
    );
    timeout(
        Duration::from_secs(u64::from(host::DEFAULT_TIMEOUT_SECONDS) + 30),
        collect(client, id),
    )
    .await
    .context("Messages read exceeded its helper deadline")?
}

async fn collect(client: &RexClient, expected: Uuid) -> Result<ReadOutput> {
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
                    return serde_json::from_str(&output)
                        .context("Messages helper returned no valid capture");
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use crate::{
        rex::{RexClient, source::read_with},
        sources::ReadOutput,
    };

    #[tokio::test]
    #[ignore = "requires a local Rex server with agent rex install"]
    async fn native_headless_read_survives_action_deadline_and_round_trips_large_unicode_capture() {
        let directory = tempfile::tempdir().unwrap();
        let payload = directory.path().join("capture.json");
        let expected = ReadOutput {
            exit_code: 7,
            stdout: "\"\\\n🐢".repeat(250_000),
            truncated: true,
        };
        std::fs::write(&payload, serde_json::to_vec(&expected).unwrap()).unwrap();
        let producer = directory.path().join("capture-producer");
        std::fs::write(&producer, "#!/usr/bin/env node\nsetTimeout(() => process.stdout.write(require('node:fs').readFileSync(process.argv.at(-1))), 31000);\n").unwrap();
        std::fs::set_permissions(&producer, std::fs::Permissions::from_mode(0o700)).unwrap();
        let actual = read_with(
            &RexClient::new(None),
            producer.to_str().unwrap(),
            &std::env::var("PATH").unwrap(),
            &[payload.to_str().unwrap().into()],
        )
        .await
        .unwrap();
        assert_eq!(actual.exit_code, expected.exit_code);
        assert_eq!(actual.stdout, expected.stdout);
        assert_eq!(actual.truncated, expected.truncated);
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
        std::fs::write(&producer, "#!/usr/bin/env node\nconst server = require('node:net').createServer(socket => socket.end());\nserver.listen(0, '127.0.0.1', () => require('node:fs').writeFileSync(process.argv.at(-1), String(server.address().port)));\n").unwrap();
        std::fs::set_permissions(&producer, std::fs::Permissions::from_mode(0o700)).unwrap();
        let program = producer.to_str().unwrap().to_owned();
        let path = std::env::var("PATH").unwrap();
        let arguments = vec![port_file.to_str().unwrap().to_owned()];
        let read = tokio::spawn(async move {
            read_with(&RexClient::new(None), &program, &path, &arguments).await
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
