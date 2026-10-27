//! Capture a remote login's loopback callback without fetching or logging it.

use anyhow::{Context, Result};
use std::{net::Ipv4Addr, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpSocket, TcpStream},
    time::{Instant, timeout_at},
};

const MAX_REQUEST: usize = 8192;
const ADDRESS: &str = "127.0.0.1:1455";

pub struct CallbackRelay {
    listener: TcpListener,
    connection: Option<Connection>,
}

struct Connection {
    stream: TcpStream,
    received: Vec<u8>,
    response: Option<Response>,
    deadline: Instant,
}

struct Response {
    bytes: Vec<u8>,
    written: usize,
    target: Option<String>,
}

impl CallbackRelay {
    pub fn bind() -> Result<Self> {
        Self::bind_at(ADDRESS.parse()?)
    }

    fn bind_at(address: std::net::SocketAddr) -> Result<Self> {
        let socket = TcpSocket::new_v4()?;
        // A completed browser callback can leave TIME_WAIT behind. Reuse that
        // closed connection's address without allowing concurrent listeners.
        socket.set_reuseaddr(true)?;
        socket
            .bind(address)
            .context("Could not bind the local ChatGPT callback on port1455")?;
        Ok(Self {
            listener: socket.listen(8)?,
            connection: None,
        })
    }

    /// State lives in self so select! cancellation preserves partial requests
    /// and partial response writes while coordinator events are handled.
    pub async fn next(&mut self) -> Result<String> {
        loop {
            if self.connection.is_none() {
                let (stream, peer) = self.listener.accept().await?;
                if peer.ip() != Ipv4Addr::LOCALHOST {
                    continue;
                }
                self.connection = Some(Connection {
                    stream,
                    received: Vec::new(),
                    response: None,
                    deadline: Instant::now() + Duration::from_secs(5),
                });
            }
            let connection = self
                .connection
                .as_mut()
                .context("Callback connection is unavailable")?;
            if connection.response.is_none() {
                let mut bytes = [0_u8; 1024];
                match timeout_at(connection.deadline, connection.stream.read(&mut bytes)).await {
                    Ok(Ok(0)) | Ok(Err(_)) | Err(_) => {
                        self.connection.take();
                        continue;
                    }
                    Ok(Ok(count)) => connection.received.extend_from_slice(&bytes[..count]),
                }
                if connection.received.len() > MAX_REQUEST {
                    connection.response = Some(Response::invalid());
                } else {
                    connection.response = parse(&connection.received);
                }
                if connection.response.is_none() {
                    continue;
                }
            }
            let response = connection
                .response
                .as_mut()
                .context("Callback response is unavailable")?;
            while response.written < response.bytes.len() {
                match timeout_at(
                    connection.deadline,
                    connection.stream.write(&response.bytes[response.written..]),
                )
                .await
                {
                    Ok(Ok(0)) | Ok(Err(_)) | Err(_) => break,
                    Ok(Ok(count)) => response.written += count,
                }
            }
            let target = response.target.take();
            self.connection.take();
            if let Some(target) = target {
                return Ok(target);
            }
        }
    }
}

impl Response {
    fn new(target: Option<String>) -> Self {
        let (status, body) = if target.is_some() {
            (
                "200 OK",
                "Authorization response received. Return to agent.",
            )
        } else {
            ("400 Bad Request", "Invalid callback request.")
        };
        let text = format!(
            "HTTP/1.1 {status}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Type: text/plain\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        Self {
            bytes: text.into_bytes(),
            written: 0,
            target,
        }
    }
    fn invalid() -> Self {
        Self::new(None)
    }
}

fn parse(bytes: &[u8]) -> Option<Response> {
    let mut headers = [httparse::EMPTY_HEADER; 32];
    let mut request = httparse::Request::new(&mut headers);
    match request.parse(bytes) {
        Ok(httparse::Status::Partial) => return None,
        Err(_) => return Some(Response::invalid()),
        Ok(httparse::Status::Complete(_)) => {}
    }
    let Some(path) = request.path else {
        return Some(Response::invalid());
    };
    let valid_path = path
        .split_once('?')
        .is_some_and(|(path, _)| path == "/auth/callback");
    let hosts: Vec<_> = request
        .headers
        .iter()
        .filter(|header| header.name.eq_ignore_ascii_case("host"))
        .collect();
    let valid_host = hosts.len() == 1 && hosts[0].value == ADDRESS.as_bytes();
    let no_body = request.headers.iter().all(|header| {
        !header.name.eq_ignore_ascii_case("transfer-encoding")
            && (!header.name.eq_ignore_ascii_case("content-length") || header.value == b"0")
    });
    if request.method != Some("GET")
        || request.version != Some(1)
        || !valid_path
        || !valid_host
        || !no_body
    {
        return Some(Response::invalid());
    }
    Some(Response::new(Some(format!("http://{ADDRESS}{path}"))))
}

