use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::Path,
    process::{Command, Output},
};

use agent_cli::config::{ApplyResult, load};

const PRIVATE: &str = r#"
# Private connection settings must survive declarative preference updates.
coordinator = "tailscale://100.64.0.10"
coordinator_program = "/example/bin/agent"
tailscale_socket = "/example/tailscaled.sock"
trusted_nodes = ["node-example"]
node_name = "example machine"
context_repositories = ["~/old-context"]
poll_interval_seconds = 120

[model]
provider = "anthropic"
model_id = "existing-model"
reasoning = "low"
fast = false

[[sources]]
provider = "github"
enabled = true
namespaces = ["github.example"]
"#;

fn apply(path: &Path, settings: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_agent"))
        .arg("--config")
        .arg(path)
        .args(["--json", "config", "apply"])
        .arg(settings)
        .output()
        .unwrap()
}

#[test]
fn real_cli_applies_selected_preferences_preserves_private_fields_and_leaves_repeated_noops_untouched()
 {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("private.toml");
    let settings = directory.path().join("managed.toml");
    fs::write(&path, PRIVATE).unwrap();
    let before = load(Some(&path)).unwrap();
    fs::write(
        &settings,
        "context_repositories = ['~/context']\npoll_interval_seconds=60\n",
    )
    .unwrap();
    let output = apply(&path, &settings);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let receipt: ApplyResult = serde_json::from_slice(&output.stdout).unwrap();
    assert!(receipt.changed);
    assert_eq!(receipt.path, path);
    let current = load(Some(&path)).unwrap();
    assert_eq!(current.coordinator, before.coordinator);
    assert_eq!(current.coordinator_program, before.coordinator_program);
    assert_eq!(current.tailscale_socket, before.tailscale_socket);
    assert_eq!(current.trusted_nodes, before.trusted_nodes);
    assert_eq!(current.node_name, before.node_name);
    assert_eq!(current.model, before.model);
    assert_eq!(
        serde_json::to_string(&current.sources).unwrap(),
        serde_json::to_string(&before.sources).unwrap()
    );
    assert_eq!(current.poll_interval_seconds, 60);
    assert_eq!(
        current.context_repositories,
        vec![dirs::home_dir().unwrap().join("context")]
    );
    let metadata = fs::metadata(&path).unwrap();
    assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
    let original = fs::read(&path).unwrap();
    let output = apply(&path, &settings);
    assert!(output.status.success());
    let receipt: ApplyResult = serde_json::from_slice(&output.stdout).unwrap();
    assert!(!receipt.changed);
    assert_eq!(fs::read(&path).unwrap(), original);
    let unchanged = fs::metadata(&path).unwrap();
    assert_eq!(unchanged.ino(), metadata.ino());
    assert_eq!(unchanged.modified().unwrap(), metadata.modified().unwrap());
    fs::write(
        &settings,
        "[model]\nprovider='openai'\nmodel_id='gpt-6.1-sol'\nreasoning='high'\nfast=false\n",
    )
    .unwrap();
    assert!(apply(&path, &settings).status.success());
    let current = load(Some(&path)).unwrap();
    assert_eq!(current.model.model_id, "gpt-6.1-sol");
    assert_eq!(current.trusted_nodes, before.trusted_nodes);
    assert_eq!(current.poll_interval_seconds, 60);
    assert_eq!(
        current.context_repositories,
        vec![dirs::home_dir().unwrap().join("context")]
    );
}

#[test]
fn real_cli_rejects_invalid_or_machine_settings_without_replacing_the_private_file() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("private.toml");
    let settings = directory.path().join("managed.toml");
    fs::write(&path, PRIVATE).unwrap();
    let metadata = fs::metadata(&path).unwrap();
    for invalid in [
        "coordinator='tailscale://100.64.0.11'",
        "trusted_nodes=[]",
        "poll_interval_seconds=0",
        "context_repositories=['relative']",
        "[model]\nprovider='unknown'",
        "[[sources]]\nprovider='slack'\naccount=''\ncommand=[]",
        "model = [",
    ] {
        fs::write(&settings, invalid).unwrap();
        assert!(!apply(&path, &settings).status.success(), "{invalid}");
        assert_eq!(fs::read_to_string(&path).unwrap(), PRIVATE);
        assert_eq!(fs::metadata(&path).unwrap().ino(), metadata.ino());
    }
    fs::write(&settings, "").unwrap();
    let output = apply(&path, &settings);
    assert!(output.status.success());
    let receipt: ApplyResult = serde_json::from_slice(&output.stdout).unwrap();
    assert!(!receipt.changed);
    assert_eq!(fs::read_to_string(&path).unwrap(), PRIVATE);
    assert!(
        !apply(&directory.path().join("missing.toml"), &settings)
            .status
            .success()
    );
    assert!(!directory.path().join("missing.toml").exists());
    assert_eq!(
        fs::read_dir(directory.path()).unwrap().count(),
        2,
        "No replacement scratch file is retained after failure"
    );
}
