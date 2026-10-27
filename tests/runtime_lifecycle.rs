use std::{
    fs::{self, OpenOptions},
    io::ErrorKind,
    os::unix::fs::{MetadataExt, PermissionsExt},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

struct Supervisor(Option<Child>);

impl Supervisor {
    fn stop(&mut self) {
        if let Some(mut child) = self.0.take() {
            let _ = child.kill();
            child.wait().unwrap();
        }
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        self.stop();
    }
}

struct Orphan(Option<libc::pid_t>);

impl Drop for Orphan {
    fn drop(&mut self) {
        // This PID belongs to the fixture we started, never a discovered process.
        if let Some(pid) = self.0.take() {
            unsafe {
                libc::kill(pid, libc::SIGTERM);
            }
        }
    }
}

#[test]
fn killing_supervisor_preserves_lock_until_pi_child_exits() {
    let state = tempfile::tempdir().unwrap();
    fs::set_permissions(state.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let script = state.path().join("linger.mjs");
    let config = state.path().join("config.toml");
    fs::write(&config, "").unwrap();
    fs::write(
        &script,
        r#"
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { createInterface } from 'node:readline';
      writeFileSync(join(process.argv[2], 'child-pid'), String(process.pid));
      setInterval(() => {}, 1000);
      createInterface({input:process.stdin}).on('line', line => {
        const {id}=JSON.parse(line);
        process.stdout.write(JSON.stringify({version:1,id,event:{type:'configured'}})+'\n');
        process.stdout.write(JSON.stringify({version:1,id,event:{type:'done'}})+'\n');
      });
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
            .arg("--config")
            .arg(&config)
            .arg("--instructions")
            .arg(state.path().join("AGENTS.md"))
            .args(["serve", "--local-only", "--no-sources"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        command
    };
    let mut supervisor = Supervisor(Some(command().spawn().unwrap()));
    let deadline = Instant::now() + Duration::from_secs(5);
    let pid_path = state.path().join("child-pid");
    let socket = state.path().join("agent.sock");
    while !pid_path.exists() {
        assert!(Instant::now() < deadline, "Coordinator did not start");
        thread::sleep(Duration::from_millis(10));
    }
    let orphan = Orphan(Some(fs::read_to_string(pid_path).unwrap().parse().unwrap()));
    while !socket.exists() {
        assert!(Instant::now() < deadline, "Coordinator did not bind");
        thread::sleep(Duration::from_millis(10));
    }
    let original_socket = fs::metadata(&socket).unwrap();
    supervisor.stop();
    let competing = command().output().unwrap();
    assert!(!competing.status.success());
    assert!(
        String::from_utf8(competing.stderr)
            .unwrap()
            .contains("Another agent process owns")
    );
    let preserved_socket = fs::metadata(socket).unwrap();
    assert_eq!(preserved_socket.ino(), original_socket.ino());
    assert_eq!(preserved_socket.dev(), original_socket.dev());
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
