//! Kiosk mode: the till boots full screen and staff can't close it, shrink it
//! or wander onto the desktop. A manager PIN unlocks a timed maintenance window.
//!
//! Settings are per PC, in `<data>/kiosk.json` beside `mode.json`, so they
//! apply before any network or login. See docs/done/KIOSK_PLAN.md.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use argon2::password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    #[default]
    Standard,
    Strict,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct KioskSettings {
    pub enabled: bool,
    pub level: Level,
    /// Start Sync Retail when this Windows user signs in.
    pub autostart: bool,
    /// "auto" = first non-primary monitor, "off" = don't open it, or a monitor name.
    pub customer_display_monitor: String,
    pub offline_exit_pin_hash: Option<String>,
    /// Set by the UI once this PC first reaches the staff lock screen, so a
    /// Main Register is never locked down mid-setup (no admin exists yet).
    pub setup_complete: bool,
    pub updated_at: Option<u64>,
    pub updated_by: Option<String>,
}

impl Default for KioskSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            level: Level::Standard,
            autostart: true,
            customer_display_monitor: "auto".into(),
            offline_exit_pin_hash: None,
            setup_complete: false,
            updated_at: None,
            updated_by: None,
        }
    }
}

pub struct KioskState {
    settings: Mutex<KioskSettings>,
    unlocked_until: Mutex<Option<Instant>>,
    offline_attempts: Mutex<Vec<Instant>>,
    watchdog_started: AtomicBool,
}

impl KioskState {
    pub fn load(app: &AppHandle) -> Self {
        let settings = path(app)
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        Self {
            settings: Mutex::new(settings),
            unlocked_until: Mutex::new(None),
            offline_attempts: Mutex::new(Vec::new()),
            watchdog_started: AtomicBool::new(false),
        }
    }
}

fn path(app: &AppHandle) -> Option<PathBuf> {
    crate::profile::data_root(app).map(|d| d.join("kiosk.json"))
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// `SR_KIOSK=0` turns kiosk off for one launch (support), `SR_KIOSK=1` forces it
/// on in dev builds (testing). Otherwise: on in release builds only.
fn env_allows() -> bool {
    match std::env::var("SR_KIOSK").as_deref() {
        Ok("0") => false,
        Ok("1") => true,
        _ => !cfg!(debug_assertions),
    }
}

fn settings(app: &AppHandle) -> KioskSettings {
    app.state::<KioskState>().settings.lock().unwrap().clone()
}

/// Kiosk applies once this PC has a role and finished setup (the wizard runs windowed).
pub fn active(app: &AppHandle) -> bool {
    let s = settings(app);
    s.enabled && s.setup_complete && crate::mode::read(app).is_some() && env_allows()
}

pub fn strict(app: &AppHandle) -> bool {
    active(app) && settings(app).level == Level::Strict
}

/// Active and not inside a maintenance window.
pub fn locked(app: &AppHandle) -> bool {
    active(app) && app.state::<KioskState>().unlocked_until.lock().unwrap().map_or(true, |t| Instant::now() >= t)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KioskStatus {
    pub available: bool,
    pub active: bool,
    pub locked: bool,
    /// Seconds left in the maintenance window, if unlocked.
    pub unlocked_for_secs: Option<u64>,
    pub level: Level,
    pub enabled: bool,
    pub autostart: bool,
    pub customer_display_monitor: String,
    pub has_offline_pin: bool,
    pub env_override: Option<String>,
    pub updated_at: Option<u64>,
    pub updated_by: Option<String>,
}

fn status(app: &AppHandle) -> KioskStatus {
    let s = settings(app);
    let until = *app.state::<KioskState>().unlocked_until.lock().unwrap();
    let left = until.and_then(|t| t.checked_duration_since(Instant::now())).map(|d| d.as_secs().max(1));
    KioskStatus {
        available: crate::mode::read(app).is_some() && s.setup_complete,
        active: active(app),
        locked: locked(app),
        unlocked_for_secs: if active(app) { left } else { None },
        level: s.level,
        enabled: s.enabled,
        autostart: s.autostart,
        customer_display_monitor: s.customer_display_monitor,
        has_offline_pin: s.offline_exit_pin_hash.is_some(),
        env_override: std::env::var("SR_KIOSK").ok(),
        updated_at: s.updated_at,
        updated_by: s.updated_by,
    }
}

fn save(app: &AppHandle, s: &KioskSettings) -> Result<(), String> {
    let p = path(app).ok_or("no data directory")?;
    std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    let body = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    std::fs::write(p, body).map_err(|e| e.to_string())?;
    *app.state::<KioskState>().settings.lock().unwrap() = s.clone();
    Ok(())
}

/// Brings the main window in line with the current kiosk state.
pub fn apply(app: &AppHandle) {
    sync_autostart(app);
    let locked = locked(app);
    let strict = strict(app);
    #[cfg(windows)]
    crate::kiosk_hook::set_active(locked && strict);
    if let Some(w) = app.get_webview_window("main") {
        if locked {
            let _ = w.set_decorations(false);
            let _ = w.set_resizable(false);
            let _ = w.set_fullscreen(true);
            let _ = w.set_always_on_top(strict);
            let _ = w.set_focus();
        } else {
            let _ = w.set_always_on_top(false);
            let was_full = w.is_fullscreen().unwrap_or(false);
            let _ = w.set_fullscreen(false);
            let _ = w.set_decorations(true);
            let _ = w.set_resizable(true);
            if was_full {
                let _ = w.maximize();
            }
        }
    }
    if strict {
        start_watchdog(app);
    }
    let _ = app.emit("kiosk://changed", status(app));
}

/// Startup work: autostart registration and the 1-second enforcement loop that
/// puts the window back to full screen (Win+↓, display changes) and ends
/// maintenance windows.
pub fn init(app: &AppHandle) {
    if strict(app) {
        start_watchdog(app);
    }
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        let state = app.state::<KioskState>();
        let expired = {
            let mut until = state.unlocked_until.lock().unwrap();
            match *until {
                Some(t) if Instant::now() >= t => {
                    *until = None;
                    true
                }
                _ => false,
            }
        };
        if expired {
            apply(&app);
            let _ = app.emit("kiosk://relocked", ());
            continue;
        }
        if locked(&app) {
            enforce(&app);
        }
    });
}

