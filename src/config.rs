use std::{
    collections::HashSet,
    env, fs, io,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};

use crate::protocol::{WorkerHost, WorkerLaunch};
use crate::sources::SourceConfig;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ClientConfig {
    #[serde(skip)]
    pub path: Option<PathBuf>,
    #[serde(skip)]
    pub launch: Option<WorkerLaunch>,
    pub coordinator: Option<String>,
    pub coordinator_program: Option<String>,
    pub tailscale_socket: Option<PathBuf>,
    #[serde(default)]
    pub trusted_nodes: Vec<String>,
    #[serde(default)]
    pub hosts: Vec<WorkerHost>,
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
            coordinator: None,
            coordinator_program: None,
            tailscale_socket: None,
            trusted_nodes: Vec::new(),
            hosts: Vec::new(),
            sources: Vec::new(),
            poll_interval_seconds: default_poll_interval(),
        }
    }
}

fn default_poll_interval() -> u64 {
    60
}

pub fn load(explicit: Option<&Path>) -> Result<ClientConfig> {
    let path = match explicit {
        Some(path) => path.to_owned(),
        None => env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|home| home.join(".config")))
            .context("No configuration directory is available")?
            .join("agent/config.json"),
    };
    let mut config: ClientConfig = match fs::read(&path) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).context("Invalid agent client configuration")?
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound && explicit.is_none() => {
            ClientConfig::default()
        }
        Err(error) => return Err(error).context("Could not read agent configuration"),
    };
    if path.is_file() {
        config.path =
            Some(fs::canonicalize(&path).context("Could not resolve agent configuration")?);
    }
    let mut names = HashSet::new();
    crate::tailnet::PeerPolicy::new(&config.trusted_nodes)?;
    crate::tailnet::Daemon::new(config.tailscale_socket.as_deref())?;
    ensure!(
        (10..=3600).contains(&config.poll_interval_seconds),
        "Source polling interval must be between 10 and 3600 seconds"
    );
    for host in &config.hosts {
        ensure!(
            !host.name.trim().is_empty() && names.insert(host.name.to_lowercase()),
            "Worker host names must be nonempty and unique"
        );
        ensure!(
            Path::new(&host.cwd).is_absolute(),
            "Worker host directories must be absolute"
        );
        ensure!(
            !host.agent_program.is_empty(),
            "Worker host needs an agent program"
        );
        if let Some(coordinator) = &host.coordinator {
            validate_coordinator(coordinator)?;
        }
    }
    if let Some(coordinator) = &config.coordinator {
        validate_coordinator(coordinator)?;
    }
    Ok(config)
}

pub fn validate_coordinator(value: &str) -> Result<()> {
    if let Some(address) = value.strip_prefix("tailscale://") {
        let address: std::net::SocketAddr = address
            .parse()
            .context("Tailnet coordinator needs an IP address and port")?;
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

pub fn program() -> Result<PathBuf> {
    let executable = env::current_exe()?;
    let wrapper = executable.with_file_name("agent");
    Ok(if wrapper.is_file() {
        wrapper
    } else {
        executable
    })
}

pub fn worker_hosts(
    config: &ClientConfig,
    coordinator: Option<&str>,
    cwd: &Path,
) -> Result<Vec<WorkerHost>> {
    if !config.hosts.is_empty() {
        return Ok(config
            .hosts
            .iter()
            .cloned()
            .map(|mut host| {
                if host.rex_server.is_none() && host.launch.is_none() {
                    host.launch = config.launch.clone();
                }
                host
            })
            .collect());
    }
    Ok(vec![WorkerHost {
        name: "local".into(),
        rex_server: None,
        coordinator: coordinator.map(str::to_owned),
        cwd: cwd.to_string_lossy().into_owned(),
        agent_program: program()?.to_string_lossy().into_owned(),
        launch: config.launch.clone(),
    }])
}

#[cfg(test)]
mod tests {
    use crate::config::{load, validate_coordinator};
    #[test]
    fn rejects_shell_syntax_and_duplicate_host_bindings() {
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
        let path = dir.path().join("config.json");
        std::fs::write(&path, r#"{"hosts":[
          {"name":"Desktop","rex_server":null,"coordinator":null,"cwd":"/workspace","agent_program":"agent"},
          {"name":"desktop","rex_server":null,"coordinator":null,"cwd":"/workspace","agent_program":"agent"}
        ]}"#).unwrap();
        assert!(load(Some(&path)).is_err());
    }
}
