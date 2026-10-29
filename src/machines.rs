//! Read-only native machine observations and their compact CLI presentation.

use std::{
    net::Ipv4Addr,
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::protocol::AgentNode;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, TS, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OperatingSystem {
    Macos,
    Linux,
    Other,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, TS, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Architecture {
    Aarch64,
    X86_64,
    Other,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS, PartialEq)]
pub struct MachineSnapshot {
    #[ts(type = "number")]
    pub observed_at_ms: u64,
    pub os: OperatingSystem,
    pub architecture: Architecture,
    pub logical_cpus: Option<u32>,
    #[ts(type = "number | null")]
    pub memory_total_bytes: Option<u64>,
    #[ts(type = "number | null")]
    pub memory_available_bytes: Option<u64>,
    pub load_average: Option<[f64; 3]>,
    #[ts(type = "string | null")]
    pub tailscale_ip: Option<Ipv4Addr>,
}

#[derive(Debug, Serialize)]
pub struct MachineInventory {
    pub nodes: Vec<AgentNode>,
    pub online_host_ids: Vec<String>,
    pub unavailable_host_ids: Vec<String>,
}

impl MachineInventory {
    pub fn format(&self, now: SystemTime) -> String {
        format(
            &self.nodes,
            &self.online_host_ids,
            &self.unavailable_host_ids,
            now,
        )
    }
}

impl MachineSnapshot {
    pub fn native() -> Result<Self> {
        let observed_at_ms = u64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .context("The system clock predates the Unix epoch")?
                .as_millis(),
        )
        .context("The system clock is out of range")?;
        let (memory_total_bytes, memory_available_bytes) = memory();
        let mut load = [0.0; 3];
        // getloadavg writes at most the supplied number of f64 values.
        let load_average = (unsafe { libc::getloadavg(load.as_mut_ptr(), 3) } == 3
            && load.iter().all(|value| value.is_finite() && *value >= 0.0))
        .then_some(load);
        Ok(Self {
            observed_at_ms,
            os: match std::env::consts::OS {
                "macos" => OperatingSystem::Macos,
                "linux" => OperatingSystem::Linux,
                _ => OperatingSystem::Other,
            },
            architecture: match std::env::consts::ARCH {
                "aarch64" => Architecture::Aarch64,
                "x86_64" => Architecture::X86_64,
                _ => Architecture::Other,
            },
            logical_cpus: std::thread::available_parallelism()
                .ok()
                .and_then(|count| u32::try_from(count.get()).ok()),
            memory_total_bytes,
            memory_available_bytes,
            load_average,
            tailscale_ip: None,
        })
    }
}

pub async fn observe(daemon: &crate::tailnet::Daemon) -> Result<MachineSnapshot> {
    let mut snapshot = MachineSnapshot::native()?;
    snapshot.tailscale_ip =
        crate::tailnet::self_address(0, daemon)
            .await
            .ok()
            .and_then(|address| match address.ip() {
                std::net::IpAddr::V4(address) => Some(address),
                std::net::IpAddr::V6(_) => None,
            });
    Ok(snapshot)
}

#[cfg(target_os = "linux")]
fn memory() -> (Option<u64>, Option<u64>) {
    let Ok(text) = std::fs::read_to_string("/proc/meminfo") else {
        return (None, None);
    };
    let kib = |name: &str| {
        text.lines().find_map(|line| {
            let (key, value) = line.split_once(':')?;
            if key != name {
                return None;
            }
            let mut fields = value.split_whitespace();
            let count = fields.next()?.parse::<u64>().ok()?;
            (fields.next()? == "kB")
                .then(|| count.checked_mul(1024))
                .flatten()
        })
    };
    (kib("MemTotal"), kib("MemAvailable"))
}

