use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::{fs::PermissionsExt, net::UnixStream},
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

use agent_cli::{
    background::{BackgroundStatus, JobSyncReport, ScheduledJobStatus},
    jobs::{JobId, ScheduleId, TimezoneId, UtcMillis},
    protocol::{RuntimeCommand, RuntimeEventKind},
};
use serde::{Deserialize, Serialize};

const JOB_ID: &str = "Daily_Review.v2";

struct Fixture {
    directory: tempfile::TempDir,
    config: PathBuf,
    state: PathBuf,
    jobs: PathBuf,
    bin: PathBuf,
    instructions: PathBuf,
}

#[derive(Serialize)]
struct Config {
    job_directories: Vec<PathBuf>,
    poll_interval_seconds: u32,
}

#[derive(Debug, Deserialize)]
struct Preview {
    job_id: JobId,
    schedule_id: ScheduleId,
    timezone: TimezoneId,
    occurrences: Vec<UtcMillis>,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let config = directory.path().join("config.toml");
        let state = directory.path().join("state");
        let jobs = directory.path().join("jobs");
        let bin = directory.path().join("bin");
        let instructions = directory.path().join("AGENTS.md");
        for path in [&state, &jobs, &bin] {
            fs::create_dir(path).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        fs::write(
            &config,
            toml::to_string(&Config {
                job_directories: vec![jobs.clone()],
                poll_interval_seconds: 60,
            })
            .unwrap(),
        )
        .unwrap();
        fs::write(&instructions, "Use only invented fixture data.\n").unwrap();
        for name in ["rex", "tailscale"] {
            executable(&bin.join(name), "#!/bin/sh\nexit 1\n");
        }
        executable(
            &bin.join("switchboard"),
            "#!/bin/sh\nprintf '%s\\n' unexpected >> \"$AGENT_TEST_EXTERNAL_CALLS\"\nexit 1\n",
        );
        Self {
            directory,
            config,
            state,
            jobs,
            bin,
            instructions,
        }
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_agent"));
        let runtime = std::env::var_os("AGENT_RUNTIME_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                Path::new(env!("CARGO_MANIFEST_DIR")).join("runtime/dist/src/bridge.js")
            });
        let mut paths = vec![self.bin.clone()];
        paths.extend(std::env::split_paths(&std::env::var_os("PATH").unwrap()));
        command
            .args(["--json", "--config"])
            .arg(&self.config)
            .arg("--state-dir")
            .arg(&self.state)
            .arg("--runtime")
            .arg(runtime)
            .arg("--instructions")
            .arg(&self.instructions)
            .args(args)
            .env("PATH", std::env::join_paths(paths).unwrap())
            .env(
                "AGENT_TEST_EXTERNAL_CALLS",
                self.directory.path().join("external-calls"),
            )
            .stdin(Stdio::null());
        command
    }

    fn cli(&self, args: &[&str]) -> Output {
        let mut child = self
            .command(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        while child.try_wait().unwrap().is_none() {
            if Instant::now() >= deadline {
                child.kill().unwrap();
                let output = child.wait_with_output().unwrap();
                panic!(
                    "Fixture command {args:?} timed out: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            thread::sleep(Duration::from_millis(10));
        }
        child.wait_with_output().unwrap()
    }

    fn events(&self, args: &[&str]) -> Vec<RuntimeEventKind> {
        let output = self.cli(args);
        assert!(
            output.status.success(),
            "Fixture command {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        output
            .stdout
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).unwrap())
            .collect()
    }

    fn sync(&self) -> JobSyncReport {
        self.sync_args(&["jobs", "sync"])
    }

    fn sync_args(&self, args: &[&str]) -> JobSyncReport {
        self.events(args)
            .into_iter()
            .find_map(|event| match event {
                RuntimeEventKind::JobsSynced { report } => Some(report),
                _ => None,
            })
            .expect("Sync must return its applied catalog receipt")
    }

    fn list(&self) -> Vec<ScheduledJobStatus> {
        self.events(&["jobs", "list"])
            .into_iter()
            .find_map(|event| match event {
                RuntimeEventKind::ScheduledJobs { jobs } => Some(jobs),
                _ => None,
            })
            .expect("List must return the applied job catalog")
    }

    fn get(&self) -> ScheduledJobStatus {
        self.events(&["jobs", "get", JOB_ID])
            .into_iter()
            .find_map(|event| match event {
                RuntimeEventKind::ScheduledJob { job } => Some(job),
                _ => None,
            })
            .expect("Get must return the applied job definition")
    }

    fn planned(&self) -> ScheduledJobStatus {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let job = self.get();
            if job
                .schedules
                .iter()
                .all(|schedule| schedule.next_at.is_some())
            {
                return job;
            }
            assert!(
                Instant::now() < deadline,
                "Native job planning did not finish"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn status(&self) -> BackgroundStatus {
        let mut stream = UnixStream::connect(self.state.join("agent.sock")).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        serde_json::to_writer(&mut stream, &RuntimeCommand::JobStatus).unwrap();
        stream.write_all(b"\n").unwrap();
        let mut reader = BufReader::new(stream);
        loop {
            let mut line = String::new();
            assert_ne!(
                reader.read_line(&mut line).unwrap(),
                0,
                "Status stream ended without a response"
            );
            match serde_json::from_str::<RuntimeEventKind>(&line).unwrap() {
                RuntimeEventKind::JobStatus { status } => return status,
                RuntimeEventKind::Failure { message, .. } => panic!("Status failed: {message}"),
                RuntimeEventKind::Done => panic!("Status completed without a response"),
                _ => {}
            }
        }
    }

    fn start(&self) -> Server {
        let stderr = self.directory.path().join("server.stderr");
        let child = self
            .command(&["serve", "--local-only", "--no-sources"])
            .stdout(Stdio::null())
            .stderr(fs::File::create(&stderr).unwrap())
            .spawn()
            .unwrap();
        let mut server = Server(Some(child));
        let deadline = Instant::now() + Duration::from_secs(10);
        while !self.state.join("agent.sock").exists() {
            assert!(
                server.0.as_mut().unwrap().try_wait().unwrap().is_none(),
                "Fixture coordinator exited before binding: {}",
                fs::read_to_string(&stderr).unwrap()
            );
            assert!(
                Instant::now() < deadline,
                "Fixture coordinator did not bind"
            );
            thread::sleep(Duration::from_millis(10));
        }
        server
    }
}

struct Server(Option<Child>);

impl Server {
    fn stop(&mut self) {
        if let Some(mut child) = self.0.take() {
            // Only the coordinator process started by this fixture is signalled.
            let pid = libc::pid_t::try_from(child.id()).unwrap();
            unsafe { libc::kill(pid, libc::SIGTERM) };
            let deadline = Instant::now() + Duration::from_secs(10);
            while child.try_wait().unwrap().is_none() {
                if Instant::now() >= deadline {
                    child.kill().unwrap();
                    child.wait().unwrap();
                    assert!(
                        thread::panicking(),
                        "Fixture coordinator did not stop gracefully"
                    );
                    return;
                }
                thread::sleep(Duration::from_millis(10));
            }
            assert!(
                child.wait().unwrap().success() || thread::panicking(),
                "Fixture coordinator shutdown failed"
            );
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop();
    }
}

fn executable(path: &Path, content: &str) {
    fs::write(path, content).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

fn definition(prompt: &str, hour: u8) -> String {
    format!(
        "id = \"{JOB_ID}\"\nprompt = {prompt:?}\nmodel = \"fixture\"\nreasoning_effort = \"medium\"\ntimezone = \"UTC\"\n\n[[schedules]]\nid = \"Morning.v1\"\nrecurrence = \"DTSTART:20990101T{hour:02}0000Z\\nRRULE:FREQ=DAILY;BYHOUR={hour};BYMINUTE=0;BYSECOND=0\"\n"
    )
}

#[test]
fn real_cli_reconciles_files_preserves_builtins_and_reopens_durable_deadlines() {
    let fixture = Fixture::new();
    let mut server = fixture.start();
    assert!(fixture.list().is_empty());
    let baseline = fixture.status();
    assert_eq!(baseline.jobs, 0);
    assert_eq!(
        baseline.triggers, 2,
        "Sources and resources use native built-in triggers even with external sources disabled"
    );

    let file = fixture.jobs.join("review.toml");
    fs::write(
        &file,
        definition("Review changes and continue existing tasks.", 9),
    )
    .unwrap();
    let output = fixture.cli(&["jobs", "check", "--next", "2"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let preview: Vec<Preview> = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(preview.len(), 1);
    assert_eq!(preview[0].job_id.as_str(), JOB_ID);
    assert_eq!(preview[0].schedule_id.as_str(), "Morning.v1");
    assert_eq!(preview[0].timezone.as_str(), "UTC");
    assert_eq!(preview[0].occurrences.len(), 2);
    assert!(
        fixture.list().is_empty(),
        "Checking files must not apply them"
    );

    assert_eq!(fixture.sync().added, 1);
    let original = fixture.planned();
    assert_eq!(
        original.schedules[0].next_at,
        Some(preview[0].occurrences[0])
    );
    assert_eq!(original.job.model.model_id, "fixture");
    assert_eq!(fixture.status().triggers, baseline.triggers + 1);

    let edited = definition(
        "Review the updated evidence and continue existing tasks.",
        10,
    );
    fs::write(&file, &edited).unwrap();
    assert_eq!(fixture.sync().updated, 1);
    let updated = fixture.planned();
    assert_ne!(updated.job.revision, original.job.revision);
    assert_eq!(updated.job.id, original.job.id);
    assert_ne!(updated.schedules[0].next_at, original.schedules[0].next_at);
    assert!(updated.job.prompt.contains("updated evidence"));

    let duplicate = fixture.jobs.join("copied.toml");
    fs::write(&duplicate, &edited).unwrap();
    let output = fixture.cli(&["jobs", "sync"]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("Duplicate scheduled job ID"));
    assert_eq!(fixture.get().job.revision, updated.job.revision);
    fs::remove_file(&duplicate).unwrap();
    let (_, schedule) = edited.split_once("[[schedules]]").unwrap();
    fs::write(&file, format!("{edited}\n[[schedules]]{schedule}")).unwrap();
    let output = fixture.cli(&["jobs", "sync"]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("Duplicate schedule ID"));
    assert_eq!(fixture.get().job.revision, updated.job.revision);
    fs::write(&file, &edited).unwrap();

    let slash = fixture.events(&["chat", "/jobs"]);
    assert!(slash.iter().any(|event| matches!(event, RuntimeEventKind::ScheduledJobs { jobs } if jobs.len() == 1 && jobs[0].job.id.as_str() == JOB_ID)));

    server.stop();
    assert!(!fixture.state.join("agent.sock").exists());
    fs::write(&duplicate, &edited).unwrap();
    server = fixture.start();
    let restored = fixture.planned();
    assert_eq!(restored.job.revision, updated.job.revision);
    assert_eq!(restored.schedules[0].next_at, updated.schedules[0].next_at);
    assert_eq!(restored.schedules[0].last_at, None);
    assert_eq!(
        fixture.status().triggers,
        baseline.triggers + 1,
        "Invalid files at startup must preserve the applied job and both built-ins"
    );
    fs::remove_file(&duplicate).unwrap();
    assert_eq!(fixture.sync().unchanged, 1);
    assert_eq!(
        fixture.planned().schedules[0].next_at,
        updated.schedules[0].next_at
    );

    fs::write(
        &fixture.config,
        toml::to_string(&Config {
            job_directories: Vec::new(),
            poll_interval_seconds: 60,
        })
        .unwrap(),
    )
    .unwrap();
    let explicit_sync = [
        "jobs",
        "sync",
        "--directory",
        fixture.jobs.to_str().unwrap(),
    ];
    assert_eq!(fixture.sync_args(&explicit_sync).unchanged, 1);
    server.stop();
    server = fixture.start();
    let explicit = fixture.planned();
    assert_eq!(
        explicit.job.revision, updated.job.revision,
        "A catalog applied through --directory must survive startup without configured roots"
    );
    assert_eq!(explicit.schedules[0].next_at, updated.schedules[0].next_at);
    assert_eq!(fixture.status().triggers, baseline.triggers + 1);

    fs::remove_file(&file).unwrap();
    assert_eq!(fixture.sync_args(&explicit_sync).removed, 1);
    assert!(fixture.list().is_empty());
    let empty = fixture.status();
    assert_eq!(empty.jobs, 0);
    assert_eq!(
        empty.triggers, baseline.triggers,
        "Removing jobs must preserve both built-in triggers"
    );
    assert!(empty.errors.is_empty(), "{:?}", empty.errors);
    assert!(
        !fixture.directory.path().join("external-calls").exists(),
        "Job management must not discover external accounts"
    );
    server.stop();
}
