use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result, bail, ensure};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio::time::{Instant, sleep, timeout};
use uuid::Uuid;

use crate::embeddings::{
    EmbeddingBatch, EmbeddingProvider, EmbeddingPurpose, EmbeddingSpace, MAX_BATCH, MAX_TEXT_BYTES,
    MODEL_DIGEST,
};

pub struct LlamaProvider {
    program: PathBuf,
    model: PathBuf,
    directory: PathBuf,
    runner: Mutex<Option<Runner>>,
}

struct Runner {
    child: Child,
    socket: PathBuf,
    directory: PathBuf,
}

impl Drop for Runner {
    fn drop(&mut self) {
        // The child is exclusive to this provider. kill_on_drop also covers cancelled startup.
        let _ = self.child.start_kill();
        let _ = std::fs::remove_file(&self.socket);
        let _ = std::fs::remove_dir(&self.directory);
    }
}

#[derive(Serialize)]
struct Request {
    input: Vec<String>,
    encoding_format: &'static str,
}

#[derive(Deserialize)]
struct Response {
    data: Vec<Embedding>,
}

#[derive(Deserialize)]
struct Embedding {
    index: usize,
    embedding: Vec<f32>,
}

impl LlamaProvider {
    pub fn from_environment(state_directory: &Path) -> Result<Self> {
        Ok(Self::new(
            PathBuf::from(
                std::env::var_os("AGENT_LLAMA_SERVER")
                    .context("Embedding runtime is unavailable; use the Nix installation")?,
            ),
            PathBuf::from(
                std::env::var_os("AGENT_EMBEDDING_MODEL")
                    .context("Embedding model is unavailable; use the Nix installation")?,
            ),
            state_directory.join("embeddings"),
        ))
    }

    pub fn new(program: PathBuf, model: PathBuf, directory: PathBuf) -> Self {
        Self {
            program,
            model,
            directory,
            runner: Mutex::new(None),
        }
    }

    async fn start(&self) -> Result<Runner> {
        let mut file = tokio::fs::File::open(&self.model)
            .await
            .context("Could not open pinned embedding model")?;
        let mut digest = Sha256::new();
        let mut buffer = vec![0; 64 * 1024];
        loop {
            let count = file.read(&mut buffer).await?;
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count]);
        }
        ensure!(
            hex::encode(digest.finalize()) == MODEL_DIGEST,
            "Embedding model digest does not match the pinned space"
        );
        std::fs::create_dir_all(&self.directory)?;
        std::fs::set_permissions(&self.directory, std::fs::Permissions::from_mode(0o700))?;
        let directory = self.directory.join(Uuid::new_v4().simple().to_string());
        std::fs::DirBuilder::new().mode(0o700).create(&directory)?;
        // macOS limits Unix socket paths to 104 bytes; the normal application
        // support directory already consumes most of that budget.
        let socket = directory.join("s.sock");
        if socket.as_os_str().len() >= 104 {
            std::fs::remove_dir(&directory)?;
            bail!("Embedding state path is too long for a private Unix socket");
        }
        let child = Command::new(&self.program)
            .arg("--model")
            .arg(&self.model)
            .arg("--host")
            .arg(&socket)
            .args([
                "--embedding",
                "--pooling",
                "last",
                "--embd-normalize",
                "2",
                "--no-webui",
                "--ctx-size",
                "8192",
                "--batch-size",
                "8192",
                "--ubatch-size",
                "8192",
                "--parallel",
                "1",
                "--no-warmup",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn();
        let child = match child {
            Ok(child) => child,
            Err(error) => {
                let _ = std::fs::remove_dir(&directory);
                return Err(error).context("Could not start the local embedding runtime");
            }
        };
        let mut runner = Runner {
            child,
            socket,
            directory,
        };
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            if let Some(status) = runner.child.try_wait()? {
                bail!("Embedding runtime exited during startup: {status}");
            }
            if timeout(
                Duration::from_secs(2),
                http(&runner.socket, "GET", "/health", &[]),
            )
            .await
            .is_ok_and(|reply| reply.is_ok())
            {
                return Ok(runner);
            }
            ensure!(
                Instant::now() < deadline,
                "Embedding runtime did not become ready within 120 seconds"
            );
            sleep(Duration::from_millis(100)).await;
        }
    }
}

