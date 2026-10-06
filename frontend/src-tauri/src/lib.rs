mod client;
mod discovery;
mod host;
mod kiosk;
#[cfg(windows)]
mod kiosk_hook;
mod mode;
mod profile;
mod windows;

use tauri::{Emitter, Manager, RunEvent, WindowEvent};

pub fn run_kiosk_watchdog(args: &[String]) {
    kiosk::run_watchdog(args);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    // One Sync Retail per PC: autostart, the kiosk watchdog or a second click
    // just brings the running register forward. Test profiles may run several.
    if profile::name().is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }));
    }
    builder
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .manage(host::HostState::new())
        .invoke_handler(tauri::generate_handler![
            host::host_status,
            mode::app_mode,
            mode::configure_host,
            discovery::discover_hosts,
            client::save_client_pairing,
            client::client_connect,
            client::forget_pairing,
            windows::open_customer_display,
            kiosk::kiosk_status,
            kiosk::kiosk_mark_ready,
            kiosk::kiosk_save_settings,
            kiosk::kiosk_unlock,
            kiosk::kiosk_relock,
            kiosk::kiosk_enforce,
            kiosk::kiosk_exit_app,
            kiosk::kiosk_hash_pin,
            kiosk::kiosk_set_offline_hash,
            kiosk::kiosk_verify_offline_pin,
            kiosk::kiosk_monitors,
        ])
        .on_window_event(|window, event| {
            // Kiosk: ✕ and Alt+F4 both arrive here.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && kiosk::locked(window.app_handle()) {
                    api.prevent_close();
                    let _ = window.emit("kiosk://blocked", ());
                }
            }
        })
        .setup(|app| {
            app.manage(kiosk::KioskState::load(app.handle()));
            windows::create_main(app.handle())?;
            kiosk::init(app.handle());
            kiosk::apply(app.handle());
            windows::auto_open_customer_display(app.handle());
            // Start the host only on a PC already set up as the Main Register;
            // otherwise the UI shows the first-launch wizard.
            if mode::read(app.handle()) == Some(mode::Mode::Host) {
                host::start(app.handle());
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Sync Retail")
        .run(|app, event| {
            // Only the main window owns the host: closing the customer display must not stop it.
            if let RunEvent::Exit = event {
                kiosk::mark_clean_exit(app);
                host::stop(app);
            }
            if let RunEvent::WindowEvent { label, event: WindowEvent::Destroyed, .. } = &event {
                if label == "main" {
                    app.exit(0);
                }
            }
        });
}
