# Sync Retail — Full-Screen Kiosk Mode & Auto-Start

**Implementation plan · v1 · 2026-10-05 — implemented 2026-10-06 (K1–K5; see §12)**

The till PC boots straight into Sync Retail, full screen. Cashiers can't accidentally close it, shrink it or wander onto the desktop. A manager can unlock it for maintenance with their PIN.

> **Scope note.** The brief arrived truncated after section 2 (programmatic full-screen enforcement). This plan covers sections 1–2, plus the stated goals: launch on PC startup, prevent accidental exit, prevent desktop access. Any further sections will be folded in as an addendum.

---

## 1. Summary

| | |
|---|---|
| **Feasibility** | Yes. Tauri v2 supports full-screen/borderless windows, intercepting close, autostart and per-device settings. Everything in this plan is app code plus a deployment guide; no new services. |
| **Key reality** | An app **can** stop accidental exits (✕, Alt+F4, Esc, F11, reload/print shortcuts, right-click, zoom). An app **cannot** block Windows' secure keys (**Ctrl+Alt+Del**, and Task Manager unless policy disables it), and only partially blocks **Win key / Alt+Tab**. Full lockdown is an **OS configuration**: a dedicated kiosk account, plus Assigned Access/Shell Launcher on Enterprise/IoT, or policy hardening on Pro. Section 6 is that deployment guide. |
| **Two levels** | **Standard kiosk** (default for till installs): full screen, close-protected, auto-start, shortcut hardening. **Strict kiosk** (opt-in): adds always-on-top, a Win/Alt+Tab keyboard hook and a relaunch watchdog, and is paired with the OS guide. |
| **Effort** | About 1 week for one engineer (§10). |

---

## 2. Corrections to the brief (Tauri v2)

| Brief | In this codebase / Tauri v2 | Plan |
|---|---|---|
| Set `"fullscreen": true` in `tauri.conf.json` | Since M2 the main window is created **in Rust** (`src-tauri/src/windows.rs`, `app.windows` is empty) so each register profile gets its own WebView2 data folder | Apply `.fullscreen(…)`, `.decorations(…)`, `.maximized(…)` in `windows::create_main()` from the device's kiosk settings. **No flicker**: the window is created full screen, rather than created normal and then switched. |
| `import { appWindow } from '@tauri-apps/api/window'` | That's the **Tauri v1** API. v2: `import { getCurrentWindow } from '@tauri-apps/api/window'`, and calling it from JS needs capability permissions (e.g. `core:window:allow-set-fullscreen`) | Rust sets full screen at creation. The React hook only **re-asserts** it (after display changes, Win+↑/↓, monitor sleep) via a narrow Rust command `kiosk_enforce`, so the webview doesn't need broad window permissions. |
| "Prevent cashiers from exiting" | Window ✕ and Alt+F4 both arrive as `CloseRequested` and **can** be prevented in Rust. Ctrl+Alt+Del can't. | Close interception + manager-PIN exit (§4.3); OS lockdown in §6. |

---

## 3. Behaviour

### 3.1 What cashiers experience (standard kiosk)

- **PC starts:**
  - Windows signs in. Automatic sign-in on a dedicated till account is recommended (§6).
  - Sync Retail starts automatically and opens **full screen** with no title bar.
  - The splash shows while the local database starts (Main Register) or the host is found (register).
  - Then the staff lock screen appears.
- **No way out by accident:**

  | Attempt | Result |
  |---|---|
  | **✕ / Alt+F4** | Ignored, with a toast: "This register is in kiosk mode — ask a manager to exit". |
  | **Esc / F11** | Doesn't leave full screen. |
  | **F5, Ctrl+R** (reload) | Blocked. |
  | **Ctrl+P** (print) | Blocked. Receipt printing uses the app's own Print button. |
  | **Ctrl+F, Ctrl+W, Ctrl+N** | Blocked. |
  | **Ctrl+/-/scroll** (zoom) | Blocked. |
  | **Pinch-zoom, Alt+←** (back) | Blocked. |
  | **Right-click menu, dragging a file onto the window** | Blocked. |
