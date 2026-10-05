//! Supervises the bundled `sr-host` sidecar (API + private Postgres) on the
//! Main Register PC.
//!
//! Lifecycle contract with the sidecar (see backend/src/host/runtime.ts):
//! * it prints `SR_HOST_READY {json}` or `SR_HOST_FAILED {json}` on stdout;
//! * it shuts Postgres down cleanly on a `shutdown` line on stdin, or when this
//!   process disappears (`--parent-pid`) — so on exit we ask first and only
//!   hard-kill as a last resort.

use serde::Serialize;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

pub const API_PORT: u16 = 47800;

#[derive(Clone, Serialize)]
#[serde(tag = "state", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum HostStatus {
    /// This PC hasn't been set up yet (no mode.json) — the UI shows the setup wizard.
    NotConfigured,
    Starting,
    Ready { api_base: String, store_id: String, first_launch: bool, needs_setup: bool },
    Failed { message: String, log_dir: String },
}

#[derive(Default)]
struct Proc {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
}

pub struct HostState {
    status: Mutex<HostStatus>,
    proc: Mutex<Proc>,
}

impl HostState {
    pub fn new() -> Self {
        Self { status: Mutex::new(HostStatus::NotConfigured), proc: Mutex::new(Proc::default()) }
    }
}

pub fn set_status(app: &AppHandle, status: HostStatus) {
    *app.state::<HostState>().status.lock().unwrap() = status.clone();
    let _ = app.emit("host-status", status);
}

fn sidecar_path() -> std::io::Result<PathBuf> {
    // Tauri places external binaries next to the main executable (triple suffix stripped).
    let dir = std::env::current_exe()?.parent().map(PathBuf::from).unwrap_or_default();
    Ok(dir.join(if cfg!(windows) { "sr-host.exe" } else { "sr-host" }))
}

pub fn start(app: &AppHandle) {
    set_status(app, HostStatus::Starting);
    keep_system_awake();
    let fail = |app: &AppHandle, msg: String, log_dir: String| set_status(app, HostStatus::Failed { message: msg, log_dir });

    let data_dir = match crate::profile::data_root(app) {
        Some(d) => d,
        None => return fail(app, "No data directory".into(), String::new()),
    };
    let log_dir = data_dir.join("logs").display().to_string();
    let resources = match app.path().resource_dir() {
        Ok(r) => r.join("host"),
        Err(e) => return fail(app, format!("No resource directory: {e}"), log_dir),
    };
    let exe = match sidecar_path() {
        Ok(p) if p.exists() => p,
        Ok(p) => return fail(app, format!("Host runtime not found at {}", p.display()), log_dir),
        Err(e) => return fail(app, e.to_string(), log_dir),
    };

    let mut cmd = Command::new(exe);
    cmd.arg("--data-dir").arg(&data_dir)
        .arg("--resources").arg(&resources)
        .arg("--port").arg(API_PORT.to_string())
        .arg("--app-version").arg(app.package_info().version.to_string())
        .arg("--watch-stdin")
        .arg("--parent-pid").arg(std::process::id().to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return fail(app, format!("Could not start host runtime: {e}"), log_dir),
    };
    let stdout = child.stdout.take();
    {
        let state = app.state::<HostState>();
        let mut p = state.proc.lock().unwrap();
        p.stdin = child.stdin.take();
        p.child = Some(child);
    }

    let app = app.clone();
    std::thread::spawn(move || {
        let Some(out) = stdout else { return };
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            if let Some(json) = line.strip_prefix("SR_HOST_READY ") {
                let v: serde_json::Value = serde_json::from_str(json).unwrap_or_default();
                let port = v["apiPort"].as_u64().unwrap_or(API_PORT as u64);
                set_status(&app, HostStatus::Ready {
                    api_base: format!("http://127.0.0.1:{port}"),
                    store_id: v["storeId"].as_str().unwrap_or_default().to_string(),
                    first_launch: v["firstLaunch"].as_bool().unwrap_or(false),
                    needs_setup: v["needsSetup"].as_bool().unwrap_or(false),
                });
            } else if let Some(json) = line.strip_prefix("SR_HOST_FAILED ") {
                let v: serde_json::Value = serde_json::from_str(json).unwrap_or_default();
                fail(&app, v["message"].as_str().unwrap_or("Host failed to start").to_string(), log_dir.clone());
            }
        }
        // stdout closed: the host process ended.
        let still_starting = matches!(*app.state::<HostState>().status.lock().unwrap(), HostStatus::Starting);
        if still_starting {
            fail(&app, "Host runtime exited during startup".into(), log_dir.clone());
        }
    });
}

/// Graceful stop: close stdin (host stops Postgres), wait, then kill if needed.
pub fn stop(app: &AppHandle) {
    let state = app.state::<HostState>();
    let mut p = state.proc.lock().unwrap();
    // Ask explicitly — EOF alone isn't reliably observed by the sidecar on Windows.
    if let Some(mut stdin) = p.stdin.take() {
        let _ = stdin.write_all(b"shutdown\n");
        let _ = stdin.flush();
    }
    if let Some(mut child) = p.child.take() {
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            if let Ok(Some(_)) = child.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = child.kill();
    }
}

#[tauri::command]
pub fn host_status(state: State<'_, HostState>) -> HostStatus {
    state.status.lock().unwrap().clone()
}

/// The Main Register must not fall asleep while other registers depend on it.
/// The display may still turn off. Held by a parked thread for the app's lifetime.
fn keep_system_awake() {
    #[cfg(windows)]
    {
        use std::sync::Once;
        static ONCE: Once = Once::new();
        ONCE.call_once(|| {
            std::thread::spawn(|| {
                #[link(name = "kernel32")]
                extern "system" {
                    fn SetThreadExecutionState(flags: u32) -> u32;
                }
                const ES_CONTINUOUS: u32 = 0x8000_0000;
                const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;
                unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) };
                loop {
                    std::thread::park();
                }
            });
        });
    }
}
