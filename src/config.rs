use std::{
    env, fs, io,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};

use crate::models::ModelSelection;
use crate::protocol::WorkerLaunch;
use crate::sources::SourceConfig;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ClientConfig {
    #[serde(skip)]
    pub path: Option<PathBuf>,
    #[serde(skip)]
    pub launch: Option<WorkerLaunch>,
    #[serde(default)]
    pub model: ModelSelection,
    #[serde(default)]
    pub context_repositories: Vec<PathBuf>,
    pub coordinator: Option<String>,
    pub coordinator_program: Option<String>,
    pub tailscale_socket: Option<PathBuf>,
    #[serde(default)]
    pub trusted_nodes: Vec<String>,
    pub node_name: Option<String>,
    #[serde(default)]
    pub sources: Vec<SourceConfig>,
    #[serde(default = "default_poll_interval")]
    pub poll_interval_seconds: u64,
}

impl Default for ClientConfig {
    fn default() -> Self {
        Self {
            path: None,
            launch: None,
            model: ModelSelection::default(),
            context_repositories: Vec::new(),
            coordinator: None,
            coordinator_program: None,
            tailscale_socket: None,
            trusted_nodes: Vec::new(),
            node_name: None,
            sources: Vec::new(),
            poll_interval_seconds: default_poll_interval(),
        }
    }
}

fn default_poll_interval() -> u64 {
    60
}

pub fn default_path() -> Result<PathBuf> {
    Ok(env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".config")))
        .context("No configuration directory is available")?
        .join("agent/config.toml"))
}

pub fn initialize(path: &Path, coordinator: Option<&str>) -> Result<()> {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    #[derive(Serialize)]
    struct WorkerConfig<'a> {
        coordinator: &'a str,
    }
    let contents = match coordinator {
        Some(value) => {
            validate_coordinator(value)?;
            toml::to_string_pretty(&WorkerConfig { coordinator: value })?
        }
        None => include_str!("../examples/coordinator.toml").to_owned(),
    };
    // Run the same strict parser before publishing a configuration template.
    let _: ClientConfig = toml::from_str(&contents)?;
    if let Some(parent) = path.parent() {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(parent)?;
    }
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .with_context(|| {
            format!(
                "Could not create {}; existing configuration is never overwritten",
                path.display()
            )
        })?;
    use std::io::Write;
    file.write_all(contents.as_bytes())?;
    Ok(())
}

pub fn load(explicit: Option<&Path>) -> Result<ClientConfig> {
    let path = match explicit {
        Some(path) => path.to_owned(),
        None => default_path()?,
    };
    let mut config: ClientConfig = match fs::read_to_string(&path) {
        Ok(contents) => toml::from_str(&contents)
            .with_context(|| format!("Invalid agent TOML configuration at {}", path.display()))?,
        Err(error) if error.kind() == io::ErrorKind::NotFound && explicit.is_none() => {
            ClientConfig::default()
        }
        Err(error) => return Err(error).context("Could not read agent configuration"),
    };
    if path.is_file() {
        config.path =
            Some(fs::canonicalize(&path).context("Could not resolve agent configuration")?);
    }
    config.model.validate()?;
    let home = dirs::home_dir();
    for repository in &mut config.context_repositories {
        *repository = context_repository_path(repository, home.as_deref())?;
    }
    crate::tailnet::PeerPolicy::new(&config.trusted_nodes)?;
    crate::tailnet::Daemon::new(config.tailscale_socket.as_deref())?;
    ensure!(
        (10..=3600).contains(&config.poll_interval_seconds),
        "Source polling interval must be between 10 and 3600 seconds"
    );
    if let Some(name) = &config.node_name {
        ensure!(
            !name.trim().is_empty() && name.len() <= 128 && !name.chars().any(char::is_control),
            "Node name must be readable and at most 128 bytes"
        );
    }
    if let Some(coordinator) = &config.coordinator {
        validate_coordinator(coordinator)?;
    }
    Ok(config)
}

fn context_repository_path(path: &Path, home: Option<&Path>) -> Result<PathBuf> {
    let expanded = match path.strip_prefix("~") {
        Ok(relative) => home
            .context("No home directory is available for a context repository")?
            .join(relative),
        Err(_) => path.to_owned(),
    };
    ensure!(
        expanded.is_absolute(),
        "Context repositories need absolute paths or ~/ paths"
    );
    Ok(expanded)
}

pub fn validate_coordinator(value: &str) -> Result<()> {
    if let Some(address) = value.strip_prefix("tailscale://") {
        tailnet_address(address)?;
        return Ok(());
    }
    ensure!(
        !value.is_empty()
            && !value.starts_with('-')
            && value
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || "-._@:".contains(ch)),
        "Coordinator must be an SSH host or user@host, without shell syntax"
    );
    Ok(())
}

pub fn tailnet_address(value: &str) -> Result<std::net::SocketAddr> {
    use std::net::{Ipv4Addr, SocketAddr};
    let address = match value.parse::<Ipv4Addr>() {
        Ok(ip) => SocketAddr::from((ip, crate::tailnet::DEFAULT_PORT)),
        Err(_) => value
            .parse::<SocketAddr>()
            .context("Use the coordinator's Tailscale IPv4 address, with an optional port")?,
    };
    ensure!(
        address.port() != 0,
        "Tailnet coordinator needs a nonzero port"
    );
    let std::net::IpAddr::V4(ip) = address.ip() else {
        anyhow::bail!("Use the coordinator's Tailscale IPv4 address");
    };
    let octets = ip.octets();
    ensure!(
        octets[0] == 100 && (64..=127).contains(&octets[1]),
        "Coordinator address must be a Tailscale IP"
    );
    Ok(address)
}

