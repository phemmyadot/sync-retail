// Hide the extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // Strict kiosk relaunch watchdog: a second copy of this exe, no window.
    if args.first().map(String::as_str) == Some("--kiosk-watchdog") {
        sync_retail_lib::run_kiosk_watchdog(&args[1..]);
        return;
    }
    sync_retail_lib::run()
}