fn enforce(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_minimized().unwrap_or(false) {
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
        if !w.is_fullscreen().unwrap_or(true) {
            let _ = w.set_decorations(false);
            let _ = w.set_fullscreen(true);
        }
    }
}

fn sync_autostart(app: &AppHandle) {
    use tauri_plugin_autostart::ManagerExt;
    // Test profiles (SR_PROFILE) and dev builds never register themselves.
    if crate::profile::name().is_some() || cfg!(debug_assertions) {
        return;
    }
    let s = settings(app);
    let want = s.enabled && s.autostart && s.setup_complete && crate::mode::read(app).is_some();
    let launcher = app.autolaunch();
    let has = launcher.is_enabled().unwrap_or(false);
    if want && !has {
        let _ = launcher.enable();
    } else if !want && has {
        let _ = launcher.disable();
    }
}

// ─── Strict-mode relaunch watchdog ──────────────────────────────────────────

const CLEAN_EXIT: &str = "kiosk-clean-exit";

/// Marks an intentional exit so the watchdog doesn't relaunch the app.
pub fn mark_clean_exit(app: &AppHandle) {
    if let Some(d) = crate::profile::data_root(app) {
        let _ = std::fs::write(d.join(CLEAN_EXIT), b"1");
    }
}

fn start_watchdog(app: &AppHandle) {
    let state = app.state::<KioskState>();
    if state.watchdog_started.swap(true, Ordering::SeqCst) {
        return;
    }
    let (Ok(exe), Some(root)) = (std::env::current_exe(), crate::profile::data_root(app)) else { return };
    let _ = std::fs::remove_file(root.join(CLEAN_EXIT));
    let _ = std::process::Command::new(exe)
        .arg("--kiosk-watchdog")
        .arg(std::process::id().to_string())
        .arg(root)
        .spawn();
}

