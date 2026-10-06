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
    let b = builder(app, "main", "index.html").title(crate::profile::window_title()).min_inner_size(1024.0, 680.0);
    // Kiosk tills are created full screen straight away (no flicker).
    let b = if crate::kiosk::locked(app) {
        b.fullscreen(true).decorations(false).resizable(false).always_on_top(crate::kiosk::strict(app)).focused(true)
    } else {
        b.inner_size(1440.0, 900.0).center()
    };
    b.build()?;
    Ok(())
}

/// Kiosk tills with a second monitor open the customer display there at start.
pub fn auto_open_customer_display(app: &AppHandle) {
    if crate::kiosk::active(app) && crate::kiosk::customer_display_monitor(app).is_some() {
        let _ = open_customer_display(app.clone());
    }
}

#[tauri::command]
pub fn open_customer_display(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("customer-display") {
        return w.set_focus().map_err(|e| e.to_string());
    }
    let b = builder(&app, "customer-display", "display").title("Customer Display");
    let b = match crate::kiosk::customer_display_monitor(&app).filter(|_| crate::kiosk::active(&app)) {
        // Kiosk: full screen on the configured monitor.
        Some(m) => {
            let scale = m.scale_factor();
            let pos = m.position().to_logical::<f64>(scale);
            b.position(pos.x, pos.y).decorations(false).fullscreen(true).focused(false)
        }
        None => b.inner_size(1280.0, 800.0),
    };
    b.build().map(|_| ()).map_err(|e| e.to_string())
}
