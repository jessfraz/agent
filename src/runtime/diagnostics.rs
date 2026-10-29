//! Content-free runtime receipts. The actor only enqueues bounded records;
//! a separate writer owns private files and rotation.
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::protocol::{ErrorCode, InputMode, ModelActivity, RuntimeCommand, RuntimeEventKind};

const MAX_BYTES: u64 = 1024 * 1024;
const CAPACITY: usize = 256;

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct Record {
    pub timestamp_ms: u64,
    pub request_id: u32,
    pub elapsed_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub dropped_before: u64,
    #[serde(flatten)]
    pub event: Event,
}

fn is_zero(value: &u64) -> bool {
    *value == 0
}
fn millis(duration: std::time::Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}
fn token(value: &str) -> Option<String> {
    (!value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-.:".contains(&byte)))
    .then(|| value.to_owned())
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub(crate) enum Event {
    RequestReceived,
    CommandSent {
        command: String,
    },
    InputReceived {
        input_id: Option<String>,
        mode: Option<InputMode>,
    },
    InputAccepted {
        input_id: Option<String>,
    },
    InputPlaced {
        input_id: Option<String>,
        entry_id: Option<String>,
    },
    InputRejected {
        input_id: Option<String>,
    },
    Ready,
    FirstActivity,
    ToolStarted {
        call_id: Option<String>,
    },
    ToolFinished {
        call_id: Option<String>,
    },
    Compaction {
        active: bool,
        failed: bool,
    },
    HostCall {
        call_id: Option<String>,
        command: Option<String>,
    },
    HostReply {
        call_id: Option<String>,
        command: Option<String>,
        duration_ms: u64,
    },
    HostCancelRequested {
        call_id: Option<String>,
        duration_ms: Option<u64>,
    },
    InterruptReceived,
    ControlIgnored,
    Interrupted,
    Detached,
    Answer,
    Failure {
        code: ErrorCode,
    },
    Done,
    RuntimeStopped {
        code: ErrorCode,
    },
}

pub(crate) struct Trace {
    started: Option<Instant>,
    conversation_id: Option<String>,
    task_id: Option<String>,
    agent_id: Option<String>,
    active: bool,
}
impl Trace {
    pub fn new(command: &RuntimeCommand) -> Self {
        let mut trace = Self {
            started: Some(Instant::now()),
            conversation_id: None,
            task_id: None,
            agent_id: None,
            active: false,
        };
        match command {
            RuntimeCommand::RunTask {
                task_id, agent_id, ..
            }
            | RuntimeCommand::RevokeAllocation {
                task_id, agent_id, ..
            } => {
                trace.task_id = Some(task_id.to_string());
                trace.agent_id = agent_id.as_deref().and_then(token);
            }
            RuntimeCommand::ReadTask { task_id } => {
                trace.task_id = Some(task_id.to_string());
            }
            RuntimeCommand::ReadHistory {
                task_id, agent_id, ..
            }
            | RuntimeCommand::ConversationSettings {
                task_id, agent_id, ..
            } => {
                trace.task_id = task_id.as_ref().map(ToString::to_string);
                trace.agent_id = agent_id.as_deref().and_then(token);
            }
            RuntimeCommand::ReadConversation {
                conversation_id, ..
            }
            | RuntimeCommand::OpenConversation {
                conversation_id, ..
            } => {
                trace.conversation_id = token(conversation_id);
            }
            _ => {}
        }
        trace
    }
    pub fn unowned() -> Self {
        Self {
            started: None,
            conversation_id: None,
            task_id: None,
            agent_id: None,
            active: false,
        }
    }
    pub fn input(&self, command: &RuntimeCommand) -> Option<Event> {
        match command {
            RuntimeCommand::Chat { input_id, .. } => Some(Event::InputReceived {
                input_id: input_id.as_deref().and_then(token),
                mode: None,
            }),
            RuntimeCommand::SubmitInput { input_id, mode, .. } => Some(Event::InputReceived {
                input_id: token(input_id),
                mode: Some(*mode),
            }),
            RuntimeCommand::WorkerInput { input_id, .. } => Some(Event::InputReceived {
                input_id: token(input_id),
                mode: None,
            }),
            RuntimeCommand::Interrupt => Some(Event::InterruptReceived),
            _ => None,
        }
    }
    pub fn observe(&mut self, event: &RuntimeEventKind) -> [Option<Event>; 2] {
        match event {
            RuntimeEventKind::MainReady {
                conversation_id, ..
            }
            | RuntimeEventKind::TaskReady {
                conversation_id, ..
            }
            | RuntimeEventKind::History {
                conversation_id, ..
            }
            | RuntimeEventKind::Answer {
                conversation_id, ..
            } => self.conversation_id = token(conversation_id),
            RuntimeEventKind::ConversationSettings { settings } => {
                self.conversation_id = token(&settings.conversation_id);
                self.task_id = settings.task_id.as_ref().map(ToString::to_string);
                self.agent_id = settings.agent_id.as_deref().and_then(token);
            }
            _ => {}
        }
        let first = if !self.active
            && matches!(
                event,
                RuntimeEventKind::Activity { .. } | RuntimeEventKind::Answer { .. }
            ) {
            self.active = true;
            Some(Event::FirstActivity)
        } else {
            None
        };
        let observed = match event {
            RuntimeEventKind::MainReady { .. } | RuntimeEventKind::TaskReady { .. } => {
                Some(Event::Ready)
            }
            RuntimeEventKind::InputAccepted { input_id } => Some(Event::InputAccepted {
                input_id: token(input_id),
            }),
            RuntimeEventKind::InputPlaced { input_id, entry_id } => Some(Event::InputPlaced {
                input_id: token(input_id),
                entry_id: token(entry_id),
            }),
            RuntimeEventKind::InputRejected { input_id, .. } => Some(Event::InputRejected {
                input_id: token(input_id),
            }),
            RuntimeEventKind::Activity {
                activity: ModelActivity::ToolStarted { call_id, .. },
            } => Some(Event::ToolStarted {
                call_id: token(call_id),
            }),
            RuntimeEventKind::Activity {
                activity: ModelActivity::ToolFinished { call_id, .. },
            } => Some(Event::ToolFinished {
                call_id: token(call_id),
            }),
            RuntimeEventKind::Activity {
                activity: ModelActivity::Compaction { active, failed },
            } => Some(Event::Compaction {
                active: *active,
                failed: *failed,
            }),
            RuntimeEventKind::Interrupted => Some(Event::Interrupted),
            RuntimeEventKind::Answer { .. } => Some(Event::Answer),
            RuntimeEventKind::Failure { code, .. } => Some(Event::Failure { code: code.clone() }),
            RuntimeEventKind::Done => Some(Event::Done),
            _ => None,
        };
        [first, observed]
    }
}

pub(crate) struct HostTiming {
    pub started: Instant,
    pub command: Option<String>,
}
impl HostTiming {
    pub fn new(bytes: &[u8]) -> Self {
        Self {
            started: Instant::now(),
            command: host_kind(bytes),
        }
    }
    pub fn received(&self, call_id: &str) -> Event {
        Event::HostCall {
            call_id: token(call_id),
            command: self.command.clone(),
        }
    }
    pub fn reply(&self, call_id: &str) -> Event {
        Event::HostReply {
            call_id: token(call_id),
            command: self.command.clone(),
            duration_ms: millis(self.started.elapsed()),
        }
    }
    pub fn cancel(call_id: &str, timing: Option<&Self>) -> Event {
        Event::HostCancelRequested {
            call_id: token(call_id),
            duration_ms: timing.map(|timing| millis(timing.started.elapsed())),
        }
    }
}

// These narrow wire views skip all payload fields. Tags come from the existing
// protocol serializer/decoder; diagnostics has no duplicate command registry.
#[derive(Deserialize)]
struct Tag {
    #[serde(rename = "type")]
    kind: String,
    command: Option<Box<Tag>>,
}
impl Tag {
    fn leaf(self) -> Option<String> {
        match self.command {
            Some(child) if self.kind == "on_node" => child.leaf(),
            _ => token(&self.kind),
        }
    }
}
#[derive(Deserialize)]
struct CommandTag {
    command: Tag,
}
#[derive(Deserialize)]
struct HostTag {
    event: CommandTag,
}
pub(crate) fn command_kind(bytes: &[u8]) -> Option<String> {
    serde_json::from_slice::<CommandTag>(bytes)
        .ok()?
        .command
        .leaf()
}
fn host_kind(bytes: &[u8]) -> Option<String> {
    serde_json::from_slice::<HostTag>(bytes)
        .ok()?
        .event
        .command
        .leaf()
}

pub(crate) struct Diagnostics {
    sender: mpsc::Sender<Record>,
    dropped: u64,
}
impl Diagnostics {
    pub fn start(state: &Path) -> Self {
        let (sender, mut records) = mpsc::channel(CAPACITY);
        let directory = state.join("diagnostics");
        tokio::task::spawn_blocking(move || {
            let result = (|| -> io::Result<()> {
                let mut writer = Writer::open(directory, MAX_BYTES)?;
                while let Some(record) = records.blocking_recv() {
                    writer.append(&record)?;
                }
                Ok(())
            })();
            if result.is_err() {
                eprintln!("Runtime diagnostics unavailable; chat continues.");
            }
        });
        Self { sender, dropped: 0 }
    }
    pub fn record(&mut self, request_id: u32, trace: &Trace, event: Event) {
        let record = Record {
            timestamp_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, millis),
            request_id,
            elapsed_ms: trace.started.map(|started| millis(started.elapsed())),
            conversation_id: trace.conversation_id.clone(),
            task_id: trace.task_id.clone(),
            agent_id: trace.agent_id.clone(),
            dropped_before: self.dropped,
            event,
        };
        match self.sender.try_send(record) {
            Ok(()) => self.dropped = 0,
            Err(mpsc::error::TrySendError::Full(_)) => {
                self.dropped = self.dropped.saturating_add(1)
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {}
        }
    }
}

struct Writer {
    lock: File,
    directory: PathBuf,
    file: File,
    bytes: u64,
    limit: u64,
}
impl Drop for Writer {
    fn drop(&mut self) {
        // Close alone waits for every inherited/duplicated descriptor. This
        // writer owns the lock, so end that ownership explicitly before drop.
        let _ = fs2::FileExt::unlock(&self.lock);
    }
}

impl Writer {
    fn open(directory: PathBuf, limit: u64) -> io::Result<Self> {
        match fs::DirBuilder::new().mode(0o700).create(&directory) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        if !fs::symlink_metadata(&directory)?.is_dir() {
            return Err(io::Error::other("Diagnostics directory is unavailable"));
        }
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
        // A retired runtime may still be draining its bounded queue. Only the
        // background writer waits here; chat admission never waits on this lock.
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(directory.join("writer.lock"))?;
        lock.set_permissions(fs::Permissions::from_mode(0o600))?;
        fs2::FileExt::lock_exclusive(&lock)?;
        let file = Self::file(&directory)?;
        let bytes = file.metadata()?.len();
        Ok(Self {
            lock,
            directory,
            file,
            bytes,
            limit,
        })
    }
    fn file(directory: &Path) -> io::Result<File> {
        let file = OpenOptions::new()
            .append(true)
            .create(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(directory.join("runtime.jsonl"))?;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
        Ok(file)
    }
    fn append(&mut self, record: &Record) -> io::Result<()> {
        let mut bytes = serde_json::to_vec(record)?;
        bytes.push(b'\n');
        if bytes.len() > 4096 {
            return Err(io::Error::other("Diagnostics record exceeds its bound"));
        }
        if self.bytes + u64::try_from(bytes.len()).unwrap_or(u64::MAX) > self.limit {
            let oldest = self.directory.join("runtime.jsonl.2");
            match fs::remove_file(&oldest) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            let previous = self.directory.join("runtime.jsonl.1");
            if previous.try_exists()? {
                fs::rename(&previous, oldest)?;
            }
            fs::rename(self.directory.join("runtime.jsonl"), previous)?;
            self.file = Self::file(&self.directory)?;
            self.bytes = 0;
        }
        self.file.write_all(&bytes)?;
        self.bytes += u64::try_from(bytes.len()).unwrap_or(u64::MAX);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::protocol::{InputMode, RuntimeCommand};
    use crate::runtime::diagnostics::{Diagnostics, Event, Record, Trace, Writer};
    use std::{
        fs,
        os::unix::fs::{PermissionsExt, symlink},
    };
    use tokio::sync::mpsc;

    fn record(sequence: u32) -> Record {
        Record {
            timestamp_ms: 1234,
            request_id: sequence,
            elapsed_ms: Some(12),
            conversation_id: Some("conversation-one".into()),
            task_id: None,
            agent_id: None,
            dropped_before: 0,
            event: Event::InputReceived {
                input_id: Some("opaque-input-id".into()),
                mode: Some(InputMode::Steer),
            },
        }
    }

    #[test]
    fn private_native_files_rotate_with_a_fixed_retention_bound() {
        let state = tempfile::tempdir().unwrap();
        let directory = state.path().join("diagnostics");
        let mut writer = Writer::open(directory.clone(), 600).unwrap();
        for sequence in 0..50 {
            writer.append(&record(sequence)).unwrap();
        }
        drop(writer);
        assert_eq!(
            fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let paths = fs::read_dir(&directory)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>();
        assert_eq!(paths.len(), 4);
        let mut retained = Vec::new();
        for path in paths {
            let metadata = fs::metadata(&path).unwrap();
            assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
            assert!(metadata.len() <= 600);
            if path.file_name().is_some_and(|name| name == "writer.lock") {
                continue;
            }
            for line in fs::read_to_string(path).unwrap().lines() {
                retained.push(serde_json::from_str::<Record>(line).unwrap().request_id);
            }
        }
        retained.sort_unstable();
        assert_eq!(retained.last(), Some(&49));
        assert!(retained.len() < 50);
        assert!(retained.windows(2).all(|pair| pair[1] == pair[0] + 1));
    }

    #[test]
    fn diagnostics_refuses_symlinks_without_touching_the_target() {
        let state = tempfile::tempdir().unwrap();
        let target = state.path().join("private-target");
        fs::write(&target, "Preserve unrelated contents").unwrap();
        let directory = state.path().join("diagnostics");
        fs::create_dir(&directory).unwrap();
        symlink(&target, directory.join("runtime.jsonl")).unwrap();
        assert!(Writer::open(directory, 600).is_err());
        assert_eq!(
            fs::read_to_string(target).unwrap(),
            "Preserve unrelated contents"
        );
        let elsewhere = tempfile::tempdir().unwrap();
        let linked = state.path().join("linked");
        symlink(elsewhere.path(), &linked).unwrap();
        assert!(Writer::open(linked, 600).is_err());
        assert_eq!(fs::read_dir(elsewhere.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn a_full_nonblocking_channel_reports_its_dropped_count_after_recovery() {
        let (sender, mut records) = mpsc::channel(1);
        let mut log = Diagnostics { sender, dropped: 0 };
        let trace = Trace::new(&RuntimeCommand::Status);
        log.record(1, &trace, Event::RequestReceived);
        log.record(2, &trace, Event::RequestReceived);
        log.record(3, &trace, Event::RequestReceived);
        assert_eq!(records.recv().await.unwrap().dropped_before, 0);
        log.record(4, &trace, Event::Done);
        let recovered = records.recv().await.unwrap();
        assert_eq!(recovered.request_id, 4);
        assert_eq!(recovered.dropped_before, 2);
        log.record(5, &trace, Event::Done);
        assert_eq!(records.recv().await.unwrap().dropped_before, 0);
        drop(records);
        log.record(6, &trace, Event::Done);
    }

    #[test]
    fn writer_drop_releases_its_native_lock_even_if_a_descriptor_was_inherited() {
        let state = tempfile::tempdir().unwrap();
        let directory = state.path().join("diagnostics");
        let writer = Writer::open(directory.clone(), 600).unwrap();
        // dup and fork retain the same open-file description. A child between
        // fork and exec can outlive the writer's own final File handle.
        let inherited = writer.lock.try_clone().unwrap();
        drop(writer);
        let replacement = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(directory.join("writer.lock"))
            .unwrap();
        assert!(
            fs2::FileExt::try_lock_exclusive(&replacement).is_ok(),
            "Writer ownership must end even while an inherited descriptor remains open"
        );
        drop(inherited);
    }

    #[test]
    fn retired_and_replacement_writers_serialize_native_rotation() {
        let state = tempfile::tempdir().unwrap();
        let directory = state.path().join("diagnostics");
        let mut retired = Writer::open(directory.clone(), 600).unwrap();
        let other = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(directory.join("writer.lock"))
            .unwrap();
        assert_eq!(
            fs2::FileExt::try_lock_exclusive(&other).unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        let (begun, started) = std::sync::mpsc::channel();
        let replacement_directory = directory.clone();
        let replacement = std::thread::spawn(move || {
            begun.send(()).unwrap();
            let mut writer = Writer::open(replacement_directory, 600).unwrap();
            for sequence in 50..100 {
                writer.append(&record(sequence)).unwrap();
            }
        });
        started.recv().unwrap();
        for sequence in 0..50 {
            retired.append(&record(sequence)).unwrap();
        }
        drop(retired);
        replacement.join().unwrap();
        fs2::FileExt::try_lock_exclusive(&other).unwrap();
        let mut retained = Vec::new();
        for entry in fs::read_dir(&directory).unwrap() {
            let path = entry.unwrap().path();
            if path.file_name().is_some_and(|name| name == "writer.lock") {
                continue;
            }
            for line in fs::read_to_string(path).unwrap().lines() {
                retained.push(serde_json::from_str::<Record>(line).unwrap().request_id);
            }
        }
        retained.sort_unstable();
        assert_eq!(retained.last(), Some(&99));
        assert!(retained.windows(2).all(|pair| pair[1] == pair[0] + 1));
    }
}
