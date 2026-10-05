mod host;

use tauri::RunEvent;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(host::HostState::new())
        .invoke_handler(tauri::generate_handler![host::host_status])
        .setup(|app| {
            host::start(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Sync Retail")
        .run(|app, event| {
            // Only the main window owns the host: closing the customer display must not stop it.
            if let RunEvent::Exit = event {
                host::stop(app);
            }
            if let RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } = &event {
                if label == "main" {
                    app.exit(0);
                }
            }
        });
}