#[cfg(test)]
mod tests {
    use crate::callback::{CallbackRelay, parse};
    use std::{io::ErrorKind, net::SocketAddr, time::Duration};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpStream,
        time::timeout,
    };

    fn run_in_own_process() -> bool {
        let current = std::thread::current();
        let name = current
            .name()
            .expect("The test harness names its test thread");
        if let Ok(expected) = std::env::var("AGENT_CALLBACK_TEST_PROCESS") {
            assert_eq!(
                name, expected,
                "The isolated process must run its exact named test"
            );
            return false;
        }
        // Other tests fork in pre_exec. CLOEXEC cannot close their inherited
        // copy until exec, so give socket lifetime assertions one process owner.
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", name, "--nocapture", "--test-threads=1"])
            .env("AGENT_CALLBACK_TEST_PROCESS", name)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        true
    }

    async fn response_and_close(stream: &mut TcpStream) -> String {
        let mut response = String::new();
        timeout(Duration::from_secs(1), stream.read_to_string(&mut response))
            .await
            .unwrap()
            .unwrap();
        stream.shutdown().await.unwrap();
        response
    }

    async fn assert_listener_closed(address: SocketAddr) {
        let error = timeout(Duration::from_secs(1), TcpStream::connect(address))
            .await
            .unwrap()
            .unwrap_err();
        assert_eq!(error.kind(), ErrorKind::ConnectionRefused);
    }

    async fn complete_login(relay: &mut CallbackRelay, address: SocketAddr, code: &str) {
        let mut browser = TcpStream::connect(address).await.unwrap();
        browser.write_all(format!("GET /auth/callback?code={code}&state=expected HTTP/1.1\r\nHost:127.0.0.1:1455\r\n\r\n").as_bytes())
            .await.unwrap();
        let target = timeout(Duration::from_secs(1), relay.next())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            target,
            format!("http://127.0.0.1:1455/auth/callback?code={code}&state=expected")
        );
        let response = response_and_close(&mut browser).await;
        assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(response.ends_with("Authorization response received. Return to agent."));
    }

    #[test]
    fn parser_rejects_foreign_hosts_methods_bodies_and_paths() {
        for request in [
            "POST /auth/callback?state=x HTTP/1.1\r\nHost:127.0.0.1:1455\r\n\r\n",
            "GET /other?state=x HTTP/1.1\r\nHost:127.0.0.1:1455\r\n\r\n",
            "GET /auth/callback?state=x HTTP/1.1\r\nHost:foreign.example\r\n\r\n",
            "GET /auth/callback?state=x HTTP/1.1\r\nHost:127.0.0.1:1455\r\nContent-Length:1\r\n\r\nx",
            "GET /auth/callback?state=x HTTP/1.1\r\nHost:127.0.0.1:1455\r\nHost:127.0.0.1:1455\r\n\r\n",
        ] {
            assert!(parse(request.as_bytes()).unwrap().target.is_none());
        }
    }

    #[tokio::test]
    async fn loopback_relay_survives_invalid_requests_and_cancelled_reads_then_closes() {
        if run_in_own_process() {
            return;
        }
        let mut relay = CallbackRelay::bind_at("127.0.0.1:0".parse().unwrap()).unwrap();
        let address = relay.listener.local_addr().unwrap();
        let mut bad = TcpStream::connect(address).await.unwrap();
        bad.write_all(b"GET /other HTTP/1.1\r\nHost:127.0.0.1:1455\r\n\r\n")
            .await
            .unwrap();
        let mut valid = TcpStream::connect(address).await.unwrap();
        valid
            .write_all(b"GET /auth/callback?code=synthetic&state=expected HTTP/1.1\r\n")
            .await
            .unwrap();
        assert!(
            timeout(Duration::from_millis(20), relay.next())
                .await
                .is_err()
        );
        let response = response_and_close(&mut bad).await;
        assert!(response.starts_with("HTTP/1.1 400"));
        valid
            .write_all(b"Host:127.0.0.1:1455\r\n\r\n")
            .await
            .unwrap();
        assert_eq!(
            timeout(Duration::from_secs(1), relay.next())
                .await
                .unwrap()
                .unwrap(),
            "http://127.0.0.1:1455/auth/callback?code=synthetic&state=expected"
        );
        let response = response_and_close(&mut valid).await;
        assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(response.ends_with("Authorization response received. Return to agent."));
        drop(bad);
        drop(valid);
        drop(relay);
        assert_listener_closed(address).await;
    }

    #[tokio::test]
    async fn consecutive_logins_reuse_the_address_but_never_share_a_live_listener() {
        if run_in_own_process() {
            return;
        }
        let mut relay = CallbackRelay::bind_at("127.0.0.1:0".parse().unwrap()).unwrap();
        let address = relay.listener.local_addr().unwrap();
        let competing = match CallbackRelay::bind_at(address) {
            Ok(_) => panic!("Concurrent callback listeners must never share the port"),
            Err(error) => error,
        };
        assert_eq!(
            competing.downcast_ref::<std::io::Error>().unwrap().kind(),
            ErrorKind::AddrInUse
        );
        complete_login(&mut relay, address, "first").await;
        drop(relay);
        assert_listener_closed(address).await;

        let mut next = CallbackRelay::bind_at(address).unwrap();
        complete_login(&mut next, address, "second").await;
        drop(next);
        assert_listener_closed(address).await;
    }
}
