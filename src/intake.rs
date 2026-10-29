//! Bounded read-only source pages. Pi owns timing, admission and checkpoints.
use crate::{
    background::{SourcePollCursor, SourceRead},
    protocol::SourceState,
    sources::{SourceBatch, SourceConfig, SourceCoverage},
};
use anyhow::{Context, Result, ensure};

pub async fn poll(
    config: &[SourceConfig],
    states: &[SourceState],
    cursor: Option<SourcePollCursor>,
) -> Result<(Vec<SourceRead>, Option<SourcePollCursor>)> {
    let catalog = crate::sources::configured(config).await;
    let mut reads = Vec::new();
    if cursor.is_none() {
        for batch in catalog.failures {
            let expected_checkpoint = states
                .iter()
                .find(|state| state.source == batch.source)
                .and_then(|state| state.checkpoint.clone());
            reads.push(SourceRead {
                batch,
                expected_checkpoint,
            });
        }
    }
    let mut sources = catalog.sources.into_iter();
    let (source, page) = if let Some(cursor) = cursor {
        ensure!(cursor.page < 4, "Source continuation page is invalid");
        let source = sources
            .find(|source| source.key() == cursor.source)
            .context("Source accounts changed during collection; saved checkpoints are retained")?;
        (Some(source), cursor.page)
    } else {
        (sources.next(), 0)
    };
    let Some(source) = source else {
        return Ok((reads, None));
    };
    let key = source.key();
    let expected_checkpoint = states
        .iter()
        .find(|state| state.source == key)
        .and_then(|state| state.checkpoint.clone());
    let mut batch = source
        .poll(expected_checkpoint.as_ref())
        .await
        .unwrap_or_else(|_| SourceBatch {
            source: key.clone(),
            events: Vec::new(),
            checkpoint: None,
            coverage: SourceCoverage::Unavailable {
                message: "Source read failed; coverage is unknown".into(),
            },
        });
    // Each page is admitted before another is read. Keep room for protocol
    // framing even when provider normalization expands an unusually large page.
    if serde_json::to_vec(&batch)?.len() > crate::runtime::MAX_FRAME_BYTES / 2 {
        batch.events.clear();
        batch.checkpoint = None;
        batch.coverage = SourceCoverage::Partial {
            message: "Source page exceeds the transport limit; checkpoint retained".into(),
        };
    }
    let next = if batch.coverage == SourceCoverage::More && page < 3 {
        Some(SourcePollCursor {
            source: key,
            page: page + 1,
        })
    } else {
        sources.next().map(|source| SourcePollCursor {
            source: source.key(),
            page: 0,
        })
    };
    reads.push(SourceRead {
        batch,
        expected_checkpoint,
    });
    Ok((reads, next))
}
