use std::{
    fs::{self, OpenOptions},
    io::ErrorKind,
    os::unix::fs::PermissionsExt,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

struct Orphan(libc::pid_t);

impl Drop for Orphan {
    fn drop(&mut self) {
        // This PID belongs to the fixture we started, never a discovered process.
        unsafe {
            libc::kill(self.0, libc::SIGTERM);
        }
    }
}

#[test]
fn killing_supervisor_preserves_lock_until_pi_child_exits() {
    let state = tempfile::tempdir().unwrap();
    fs::set_permissions(state.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let script = state.path().join("linger.mjs");
    fs::write(
        &script,
        r#"
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      writeFileSync(join(process.argv[2], 'child-pid'), String(process.pid));
      setInterval(() => {}, 1000);
      process.stdin.resume();
    "#,
    )
    .unwrap();
    let command = || {
        let mut command = Command::new(env!("CARGO_BIN_EXE_agent"));
        command
            .arg("--state-dir")
            .arg(state.path())
            .arg("--runtime")
            .arg(&script)
            .arg("status")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        command
    };
    let mut supervisor = command().spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let pid_path = state.path().join("child-pid");
    while !pid_path.exists() {
        assert!(Instant::now() < deadline, "Child did not start");
        thread::sleep(Duration::from_millis(10));
    }
    let orphan = Orphan(fs::read_to_string(pid_path).unwrap().parse().unwrap());
    supervisor.kill().unwrap();
    supervisor.wait().unwrap();
    let competing = command().output().unwrap();
    assert!(!competing.status.success());
    assert!(
        String::from_utf8(competing.stderr)
            .unwrap()
            .contains("Another agent process owns")
    );
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .open(state.path().join("writer.lock"))
        .unwrap();
    assert_eq!(
        fs2::FileExt::try_lock_exclusive(&lock).unwrap_err().kind(),
        ErrorKind::WouldBlock
    );
    drop(orphan);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match fs2::FileExt::try_lock_exclusive(&lock) {
            Ok(()) => break,
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                assert!(
                    Instant::now() < deadline,
                    "Child retained lock after termination"
                );
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => panic!("Unexpected lock failure: {error}"),
        }
    }
}
