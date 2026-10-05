//! Finds Main Registers on the LAN via mDNS (`_syncretail._tcp`).
//! Runs in Rust because browser JavaScript can't send multicast.

use mdns_sd::{ServiceDaemon, ServiceEvent};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{IpAddr, SocketAddr, TcpStream, UdpSocket};
use std::time::{Duration, Instant};

const SERVICE: &str = "_syncretail._tcp.local.";

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredHost {
    pub instance: String,
    pub store_id: String,
    pub version: String,
    pub port: u16,
    /// Reachable IPv4 addresses, best first (`ip:port`).
    pub addresses: Vec<String>,
}

/// One mDNS daemon for the app's lifetime. Creating and shutting a daemon down
/// on every scan (sockets + multicast joins every few seconds) intermittently
/// took the WebView2 process down with it; scans are serialised on this one.
fn daemon() -> Result<std::sync::MutexGuard<'static, Option<ServiceDaemon>>, String> {
    static DAEMON: std::sync::OnceLock<std::sync::Mutex<Option<ServiceDaemon>>> = std::sync::OnceLock::new();
    let mut guard = DAEMON.get_or_init(|| std::sync::Mutex::new(None)).lock().map_err(|_| "mDNS lock poisoned".to_string())?;
    if guard.is_none() {
        *guard = Some(ServiceDaemon::new().map_err(|e| format!("mDNS unavailable: {e}"))?);
    }
    Ok(guard)
}

/// Browse for `timeout` and return every distinct host (by store id).
pub fn discover(timeout: Duration) -> Result<Vec<DiscoveredHost>, String> {
    let guard = daemon()?;
    let daemon = guard.as_ref().expect("daemon initialised");
    let rx = daemon.browse(SERVICE).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + timeout;
    let mut found: HashMap<String, DiscoveredHost> = HashMap::new();

    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        match rx.recv_timeout(left) {
            Ok(ServiceEvent::ServiceResolved(info)) => {
                let Some(sid) = info.get_property_val_str("sid").map(str::to_string) else { continue };
                let port = info.get_port();
                let mut ips: Vec<IpAddr> = info.get_addresses().iter().copied().filter(|a| a.is_ipv4()).collect();
                // Hosts advertise every adapter (incl. virtual ones like WSL/Hyper-V).
                // Prefer: same subnet as this PC's primary (default-route) network,
                // then any directly reachable subnet, then other private ranges.
                let primary = primary_ipv4();
                ips.sort_by_key(|a| {
                    let on_primary = matches!((a, primary), (IpAddr::V4(v), Some(p)) if v.octets()[..3] == p.octets()[..3]);
                    (!on_primary, !same_subnet(a), !matches!(a, IpAddr::V4(v) if v.is_private()))
                });
                let entry = found.entry(sid.clone()).or_insert_with(|| DiscoveredHost {
                    instance: info.get_fullname().trim_end_matches(SERVICE).trim_end_matches('.').to_string(),
                    store_id: sid,
                    version: info.get_property_val_str("v").unwrap_or("?").to_string(),
                    port,
                    addresses: vec![],
                });
                for ip in ips {
                    let a = format!("{ip}:{port}");
                    if !entry.addresses.contains(&a) {
                        entry.addresses.push(a);
                    }
                }
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }
    let _ = daemon.stop_browse(SERVICE); // keep the daemon; just end this scan
    Ok(found.into_values().collect())
}

/// This PC's address on its default-route interface (no packet is sent).
fn primary_ipv4() -> Option<std::net::Ipv4Addr> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect(("1.1.1.1", 53)).ok()?;
    match sock.local_addr().ok()?.ip() {
        IpAddr::V4(v) if !v.is_unspecified() => Some(v),
        _ => None,
    }
}

/// True if the local interface the OS would route `ip` through is on the same /24.
fn same_subnet(ip: &IpAddr) -> bool {
    let IpAddr::V4(target) = ip else { return false };
    let Ok(sock) = UdpSocket::bind("0.0.0.0:0") else { return false };
    // connect() on UDP sends nothing; it only asks the routing table for a source address.
    if sock.connect((*target, 9)).is_err() {
        return false;
    }
    match sock.local_addr().map(|a| a.ip()) {
        Ok(IpAddr::V4(local)) => local.octets()[..3] == target.octets()[..3],
        _ => false,
    }
}

/// `GET http://<addr>/api/pair/info` → (status, body). Minimal HTTP/1.0 client;
/// used to confirm an address really is our host before switching to it.
pub fn probe(addr: &str, timeout: Duration) -> Option<(u16, String)> {
    let sock: SocketAddr = addr.parse().ok()?;
    let mut s = TcpStream::connect_timeout(&sock, timeout).ok()?;
    s.set_read_timeout(Some(timeout)).ok()?;
    s.set_write_timeout(Some(timeout)).ok()?;
    write!(s, "GET /api/pair/info HTTP/1.0\r\nHost: {addr}\r\nAccept: application/json\r\n\r\n").ok()?;
    let mut buf = String::new();
    s.read_to_string(&mut buf).ok()?;
    let status = buf.split_whitespace().nth(1)?.parse().ok()?;
    let body = buf.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default();
    Some((status, body))
}

/// True if `addr` answers as the host of `store_id`.
pub fn is_host_of(addr: &str, store_id: &str) -> bool {
    match probe(addr, Duration::from_millis(1500)) {
        Some((200, body)) => serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v["storeId"].as_str().map(|s| s == store_id))
            .unwrap_or(false),
        _ => false,
    }
}

#[tauri::command]
pub async fn discover_hosts(timeout_ms: Option<u64>) -> Result<Vec<DiscoveredHost>, String> {
    let t = Duration::from_millis(timeout_ms.unwrap_or(2500).clamp(500, 10_000));
    tauri::async_runtime::spawn_blocking(move || discover(t)).await.map_err(|e| e.to_string())?
}
