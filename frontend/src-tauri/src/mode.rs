//! Which role this PC plays, chosen in the first-launch wizard and stored in
//! `<data>/mode.json`:
//!   host    — Main Register: runs the API + database (see host.rs)
//!   client  — a register paired with a Main Register (see client.rs)

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    Host,
    Client,
}

/// What a paired register remembers about its Main Register.
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfo {
    pub store_id: String,
    pub store_name: String,
    /// Last address that worked, `ip:port`. Re-found by store id if it changes.
    pub address: String,
    pub device_id: String,
    pub device_code: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeFile {
    pub mode: Mode,
    pub configured_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client: Option<ClientInfo>,
}

fn path(app: &AppHandle) -> Option<std::path::PathBuf> {
    crate::profile::data_root(app).map(|d| d.join("mode.json"))
}

pub fn read_file(app: &AppHandle) -> Option<ModeFile> {
    let text = std::fs::read_to_string(path(app)?).ok()?;
    serde_json::from_str::<ModeFile>(&text).ok()
}

pub fn read(app: &AppHandle) -> Option<Mode> {
    read_file(app).map(|m| m.mode)
}

pub fn write(app: &AppHandle, mode: Mode, client: Option<ClientInfo>) -> Result<(), String> {
    let p = path(app).ok_or("no data directory")?;
    std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let body = serde_json::to_string_pretty(&ModeFile { mode, configured_at: format!("{secs}"), client }).map_err(|e| e.to_string())?;
    std::fs::write(p, body).map_err(|e| e.to_string())
}

pub fn clear(app: &AppHandle) {
    if let Some(p) = path(app) {
        let _ = std::fs::remove_file(p);
    }
}

#[tauri::command]
pub fn app_mode(app: AppHandle) -> Option<Mode> {
    read(&app)
}

/// Wizard → "Main Register": remember the choice and start the host.
#[tauri::command]
pub fn configure_host(app: AppHandle) -> Result<(), String> {
    if read(&app) != Some(Mode::Host) {
        write(&app, Mode::Host, None)?;
    }
    crate::host::start(&app);
    Ok(())
}
