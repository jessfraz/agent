use std::{
    fs::{File, OpenOptions},
    os::{fd::AsRawFd, unix::fs::OpenOptionsExt},
    path::Path,
    process::Stdio,
    time::Duration,
};

use agent_cli::protocol::{
    PROTOCOL_VERSION, RuntimeCommand, RuntimeEvent, RuntimeEventKind, RuntimeRequest,
};
use anyhow::{Context, Result, ensure};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdin, ChildStdout, Command},
    time::timeout,
};

pub struct Runtime {
    child: Child,
    stdin: Option<ChildStdin>,
    output: Lines<BufReader<ChildStdout>>,
    next_id: u32,
    _writer_guard: File,
}

enum Completion {
    Pending,
    Answered,
    Failed(String),
}

impl Runtime {
    pub fn start(script: &Path, state: &Path) -> Result<Self> {
        ensure!(
            script.is_file(),
            "Pi runtime is not built; build the runtime first"
        );
        let guard = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(state.join("writer.lock"))?;
        fs2::FileExt::try_lock_exclusive(&guard)
            .context("Another agent process owns this state directory")?;
        let lock_fd = guard.as_raw_fd();
        let mut command = Command::new("node");
        command
            .arg("--no-warnings")
            .arg(script)
            .arg(state)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        // The child retains this descriptor after exec, so killing the Rust
        // supervisor cannot release ownership while Pi is still writing.
        unsafe {
            command.pre_exec(move || {
                if libc::fcntl(lock_fd, libc::F_SETFD, 0) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command.spawn().context("Could not start the Pi runtime")?;
        let stdin = child
            .stdin
            .take()
            .context("Runtime input pipe is unavailable")?;
        let stdout = child
            .stdout
            .take()
            .context("Runtime output pipe is unavailable")?;
        Ok(Self {
            child,
            stdin: Some(stdin),
            output: BufReader::new(stdout).lines(),
            next_id: 1,
            _writer_guard: guard,
        })
    }

    pub async fn call(
        &mut self,
        command: RuntimeCommand,
        mut on_event: impl FnMut(&RuntimeEventKind) -> Result<()>,
    ) -> Result<()> {
        let id = self.next_id;
        self.next_id = id.checked_add(1).context("Runtime request IDs exhausted")?;
        let mut line = serde_json::to_vec(&RuntimeRequest {
            version: PROTOCOL_VERSION,
            id,
            command,
        })?;
        line.push(b'\n');
        self.stdin
            .as_mut()
            .context("Runtime is closed")?
            .write_all(&line)
            .await?;
        let mut completion = Completion::Pending;
        loop {
            let line = self
                .output
                .next_line()
                .await?
                .context("Pi runtime exited before completing the request")?;
            ensure!(
                line.len() <= 4 * 1024 * 1024,
                "Runtime event exceeds its size limit"
            );
            let event: RuntimeEvent =
                serde_json::from_str(&line).context("Pi runtime returned an invalid event")?;
            ensure!(
                event.version == PROTOCOL_VERSION && event.id == id,
                "Pi runtime protocol mismatch"
            );
            match event.event {
                RuntimeEventKind::Done => {
                    return match completion {
                        Completion::Pending => {
                            Err(anyhow::anyhow!("Runtime completed without a result"))
                        }
                        Completion::Answered => Ok(()),
                        Completion::Failed(message) => Err(anyhow::anyhow!(message)),
                    };
                }
                RuntimeEventKind::AuthorizationUrl { .. } => {
                    ensure!(
                        matches!(completion, Completion::Pending),
                        "Unexpected authorization event"
                    );
                    on_event(&event.event)?;
                }
                RuntimeEventKind::Failure { code: _, message } => {
                    ensure!(
                        matches!(completion, Completion::Pending),
                        "Runtime returned multiple results"
                    );
                    completion = Completion::Failed(message);
                }
                other => {
                    ensure!(
                        matches!(completion, Completion::Pending),
                        "Runtime returned multiple results"
                    );
                    on_event(&other)?;
                    completion = Completion::Answered;
                }
            }
        }
    }

    pub async fn close(mut self) -> Result<()> {
        self.stdin.take();
        match timeout(Duration::from_secs(5), self.child.wait()).await {
            Ok(status) => {
                ensure!(status?.success(), "Pi runtime did not exit cleanly");
            }
            Err(_) => {
                self.child.kill().await?;
                self.child.wait().await?;
            }
        }
        Ok(())
    }
}