#[async_trait]
impl EmbeddingProvider for LlamaProvider {
    async fn embed(&self, texts: &[String], purpose: EmbeddingPurpose) -> Result<EmbeddingBatch> {
        ensure!(
            !texts.is_empty() && texts.len() <= MAX_BATCH,
            "Embed 1 to 16 texts per batch"
        );
        ensure!(
            texts
                .iter()
                .all(|text| !text.trim().is_empty() && text.len() <= MAX_TEXT_BYTES),
            "Embedding text must contain 1 to 8192 UTF-8 bytes"
        );
        let mut runner = self.runner.lock().await;
        if runner
            .as_mut()
            .is_some_and(|runner| runner.child.try_wait().is_ok_and(|status| status.is_some()))
        {
            *runner = None;
        }
        if runner.is_none() {
            *runner = Some(self.start().await?);
        }
        let socket = &runner
            .as_ref()
            .context("Embedding runtime did not start")?
            .socket;
        let input = texts.iter().map(|text| match purpose {
            EmbeddingPurpose::Query => format!("Instruct: Find conversations relevant to this request\nQuery: {text}<|endoftext|>"),
            EmbeddingPurpose::Document => format!("{text}<|endoftext|>"),
        }).collect();
        let body = serde_json::to_vec(&Request {
            input,
            encoding_format: "float",
        })?;
        let response = timeout(
            Duration::from_secs(180),
            http(socket, "POST", "/v1/embeddings", &body),
        )
        .await
        .context("Local embedding request timed out")??;
        let mut response: Response =
            serde_json::from_slice(&response).context("Embedding runtime returned invalid JSON")?;
        response.data.sort_by_key(|item| item.index);
        ensure!(
            response.data.len() == texts.len()
                && response
                    .data
                    .iter()
                    .enumerate()
                    .all(|(index, item)| item.index == index),
            "Embedding runtime returned missing or duplicate indexes"
        );
        let batch = EmbeddingBatch {
            space: EmbeddingSpace::qwen3(),
            vectors: response
                .data
                .into_iter()
                .map(|item| item.embedding)
                .collect(),
        };
        batch.validate(texts.len())?;
        Ok(batch)
    }
}

async fn http(socket: &Path, method: &str, route: &str, body: &[u8]) -> Result<Vec<u8>> {
    let mut stream = UnixStream::connect(socket).await?;
    let headers = format!(
        "{method} {route} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(headers.as_bytes()).await?;
    stream.write_all(body).await?;
    let mut response = Vec::new();
    stream
        .take(4 * 1024 * 1024 + 1)
        .read_to_end(&mut response)
        .await?;
    ensure!(
        response.len() <= 4 * 1024 * 1024,
        "Embedding response exceeds the local protocol budget"
    );
    let mut headers = [httparse::EMPTY_HEADER; 32];
    let mut parsed = httparse::Response::new(&mut headers);
    let httparse::Status::Complete(offset) = parsed.parse(&response)? else {
        bail!("Incomplete embedding HTTP response");
    };
    ensure!(
        parsed.code == Some(200),
        "Embedding runtime returned HTTP {}",
        parsed.code.unwrap_or(0)
    );
    Ok(response[offset..].to_vec())
}

#[cfg(test)]
mod tests {
    use crate::embeddings::{EmbeddingProvider, EmbeddingPurpose, llama::LlamaProvider};

    #[tokio::test]
    #[ignore = "requires the pinned local embedding runtime and model from nix develop"]
    async fn native_runner_is_private_warm_and_returns_retrieval_vectors() {
        let directory = tempfile::tempdir_in("/tmp").unwrap();
        let state = directory.path().join("a".repeat(36));
        let provider = LlamaProvider::from_environment(&state).unwrap();
        let documents = provider
            .embed(
                &[
                    "An automobile needs a replacement tire".into(),
                    "Bake a chocolate cake".into(),
                ],
                EmbeddingPurpose::Document,
            )
            .await
            .unwrap();
        let pid = provider
            .runner
            .lock()
            .await
            .as_ref()
            .unwrap()
            .child
            .id()
            .unwrap();
        let query = provider
            .embed(&["car wheel repair".into()], EmbeddingPurpose::Query)
            .await
            .unwrap();
        assert_eq!(
            provider.runner.lock().await.as_ref().unwrap().child.id(),
            Some(pid)
        );
        assert_eq!(documents.space, query.space);
        let similarity = |vector: &[f32]| {
            vector
                .iter()
                .zip(&query.vectors[0])
                .map(|(left, right)| left * right)
                .sum::<f32>()
        };
        assert!(similarity(&documents.vectors[0]) > similarity(&documents.vectors[1]));
        let socket = provider
            .runner
            .lock()
            .await
            .as_ref()
            .unwrap()
            .socket
            .clone();
        assert!(socket.exists());
        drop(provider);
        assert!(!socket.exists());
    }
}
