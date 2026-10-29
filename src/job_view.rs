//! Shared CLI and slash-command presentation of applied job state.
use crate::{background::ScheduledJobStatus, jobs::UtcMillis, protocol::RuntimeEventKind};

fn instant(value: Option<UtcMillis>, timezone: &str) -> String {
    let Some(value) = value else {
        return "none".into();
    };
    match (
        chrono::DateTime::from_timestamp_millis(value.get()),
        timezone.parse::<chrono_tz::Tz>(),
    ) {
        (Some(value), Ok(timezone)) => value
            .with_timezone(&timezone)
            .format("%Y-%m-%d %H:%M %Z")
            .to_string(),
        _ => "unknown".into(),
    }
}

pub fn list(jobs: &[ScheduledJobStatus]) -> String {
    if jobs.is_empty() {
        return "No scheduled jobs. Apply the Git-managed files with agent jobs sync.".into();
    }
    let mut lines = vec![
        "| Job | Next run | Model |".into(),
        "| --- | --- | --- |".into(),
    ];
    for status in jobs {
        let next = status
            .schedules
            .iter()
            .filter_map(|schedule| schedule.next_at)
            .min();
        let errors = status
            .schedules
            .iter()
            .filter(|schedule| schedule.error.is_some())
            .count();
        lines.push(format!(
            "| {}{} | {} | {} |",
            status.job.id,
            if errors == 0 {
                ""
            } else {
                " (needs attention)"
            },
            instant(next, status.job.timezone.as_str()),
            status.job.model.model_id
        ));
    }
    lines.join("\n")
}

pub fn get(status: &ScheduledJobStatus) -> String {
    let job = &status.job;
    let mut lines = vec![
        format!("{} ({})", job.title, job.id),
        format!(
            "Model: {}/{}",
            job.model.provider.as_str(),
            job.model.model_id
        ),
        format!(
            "Reasoning: {}",
            job.model
                .reasoning
                .map(|value| value.as_str())
                .unwrap_or("default")
        ),
        format!("Fast: {}", job.model.fast),
        format!("Timezone: {}", job.timezone),
        format!("Directory: {}", job.cwd),
        format!("Revision: {}", job.revision),
        String::new(),
        job.prompt.clone(),
    ];
    for schedule in &job.schedules {
        let current = status
            .schedules
            .iter()
            .find(|current| current.schedule_id == schedule.id);
        lines.push(format!(
            "\nSchedule: {}\n{}",
            schedule.id,
            schedule.recurrence.as_str()
        ));
        if let Some(current) = current {
            lines.push(format!(
                "Next: {}\nLast admitted: {}",
                instant(current.next_at, job.timezone.as_str()),
                instant(current.last_at, job.timezone.as_str())
            ));
            if let Some(error) = &current.error {
                lines.push(format!("Error: {error}"));
            }
        }
        if let Some(prompt) = &schedule.prompt {
            lines.push(format!(
                "Focus: {}\n{prompt}",
                schedule.focus.as_deref().unwrap_or("scheduled pass")
            ));
        }
    }
    lines.join("\n")
}

pub fn event(event: &RuntimeEventKind) -> Option<String> {
    match event {
        RuntimeEventKind::ScheduledJobs { jobs } => Some(list(jobs)),
        RuntimeEventKind::ScheduledJob { job } => Some(get(job)),
        RuntimeEventKind::JobsSynced { report } => Some(format!(
            "Jobs: {} added, {} updated, {} removed, {} unchanged",
            report.added, report.updated, report.removed, report.unchanged
        )),
        _ => None,
    }
}
