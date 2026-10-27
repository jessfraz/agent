//! Bounded Messages reads for the existing trusted Rex process. This helper
//! does not load agent state, choose credentials or evaluate shell commands.

use std::{path::Path, time::Duration};

use anyhow::{Context, Result, bail, ensure};
use tokio::signal::unix::{SignalKind, signal};

use crate::{host, protocol::HostResult, runtime::MAX_FRAME_BYTES, sources::ReadOutput};

fn command(argv: &[String]) -> Result<(&str, &[String])> {
    let (program, args) = argv
        .split_first()
        .context("Messages read command is empty")?;
    let method = args.first().map(String::as_str);
    let allowed = match Path::new(program)
        .file_name()
        .and_then(|name| name.to_str())
    {
        Some("messages") => matches!(method, Some("chats" | "read" | "doctor")),
        Some("switchboard") => matches!(
            method,
            Some("messages.chats.list" | "messages.chats.read" | "messages.doctor")
        ),
        _ => false,
    };
    ensure!(allowed, "Only read-only Messages commands are supported");
    Ok((program, args))
}

pub async fn capture(argv: &[String]) -> Result<ReadOutput> {
    let (program, args) = command(argv)?;
    // Install both handlers before the child exists. A signal follows the
    // runner's ordinary cleanup path rather than abandoning a detached child.
    let mut terminate = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    let result = host::run_process_until(
        program,
        args,
        Path::new("/"),
        Duration::from_secs(host::DEFAULT_TIMEOUT_SECONDS.into()),
        MAX_FRAME_BYTES / 2,
        async move {
            tokio::select! {
                _ = terminate.recv() => {},
                _ = interrupt.recv() => {},
            }
        },
    )
    .await?;
    match result {
        HostResult::Process {
            exit_code,
            stdout,
            truncated,
            ..
        } => Ok(ReadOutput {
            exit_code,
            stdout,
            truncated,
        }),
        _ => bail!("Messages read did not return a process result"),
    }
}

#[cfg(test)]
mod tests {
    use crate::sources::messages_read::command;

    #[test]
    fn read_methods_preserve_literal_arguments_and_reject_other_programs_or_methods() {
        for (program, methods) in [
            ("messages", ["chats", "read", "doctor"]),
            (
                "/example/bin/switchboard",
                [
                    "messages.chats.list",
                    "messages.chats.read",
                    "messages.doctor",
                ],
            ),
        ] {
            for method in methods {
                let argv = vec![
                    program.into(),
                    method.into(),
                    "--json".into(),
                    "--".into(),
                    "$(literal);*.chat".into(),
                ];
                let (selected, args) = command(&argv).unwrap();
                assert_eq!(selected, program);
                assert_eq!(args, &argv[1..]);
            }
        }
        for argv in [
            vec![],
            vec!["messages".into()],
            vec!["messages".into(), "send".into()],
            vec!["switchboard".into(), "messages.send".into()],
            vec!["switchboard".into(), "google.mail.send".into()],
            vec!["sh".into(), "-c".into(), "messages doctor".into()],
        ] {
            assert!(command(&argv).is_err());
        }
    }
}
