//! Native PTY driver for CLI integration tests. No terminal emulator or shell.

use std::{
    fs::File,
    io::{self, Read, Write},
    os::{fd::FromRawFd, unix::process::CommandExt},
    process::{Command, ExitCode},
    sync::{Arc, Mutex, MutexGuard},
};

use anyhow::{Context, Result, ensure};

fn main() -> Result<ExitCode> {
    let mut arguments = std::env::args_os().skip(1);
    let program = arguments.next().context("A terminal command is required")?;
    let mut master = -1;
    let mut size = libc::winsize {
        ws_row: 32,
        ws_col: 100,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    // The fixture has one thread before fork. The child becomes the PTY's
    // session leader and execs the CLI with real controlling-terminal stdio.
    let child = unsafe {
        libc::forkpty(
            &mut master,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            // libc exposes this as mutable on Darwin and const on Linux.
            &raw mut size,
        )
    };
    ensure!(
        child >= 0,
        "Could not open a PTY: {}",
        io::Error::last_os_error()
    );
    if child == 0 {
        return Err(Command::new(program).args(arguments).exec().into());
    }
    // forkpty transferred this descriptor to the parent. Closing the master's
    // final handle also hangs up the test CLI if its driver is terminated.
    let mut output = unsafe { File::from_raw_fd(master) };
    let mut input = InputWriter(Arc::new(Mutex::new(output.try_clone()?)));
    let mut replies = input.clone();
    let mut cursor = std::env::var_os("AGENT_TEST_TERMINAL_REPLY")
        .is_some()
        .then(CursorReport::default);
    std::thread::spawn(move || {
        let _ = io::copy(&mut io::stdin().lock(), &mut input);
    });
    let mut bytes = [0; 8192];
    loop {
        match output.read(&mut bytes) {
            Ok(0) => break,
            Ok(length) => {
                if let Some(cursor) = &mut cursor {
                    cursor.observe(&bytes[..length], &mut replies)?;
                }
                io::stdout().write_all(&bytes[..length])?;
                io::stdout().flush()?;
            }
            Err(error) if error.raw_os_error() == Some(libc::EIO) => break,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error.into()),
        }
    }
    let mut status = 0;
    // The only child is retained until this exact PID is reaped.
    while unsafe { libc::waitpid(child, &mut status, 0) } < 0 {
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error.into());
        }
    }
    let code = if libc::WIFEXITED(status) {
        libc::WEXITSTATUS(status)
    } else {
        128 + libc::WTERMSIG(status)
    };
    Ok(ExitCode::from(u8::try_from(code)?))
}

/// Keyboard chunks and cursor reports share one byte stream. Keep complete
/// writes together, including any partial-write retries on the PTY master.
#[derive(Clone)]
struct InputWriter(Arc<Mutex<File>>);
impl InputWriter {
    fn locked(&self) -> io::Result<MutexGuard<'_, File>> {
        self.0
            .lock()
            .map_err(|_| io::Error::other("PTY input writer is unavailable"))
    }
}
impl Write for InputWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.locked()?.write(bytes)
    }
    fn write_all(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.locked()?.write_all(bytes)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.locked()?.flush()
    }
}

/// The test PTY starts at the origin. Reply to cursor queries and track explicit
/// CUP moves, including frames split across reads. This is a terminal-protocol
/// fixture, not an emulator; normal fixture runs continue forwarding unchanged.
#[derive(Default)]
struct CursorReport {
    sequence: Vec<u8>,
    row: u16,
    column: u16,
}
impl CursorReport {
    fn observe(&mut self, bytes: &[u8], replies: &mut impl Write) -> io::Result<()> {
        for byte in bytes {
            if *byte == 0x1b {
                self.sequence.clear();
                self.sequence.push(*byte);
            } else if !self.sequence.is_empty() {
                self.sequence.push(*byte);
                if self.sequence.len() == 2 {
                    if *byte != b'[' {
                        self.sequence.clear();
                    }
                } else if (0x40..=0x7e).contains(byte) {
                    if self.sequence == b"\x1b[6n" {
                        replies.write_all(
                            format!("\x1b[{};{}R", self.row.max(1), self.column.max(1)).as_bytes(),
                        )?;
                        replies.flush()?;
                    } else if matches!(*byte, b'H' | b'f') {
                        let arguments = &self.sequence[2..self.sequence.len() - 1];
                        if let Ok(arguments) = std::str::from_utf8(arguments) {
                            let mut positions = arguments.split(';');
                            self.row = positions.next().and_then(|n| n.parse().ok()).unwrap_or(1);
                            self.column =
                                positions.next().and_then(|n| n.parse().ok()).unwrap_or(1);
                        }
                    }
                    self.sequence.clear();
                } else if self.sequence.len() > 64 {
                    self.sequence.clear();
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_report_remains_a_complete_terminal_frame_when_keyboard_input_arrives() {
        struct KeyboardWriter {
            bytes: Vec<u8>,
            typed: bool,
        }
        impl Write for KeyboardWriter {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                self.bytes.extend_from_slice(bytes);
                if !self.typed {
                    self.typed = true;
                    self.bytes.extend_from_slice(b"/exit\r");
                }
                Ok(bytes.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let mut writer = KeyboardWriter {
            bytes: Vec::new(),
            typed: false,
        };
        let mut cursor = CursorReport::default();
        cursor.observe(b"\x1b[12;34H\x1b[6", &mut writer).unwrap();
        assert!(writer.bytes.is_empty());
        cursor.observe(b"n", &mut writer).unwrap();
        assert_eq!(writer.bytes, b"\x1b[12;34R/exit\r");
    }
}
