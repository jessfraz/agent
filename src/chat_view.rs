//! A terminal view never claims the Rex worker's execution or effects.

use crate::{ClientContext, UiSession, connection, exchange, write_command};
use agent_cli::{
    protocol::{RuntimeCommand, RuntimeEventKind, SavedConversation},
    runtime::FrameReader,
    tui::TuiInfo,
};
use anyhow::{Context, Result, bail};
use tokio::{io::BufReader, task::JoinHandle};

pub(crate) struct View {
    pub(crate) token: uuid::Uuid,
    pub(crate) ready: tokio::sync::watch::Receiver<bool>,
    task: JoinHandle<()>,
}
impl Drop for View {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl View {
    pub(crate) async fn stop(mut self) {
        self.task.abort();
        let _ = (&mut self.task).await;
    }
}

pub(crate) async fn choices(
    client: ClientContext<'_>,
    query: String,
) -> Result<Vec<SavedConversation>> {
    let mut cursor = None;
    let mut items = Vec::new();
    // The picker is a bounded recent list. Exact/query lookups are filtered by
    // the native catalog before pagination, including original imported IDs.
    for _ in 0..10 {
        let page = exchange(
            client.config,
            client.coordinator,
            client.script,
            client.directory,
            RuntimeCommand::ListConversations {
                query: query.clone(),
                cursor,
                limit: 100,
            },
        )
        .await?
        .into_iter()
        .find_map(|event| match event {
            RuntimeEventKind::Conversations { items, next_cursor } => Some((items, next_cursor)),
            _ => None,
        })
        .context("The coordinator returned no saved conversations")?;
        items.extend(page.0);
        cursor = page.1;
        if cursor.is_none() {
            break;
        }
    }
    Ok(items)
}

pub(crate) fn exact<'a>(
    items: &'a [SavedConversation],
    query: &str,
) -> Option<&'a SavedConversation> {
    items
        .iter()
        .find(|item| item.conversation_id == query)
        .or_else(|| {
            items
                .iter()
                .find(|item| item.agent_id.as_deref() == Some(query))
        })
        .or_else(|| {
            items
                .iter()
                .find(|item| item.source_thread_id.as_deref() == Some(query))
        })
        .or_else(|| {
            items.iter().find(|item| {
                item.agent_id.is_none()
                    && item
                        .task_id
                        .as_ref()
                        .is_some_and(|id| id.to_string() == query)
            })
        })
}

pub(crate) async fn resume(
    client: ClientContext<'_>,
    ui: &mut UiSession,
    query: String,
) -> Result<bool> {
    if let Some(current) = &ui.conversation_id {
        ui.drafts.insert(current.clone(), ui.handle.draft().await?);
    }
    let items = choices(client, query.clone()).await?;
    let selected = if !query.is_empty() {
        exact(&items, &query).map(|item| item.conversation_id.clone())
    } else {
        None
    };
    let selected = match selected {
        Some(id) => Some(id),
        None => ui.handle.choose_conversation(items.clone(), query).await?,
    };
    let Some(id) = selected else {
        return Ok(false);
    };
    let item = items
        .into_iter()
        .find(|item| item.conversation_id == id)
        .context("The selected conversation is unavailable")?;
    open(client, ui, item).await?;
    Ok(true)
}