/// `sync-retail.exe --kiosk-watchdog <pid> <data-root>`: waits for the app to
/// exit and relaunches it unless the exit was intentional or kiosk is no
/// longer strict. Runs before Tauri starts (see main.rs).
pub fn run_watchdog(args: &[String]) {
    let (Some(pid), Some(root)) = (args.first().and_then(|p| p.parse::<u32>().ok()), args.get(1)) else { return };
    let root = PathBuf::from(root);
    #[cfg(windows)]
    crate::kiosk_hook::wait_for_process(pid);
    std::thread::sleep(Duration::from_secs(2));
    if std::fs::remove_file(root.join(CLEAN_EXIT)).is_ok() {
        return;
    }
    let still_strict = std::fs::read_to_string(root.join("kiosk.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<KioskSettings>(&t).ok())
        .is_some_and(|s| s.enabled && s.level == Level::Strict);
    if still_strict {
        if let Ok(exe) = std::env::current_exe() {
            let _ = std::process::Command::new(exe).spawn();
        }
    }
}

// ─── Commands ───────────────────────────────────────────────────────────────

#[tauri::command]
pub fn kiosk_status(app: AppHandle) -> KioskStatus {
    status(&app)
}

/// The UI reached the staff lock screen: setup is done, kiosk may engage.
#[tauri::command]
pub fn kiosk_mark_ready(app: AppHandle) -> Result<KioskStatus, String> {
    let mut s = settings(&app);
    let first = !s.setup_complete;
    if first {
        s.setup_complete = true;
        save(&app, &s)?;
    }
    // Also covers a register that was just (re-)paired.
    apply(&app);
    if first {
        crate::windows::auto_open_customer_display(&app);
    }
    Ok(status(&app))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsInput {
    enabled: bool,
    level: Level,
    autostart: bool,
    customer_display_monitor: String,
    updated_by: Option<String>,
}

/// Admin → System → Kiosk (the UI requires a manager/admin session).
#[tauri::command]
pub fn kiosk_save_settings(app: AppHandle, input: SettingsInput) -> Result<KioskStatus, String> {
    let mut s = settings(&app);
    s.enabled = input.enabled;
    s.level = input.level;
    s.autostart = input.autostart;
    s.customer_display_monitor = input.customer_display_monitor;
    s.updated_by = input.updated_by;
    s.updated_at = Some(now_secs());
    save(&app, &s)?;
    sync_autostart(&app);
    apply(&app);
    Ok(status(&app))
}

/// Called after the server approved a manager PIN (or the offline PIN matched).
#[tauri::command]
pub fn kiosk_unlock(app: AppHandle, minutes: u64) -> KioskStatus {
    let minutes = minutes.clamp(1, 60);
    *app.state::<KioskState>().unlocked_until.lock().unwrap() = Some(Instant::now() + Duration::from_secs(minutes * 60));
    apply(&app);
    status(&app)
}

#[tauri::command]
pub fn kiosk_relock(app: AppHandle) -> KioskStatus {
    *app.state::<KioskState>().unlocked_until.lock().unwrap() = None;
    apply(&app);
    status(&app)
}

#[tauri::command]
pub fn kiosk_enforce(app: AppHandle) {
    if locked(&app) {
        enforce(&app);
    }
}

/// "Exit app" in the maintenance window. Refused while kiosk is locked.
#[tauri::command]
pub fn kiosk_exit_app(app: AppHandle) -> Result<(), String> {
    if locked(&app) {
        return Err("Unlock the kiosk first".into());
    }
    mark_clean_exit(&app);
    app.exit(0);
    Ok(())
}

/// Hashes a new offline exit PIN on this register; the hash is shared with the
/// other registers through the Main Register.
#[tauri::command]
pub fn kiosk_hash_pin(pin: String) -> Result<String, String> {
    if !(4..=8).contains(&pin.len()) || !pin.chars().all(|c| c.is_ascii_digit()) {
        return Err("Use 4 to 8 digits".into());
    }
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default().hash_password(pin.as_bytes(), &salt).map(|h| h.to_string()).map_err(|e| e.to_string())
}

/// Stores the store's offline exit PIN hash (from the server) on this PC.
#[tauri::command]
pub fn kiosk_set_offline_hash(app: AppHandle, hash: Option<String>) -> Result<(), String> {
    if let Some(h) = &hash {
        PasswordHash::new(h).map_err(|_| "Invalid PIN hash".to_string())?;
    }
    let mut s = settings(&app);
    if s.offline_exit_pin_hash == hash {
        return Ok(());
    }
    s.offline_exit_pin_hash = hash;
    save(&app, &s)
}

/// Offline exit: checks the PIN locally. 5 attempts per 10 minutes.
#[tauri::command]
pub fn kiosk_verify_offline_pin(app: AppHandle, state: State<'_, KioskState>, pin: String) -> Result<bool, String> {
    let hash = settings(&app).offline_exit_pin_hash.ok_or("No offline exit PIN is set for this store")?;
    {
        let mut attempts = state.offline_attempts.lock().unwrap();
        attempts.retain(|t| t.elapsed() < Duration::from_secs(600));
        if attempts.len() >= 5 {
            return Err("Too many attempts. Try again in 10 minutes.".into());
        }
        attempts.push(Instant::now());
    }
    let parsed = PasswordHash::new(&hash).map_err(|e| e.to_string())?;
    let ok = Argon2::default().verify_password(pin.as_bytes(), &parsed).is_ok();
    if ok {
        state.offline_attempts.lock().unwrap().clear();
    }
    Ok(ok)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    name: String,
    primary: bool,
    width: u32,
    height: u32,
}

#[tauri::command]
pub fn kiosk_monitors(app: AppHandle) -> Vec<MonitorInfo> {
    let primary = app.primary_monitor().ok().flatten().map(|m| *m.position());
    app.available_monitors()
        .unwrap_or_default()
        .into_iter()
        .enumerate()
        .map(|(i, m)| MonitorInfo {
            name: m.name().cloned().unwrap_or_else(|| format!("Display {}", i + 1)),
            primary: Some(*m.position()) == primary,
            width: m.size().width,
            height: m.size().height,
        })
        .collect()
}

/// The monitor the customer display should use, if any.
pub fn customer_display_monitor(app: &AppHandle) -> Option<tauri::Monitor> {
    let choice = settings(app).customer_display_monitor;
    if choice == "off" {
        return None;
    }
    let primary = app.primary_monitor().ok().flatten().map(|m| *m.position());
    let monitors = app.available_monitors().ok()?;
    if choice == "auto" {
        monitors.into_iter().find(|m| Some(*m.position()) != primary)
    } else {
        monitors.into_iter().find(|m| m.name().is_some_and(|n| *n == choice))
    }
}
