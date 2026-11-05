use std::{fs, path::Path, process::Command};

fn binary() -> &'static str {
    option_env!("CARGO_BIN_EXE_beep-boop")
        .or(option_env!("CARGO_BIN_EXE_agent"))
        .expect("the CLI must be built for integration tests")
}

#[test]
fn cli_exposes_the_canonical_name_in_help_and_version() {
    for args in [["--help"].as_slice(), ["chat", "--help"].as_slice()] {
        let output = Command::new(binary()).args(args).output().unwrap();
        assert!(output.status.success());
        let help = String::from_utf8(output.stdout).unwrap();
        assert!(help.contains("Usage: beep-boop"), "{help}");
    }
    let output = Command::new(binary()).arg("--version").output().unwrap();
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        format!("beep-boop {}\n", env!("CARGO_PKG_VERSION"))
    );
}

fn initialize(config_home: &Path) -> std::process::Output {
    Command::new(binary())
        .env("XDG_CONFIG_HOME", config_home)
        .args(["init", "--coordinator", "tailscale://100.64.0.10"])
        .output()
        .unwrap()
}

#[test]
fn renamed_cli_keeps_the_existing_config_path_and_refuses_to_replace_settings() {
    let directory = tempfile::tempdir().unwrap();
    let output = initialize(directory.path());
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let path = directory.path().join("agent/config.toml");
    let original = fs::read(&path).unwrap();
    let config = agent_cli::config::load(Some(&path)).unwrap();
    assert_eq!(
        config.coordinator.as_deref(),
        Some("tailscale://100.64.0.10")
    );
    let output = initialize(directory.path());
    assert!(!output.status.success());
    assert_eq!(fs::read(&path).unwrap(), original);
    assert!(!directory.path().join("beep-boop").exists());
}
