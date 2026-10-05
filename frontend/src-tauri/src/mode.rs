//! Which role this PC plays, chosen in the first-launch wizard and stored in
//! `<app-local-data>/mode.json`. M1 supports `host`; `client` arrives with pairing (M2).

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    Host,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModeFile {
    mode: Mode,
    configured_at: String,
}

fn path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_local_data_dir().ok().map(|d| d.join("mode.json"))
}

pub fn read(app: &AppHandle) -> Option<Mode> {
    let text = std::fs::read_to_string(path(app)?).ok()?;
    serde_json::from_str::<ModeFile>(&text).ok().map(|m| m.mode)
}

fn write(app: &AppHandle, mode: Mode) -> Result<(), String> {
    let p = path(app).ok_or("no data directory")?;
    std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let body = serde_json::to_string_pretty(&ModeFile { mode, configured_at: format!("{secs}") }).map_err(|e| e.to_string())?;
    std::fs::write(p, body).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn app_mode(app: AppHandle) -> Option<Mode> {
    read(&app)
}

/// Wizard step 1 → "Main Register": remember the choice and start the host.
#[tauri::command]
pub fn configure_host(app: AppHandle) -> Result<(), String> {
    if read(&app) != Some(Mode::Host) {
        write(&app, Mode::Host)?;
    }
    crate::host::start(&app);
    Ok(())
}