pub(crate) async fn open(
    client: ClientContext<'_>,
    ui: &mut UiSession,
    item: SavedConversation,
) -> Result<()> {
    if ui
        .selected
        .as_ref()
        .is_some_and(|current| current.conversation_id == item.conversation_id)
    {
        return Ok(());
    }
    let initial = ui.view.is_none() && ui.conversation_id.is_none() && ui.initial_replay.is_none();
    if let Some(current) = ui.conversation_id.clone() {
        ui.cancel_waiting(&current)?;
    }
    if let Some(view) = ui.view.take() {
        view.stop().await;
    }
    if let Some(history) = ui.history.take() {
        history.cancel().await;
    }
    // Cancel local reads/settings before their result can alter another view.
    ui.controls.abort_all();
    while ui.controls.join_next().await.is_some() {}
    let previous = ui.handle.info().await?;
    if !initial {
        ui.handle.reset_conversation(TuiInfo {
            title: item.title.clone(),
            ..previous
        })?;
    }
    if let Some(draft) = ui
        .drafts
        .get(&item.conversation_id)
        .filter(|draft| !draft.is_empty())
    {
        ui.handle.set_draft(draft.clone())?;
    }
    let mut input_ids = Vec::new();
    for input in &ui.pending_admissions {
        if input.conversation_id == item.conversation_id && input.retained()? {
            input_ids.push(input.id.clone());
            ui.handle
                .pending_input(input.id.clone(), input.text.clone(), input.mode)?;
            if input.stage()? == crate::chat_admission::Stage::Accepted {
                ui.handle.event(RuntimeEventKind::InputAccepted {
                    input_id: input.id.clone(),
                })?;
            }
        }
    }
    let replay = ui.handle.begin_history_replay()?;
    let (ready, attached) = tokio::sync::oneshot::channel();
    let (connected, readiness) = tokio::sync::watch::channel(false);
    ui.history = Some(crate::chat_history::Job::start(
        client,
        item.conversation_id.clone(),
        crate::chat_history::Start::AfterAttach(attached),
        replay,
    ));
    ui.conversation_id = Some(item.conversation_id.clone());
    ui.selected = Some(item.clone());
    let token = uuid::Uuid::new_v4();
    let sender = ui.view_sender.clone();
    let config = client.config.clone();
    let coordinator = client.coordinator.map(str::to_owned);
    let script = client.script.to_owned();
    let directory = client.directory.to_owned();
    let task = tokio::spawn(async move {
        let mut ready = Some(ready);
        let result: Result<()> = async {
            let mut wire =
                connection(&config, coordinator.as_deref(), &script, &directory, false).await?;
            write_command(
                &mut *wire.writer,
                &RuntimeCommand::AttachConversation {
                    conversation_id: item.conversation_id,
                    input_ids,
                },
            )
            .await?;
            let mut reader = FrameReader::new(BufReader::new(wire.reader));
            while let Some(frame) = reader.next_frame().await? {
                let event: RuntimeEventKind = serde_json::from_slice(&frame)?;
                if matches!(event, RuntimeEventKind::HostCall { .. }) {
                    bail!("An observing terminal cannot own execution effects");
                }
                if matches!(event, RuntimeEventKind::ConversationReady { .. })
                    && let Some(ready) = ready.take()
                {
                    let _ = ready.send(());
                    let _ = connected.send(true);
                }
                let done = matches!(event, RuntimeEventKind::Done);
                if sender.send((token, event)).is_err() {
                    return Ok(());
                }
                if done {
                    return Ok(());
                }
            }
            bail!("Conversation observation disconnected; saved work is retained")
        }
        .await;
        if let Err(error) = result {
            let _ = sender.send((
                token,
                RuntimeEventKind::Failure {
                    code: agent_cli::protocol::ErrorCode::Internal,
                    message: error.to_string(),
                },
            ));
        }
    });
    ui.view = Some(View {
        token,
        ready: readiness,
        task,
    });
    Ok(())
}

/// Control admission is streamed so a long-running turn never delays its receipt.
pub(crate) async fn control(
    client: ClientContext<'_>,
    command: RuntimeCommand,
    token: uuid::Uuid,
    sender: tokio::sync::mpsc::UnboundedSender<(uuid::Uuid, RuntimeEventKind)>,
    admission: &crate::chat_admission::Admission,
) -> Result<()> {
    let mut wire = connection(
        client.config,
        client.coordinator,
        client.script,
        client.directory,
        false,
    )
    .await?;
    if !admission.sending()? {
        return Ok(());
    }
    write_command(&mut *wire.writer, &command).await?;
    let mut reader = FrameReader::new(BufReader::new(wire.reader));
    while let Some(frame) = reader.next_frame().await? {
        let event: RuntimeEventKind = serde_json::from_slice(&frame)?;
        match event {
            RuntimeEventKind::Done => return Ok(()),
            RuntimeEventKind::HostCall { .. } => {
                bail!("The coordinator must own admitted execution effects")
            }
            RuntimeEventKind::InputAccepted { .. }
            | RuntimeEventKind::InputPlaced { .. }
            | RuntimeEventKind::InputRejected { .. }
            | RuntimeEventKind::Failure { .. } => {
                let _ = sender.send((token, event));
            }
            _ => {}
        }
    }
    bail!("Input connection ended; saved input may still be running")
}
