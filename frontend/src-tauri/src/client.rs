//! Client-register mode: pairing persistence and finding the Main Register.
//!
//! * The device token lives in Windows Credential Manager (`keyring`), never
//!   in a plain file. `mode.json` keeps the non-secret parts.
//! * On every launch the last address is tried first; if it doesn't answer as
//!   our store, mDNS is searched for the same store id and `mode.json` is
//!   updated — so a Main Register that got a new IP from DHCP self-heals.

use crate::discovery;
use crate::mode::{self, ClientInfo, Mode};
use serde::Serialize;
use std::time::Duration;
use tauri::AppHandle;

const SERVICE: &str = "SyncRetail";

fn keyring_user(store_id: &str) -> String {
    match crate::profile::name() {
        Some(p) => format!("device:{store_id}:{p}"),
        None => format!("device:{store_id}"),
    }
}

fn entry(store_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, &keyring_user(store_id)).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub reachable: bool,
    pub healed: bool,
    pub api_base: String,
    pub device_token: String,
    pub device_code: String,
    pub store_id: String,
    pub store_name: String,
}

#[tauri::command]
pub fn save_client_pairing(
    app: AppHandle,
    store_id: String,
    store_name: String,
    address: String,
    device_id: String,
    device_code: String,
    device_token: String,
) -> Result<(), String> {
    entry(&store_id)?.set_password(&device_token).map_err(|e| format!("Could not store the device key: {e}"))?;
    mode::write(&app, Mode::Client, Some(ClientInfo { store_id, store_name, address, device_id, device_code }))
}

/// Resolve the Main Register for this paired register (blocking network work).
fn connect_blocking(app: &AppHandle) -> Result<Connection, String> {
    let file = mode::read_file(app).ok_or("This register isn't paired")?;
    let mut info = file.client.ok_or("This register isn't paired")?;
    let token = entry(&info.store_id)?.get_password().map_err(|_| "The device key is missing — pair this register again")?;

    let mut healed = false;
    let mut reachable = discovery::is_host_of(&info.address, &info.store_id);
    if !reachable {
        // Last address failed: look for our store on the network.
        if let Ok(hosts) = discovery::discover(Duration::from_millis(3000)) {
            if let Some(h) = hosts.into_iter().find(|h| h.store_id == info.store_id) {
                if let Some(addr) = h.addresses.into_iter().find(|a| discovery::is_host_of(a, &info.store_id)) {
                    healed = addr != info.address;
                    info.address = addr;
                    reachable = true;
                    if healed {
                        mode::write(app, Mode::Client, Some(info.clone()))?;
                    }
                }
            }
        }
    }
    Ok(Connection {
        reachable,
        healed,
        api_base: format!("http://{}", info.address),
        device_token: token,
        device_code: info.device_code,
        store_id: info.store_id,
        store_name: info.store_name,
    })
}

#[tauri::command]
pub async fn client_connect(app: AppHandle) -> Result<Connection, String> {
    tauri::async_runtime::spawn_blocking(move || connect_blocking(&app)).await.map_err(|e| e.to_string())?
}

/// "Pair again" after this register was removed, or "Change role".
#[tauri::command]
pub fn forget_pairing(app: AppHandle) -> Result<(), String> {
    if let Some(c) = mode::read_file(&app).and_then(|m| m.client) {
        if let Ok(e) = entry(&c.store_id) {
            let _ = e.delete_credential();
        }
    }
    mode::clear(&app);
    crate::kiosk::apply(&app); // back to a normal window for re-pairing
    Ok(())
}
