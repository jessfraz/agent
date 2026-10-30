//! Background replay of bounded native pages. The terminal remains interactive.

use crate::{ClientContext, exchange};
use agent_cli::{
    config::ClientConfig,
    protocol::{RuntimeCommand, RuntimeEventKind},
    tui::HistoryReplay,
};
use anyhow::{Context, Result, bail, ensure};
use std::{collections::HashSet, path::PathBuf};
use tokio::task::JoinHandle;

pub(crate) enum Start {
    AfterAttach(tokio::sync::oneshot::Receiver<()>),
    Recent,
    Older(String),
}

pub(crate) struct Job {
    task: JoinHandle<Result<()>>,
}

impl Job {
    pub(crate) fn start(
        client: ClientContext<'_>,
        conversation_id: String,
        start: Start,
        replay: HistoryReplay,
    ) -> Self {
        let config: ClientConfig = client.config.clone();
        let coordinator = client.coordinator.map(str::to_owned);
        let script: PathBuf = client.script.into();
        let directory: PathBuf = client.directory.into();
        Self {
            task: tokio::spawn(async move {
                let (mut cursor, mut attaching) = match start {
                    Start::Recent => (None, None),
                    Start::AfterAttach(ready) => (None, Some(ready)),
                    Start::Older(cursor) => (Some(cursor), None),
                };
                let mut seen: HashSet<String> = cursor.iter().cloned().collect();
                loop {
                    let events = match exchange(
                        &config,
                        coordinator.as_deref(),
                        &script,
                        &directory,
                        RuntimeCommand::ReadConversation {
                            conversation_id: conversation_id.clone(),
                            cursor: cursor.clone(),
                        },
                    )
                    .await
                    {
                        Ok(events) => events,
                        Err(error) if crate::chat_view::ViewError::is_transport(&error) => {
                            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                            continue;
                        }
                        Err(error) => return Err(error),
                    };
                    let mut complete = false;
                    for event in &events {
                        match event {
                            RuntimeEventKind::Failure { message, .. } => bail!("{message}"),
                            RuntimeEventKind::History {
                                conversation_id: returned,
                                next_cursor,
                                page_complete,
                                ..
                            } => {
                                ensure!(
                                    returned == &conversation_id,
                                    "History returned another conversation"
                                );
                                if *page_complete {
                                    cursor.clone_from(next_cursor);
                                    complete = true;
                                }
                            }
                            _ => {}
                        }
                    }
                    ensure!(complete, "The saved history page did not complete");
                    replay.page(events)?;
                    if let Some(ready) = attaching.take() {
                        // Show a bounded recent preview without waiting for the
                        // observer handshake. Read it again after attachment so
                        // commits between the two connections cannot be missed.
                        ready
                            .await
                            .context("The conversation view did not attach")?;
                        cursor = None;
                        continue;
                    }
                    if let Some(next) = &cursor {
                        ensure!(
                            seen.insert(next.clone()),
                            "The saved history page repeated its cursor"
                        );
                    }
                    if cursor.is_none() {
                        replay.finish()?;
                        return Ok(());
                    }
                }
            }),
        }
    }

    pub(crate) async fn cancel(mut self) {
        self.task.abort();
        let _ = (&mut self.task).await;
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        self.task.abort();
    }
}
