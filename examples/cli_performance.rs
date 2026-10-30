//! Paired process-to-visible-conversation benchmarks, using the real CLI and Pi.

use std::{
    fs,
    io::Write,
    num::NonZeroU16,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail, ensure};
use clap::{Parser, ValueEnum};
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
    time::{sleep, timeout},
};

const DEADLINE: Duration = Duration::from_secs(20);

#[derive(Parser)]
#[command(about = "Measure actual CLI conversation rendering against a paired baseline")]
struct Arguments {
    #[arg(long)]
    baseline: PathBuf,
    #[arg(long)]
    baseline_runtime: PathBuf,
    #[arg(long)]
    candidate: PathBuf,
    #[arg(long)]
    candidate_runtime: PathBuf,
    #[arg(long)]
    terminal: PathBuf,
    /// Compiled runtime/test/fixtures/performance.js.
    #[arg(long)]
    seed: PathBuf,
    #[arg(long, default_value_t = 7, value_parser = clap::value_parser!(u8).range(3..=31))]
    samples: u8,
    #[arg(long, default_value = "performance/results.json")]
    output: PathBuf,
}

#[derive(Clone, Copy, Debug, Serialize, ValueEnum, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Scenario {
    ChiefCold,
    Chief,
    LongHistory,
}

impl Scenario {
    fn sentence(self) -> &'static str {
        match self {
            Self::ChiefCold | Self::Chief => "Stored chief conversation is ready.",
            Self::LongHistory => "Stored long conversation is ready.",
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Version {
    Baseline,
    Candidate,
}

#[derive(Deserialize)]
struct Seed {
    chief: String,
    long_history: String,
}

#[derive(Serialize)]
struct Sample {
    scenario: Scenario,
    version: Version,
    pair: u8,
    warmup: bool,
    first_conversation_ms: f64,
    received_bytes: usize,
}

#[derive(Serialize)]
struct Comparison {
    scenario: Scenario,
    baseline_median_ms: f64,
    candidate_median_ms: f64,
    allowed_ms: f64,
    passed: bool,
}

#[derive(Serialize)]
struct Report {
    schema: u8,
    metric: &'static str,
    terminal_rows: u16,
    terminal_columns: u16,
    long_history_messages: u32,
    unrelated_saved_conversations: u32,
    relative_allowance: f64,
    absolute_allowance_ms: f64,
    samples: Vec<Sample>,
    comparisons: Vec<Comparison>,
}

/// The emulator owns actual cursor position, including printed characters and
/// scrolling. Cursor replies travel through the fixture's existing input owner.
#[derive(Default)]
struct Replies(Vec<u8>);
impl vt100::Callbacks for Replies {
    fn unhandled_csi(
        &mut self,
        screen: &mut vt100::Screen,
        first: Option<u8>,
        second: Option<u8>,
        parameters: &[&[u16]],
        command: char,
    ) {
        if first.is_none()
            && second.is_none()
            && command == 'n'
            && parameters.len() == 1
            && parameters[0] == [6]
        {
            let (row, column) = screen.cursor_position();
            self.0
                .extend(format!("\x1b[{};{}R", row + 1, column + 1).bytes());
        }
    }
}

fn terminal() -> Result<vt100::Parser<Replies>> {
    Ok(vt100::Parser::new_with_callbacks(
        NonZeroU16::new(32).context("Invalid terminal height")?,
        NonZeroU16::new(100).context("Invalid terminal width")?,
        0,
        Replies::default(),
    ))
}

fn isolated(command: &mut Command, directory: &Path) -> Result<()> {
    let bin = directory.join("bin");
    if !bin.exists() {
        fs::create_dir(&bin)?;
        let paths = std::env::var_os("PATH").context("PATH is required")?;
        let node = std::env::split_paths(&paths)
            .map(|path| path.join("node"))
            .find(|path| path.is_file())
            .context("Node is required")?;
        std::os::unix::fs::symlink(fs::canonicalize(node)?, bin.join("node"))?;
    }
    command
        .env_clear()
        .env("PATH", bin)
        .env("HOME", directory)
        .env("XDG_CONFIG_HOME", directory.join("config"))
        .env("XDG_DATA_HOME", directory.join("data"))
        .env("TERM", "xterm-256color")
        .env("LANG", "C.UTF-8")
        .current_dir(directory)
        .kill_on_drop(true);
    Ok(())
}

struct Coordinator {
    child: Child,
    directory: tempfile::TempDir,
}

impl Coordinator {
    async fn start(binary: &Path, seed: &Path, runtime: &Path, snapshot: &Path) -> Result<Self> {
        let directory = tempfile::tempdir()?;
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700))?;
        for entry in fs::read_dir(snapshot)? {
            let entry = entry?;
            if entry.file_type()?.is_file() {
                fs::copy(entry.path(), directory.path().join(entry.file_name()))?;
            }
        }
        fs::write(directory.path().join("config.toml"), "")?;
        fs::write(directory.path().join("AGENTS.md"), "")?;
        let mut command = Command::new(binary);
        command
            .arg("--state-dir")
            .arg(directory.path())
            .arg("--config")
            .arg(directory.path().join("config.toml"))
            .arg("--instructions")
            .arg(directory.path().join("AGENTS.md"))
            .arg("--runtime")
            .arg(seed)
            .arg("serve")
            .arg("--local-only")
            .arg("--no-sources")
            .arg("--coordinator-only")
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        isolated(&mut command, directory.path())?;
        // isolated clears inherited credentials; this is the one explicit runtime.
        command.env("AGENT_PERFORMANCE_RUNTIME", runtime);
        let child = command.spawn()?;
        let mut coordinator = Self { child, directory };
        timeout(DEADLINE, async {
            loop {
                if agent_cli::service::connect(coordinator.directory.path())
                    .await
                    .is_ok()
                {
                    return Ok::<_, anyhow::Error>(());
                }
                if let Some(status) = coordinator.child.try_wait()? {
                    bail!("Synthetic coordinator exited before binding: {status}");
                }
                sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .context("Synthetic coordinator did not bind")??;
        Ok(coordinator)
    }

    async fn close(self) -> Result<()> {
        if let Some(pid) = self.child.id() {
            // Only this fixture-owned coordinator is signaled and reaped.
            ensure!(unsafe { libc::kill(i32::try_from(pid)?, libc::SIGTERM) } == 0);
        }
        let output = timeout(DEADLINE, self.child.wait_with_output())
            .await
            .context("Synthetic coordinator did not shut down")??;
        ensure!(
            output.status.success(),
            "Synthetic coordinator failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        Ok(())
    }
}

async fn sample(
    options: &Arguments,
    coordinator: &Coordinator,
    binary: &Path,
    scenario: Scenario,
    seed: &Seed,
    version: Version,
    pair: u8,
) -> Result<Sample> {
    let directory = coordinator.directory.path();
    let mut command = Command::new(&options.terminal);
    command
        .arg(binary)
        .arg("--state-dir")
        .arg(directory)
        .arg("--config")
        .arg(directory.join("config.toml"))
        .arg("--instructions")
        .arg(directory.join("AGENTS.md"))
        .arg("--runtime")
        .arg(match version {
            Version::Baseline => &options.baseline_runtime,
            Version::Candidate => &options.candidate_runtime,
        })
        .arg("chat");
    if scenario == Scenario::LongHistory {
        command.arg(format!("/resume {}", seed.long_history));
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    isolated(&mut command, directory)?;
    let started = Instant::now();
    let mut child = command.spawn()?;
    let mut input = child.stdin.take().context("Missing terminal input")?;
    let mut output = child.stdout.take().context("Missing terminal output")?;
    let mut screen = terminal()?;
    let mut received = 0;
    let measured = timeout(DEADLINE, async {
        let mut buffer = [0; 8192];
        loop {
            let length = output.read(&mut buffer).await?;
            ensure!(
                length != 0,
                "CLI exited before showing stored conversation text"
            );
            screen.process(&buffer[..length]);
            received += length;
            if !screen.callbacks().0.is_empty() {
                input
                    .write_all(&std::mem::take(&mut screen.callbacks_mut().0))
                    .await?;
            }
            if screen.screen().contents().contains(scenario.sentence()) {
                return Ok::<_, anyhow::Error>(started.elapsed().as_secs_f64() * 1000.0);
            }
        }
    })
    .await
    .context("Stored conversation text did not become visible")
    .and_then(|result| result);
    let measured = match measured {
        Ok(measured) => measured,
        Err(error) => {
            if child.try_wait()?.is_none() {
                child.start_kill()?;
            }
            let status = child.wait_with_output().await?;
            bail!(
                "{error:#}; terminal status: {}; stderr: {}; visible screen: {}",
                status.status,
                String::from_utf8_lossy(&status.stderr),
                screen.screen().contents()
            );
        }
    };
    // Keep output draining during terminal cleanup and any final cursor query.
    input.write_all(b"/exit\r").await?;
    let drain = async {
        let mut buffer = [0; 8192];
        loop {
            let length = output.read(&mut buffer).await?;
            if length == 0 {
                return Ok::<_, anyhow::Error>(());
            }
            screen.process(&buffer[..length]);
            received += length;
            input
                .write_all(&std::mem::take(&mut screen.callbacks_mut().0))
                .await?;
        }
    };
    let (status, drained) = timeout(DEADLINE, async {
        tokio::join!(child.wait_with_output(), drain)
    })
    .await
    .context("CLI terminal cleanup did not finish")?;
    drained?;
    let status = status?;
    ensure!(
        status.status.success(),
        "CLI failed: {}; screen: {}",
        String::from_utf8_lossy(&status.stderr),
        screen.screen().contents()
    );
    Ok(Sample {
        scenario,
        version,
        pair,
        warmup: pair == 0,
        first_conversation_ms: measured,
        received_bytes: received,
    })
}

fn comparisons(samples: &[Sample]) -> Vec<Comparison> {
    Scenario::value_variants()
        .iter()
        .map(|scenario| {
            let median = |version| {
                let mut values = samples
                    .iter()
                    .filter(|sample| {
                        sample.scenario == *scenario && sample.version == version && !sample.warmup
                    })
                    .map(|sample| sample.first_conversation_ms)
                    .collect::<Vec<_>>();
                values.sort_by(f64::total_cmp);
                values[values.len() / 2]
            };
            let baseline = median(Version::Baseline);
            let candidate = median(Version::Candidate);
            let allowed = (baseline * 1.25).max(baseline + 20.0);
            Comparison {
                scenario: *scenario,
                baseline_median_ms: baseline,
                candidate_median_ms: candidate,
                allowed_ms: allowed,
                passed: candidate <= allowed,
            }
        })
        .collect()
}

async fn run(mut options: Arguments) -> Result<()> {
    if let Some(parent) = options.output.parent() {
        fs::create_dir_all(parent)?;
    }
    for previous in [
        &options.output,
        &options.output.with_extension("failure.json"),
    ] {
        match fs::remove_file(previous) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    let mut raw = fs::File::create(options.output.with_extension("jsonl"))?;
    for path in [
        &mut options.baseline,
        &mut options.baseline_runtime,
        &mut options.candidate,
        &mut options.candidate_runtime,
        &mut options.terminal,
        &mut options.seed,
    ] {
        *path = fs::canonicalize(&*path)
            .with_context(|| format!("Could not locate {}", path.display()))?;
    }
    let snapshot = tempfile::tempdir()?;
    fs::set_permissions(snapshot.path(), fs::Permissions::from_mode(0o700))?;
    let mut command = Command::new("node");
    command.arg(&options.seed).arg(snapshot.path());
    isolated(&mut command, snapshot.path())?;
    let seeded = timeout(Duration::from_secs(60), command.output())
        .await
        .context("Synthetic history seeding did not finish")??;
    ensure!(
        seeded.status.success(),
        "Could not seed native history: {}",
        String::from_utf8_lossy(&seeded.stderr)
    );
    let seed: Seed = serde_json::from_slice(&seeded.stdout)?;
    ensure!(
        !seed.chief.is_empty(),
        "The native chief conversation is missing"
    );
    let baseline = Coordinator::start(
        &options.baseline,
        &options.seed,
        &options.baseline_runtime,
        snapshot.path(),
    )
    .await?;
    let candidate = match Coordinator::start(
        &options.candidate,
        &options.seed,
        &options.candidate_runtime,
        snapshot.path(),
    )
    .await
    {
        Ok(candidate) => candidate,
        Err(error) => {
            if let Err(cleanup) = baseline.close().await {
                return Err(error.context(format!("Baseline cleanup failed: {cleanup:#}")));
            }
            return Err(error);
        }
    };
    let measured = async {
        let mut samples = Vec::new();
        for scenario in Scenario::value_variants() {
            for pair in 0..=options.samples {
                let order = if pair % 2 == 0 {
                    [Version::Baseline, Version::Candidate]
                } else {
                    [Version::Candidate, Version::Baseline]
                };
                for version in order {
                    let (coordinator, binary, runtime) = match version {
                        Version::Baseline => {
                            (&baseline, &options.baseline, &options.baseline_runtime)
                        }
                        Version::Candidate => {
                            (&candidate, &options.candidate, &options.candidate_runtime)
                        }
                    };
                    let cold = if *scenario == Scenario::ChiefCold {
                        Some(
                            Coordinator::start(binary, &options.seed, runtime, snapshot.path())
                                .await?,
                        )
                    } else {
                        None
                    };
                    let measured = sample(
                        &options,
                        cold.as_ref().unwrap_or(coordinator),
                        binary,
                        *scenario,
                        &seed,
                        version,
                        pair,
                    )
                    .await;
                    let closed = match cold {
                        Some(coordinator) => coordinator.close().await,
                        None => Ok(()),
                    };
                    let sample = measured?;
                    closed?;
                    serde_json::to_writer(&mut raw, &sample)?;
                    raw.write_all(b"\n")?;
                    raw.flush()?;
                    samples.push(sample);
                }
            }
        }
        Ok::<_, anyhow::Error>(samples)
    }
    .await;
    let closed_baseline = baseline.close().await;
    let closed_candidate = candidate.close().await;
    let samples = measured?;
    closed_baseline?;
    closed_candidate?;
    let report = Report {
        schema: 1,
        metric: "process_spawn_to_visible_conversation",
        terminal_rows: 32,
        terminal_columns: 100,
        long_history_messages: 5_000,
        unrelated_saved_conversations: 3_000,
        relative_allowance: 0.25,
        absolute_allowance_ms: 20.0,
        comparisons: comparisons(&samples),
        samples,
    };
    fs::write(&options.output, serde_json::to_vec_pretty(&report)?)?;
    for comparison in &report.comparisons {
        println!(
            "{:?}: base {:.1} ms, candidate {:.1} ms, limit {:.1} ms, {}",
            comparison.scenario,
            comparison.baseline_median_ms,
            comparison.candidate_median_ms,
            comparison.allowed_ms,
            if comparison.passed {
                "pass"
            } else {
                "REGRESSION"
            }
        );
    }
    ensure!(
        report.comparisons.iter().all(|result| result.passed),
        "CLI rendering regressed; raw samples are in {}",
        options.output.display()
    );
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let options = Arguments::parse();
    let failure = options.output.with_extension("failure.json");
    let result = run(options).await;
    if let Err(error) = &result {
        #[derive(Serialize)]
        struct Failure {
            error: String,
        }
        fs::write(
            failure,
            serde_json::to_vec_pretty(&Failure {
                error: format!("{error:#}"),
            })?,
        )?;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn screen_observation_requires_visible_cells_and_replies_from_the_real_cursor() {
        let mut screen = terminal().unwrap();
        let sentence = Scenario::Chief.sentence();
        screen.process(sentence.as_bytes());
        screen.process(b"\x1b[2J\x1b[H");
        assert!(!screen.screen().contents().contains(sentence));
        screen.process(b"Storedchief");
        screen.process(b"\x1b[1;7H chief conversation is ready.");
        assert!(screen.screen().contents().contains(sentence));
        screen.process(b"\x1b[6n");
        assert_eq!(screen.callbacks().0, b"\x1b[1;36R");
    }

    #[test]
    fn paired_gate_excludes_warmups_and_rejects_a_material_visible_text_regression() {
        let samples = Scenario::value_variants()
            .iter()
            .flat_map(|scenario| {
                [(Version::Baseline, 100.0), (Version::Candidate, 140.0)]
                    .into_iter()
                    .flat_map(move |(version, milliseconds)| {
                        (0..=3).map(move |pair| Sample {
                            scenario: *scenario,
                            version,
                            pair,
                            warmup: pair == 0,
                            first_conversation_ms: if pair == 0 { 5_000.0 } else { milliseconds },
                            received_bytes: 1,
                        })
                    })
            })
            .collect::<Vec<_>>();
        for result in comparisons(&samples) {
            assert_eq!(result.baseline_median_ms, 100.0);
            assert_eq!(result.allowed_ms, 125.0);
            assert!(!result.passed);
        }
    }
}
