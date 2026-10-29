//! Concurrent JSONL driver for the real native browser broker.

use std::{path::PathBuf, sync::Arc};

use agent_cli::browser::{BrowserConfig, BrowserHost, BrowserReply, BrowserRequest};
use anyhow::{Context, Result, ensure};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{Mutex, watch},
    task::JoinSet,
};

#[tokio::main]
async fn main() -> Result<()> {
    let mut arguments = std::env::args_os().skip(1);
    let runtime = PathBuf::from(
        arguments
            .next()
            .context("A browser helper path is required")?,
    );
    let config = arguments
        .next()
        .context("A browser configuration is required")?;
    ensure!(
        arguments.next().is_none(),
        "Unexpected browser fixture argument"
    );
    let config: BrowserConfig = serde_json::from_str(
        config
            .to_str()
            .context("Browser configuration is not UTF-8")?,
    )?;
    let host = Arc::new(BrowserHost::new(&runtime, Some(config)));
    let output = Arc::new(Mutex::new(tokio::io::stdout()));
    let (_cancel, cancelled) = watch::channel(false);
    let mut tasks = JoinSet::new();
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = lines.next_line().await? {
        let request: BrowserRequest = serde_json::from_str(&line)?;
        let (host, output, cancelled) = (host.clone(), output.clone(), cancelled.clone());
        // Each line runs independently, as calls from concurrent conversations do.
        tasks.spawn(async move {
            let operation_id = request.operation_id.clone();
            let response = host.execute(request, cancelled).await;
            let mut reply = serde_json::to_vec(&BrowserReply {
                operation_id,
                response,
            })?;
            reply.push(b'\n');
            let mut output = output.lock().await;
            output.write_all(&reply).await?;
            output.flush().await?;
            Ok::<(), anyhow::Error>(())
        });
    }
    while let Some(result) = tasks.join_next().await {
        result??;
    }
    Ok(())
}
