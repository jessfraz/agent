//! Native PTY driver for CLI integration tests. No terminal emulator or shell.

use std::{
    fs::File,
    io::{self, Read, Write},
    os::{fd::FromRawFd, unix::process::CommandExt},
    process::{Command, ExitCode},
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
            &mut size,
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
    let mut input = output.try_clone()?;
    std::thread::spawn(move || {
        let _ = io::copy(&mut io::stdin().lock(), &mut input);
    });
    let mut bytes = [0; 8192];
    loop {
        match output.read(&mut bytes) {
            Ok(0) => break,
            Ok(length) => {
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