#[cfg(target_os = "macos")]
fn memory() -> (Option<u64>, Option<u64>) {
    let mut bytes = 0_u64;
    let mut size = std::mem::size_of::<u64>();
    // hw.memsize is a read-only u64. The output buffer and length match it.
    let result = unsafe {
        libc::sysctlbyname(
            c"hw.memsize".as_ptr(),
            std::ptr::from_mut(&mut bytes).cast(),
            &raw mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    // macOS reclaimable memory is not equivalent to Linux MemAvailable.
    (
        (result == 0 && size == std::mem::size_of::<u64>()).then_some(bytes),
        None,
    )
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn memory() -> (Option<u64>, Option<u64>) {
    (None, None)
}

fn bytes(value: Option<u64>) -> String {
    value.map_or_else(
        || "unknown".into(),
        |value| format!("{:.1} GiB", value as f64 / 1_073_741_824.0),
    )
}

pub fn format(
    nodes: &[AgentNode],
    online: &[String],
    unavailable: &[String],
    now: SystemTime,
) -> String {
    if nodes.is_empty() {
        return "No machines have registered with this coordinator.".into();
    }
    let now = now
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok());
    let mut nodes = nodes.iter().collect::<Vec<_>>();
    nodes.sort_by(|left, right| left.name.cmp(&right.name));
    nodes.into_iter().map(|node| {
        let connected = online.contains(&node.host_id);
        let state = if connected { "online" } else { "offline" };
        let Some(snapshot) = &node.machine else {
            let sample = if unavailable.contains(&node.host_id) { "Machine probe unavailable; no saved sample." } else { "No machine sample available." };
            return format!("{} · {state}\nOS / CPU / RAM / load / Tailscale IP: unknown\n{sample}", node.name);
        };
        let os = match snapshot.os { OperatingSystem::Macos => "macOS", OperatingSystem::Linux => "Linux", OperatingSystem::Other => "OS unknown" };
        let architecture = match snapshot.architecture { Architecture::Aarch64 => "aarch64", Architecture::X86_64 => "x86_64", Architecture::Other => "architecture unknown" };
        let cpus = snapshot.logical_cpus.map_or_else(|| "CPU unknown".into(), |count| format!("{count} logical CPUs"));
        let address = snapshot.tailscale_ip.map_or_else(|| "Tailscale IP unknown".into(), |address| address.to_string());
        let load = snapshot.load_average.map_or_else(|| "unknown".into(), |[one, five, fifteen]| format!("{one:.2} / {five:.2} / {fifteen:.2}"));
        let age = match now.and_then(|now| now.checked_sub(snapshot.observed_at_ms)) {
            Some(age) if age < 60_000 => format!("{}s ago", age / 1000),
            Some(age) if age < 3_600_000 => format!("{}m ago", age / 60_000),
            Some(age) => format!("{}h ago", age / 3_600_000),
            None => "time unknown".into(),
        };
        let coverage = if unavailable.contains(&node.host_id) { " · probe unavailable, cached" }
            else if connected { "" } else { " · cached" };
        format!("{} · {state} · {address}\n{os} / {architecture} · {cpus} · RAM {}\nAvailable RAM {} · load (1/5/15m) {load}\nSample {age}{coverage}", node.name, bytes(snapshot.memory_total_bytes), bytes(snapshot.memory_available_bytes))
    }).collect::<Vec<_>>().join("\n\n")
}

#[cfg(test)]
mod tests {
    use crate::{
        machines::{Architecture, MachineInventory, MachineSnapshot, OperatingSystem},
        protocol::{AgentNode, WorkerLaunch},
    };
    use std::time::{Duration, UNIX_EPOCH};
    #[test]
    fn native_observation_uses_the_running_platform_and_real_capacity() {
        let sample = MachineSnapshot::native().unwrap();
        assert!(sample.observed_at_ms > 0);
        assert!(sample.logical_cpus.is_some_and(|value| value > 0));
        assert!(
            sample
                .load_average
                .is_some_and(|values| values.iter().all(|value| value.is_finite()))
        );
        assert!(sample.memory_total_bytes.is_some_and(|bytes| bytes > 0));
        #[cfg(target_os = "macos")]
        {
            assert_eq!(sample.os, OperatingSystem::Macos);
            assert_eq!(sample.memory_available_bytes, None);
        }
        #[cfg(target_os = "linux")]
        {
            assert_eq!(sample.os, OperatingSystem::Linux);
            assert!(sample.memory_available_bytes.unwrap() <= sample.memory_total_bytes.unwrap());
        }
        #[cfg(target_arch = "aarch64")]
        assert_eq!(sample.architecture, Architecture::Aarch64);
        #[cfg(target_arch = "x86_64")]
        assert_eq!(sample.architecture, Architecture::X86_64);
    }

    #[test]
    fn inventory_formats_native_values_and_keeps_offline_failed_and_unknown_samples_explicit() {
        let mut sample = MachineSnapshot::native().unwrap();
        sample.tailscale_ip = Some("100.64.0.10".parse().unwrap());
        let node = |name: &str, machine| AgentNode {
            host_id: name.into(),
            name: name.into(),
            rex_server: None,
            agent_program: "/example/agent".into(),
            home_directory: "/example".into(),
            coordinator: None,
            launch: WorkerLaunch {
                state_dir: None,
                runtime: None,
                config: None,
                instructions: None,
                model: None,
            },
            machine,
        };
        let now = UNIX_EPOCH + Duration::from_millis(sample.observed_at_ms + 65_000);
        let inventory = MachineInventory {
            nodes: vec![
                node("desktop", Some(sample.clone())),
                node("server", Some(sample.clone())),
                node("laptop", None),
            ],
            online_host_ids: vec!["desktop".into(), "laptop".into()],
            unavailable_host_ids: vec!["desktop".into(), "laptop".into()],
        };
        let rendered = inventory.format(now);
        assert!(rendered.contains("desktop · online · 100.64.0.10"));
        assert!(rendered.contains(&format!("{} logical CPUs", sample.logical_cpus.unwrap())));
        assert!(rendered.contains(&format!(
            "RAM {}",
            crate::machines::bytes(sample.memory_total_bytes)
        )));
        assert!(rendered.contains("load (1/5/15m)"));
        assert!(rendered.contains("Sample 1m ago · probe unavailable, cached"));
        assert!(rendered.contains("server · offline · 100.64.0.10"));
        assert!(rendered.contains("Sample 1m ago · cached"));
        assert!(
            rendered.contains("laptop · online\nOS / CPU / RAM / load / Tailscale IP: unknown")
        );
        assert!(rendered.contains("Machine probe unavailable; no saved sample."));
        assert!(
            !rendered.contains('%'),
            "Load averages are not CPU utilization"
        );
        assert!(inventory.format(UNIX_EPOCH).contains("Sample time unknown"));
    }
}
