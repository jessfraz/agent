//! Tailscale transport with explicit peer trust. Never bind a wildcard or ordinary LAN address.

use std::{
    collections::BTreeSet,
    io,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    num::NonZeroU64,
    os::fd::AsRawFd,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, de::DeserializeOwned};
use tokio::{
    io::AsyncReadExt,
    net::{TcpListener, TcpSocket, TcpStream},
    process::Command,
    time::timeout,
};

/// Select one native daemon explicitly when GUI and system daemons coexist.
#[derive(Clone, Debug, Default)]
pub struct Daemon {
    socket: Option<PathBuf>,
}

impl Daemon {
    pub fn new(socket: Option<&Path>) -> Result<Self> {
        if let Some(path) = socket {
            ensure!(
                path.is_absolute(),
                "Tailscale socket must be an absolute path"
            );
        }
        Ok(Self {
            socket: socket.map(Path::to_owned),
        })
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new("tailscale");
        if let Some(path) = &self.socket {
            command.arg("--socket").arg(path);
        }
        command.args(args);
        command
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Status {
    backend_state: String,
    #[serde(rename = "Self")]
    this_node: SelfNode,
    #[serde(rename = "TailscaleIPs")]
    addresses: Vec<IpAddr>,
}

#[derive(Deserialize)]
struct SelfNode {
    #[serde(rename = "UserID")]
    owner: NonZeroU64,
    #[serde(rename = "TailscaleIPs")]
    addresses: Vec<IpAddr>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Whois {
    node: PeerNode,
    user_profile: UserProfile,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct PeerNode {
    user: NonZeroU64,
    addresses: Vec<String>,
    #[serde(rename = "StableID")]
    stable_id: Option<String>,
    tags: Option<Vec<String>>,
    #[serde(default)]
    machine_authorized: bool,
}

#[derive(Clone, Debug)]
pub struct PeerPolicy {
    trust: PeerTrust,
}

#[derive(Clone, Debug)]
enum PeerTrust {
    SameUser,
    Explicit(BTreeSet<String>),
}

impl PeerPolicy {
    pub fn new(stable_node_ids: &[String]) -> Result<Self> {
        if stable_node_ids.is_empty() {
            return Ok(Self {
                trust: PeerTrust::SameUser,
            });
        }
        let mut nodes = BTreeSet::new();
        for id in stable_node_ids {
            ensure!(
                !id.is_empty()
                    && id.len() <= 128
                    && !id
                        .chars()
                        .any(|character| character.is_whitespace() || character.is_control()),
                "Trusted Tailscale stable node IDs require 1 to 128 bytes without whitespace or control characters"
            );
            ensure!(
                nodes.insert(id.clone()),
                "Trusted Tailscale stable node IDs must be unique"
            );
        }
        Ok(Self {
            trust: PeerTrust::Explicit(nodes),
        })
    }
}

#[derive(Deserialize)]
struct UserProfile {
    #[serde(rename = "ID")]
    id: NonZeroU64,
}

fn tailnet_v4(address: IpAddr) -> Result<Ipv4Addr> {
    let IpAddr::V4(address) = address else {
        anyhow::bail!("A Tailscale IPv4 address is required");
    };
    let octets = address.octets();
    ensure!(
        octets[0] == 100 && (64..=127).contains(&octets[1]),
        "Only the Tailscale IPv4 range is accepted"
    );
    Ok(address)
}

fn current_address(status: &Status) -> Result<Ipv4Addr> {
    ensure!(
        status.backend_state == "Running",
        "Tailscale is not running"
    );
    status
        .this_node
        .addresses
        .iter()
        .copied()
        .filter(|address| status.addresses.contains(address))
        .find_map(|address| tailnet_v4(address).ok())
        .context("Tailscale has no active self IPv4 address")
}

fn authorize(status: &Status, peer: SocketAddr, whois: &Whois, policy: &PeerPolicy) -> Result<()> {
    current_address(status)?;
    let address = tailnet_v4(peer.ip())?;
    ensure!(
        whois.node.user == whois.user_profile.id,
        "Tailscale peer user does not match its identity profile"
    );
    match &policy.trust {
        PeerTrust::SameUser => {
            ensure!(
                whois.node.machine_authorized,
                "Tailscale peer is not authorized"
            );
            ensure!(
                whois.node.tags.as_ref().is_none_or(Vec::is_empty),
                "Tagged Tailscale peers require an explicit stable node ID"
            );
            ensure!(
                whois.node.user == status.this_node.owner,
                "Tailscale peer belongs to a different user"
            );
        }
        PeerTrust::Explicit(nodes) => {
            // A reachable WireGuard peer plus its pinned control-plane identity
            // is the authority. Tags and their synthetic owner grant no trust.
            ensure!(
                whois
                    .node
                    .stable_id
                    .as_ref()
                    .is_some_and(|id| nodes.contains(id)),
                "Tailscale peer stable node ID is not explicitly trusted"
            );
        }
    }
    let exact = whois.node.addresses.iter().any(|prefix| {
        let Some((ip, bits)) = prefix.split_once('/') else {
            return false;
        };
        bits == "32" && ip.parse::<Ipv4Addr>().is_ok_and(|ip| ip == address)
    });
    ensure!(
        exact,
        "Tailscale identity does not match the connected peer address"
    );
    Ok(())
}

pub async fn self_address(port: u16, daemon: &Daemon) -> Result<SocketAddr> {
    let status: Status = invoke(daemon, &["status", "--json"]).await?;
    Ok(SocketAddr::new(current_address(&status)?.into(), port))
}

/// Validate the actual connected IP, never a forwarded header or caller label.
pub async fn validate_peer(peer: SocketAddr, policy: &PeerPolicy, daemon: &Daemon) -> Result<()> {
    tailnet_v4(peer.ip())?;
    let status: Status = invoke(daemon, &["status", "--json"]).await?;
    let whois: Whois = invoke(daemon, &["whois", "--json", &peer.to_string()]).await?;
    authorize(&status, peer, &whois, policy)
}

pub(crate) async fn validate_connection(
    local: SocketAddr,
    peer: SocketAddr,
    policy: &PeerPolicy,
    daemon: &Daemon,
) -> Result<()> {
    tailnet_v4(peer.ip())?;
    let status: Status = invoke(daemon, &["status", "--json"]).await?;
    ensure!(
        local.ip() == IpAddr::V4(current_address(&status)?),
        "Coordinator listener is no longer the active Tailscale address"
    );
    let whois: Whois = invoke(daemon, &["whois", "--json", &peer.to_string()]).await?;
    authorize(&status, peer, &whois, policy)
}

pub async fn connect(peer: SocketAddr, policy: &PeerPolicy, daemon: &Daemon) -> Result<TcpStream> {
    tailnet_v4(peer.ip())?;
    let status: Status = invoke(daemon, &["status", "--json"]).await?;
    let address = current_address(&status)?;
    let whois: Whois = invoke(daemon, &["whois", "--json", &peer.to_string()]).await?;
    authorize(&status, peer, &whois, policy)?;
    let socket = scoped_socket(address)?;
    socket.bind(SocketAddr::new(address.into(), 0))?;
    timeout(Duration::from_secs(8), socket.connect(peer))
        .await
        .context("Tailscale coordinator connection timed out")?
        .context("Could not connect to Tailscale coordinator")
}

pub(crate) async fn listen(port: u16, daemon: &Daemon) -> Result<TcpListener> {
    let address = self_address(port, daemon).await?;
    let socket = scoped_socket(tailnet_v4(address.ip())?)?;
    socket
        .bind(address)
        .context("Could not bind the Tailscale coordinator address")?;
    socket
        .listen(128)
        .context("Could not listen on the Tailscale interface")
}

fn scoped_socket(address: Ipv4Addr) -> Result<TcpSocket> {
    let interface = Interface::for_address(address)?;
    let socket = TcpSocket::new_v4()?;
    bind_interface(&socket, &interface)?;
    Ok(socket)
}

struct Interface {
    #[cfg(target_os = "macos")]
    index: libc::c_uint,
    #[cfg(target_os = "linux")]
    name: std::ffi::CString,
}

impl Interface {
    fn for_address(address: Ipv4Addr) -> Result<Self> {
        struct Addresses(*mut libc::ifaddrs);
        impl Drop for Addresses {
            fn drop(&mut self) {
                unsafe {
                    libc::freeifaddrs(self.0);
                }
            }
        }
        let mut list = std::ptr::null_mut();
        // getifaddrs owns a stable snapshot until freeifaddrs. Family AF_INET
        // guarantees sockaddr_in layout; interface names are NUL terminated.
        if unsafe { libc::getifaddrs(&mut list) } != 0 {
            return Err(io::Error::last_os_error()).context("Could not inspect local interfaces");
        }
        let _addresses = Addresses(list);
        let mut cursor = list;
        while let Some(interface) = unsafe { cursor.as_ref() } {
            if !interface.ifa_addr.is_null()
                && !interface.ifa_name.is_null()
                && unsafe { (*interface.ifa_addr).sa_family } == libc::AF_INET as libc::sa_family_t
            {
                let socket_address = unsafe { &*interface.ifa_addr.cast::<libc::sockaddr_in>() };
                if Ipv4Addr::from(socket_address.sin_addr.s_addr.to_ne_bytes()) == address {
                    let index = unsafe { libc::if_nametoindex(interface.ifa_name) };
                    ensure!(index != 0, "Tailscale interface has no index");
                    return Ok(Self {
                        #[cfg(target_os = "macos")]
                        index,
                        #[cfg(target_os = "linux")]
                        name: unsafe { std::ffi::CStr::from_ptr(interface.ifa_name) }.to_owned(),
                    });
                }
            }
            cursor = interface.ifa_next;
        }
        anyhow::bail!("Tailscale IPv4 is not assigned to a local interface")
    }
}

#[cfg(target_os = "macos")]
fn bind_interface(socket: &TcpSocket, interface: &Interface) -> Result<()> {
    let index = interface.index;
    let bound = unsafe {
        libc::setsockopt(
            socket.as_raw_fd(),
            libc::IPPROTO_IP,
            libc::IP_BOUND_IF,
            std::ptr::from_ref(&index).cast(),
            std::mem::size_of_val(&index) as libc::socklen_t,
        )
    };
    ensure!(
        bound == 0,
        "Could not restrict the socket to the Tailscale interface: {}",
        io::Error::last_os_error()
    );
    Ok(())
}

#[cfg(target_os = "linux")]
fn bind_interface(socket: &TcpSocket, interface: &Interface) -> Result<()> {
    let name = interface.name.as_bytes_with_nul();
    let bound = unsafe {
        libc::setsockopt(
            socket.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_BINDTODEVICE,
            name.as_ptr().cast(),
            name.len().try_into()?,
        )
    };
    ensure!(
        bound == 0,
        "Could not restrict the socket to the Tailscale interface: {}",
        io::Error::last_os_error()
    );
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn bind_interface(_socket: &TcpSocket, _interface: &Interface) -> Result<()> {
    anyhow::bail!("Tailscale interface binding is unsupported on this platform")
}

async fn invoke<T: DeserializeOwned>(daemon: &Daemon, args: &[&str]) -> Result<T> {
    const MAX_BYTES: u64 = 1024 * 1024;
    let mut child = daemon
        .command(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .context("Tailscale CLI is unavailable")?;
    let result = timeout(Duration::from_secs(8), async {
        let mut bytes = Vec::new();
        child
            .stdout
            .take()
            .context("Tailscale output is unavailable")?
            .take(MAX_BYTES + 1)
            .read_to_end(&mut bytes)
            .await?;
        ensure!(
            bytes.len() as u64 <= MAX_BYTES,
            "Tailscale identity response exceeded its size limit"
        );
        ensure!(
            child.wait().await?.success(),
            "Tailscale identity read failed"
        );
        serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("Tailscale returned invalid identity metadata"))
    })
    .await
    .context("Tailscale identity read timed out")
    .and_then(std::convert::identity);
    let _ = child.start_kill();
    timeout(Duration::from_secs(2), child.wait())
        .await
        .context("Could not confirm Tailscale reader exit")??;
    result
}

#[cfg(test)]
mod tests {
    use crate::tailnet::{
        PeerNode, PeerPolicy, SelfNode, Status, UserProfile, Whois, authorize, current_address,
        tailnet_v4,
    };
    use std::{
        net::{IpAddr, Ipv4Addr, SocketAddr},
        num::NonZeroU64,
    };

    fn status() -> Status {
        Status {
            backend_state: "Running".into(),
            addresses: vec!["100.64.10.1".parse().unwrap()],
            this_node: SelfNode {
                owner: NonZeroU64::new(42).unwrap(),
                addresses: vec!["100.64.10.1".parse().unwrap()],
            },
        }
    }
    fn whois() -> Whois {
        Whois {
            node: PeerNode {
                user: NonZeroU64::new(42).unwrap(),
                addresses: vec!["100.64.10.2/32".into()],
                stable_id: Some("nSyntheticPeer".into()),
                tags: None,
                machine_authorized: true,
            },
            user_profile: UserProfile {
                id: NonZeroU64::new(42).unwrap(),
            },
        }
    }

    #[test]
    fn requires_running_self_address_and_same_verified_peer_owner() {
        let policy = PeerPolicy::new(&[]).unwrap();
        let peer: SocketAddr = "100.64.10.2:12345".parse().unwrap();
        let mut current = status();
        let mut peer_identity = whois();
        assert!(authorize(&current, peer, &peer_identity, &policy).is_ok());
        peer_identity.node.user = NonZeroU64::new(43).unwrap();
        assert!(authorize(&current, peer, &peer_identity, &policy).is_err());
        peer_identity = whois();
        peer_identity.user_profile.id = NonZeroU64::new(43).unwrap();
        assert!(authorize(&current, peer, &peer_identity, &policy).is_err());
        peer_identity = whois();
        peer_identity.node.addresses = vec!["100.64.10.3/32".into()];
        assert!(authorize(&current, peer, &peer_identity, &policy).is_err());
        peer_identity = whois();
        peer_identity.node.machine_authorized = false;
        assert!(authorize(&current, peer, &peer_identity, &policy).is_err());
        current.backend_state = "NeedsLogin".into();
        assert!(current_address(&current).is_err());
        current = status();
        current.addresses.clear();
        assert!(current_address(&current).is_err());
    }

    #[test]
    fn rejects_lan_wildcard_loopback_and_ipv6_destinations() {
        for address in [
            "0.0.0.0",
            "127.0.0.1",
            "192.168.1.1",
            "8.8.8.8",
            "100.63.255.255",
            "100.128.0.1",
            "::1",
        ] {
            assert!(tailnet_v4(address.parse().unwrap()).is_err());
        }
        assert_eq!(
            tailnet_v4(IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1))).unwrap(),
            Ipv4Addr::new(100, 64, 0, 1)
        );
    }

    #[test]
    fn parses_native_identity_shapes_without_reading_unneeded_profile_fields() {
        let status: Status = serde_json::from_str(
            r#"{
            "BackendState":"Running", "TailscaleIPs":["100.64.10.1"],
            "Self":{"UserID":42,"TailscaleIPs":["100.64.10.1"]}
        }"#,
        )
        .unwrap();
        let peer: Whois = serde_json::from_str(r#"{
            "Node":{"User":42,"Addresses":["100.64.10.2/32"],"MachineAuthorized":true,"Name":"synthetic.example"},
            "UserProfile":{"ID":42,"LoginName":"user@example.com"}
        }"#).unwrap();
        assert!(
            authorize(
                &status,
                "100.64.10.2:1234".parse().unwrap(),
                &peer,
                &PeerPolicy::new(&[]).unwrap()
            )
            .is_ok()
        );
        assert!(
            serde_json::from_str::<Status>(
                r#"{
            "BackendState":"Running", "TailscaleIPs":["100.64.10.1"],
            "Self":{"UserID":0,"TailscaleIPs":["100.64.10.1"]}
        }"#
            )
            .is_err()
        );
    }

    #[test]
    fn peer_policy_validates_unique_bounded_opaque_stable_node_ids() {
        assert!(PeerPolicy::new(&[]).is_ok());
        assert!(PeerPolicy::new(&["nSyntheticPeer".into()]).is_ok());
        for ids in [
            vec![String::new()],
            vec!["  ".into()],
            vec!["nSynthetic Peer".into()],
            vec!["nSyntheticPeer\n".into()],
            vec!["x".repeat(129)],
            vec!["nSyntheticPeer".into(), "nSyntheticPeer".into()],
        ] {
            assert!(PeerPolicy::new(&ids).is_err());
        }
    }

    fn tagged_native_identity() -> Whois {
        serde_json::from_str(r#"{
            "Node":{"StableID":"nSyntheticTagged","User":99,"Addresses":["100.64.10.2/32"],"Tags":["tag:fixture-server"]},
            "UserProfile":{"ID":99,"LoginName":"tagged-devices"}
        }"#).unwrap()
    }

    #[test]
    fn explicitly_pinned_native_tagged_identity_does_not_require_local_owner_or_optional_approval_field()
     {
        let peer: SocketAddr = "100.64.10.2:12345".parse().unwrap();
        let current = status();
        let mut native = tagged_native_identity();
        let policy = PeerPolicy::new(&["nSyntheticTagged".into()]).unwrap();
        assert!(
            !native.node.machine_authorized,
            "Native omitempty approval metadata defaults to false"
        );
        assert!(authorize(&current, peer, &native, &policy).is_ok());
        assert!(authorize(&current, peer, &native, &PeerPolicy::new(&[]).unwrap()).is_err());
        native.node.user = current.this_node.owner;
        native.user_profile.id = current.this_node.owner;
        native.node.machine_authorized = true;
        assert!(
            authorize(&current, peer, &native, &PeerPolicy::new(&[]).unwrap()).is_err(),
            "Tags never inherit same-user trust"
        );
        native.node.tags = Some(vec![]);
        assert!(authorize(&current, peer, &native, &PeerPolicy::new(&[]).unwrap()).is_ok());
        native.node.machine_authorized = false;
        assert!(authorize(&current, peer, &native, &PeerPolicy::new(&[]).unwrap()).is_err());
    }

    #[test]
    fn explicit_trust_rejects_wrong_or_missing_nodes_even_with_matching_user_or_tags() {
        let peer: SocketAddr = "100.64.10.2:12345".parse().unwrap();
        let current = status();
        let policy = PeerPolicy::new(&["nSyntheticTagged".into()]).unwrap();
        let mut identity = whois();
        assert!(
            authorize(&current, peer, &identity, &policy).is_err(),
            "Explicit trust has no same-user fallback"
        );
        identity = tagged_native_identity();
        identity.node.stable_id = Some("nOtherTagged".into());
        assert!(
            authorize(&current, peer, &identity, &policy).is_err(),
            "Tag ownership is not an allowlist"
        );
        for missing in [None, Some(String::new())] {
            identity.node.stable_id = missing;
            assert!(authorize(&current, peer, &identity, &policy).is_err());
        }
        identity = tagged_native_identity();
        identity.user_profile.id = current.this_node.owner;
        assert!(
            authorize(&current, peer, &identity, &policy).is_err(),
            "Native profile must still match the node owner"
        );
    }

    #[test]
    fn explicit_node_trust_still_requires_the_exact_connected_host_address() {
        let peer: SocketAddr = "100.64.10.2:12345".parse().unwrap();
        let policy = PeerPolicy::new(&["nSyntheticTagged".into()]).unwrap();
        let mut identity = tagged_native_identity();
        for address in ["100.64.10.3/32", "100.64.10.2/24", "100.64.10.2", "::1/128"] {
            identity.node.addresses = vec![address.into()];
            assert!(authorize(&status(), peer, &identity, &policy).is_err());
        }
        identity.node.addresses = vec!["100.64.10.2/32".into()];
        assert!(authorize(&status(), peer, &identity, &policy).is_ok());
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn native_socket_retains_its_interface_scope() {
        use crate::tailnet::{Interface, bind_interface};
        use std::os::fd::AsRawFd;
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::{TcpSocket, TcpStream},
        };
        let interface = Interface::for_address(Ipv4Addr::LOCALHOST).unwrap();
        let socket = TcpSocket::new_v4().unwrap();
        bind_interface(&socket, &interface).unwrap();
        let mut index = 0_u32;
        let mut size = std::mem::size_of_val(&index) as libc::socklen_t;
        assert_eq!(
            unsafe {
                libc::getsockopt(
                    socket.as_raw_fd(),
                    libc::IPPROTO_IP,
                    libc::IP_BOUND_IF,
                    std::ptr::from_mut(&mut index).cast(),
                    &mut size,
                )
            },
            0
        );
        assert_eq!(index, interface.index);
        socket.bind("127.0.0.1:0".parse().unwrap()).unwrap();
        let listener = socket.listen(1).unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        let (mut accepted, _) = listener.accept().await.unwrap();
        client.write_all(b"scoped").await.unwrap();
        let mut received = [0_u8; 6];
        accepted.read_exact(&mut received).await.unwrap();
        assert_eq!(&received, b"scoped");
    }

    #[tokio::test]
    #[ignore = "requires this machine's running Tailscale daemon"]
    async fn live_tailscale_self_connection_checks_native_identity() {
        use crate::tailnet::{Daemon, connect, listen, validate_connection};
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            time::{Duration, timeout},
        };
        // Five bounded native identity reads plus connection setup can take
        // longer than one CLI read while the local daemon is cold.
        timeout(Duration::from_secs(60), async {
            let policy = PeerPolicy::new(&[]).unwrap();
            let daemon = Daemon::default();
            eprintln!("native smoke: binding");
            let listener = listen(0, &daemon).await.unwrap();
            let address = listener.local_addr().unwrap();
            eprintln!("native smoke: connecting");
            let mut client = connect(address, &policy, &daemon).await.unwrap();
            eprintln!("native smoke: accepting");
            let (mut accepted, peer) = listener.accept().await.unwrap();
            eprintln!("native smoke: validating");
            validate_connection(accepted.local_addr().unwrap(), peer, &policy, &daemon)
                .await
                .unwrap();
            eprintln!("native smoke: exchanging");
            client.write_all(b"verified").await.unwrap();
            let mut bytes = [0_u8; 8];
            accepted.read_exact(&mut bytes).await.unwrap();
            assert_eq!(&bytes, b"verified");
        })
        .await
        .unwrap();
    }
}