pub fn program() -> Result<PathBuf> {
    let executable = env::current_exe()?;
    let wrapper = executable.with_file_name("agent");
    Ok(if wrapper.is_file() {
        wrapper
    } else {
        executable
    })
}

#[cfg(test)]
mod tests {
    use crate::config::{context_repository_path, load, tailnet_address, validate_coordinator};

    #[test]
    fn initialization_publishes_real_private_settings_and_never_overwrites() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        for coordinator in [None, Some("tailscale://100.64.0.10")] {
            let path = directory.path().join(if coordinator.is_some() {
                "worker/config.toml"
            } else {
                "coordinator/config.toml"
            });
            crate::config::initialize(&path, coordinator).unwrap();
            let config = load(Some(&path)).unwrap();
            assert_eq!(config.coordinator.as_deref(), coordinator);
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            let original = std::fs::read(&path).unwrap();
            assert!(crate::config::initialize(&path, Some("tailscale://100.64.0.11")).is_err());
            assert_eq!(std::fs::read(&path).unwrap(), original);
        }
        assert!(
            crate::config::initialize(&directory.path().join("bad.toml"), Some("127.0.0.1;bad"))
                .is_err()
        );
        assert!(!directory.path().join("bad.toml").exists());
    }

    #[test]
    fn checked_in_examples_use_the_real_configuration_contract() {
        use crate::models::ModelProvider;
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("examples");
        let coordinator = load(Some(&root.join("coordinator.toml"))).unwrap();
        assert!(coordinator.coordinator.is_none());
        assert_eq!(coordinator.model.provider, ModelProvider::OpenAi);
        assert!(coordinator.sources.iter().any(|source| source.enabled()));
        let client = load(Some(&root.join("client.toml"))).unwrap();
        assert_eq!(
            client.coordinator.as_deref(),
            Some("tailscale://100.64.0.10")
        );
        assert!(client.sources.is_empty());
        assert_eq!(tailnet_address("100.64.0.10").unwrap().port(), 43187);
        assert_eq!(tailnet_address("100.64.0.10:50000").unwrap().port(), 50000);
        for invalid in [
            "0.0.0.0",
            "127.0.0.1",
            "192.168.1.2",
            "100.64.0.10:0",
            "[::1]:43187",
        ] {
            assert!(tailnet_address(invalid).is_err());
        }
    }
    #[test]
    fn rejects_shell_syntax_and_obsolete_manual_host_bindings() {
        assert!(validate_coordinator("owner@desktop").is_ok());
        for value in [
            "-oProxyCommand=bad",
            "host; touch file",
            "$(command)",
            "host name",
        ] {
            assert!(validate_coordinator(value).is_err());
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        std::fs::write(&path, "[[hosts]]\nname='Desktop'\ncwd='/workspace'\nagent_program='agent'\n[[hosts]]\nname='desktop'\ncwd='/workspace'\nagent_program='agent'\n").unwrap();
        assert!(load(Some(&path)).is_err());
    }

    #[test]
    fn toml_settings_preserve_model_defaults_and_source_switches() {
        use crate::models::{ModelProvider, Reasoning};
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.toml");
        std::fs::write(
            &path,
            r#"
          [model]
          provider = 'anthropic'
          model_id = 'example-model'
          reasoning = 'high'
          fast = true
          [[sources]]
          provider = 'github'
          enabled = false
          [[sources]]
          provider = 'messages'
        "#,
        )
        .unwrap();
        let config = load(Some(&path)).unwrap();
        assert_eq!(config.model.provider, ModelProvider::Anthropic);
        assert_eq!(config.model.reasoning, Some(Reasoning::High));
        assert!(config.model.fast);
        assert!(!config.sources[0].enabled());
        assert!(config.sources[1].enabled());
        assert_eq!(
            config.path.as_ref().unwrap(),
            &std::fs::canonicalize(&path).unwrap()
        );
    }

    #[test]
    fn explicit_malformed_or_unknown_toml_is_rejected_without_a_format_fallback() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.toml");
        for invalid in [
            "{\"model\": {\"model_id\": \"old-json\"}}",
            "[model\n",
            "[model]\nprovider='misspelled'",
            "[model]\nmodel_id=' '",
            "[[sources]]\nprovider='github'\nenabeld=false",
            "unknown_setting=true",
        ] {
            std::fs::write(&path, invalid).unwrap();
            let error = load(Some(&path)).err().unwrap();
            assert!(
                error
                    .to_string()
                    .contains("Invalid agent TOML configuration")
            );
        }
        assert!(load(Some(&directory.path().join("missing.toml"))).is_err());
    }

    #[test]
    fn context_repository_paths_expand_the_current_host_home_and_reject_relative_paths() {
        use std::path::Path;
        assert_eq!(
            context_repository_path(Path::new("~/context"), Some(Path::new("/example/user")))
                .unwrap(),
            Path::new("/example/user/context")
        );
        assert_eq!(
            context_repository_path(Path::new("/workspace/context"), None).unwrap(),
            Path::new("/workspace/context")
        );
        assert!(context_repository_path(Path::new("~/context"), None).is_err());
        assert!(
            context_repository_path(
                Path::new("relative/context"),
                Some(Path::new("/example/user"))
            )
            .is_err()
        );
    }
}