- **If something takes it out of full screen** (Win+↓, display reconnect, resolution change): it goes back to full screen within 1 second.
- **Idle auto-lock:** after N minutes without input (default 5), the till returns to the PIN lock screen. This is a cashier-security feature that kiosks need.
- **Customer display:** opens full screen automatically **on the second monitor** if one is connected. Choosing the monitor is a per-device setting.

### 3.2 What managers can do

- **Exit / maintenance:** Admin → System → **Kiosk** → *Unlock for maintenance*, or a hidden gesture: press and hold the **Sr** logo for 3 seconds.
  - This opens the existing manager-override PIN pad, with a new action `KIOSK_EXIT`; the attempt is audited.
  - Unlocking gives a **10-minute maintenance window**: windowed mode, normal close allowed, a banner with a countdown. Kiosk mode comes back automatically afterwards or at the next start.
  - Options in that window: *Exit app*, *Restore kiosk now*, *Open Windows settings* (Main Register only).
- **Settings per PC** (Admin → System → Kiosk, applies to *this* register):
  - kiosk on/off; Standard / Strict
  - start on Windows sign-in
  - idle auto-lock minutes
  - customer display monitor
  - offline exit PIN (§4.4)

---

## 4. Design

### 4.1 Where settings live

Kiosk settings are **per device**: a back-office PC might not want kiosk mode. They are stored in the register's local `kiosk.json` beside `mode.json`, so they apply **before** any network or login:

```json
{
  "enabled": true,
  "level": "standard",              // "standard" | "strict"
  "autostart": true,
  "idleLockMinutes": 5,
  "customerDisplayMonitor": "auto", // "auto" = first non-primary, or a monitor name
  "offlineExitPinHash": "$argon2id$…",
  "updatedAt": "…", "updatedBy": "Ada Owner"
}
```

- **Defaults:** enabled for installed builds once a role is chosen (Main Register or register). Disabled during first-launch setup and in dev builds.
- **Support override:** `SR_KIOSK=0` disables kiosk for one launch (test and support only). It's ignored when Strict level and the setting's lock flag are set.
- **Changing settings** requires an Admin/Manager session on that register; every change is audited on the host.

### 4.2 Rust (`src-tauri/src/kiosk.rs` + `windows.rs`)

| Piece | Behaviour |
|---|---|
| Window creation | `create_main()` reads `kiosk.json`. When enabled: `.fullscreen(true)`, `.decorations(false)`, `.resizable(false)`, and focus on create. When disabled: `.maximized(true)` with decorations, the normal windowed POS. |
| Close interception | `on_window_event`: `CloseRequested` on `main` → `api.prevent_close()` unless `KioskState::unlocked_until > now`, and emit `kiosk-blocked` (UI shows the toast). Normal app exit and host shutdown continue to use the existing graceful path (§ LAN plan host.rs). |
| Enforcement | `kiosk_enforce` command + a `Resized`/`Focused` window-event handler: if kiosk is on and the window isn't full screen or is minimized, re-apply full screen. Debounced (500 ms) so it never fights the user during maintenance. |
| Unlock | `kiosk_unlock(minutes)` (called after a successful manager override, §4.3) sets `unlocked_until`, leaves full screen and re-enables decorations. A timer restores kiosk when it expires. |
| Autostart | `tauri-plugin-autostart` (per-user `HKCU\…\Run` entry). Enabled or disabled from the setting; the installer offers it as a checkbox. |
| Strict level only | `.always_on_top(true)`.<br>A **low-level keyboard hook** (`WH_KEYBOARD_LL`) swallows Win, Alt+Tab, Alt+Esc and Ctrl+Esc **only while the app has focus**. Released in maintenance mode and on exit.<br>A **relaunch watchdog** (Windows Task Scheduler task "SyncRetail Kiosk Watchdog": at logon, restart on failure) brings the app back if it crashes or is killed. |
| WebView hardening | Browser accelerator keys (reload, print, find, devtools) disabled at the WebView2 level where Tauri exposes the setting. **To verify in the K1 spike**; fallback is the JS guard in §4.5, which covers the same keys. DevTools are already off in release builds. |
| Multi-monitor | `open_customer_display` places the display window on the configured monitor (`available_monitors()`; "auto" = first non-primary) and makes it full screen in kiosk mode. |

