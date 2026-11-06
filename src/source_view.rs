//! Explicit source inspection. Background warnings stay concise and ephemeral.
use crate::{protocol::SourceState, sources::SourceCoverage};

pub fn format(sources: &[SourceState]) -> String {
    if sources.is_empty() {
        return "No source checks recorded.".into();
    }
    sources
        .iter()
        .map(|source| {
            let (status, diagnostic) = match &source.coverage {
                SourceCoverage::Complete => ("current", None),
                SourceCoverage::More => ("catching up", None),
                SourceCoverage::Partial { message } => ("partial", Some(message)),
                SourceCoverage::Unavailable { message } => ("unavailable", Some(message)),
            };
            let checked = i64::try_from(source.checked_at)
                .ok()
                .filter(|value| *value > 0)
                .and_then(chrono::DateTime::from_timestamp_millis)
                .map(|value| {
                    value
                        .with_timezone(&chrono::Local)
                        .format("%Y-%m-%d %H:%M:%S %Z")
                        .to_string()
                })
                .unwrap_or_else(|| "not checked".into());
            let mut text = format!(
                "{} / {}: {status}\nLast checked: {checked}",
                source.source.provider, source.source.account
            );
            if let Some(diagnostic) = diagnostic {
                text.push_str("\nError: ");
                text.push_str(diagnostic);
            }
            text
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}
