use std::{process::Stdio, time::Duration};

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use tokio::{io::AsyncReadExt, process::Command, time::timeout};

#[derive(Deserialize)]
struct NamespaceList {
    namespaces: Vec<Namespace>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Namespace {
    pub id: String,
    provider: String,
}

#[derive(Serialize)]
pub struct MailPage {
    pub namespace: String,
    pub outcome: MailOutcome,
}

#[derive(Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum MailOutcome {
    /// The provider owns its payload and coverage contract.
    Observed {
        result: serde_json::Value,
    },
    Unavailable {
        message: String,
    },
}

pub async fn accounts() -> Result<Vec<Namespace>> {
    let output = invoke(&["ns", "list", "--json"]).await?;
    google_accounts(&output)
}

fn google_accounts(output: &[u8]) -> Result<Vec<Namespace>> {
    let registry: NamespaceList = serde_json::from_slice(output)
        .context("Switchboard returned an invalid namespace registry")?;
    Ok(registry
        .namespaces
        .into_iter()
        .filter(|namespace| namespace.provider == "google")
        .collect())
}

pub async fn search(
    query: &str,
    namespace: Option<&str>,
    limit: u16,
    cursor: Option<&str>,
) -> Result<Vec<MailPage>> {
    ensure!(
        (1..=500).contains(&limit),
        "Mail limit must be between 1 and 500"
    );
    ensure!(
        cursor.is_none() || namespace.is_some(),
        "Continue a mail cursor with its explicit namespace"
    );
    let accounts = accounts().await?;
    let selected: Vec<_> = accounts
        .into_iter()
        .filter(|account| namespace.is_none_or(|id| id == account.id))
        .collect();
    ensure!(
        !selected.is_empty(),
        "No matching Google mail namespace is configured in Switchboard"
    );
    let limit = limit.to_string();
    let mut pages = Vec::new();
    // Provider refresh belongs to Switchboard. Serial reads avoid competing
    // interactive refreshes while preserving each account's coverage separately.
    for account in selected {
        let mut args = vec![
            "google.mail.search",
            "--ns",
            &account.id,
            "--json",
            "--query",
            query,
            "--hydrate",
            "--max",
            &limit,
            "--body-limit",
            "4000",
        ];
        if let Some(cursor) = cursor {
            args.extend(["--cursor", cursor]);
        }
        let outcome = match invoke(&args).await {
            Ok(output) => match serde_json::from_slice(&output) {
                Ok(result) => MailOutcome::Observed { result },
                Err(_) => MailOutcome::Unavailable {
                    message: "Switchboard returned invalid JSON; coverage is unknown".into(),
                },
            },
            Err(error) => MailOutcome::Unavailable {
                message: error.to_string(),
            },
        };
        pages.push(MailPage {
            namespace: account.id,
            outcome,
        });
    }
    Ok(pages)
}

async fn invoke(args: &[&str]) -> Result<Vec<u8>> {
    let mut command = Command::new("switchboard");
    command.args(args);
    run(command, Duration::from_secs(30)).await
}

struct ProcessGroup(libc::pid_t);

impl ProcessGroup {
    fn terminate(&mut self) {
        if self.0 != 0 {
            // The unreaped child reserves this group ID until after cleanup.
            // Its provider descendants belong to the same owned process group.
            unsafe {
                libc::kill(-self.0, libc::SIGKILL);
            }
            self.0 = 0;
        }
    }
}

impl Drop for ProcessGroup {
    fn drop(&mut self) {
        self.terminate();
    }
}

async fn run(mut command: Command, deadline: Duration) -> Result<Vec<u8>> {
    const MAX_BYTES: u64 = 8 * 1024 * 1024;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0)
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .context("Could not run Switchboard; install and configure its CLI")?;
    let mut group = ProcessGroup(
        child
            .id()
            .context("Switchboard process has no identity")?
            .try_into()?,
    );
    let output = child
        .stdout
        .take()
        .context("Switchboard output is unavailable")?;
    let mut bytes = Vec::new();
    let read = timeout(deadline, output.take(MAX_BYTES + 1).read_to_end(&mut bytes)).await;
    // Kill before reaping, so the process-group identity cannot be reused.
    group.terminate();
    timeout(Duration::from_secs(3), child.wait())
        .await
        .context("Switchboard process exit could not be confirmed")??;
    read.context("Switchboard read timed out; coverage is unknown")?
        .context("Switchboard output could not be read; coverage is unknown")?;
    ensure!(
        bytes.len() as u64 <= MAX_BYTES,
        "Switchboard result exceeded its size limit; coverage is unknown"
    );
    // Switchboard returns structured failures on stdout even with a nonzero
    // exit code. Preserve them so a failed account cannot look like no mail.
    ensure!(
        !bytes.is_empty(),
        "Switchboard returned no result; coverage is unknown"
    );
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use crate::mail::{google_accounts, run};
    use std::{fs, time::Duration};
    use tokio::{
        process::Command,
        time::{Instant, sleep},
    };

    #[test]
    fn discovers_all_google_accounts_from_the_live_registry_shape() {
        let accounts = google_accounts(
            br#"{"schema_version":1,"namespaces":[
          {"id":"google.alpha","provider":"google"},
          {"id":"github.example","provider":"github"},
          {"id":"google.beta","provider":"google"}
        ]}"#,
        )
        .unwrap();
        assert_eq!(
            accounts
                .into_iter()
                .map(|account| account.id)
                .collect::<Vec<_>>(),
            ["google.alpha", "google.beta"]
        );
        assert!(google_accounts(br#"{"failure":{"code":"unavailable"}}"#).is_err());
    }

    #[tokio::test]
    async fn timeout_stops_provider_descendants() {
        let directory = tempfile::tempdir().unwrap();
        let pid_file = directory.path().join("descendant");
        let mut command = Command::new("sh");
        command
            .args([
                "-c",
                "sleep 60 >/dev/null 2>&1 & echo $! > \"$1\"; wait",
                "fixture",
            ])
            .arg(&pid_file);
        assert!(
            run(command, Duration::from_millis(200))
                .await
                .unwrap_err()
                .to_string()
                .contains("timed out")
        );
        let pid: libc::pid_t = fs::read_to_string(pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while unsafe { libc::kill(pid, 0) } == 0 {
            assert!(
                Instant::now() < deadline,
                "Provider descendant survived timeout"
            );
            sleep(Duration::from_millis(10)).await;
        }
    }
}