### 4.3 Exit with manager PIN

1. The cashier or manager triggers *Unlock* (Admin → System, or the 3-second logo hold).
2. The existing **override modal** asks for a manager/admin PIN with the new action `KIOSK_EXIT`. The server validates it, logs it and returns a single-use token (same flow as voids).
3. On success, the UI calls `kiosk_unlock(10)`. In release builds the webview only runs Sync Retail's own code (DevTools disabled), so only the app's override flow can reach that command. The token is shown in the audit trail.
4. When the maintenance window ends, or "Restore kiosk now" is pressed, kiosk mode returns.

### 4.4 Offline exit (register can't reach the Main Register)

PIN checks normally happen on the server. If a register is offline (Main Register switched off) and must be exited:

- Admin sets an **offline exit PIN** per store in Admin → System → Kiosk. Its **Argon2id hash** is synced to every register's `kiosk.json`. The hash never leaves the store network, and the PIN is never stored in plain text.
- When the host can't be reached, the exit dialog verifies the PIN **locally in Rust** (`argon2` crate). Attempts are rate-limited (5 per 10 min) and logged locally, then uploaded on reconnect.

### 4.5 React (`frontend/src/features/kiosk/`)

| Piece | Behaviour |
|---|---|
| `useKiosk()` | Reads kiosk state (`kiosk_status`), listens to `kiosk-blocked` and `kiosk-unlocked` events, exposes `requestUnlock()`, and re-asserts full screen on `visibilitychange`/`resize` (via `kiosk_enforce`). |
| `<KioskGuard>` | Wraps the app when kiosk is on: capture-phase `keydown` blocks reload/print/find/zoom/back/F-keys (allow-list for the app's own shortcuts F2, F4, F9); `contextmenu`, `dragover`/`drop`, `wheel+ctrl` and `gesturestart` prevented; CSS `touch-action: pan-x pan-y` and `user-select` rules for touch screens. |
| `<IdleLock>` | Locks to the PIN screen after the configured idle time (pauses while a payment or the override modal is open). |
| `KioskSettings.tsx` | Admin → System → Kiosk section for this PC (§3.2). |
| Maintenance banner | Countdown, *Restore kiosk now*, *Exit app*. |

---

## 5. Interaction with existing features

| Feature | Consideration |
|---|---|
| **Main Register host** | Closing the app stops the local database cleanly (LAN plan). Kiosk only changes *who* may close. Sleep prevention already exists for hosts; kiosk adds nothing there. |
| **Paired registers** | Same behaviour. "Register removed" / "Pair again" screens stay reachable in kiosk mode. Re-pairing requires a manager anyway. |
| **First-launch wizard** | Kiosk stays off until setup or pairing completes, so the installer → wizard flow works normally. |
| **Payments (future)** | Moniepoint terminal flows are unaffected. The idle lock is paused during a pending payment. |
| **Updates** | The updater (future M5) triggers maintenance mode, closes gracefully and relaunches into kiosk. |
| **Receipt printing** | `window.print()` dialog: in strict mode, always-on-top is lifted while it's open. Raw ESC/POS printing (future) avoids the dialog entirely. |

---

## 6. OS lockdown guide (deployment, not app code)

These steps make kiosk mode **resistant to deliberate escape**. They ship as `docs/KIOSK_DEPLOYMENT.md` plus an optional PowerShell script.

| Layer | Windows 10/11 **Pro** | Windows 10/11 **Enterprise / Education / IoT Enterprise** |
|---|---|---|
| Dedicated account | Local standard user "Till" (no admin rights) | Same |
| Auto sign-in | Sysinternals **Autologon** (stores credentials encrypted) | Same, or Assigned Access auto-logon |
| Launch app as the shell | Not available on Pro. Use autostart + strict kiosk + watchdog. | **Shell Launcher v2**: Sync Retail *replaces Explorer*; if it exits it is restarted, and there is no desktop or taskbar |
| Block Task Manager / lock workstation options | Local Group Policy: *Ctrl+Alt+Del Options* → remove Task Manager, Change password, Lock, Switch user | Same (GPO/Intune) |
| Block Win key, edge swipes | Registry `NoWinKeys`; touch: disable edge swipe via policy | **Keyboard Filter** feature + same policies |
| Notifications / updates | Focus assist on; Windows Update active hours outside trading hours | Same, managed |
| Escape hatch for admins | A separate admin Windows account (Ctrl+Alt+Del → Switch user, if left enabled) | Admin account excluded from Shell Launcher |

Recommendation:
- **Standard kiosk** is enough for most small shops: accidents are what actually happen.
- Stores worried about deliberate misuse should run **Pro + strict kiosk + policies**, or **IoT Enterprise + Shell Launcher**, which is ideal for dedicated till PCs.

---

## 7. Security & safety

- **Kiosk changes are audited:** every unlock, exit, setting change and failed PIN, on the host (or queued locally while offline).
- **The hook is scoped:** the strict-mode keyboard hook is only active while Sync Retail has focus and kiosk is locked. It never logs keys (it only swallows a fixed set of combinations), so it isn't a keylogger. Antivirus/EDR vendors may still flag low-level hooks; strict mode documents this, and code signing (future M5) mitigates it.
- **Accessibility:** Windows accessibility shortcuts (Narrator, magnifier) are not blocked.
- **Emergency:** Ctrl+Alt+Del always works on Pro (secure attention sequence). Field staff know to use the manager unlock, or sign out the Till account from there.

---

## 8. Deliverables → paths

| Brief / need | Path |
|---|---|
| Startup window configuration (brief §1) | `frontend/src-tauri/src/windows.rs` (kiosk-aware creation); `tauri.conf.json` gains `plugins.autostart` and capability updates only. Windows stay code-created (see §2) |
| Programmatic enforcement (brief §2) | `frontend/src/features/kiosk/useKiosk.ts` (`getCurrentWindow`-based checks → `kiosk_enforce`); `src-tauri/src/kiosk.rs` |
| Close interception, unlock, strict hook, watchdog | `src-tauri/src/kiosk.rs`, `src-tauri/src/kiosk_hook.rs` (strict), installer hook for the watchdog task |
| Guard, idle lock, settings UI | `frontend/src/features/kiosk/KioskGuard.tsx`, `IdleLock.tsx`, `KioskSettings.tsx` |
| Override action | `shared/src/domain.ts` (`KIOSK_EXIT`) + Prisma enum migration |
| Deployment guide | `docs/KIOSK_DEPLOYMENT.md` + `scripts/windows/kiosk-setup.ps1` (optional) |

---

## 9. Testing

**Automated:**
- Rust unit tests: close prevention vs unlocked window, settings parsing, local Argon2 PIN check and rate limit.
- WebView2 end-to-end (CDP, raw screenshots only, as in M1/M2):
  - blocked keys don't reload, print or zoom
  - the context menu doesn't open
  - idle lock fires
  - the unlock flow calls `kiosk_unlock` only after a valid override
- Window state checks via the Win32 API from PowerShell: window rect = monitor bounds, no caption, not minimized.

**Manual matrix** (signed off per release, on Windows 11 Pro and Windows 10):

| Area | Checks |
|---|---|
| Keys and closing | ✕, Alt+F4, Esc, F11, F5/Ctrl+R, Ctrl+P/F/W/N, Ctrl+wheel, right-click, file drag-in, Alt+←, touch pinch / edge swipe |
| Window state | Win+↓/↑, Win+D (standard: returns to full screen on focus; strict: blocked) |
| Strict only | Alt+Tab, Win key |
| Hardware and lifecycle | Reboot → auto sign-in → full screen within 20 s; unplug/replug monitors (customer display re-placed); resolution change; app killed (strict: watchdog restarts it within 5 s) |
| Unlock | Manager unlock → 10 min → auto re-lock; offline exit PIN with the host off |

---

## 10. Milestones

| # | Scope | Estimate | Done when |
|---|---|---|---|
| K1 | Kiosk settings file, kiosk-aware window creation, close interception, enforcement, `KIOSK_EXIT` override → maintenance window; WebView accelerator-key spike | 2 days | Installed app boots full screen; ✕/Alt+F4/Esc/F11 can't exit; manager PIN unlocks for 10 min |
| K2 | KioskGuard (keys, context menu, zoom, drag, touch), idle auto-lock | 1 day | Manual key matrix passes on Win 11 Pro |
| K3 | Autostart, Admin → System → Kiosk settings, offline exit PIN (Argon2) | 1 day | Reboot launches straight into kiosk; settings persist per PC; offline exit works |
| K4 | Customer display monitor placement + full screen; strict level (always-on-top, keyboard hook, watchdog task) | 1 day | Second monitor shows the customer display full screen; strict blocks Alt+Tab/Win; killed app relaunches |
| K5 | Deployment guide + setup script, full test matrix, docs | 0.5–1 day | A fresh Pro PC can be configured from the guide in under 30 minutes |

**Total: about 1 week.**

---

## 11. Open questions

1. **Windows editions at your stores:** Pro, or Enterprise/IoT? This decides whether Shell Launcher (strongest lockdown) is an option.
2. **Dedicated Windows account:** will tills sign in automatically as a "Till" account? Recommended; it is required for real lockdown.
3. **Default level:** standard kiosk for all tills (recommended), or strict by default?
4. **Exit gesture:** is the 3-second logo hold acceptable, or do you prefer only the Admin → System route?
5. **Hardware:** are tills touchscreens? Do they have a second monitor for the customer display?
6. **Truncated brief:** were there further sections after "Programmatic Full-Screen Enforcement on Boot"?

---

## 12. Implementation status (2026-10-06)

K1–K5 are implemented. Idle logout was added at the same time and applies to every register, not only kiosk tills.

| Area | What shipped | Where |
|---|---|---|
| Settings and engagement | `kiosk.json` per PC. Kiosk engages only after setup or pairing has reached the staff lock screen (`setupComplete`), so a Main Register is never locked down before an admin exists. Release builds only; `SR_KIOSK=0/1` overrides for one launch. | `src-tauri/src/kiosk.rs` |
| Window | Created full screen without decorations (no windowed flash). ✕/Alt+F4 prevented, with a toast. A 1-second loop restores full screen after minimise or display changes. | `windows.rs`, `lib.rs`, `kiosk.rs` |
| Unlock | Hold the **Sr** logo (or the lock screen's "Register … · locked" line) for 3 s, then enter a manager or admin PIN. `POST /api/kiosk/unlock` works **without a session** (rate-limited 5 per 10 min) and is logged as override `KIOSK_EXIT`. 10-minute maintenance window with a countdown banner, *Restore kiosk now* and *Exit app*. | `routes/kiosk.ts`, `features/kiosk/*` |
| Offline exit | Store-wide 4-digit PIN, hashed with **Argon2id on the register** (the server only stores the hash). Registers fetch it when someone signs in and verify it locally (5 attempts per 10 min). Offline unlocks are queued and replayed to the audit log. | `kiosk.rs`, `KioskSettings.tsx`, `lib/kiosk.ts` |
| Browser hardening | Capture-phase guard: F1/F3/F5/F6/F7/F10–F12, Ctrl+R/P/F/G/N/W/T/S/O/U/J/H/L, zoom keys, Ctrl+Shift+letter, Alt+←/→, the context menu, Ctrl+wheel and file drops are blocked (except on `[data-allow-drop]`, i.e. the import page). Touch: no pinch-zoom or text selection outside fields. App shortcuts F2/F4/F9 still work. | `KioskGuard.tsx`, `styles/index.css` |
| Strict level | Always on top; `WH_KEYBOARD_LL` hook (Win, Alt+Tab, Alt/Ctrl+Esc, only while the till is in front); relaunch watchdog. | `kiosk_hook.rs` |
| Autostart | `tauri-plugin-autostart` (HKCU Run), kept in sync with the setting. Never registered by dev builds or `SR_PROFILE` test instances. | `kiosk.rs` |
| Single instance | `tauri-plugin-single-instance`: autostart, the watchdog or a second click focuses the running till (off for `SR_PROFILE` test instances). | `lib.rs` |
| Customer display | Opens full screen on the configured monitor (auto = first non-primary) at start, when kiosk is on. | `windows.rs` |
| **Idle logout** | Store setting **Lock idle registers after N minutes** (Admin → Store & loyalty; default 5, 0 = off). A 30-second "Still there?" warning, then the PIN lock screen. **The open sale (cart, customer, approvals) is kept**: the lock screen shows "Sale on hold: N items · total", and it is on the register after the next sign-in. Paused while a sale or payment is being submitted or a manager override is open. Works in the browser build too. | `features/kiosk/IdleLock.tsx`, `store/idle.ts` |
| Deployment | `docs/KIOSK_DEPLOYMENT.md` + `scripts/windows/kiosk-setup.ps1` (Pro policy hardening for the till account, with `-Undo`). | |

**Changes from the plan**
- **Idle lock** is a store-wide setting instead of per-PC `kiosk.json`. Unattended registers are a security issue whether or not kiosk is on, and it also applies to browser registers.
- **Watchdog** is a second copy of the app (`sync-retail.exe --kiosk-watchdog <pid> <data>`) instead of a Task Scheduler task. It needs no admin rights, and autostart covers sign-in. An intentional exit writes a `kiosk-clean-exit` marker so it doesn't relaunch.
- **WebView2 accelerator keys:** Tauri 2.12 doesn't expose the setting, so the JS guard is the only layer (as planned for that case). DevTools are already off in release builds.
- **Installer autostart checkbox** was not added: the app registers autostart itself, on by default.

**Verification**
- Desktop, on the real release build in an isolated profile: **25/25** checks. They cover: windowed during setup; full screen after it; WM_CLOSE ignored with a toast; minimise restored; F5/Ctrl+R/context menu/zoom blocked while F2 still works; the offline PIN stored only as an Argon2id hash and verified locally; the 3-second hold with a wrong PIN refused and the right one unlocking; maintenance windowed with the banner; close allowed while unlocked; relaunch created full screen; strict always-on-top plus watchdog; a Task Manager kill relaunched full screen; unlock from the lock screen then *Exit app* with no relaunch.
- Web (Docker): **13/13** checks. They cover: unlock without a session; agent PIN refused; both attempts in the override log; offline-PIN permissions and format; event replay; default idle 5 min; the warning about 30 s before; "I'm here" keeps the session; locked after the idle minute; the held sale on the lock screen; the sale still there after another cashier signs in.
- After a hard kill, the host stopped Postgres cleanly (`shutting down → stopped` in `host.log`).

**Still to check by hand:** the strict keyboard hook (Win / Alt+Tab need a physical keyboard), autostart at Windows sign-in (disabled for test profiles), customer-display placement on a second monitor, touch gestures, and the policy script on a Windows Pro till account.

