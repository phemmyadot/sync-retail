//! Where this app instance keeps its data.
//!
//! Normally `%LOCALAPPDATA%\dev.syncretail.pos`. For testing several registers
//! on one PC, `SR_PROFILE=<name>` gives an instance its own folder (mode, host
//! data, WebView2 storage, credential-store entry). Not for production use.

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub fn name() -> Option<String> {
    std::env::var("SR_PROFILE")
        .ok()
        .map(|s| s.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect::<String>())
        .filter(|s| !s.is_empty())
}

pub fn data_root(app: &AppHandle) -> Option<PathBuf> {
    let base = app.path().app_local_data_dir().ok()?;
    Some(match name() {
        Some(p) => base.join("profiles").join(p),
        None => base,
    })
}

/// WebView2 user-data folder for this profile (keeps localStorage/IndexedDB apart).
pub fn webview_dir(app: &AppHandle) -> Option<PathBuf> {
    name().and_then(|_| data_root(app)).map(|d| d.join("EBWebView"))
}

pub fn window_title() -> String {
    match name() {
        Some(p) => format!("Sync Retail POS [{p}]"),
        None => "Sync Retail POS".into(),
    }
}
