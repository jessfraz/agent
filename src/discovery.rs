//! Node capabilities come from the machine, while Rex owns its peer inventory.

use std::path::Path;

use anyhow::{Context, Result, ensure};
use serde::Deserialize;

use crate::{
    config, host,
    protocol::{AgentNode, HostCommand, HostResult, WorkerLaunch},
    rex::{HostId, RexClient},
};

#[derive(Deserialize)]
struct Inventory {
    #[serde(default)]
    hosts: Vec<Peer>,
}
#[derive(Deserialize)]
struct Peer {
    host_id: Option<String>,
    label: String,
    endpoints: Option<Vec<String>>,
}

pub async fn local_node(
    coordinator: Option<&str>,
    launch: WorkerLaunch,
    name: Option<&str>,
) -> Result<AgentNode> {
    let identity = RexClient::new(None).whoami().await?;
    let output = host::execute(HostCommand::Exec {
        program: "rex".into(),
        args: vec!["--autostart=false".into(), "hosts".into(), "--json".into()],
        cwd: "/".into(),
        timeout_seconds: 15,
    })
    .await;
    let inventory = match output {
        HostResult::Process {
            exit_code: 0,
            stdout,
            truncated: false,
            ..
        } => serde_json::from_str::<Inventory>(&stdout).ok(),
        _ => None,
    };
    let peer = inventory.as_ref().and_then(|inventory| {
        inventory
            .hosts
            .iter()
            .find(|peer| peer.host_id.as_deref() == Some(&identity.host_id.to_string()))
    });
    let native_name = identity
        .tailscale
        .as_ref()
        .and_then(|tailnet| tailnet.dns_name.as_deref())
        .and_then(|name| name.split('.').next())
        .filter(|name| !name.is_empty())
        .map(|name| name.strip_suffix("-rex").unwrap_or(name).to_owned());
    let name = name
        .map(str::to_owned)
        .or_else(|| {
            peer.filter(|peer| !peer.label.trim().is_empty())
                .map(|peer| peer.label.clone())
        })
        .or(native_name)
        .unwrap_or_else(|| "local".into());
    let endpoint = identity
        .tailscale
        .as_ref()
        .and_then(|tailnet| tailnet.https.as_ref())
        .filter(|https| https.state == "available")
        .and_then(|https| https.url.clone())
        .or_else(|| peer.and_then(|peer| peer.endpoints.as_ref()?.first().cloned()));
    let node = AgentNode {
        host_id: identity.host_id.to_string(),
        name,
        rex_server: endpoint,
        agent_program: config::program()?.to_string_lossy().into_owned(),
        home_directory: dirs::home_dir()
            .context("No home directory is available")?
            .to_string_lossy()
            .into_owned(),
        coordinator: coordinator.map(str::to_owned),
        launch,
    };
    validate_node(&node)?;
    Ok(node)
}

pub fn validate_node(node: &AgentNode) -> Result<()> {
    HostId::parse(&node.host_id)?;
    ensure!(
        !node.name.trim().is_empty()
            && node.name.len() <= 128
            && !node.name.chars().any(char::is_control),
        "Node needs a bounded, readable name"
    );
    ensure!(
        Path::new(&node.agent_program).is_absolute()
            && Path::new(&node.home_directory).is_absolute(),
        "Node program and home directory must be absolute paths"
    );
    for path in [
        &node.launch.state_dir,
        &node.launch.runtime,
        &node.launch.config,
        &node.launch.instructions,
    ]
    .into_iter()
    .flatten()
    {
        ensure!(
            Path::new(path).is_absolute(),
            "Node launch paths must be absolute"
        );
    }
    if let Some(coordinator) = &node.coordinator {
        config::validate_coordinator(coordinator)?;
    }
    if let Some(model) = &node.launch.model {
        model.validate()?;
    }
    Ok(())
}
