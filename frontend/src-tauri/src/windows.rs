//! Windows are created in code (not tauri.conf.json) so that every window of
//! an instance shares the same WebView2 profile — the customer display relies
//! on BroadcastChannel/localStorage of the register window.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

fn builder<'a>(app: &'a AppHandle, label: &'a str, url: &str) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    let mut b = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()));
    if let Some(dir) = crate::profile::webview_dir(app) {
        b = b.data_directory(dir);
    }
    b
}

pub fn create_main(app: &AppHandle) -> tauri::Result<()> {
    builder(app, "main", "index.html")
        .title(crate::profile::window_title())
        .inner_size(1440.0, 900.0)
        .min_inner_size(1024.0, 680.0)
        .center()
        .build()?;
    Ok(())
}

#[tauri::command]
pub fn open_customer_display(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("customer-display") {
        return w.set_focus().map_err(|e| e.to_string());
    }
    builder(&app, "customer-display", "display")
        .title("Customer Display")
        .inner_size(1280.0, 800.0)
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}
