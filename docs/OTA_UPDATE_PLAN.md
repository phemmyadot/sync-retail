# Sync Retail — In-App Updates (OTA)

**Implementation plan · v1 · 2026-10-06**

Store staff update Sync Retail from inside the app: one button, a progress bar and an automatic restart. The Main Register (host) and every paired register (client) update the same way. The app never installs anything it can't verify.

> **Scope note.** The brief arrived truncated after section 2 (the `latest.json` manifest). This plan covers sections 1–2 and the stated goal: a one-click update with automatic restart for staff who aren't tech-savvy, on host and client PCs. It also covers what this codebase needs on top of that: stopping the bundled host server and its database safely, keeping host and client versions compatible, and kiosk tills. Any further sections of the brief will be folded in as an addendum.

---

## 1. Summary

| | |
|---|---|
| **Feasibility** | Yes. Tauri v2's official updater plugin (`tauri-plugin-updater`) checks a JSON manifest, downloads the new installer, verifies its signature, and runs the NSIS installer we already ship. |
| **Key reality 1: elevation** | Our installer is **per-machine** (needed for the firewall rule from M1), so every update shows a **Windows UAC prompt**. That is one extra click on an administrator account. On a **standard or kiosk account** it asks for an administrator password, which breaks "one button". U5 removes the prompt with a small elevated update service; it is recommended before kiosk mode ships. |
| **Key reality 2: the Main Register runs a server** | Updating the host stops the store's API and its Postgres for about 30–60 s. The plan stops them cleanly, snapshots the database first, runs migrations on restart, and checks the store came back healthy. Registers keep selling offline meanwhile (existing offline queue). |
| **Key reality 3: version skew** | Registers run their own UI against the host's API. A register on 1.2 talking to a host on 1.1 (or the reverse) must be detected and handled (§5). |
| **Distribution** | A static `latest.json` + signed installer on a CDN (recommendation: Cloudflare R2 or S3 + CloudFront behind `updates.syncretail.com`). The Main Register also **mirrors** the update to its registers over the LAN. |
| **Effort** | About 2.5 weeks for one engineer, including the update service (§11). |

---

## 2. Corrections to the brief (this codebase / Tauri v2)

| Brief | Reality | Plan |
|---|---|---|
| Plugin in `src-rs/main.rs` | The Rust shell is `frontend/src-tauri/src/lib.rs` (plugins registered in `run()`); `main.rs` only calls it | Register `tauri_plugin_updater` in `lib.rs`; logic in a new `src-tauri/src/updater.rs` |
| `@tauri-apps/plugin-updater` drives the update from React | Possible, but the update must first stop the `sr-host` sidecar, snapshot Postgres and check the cart and offline queue. Those steps live in Rust (`host.rs`) | React calls **narrow Rust commands** (`update_check`, `update_download`, `update_install`), the same pattern as the kiosk plan. The JS plugin package isn't needed, so the webview gets no `updater:*` capability. |
| Artifact `…_x64_en-US.msi.zip` | That's the Tauri **v1** format. We build **NSIS** (`targets: ["nsis"]`), and Tauri v2 signs the setup `.exe` directly, with no zip | Manifest URL points to `Sync Retail_1.2.0_x64-setup.exe`; signature from the `.exe.sig` beside it (`bundle.createUpdaterArtifacts: true`) |
| "Public key signing" | Tauri updater signatures (minisign) prove the **file came from us**. They are separate from **Authenticode**, which Windows/SmartScreen checks and is LAN plan M5 | Updater keys are **required** (U1). Authenticode is strongly recommended in the same release pipeline; it doesn't block this plan. |
| Version `1.2.0` | The app is `1.0.0` in five places (3 × `package.json`, `tauri.conf.json`, `Cargo.toml`) | One source of truth: `tauri.conf.json` `"version": "../package.json"`; `npm run release:version x.y.z` bumps the rest |

---

## 3. What staff experience

### 3.1 Normal update (Main Register or a register)

1. **Silent check:** at startup, then every 6 hours. Registers ask their Main Register first, then the internet (§6.2).
2. **Silent download** in the background once an update is found, throttled so card payments and sync aren't starved. Nothing interrupts the cashier.
3. A **quiet badge** on the Admin rail item and a slim banner on the lock (who's-on-the-till) screen: *"Update ready — Sync Retail 1.2.0. Takes about a minute."* with **What's new** and **Update now**.
4. **Update now:**
   - Guards (§3.3).
   - A full-screen overlay: *"Updating Sync Retail… Don't turn off this PC."*
   - The installer runs in **passive** mode (progress bar only, no wizard pages).
   - The app restarts itself and opens the lock screen with a toast: *"Updated to 1.2.0"*. *What's new* stays one click away.
5. Nothing else to click (after U5; before U5, plus one UAC prompt).

### 3.2 Who can press it

- **Admin and Manager:** new permission `system:update`.
- A **Sales Agent** sees the banner, and pressing it asks for a **manager PIN**, reusing the existing manager-override flow. So the update is never blocked by "who's logged in", and a cashier can't start a restart in a rush.
- **Scheduled install (optional, per device):** "Install updates automatically at close of day" (default 23:00, only when idle and the cart is empty). Recommended on for the Main Register, so the API isn't stopped during trading.

### 3.3 Guards before installing

| Condition | Behaviour |
|---|---|
| Items in the cart, or a payment in progress | Blocked: *"Finish or park this sale first."* |
| Offline sales still queued (register) | Try a sync first. If the host is unreachable, allow it: the queue lives in the register's WebView2 profile in `%LOCALAPPDATA%`, which an update doesn't touch. The plan tests this explicitly. |
| Main Register with registers online | Warn: *"3 registers are connected. They'll keep selling offline for about a minute and catch up automatically."* (Uses the online-devices list from M2.) |
| Disk space < 2 × installer + database size | Blocked, with an explanation |
| Battery below 20 % and unplugged (laptop tills) | Blocked until plugged in |

### 3.4 Mandatory updates

`latest.json` can carry `"minimumVersion"`. Below it the banner can't be dismissed and turns amber (*"This version is no longer supported. Update before tomorrow."*). It still never interrupts a sale. Used for security fixes and for API breaks the compatibility window can't cover (§5).

---

## 4. Design

### 4.1 Manifest (`latest.json`)

The brief's structure plus two optional fields Tauri passes through untouched (`Update::raw_json`):

```json
{
  "version": "1.2.0",
  "notes": "Bug fixes, performance improvements, and new Moniepoint status polling resilience.",
  "pub_date": "2026-10-06T12:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<contents of Sync Retail_1.2.0_x64-setup.exe.sig>",
      "url": "https://updates.syncretail.com/stable/1.2.0/Sync%20Retail_1.2.0_x64-setup.exe"
    }
  },
  "minimumVersion": "1.0.0",
  "apiLevel": 3
}
```

- **Channels** are folders: `https://updates.syncretail.com/{stable|beta}/latest.json`. A device's channel is a per-device setting (default `stable`). Pilot stores go on `beta`.
- Releases are **immutable folders** (`/stable/1.2.0/…`). Only `latest.json` changes, so rolling back the channel means re-pointing `latest.json` at the previous folder.
- **Notes** are plain text shown in *What's new*. Write them for staff: "Card payments recover if the terminal drops Wi-Fi", not "fix #213".

### 4.2 Tauri configuration

`frontend/src-tauri/tauri.conf.json`:

```jsonc
{
  "version": "../package.json",
  "bundle": { "createUpdaterArtifacts": true, /* existing nsis, externalBin, resources */ },
  "plugins": {
    "updater": {
      "pubkey": "<contents of syncretail-updater.key.pub>",
      "endpoints": ["https://updates.syncretail.com/stable/latest.json"],
      "windows": { "installMode": "passive" }
    }
  }
}
```

Endpoints are **overridden at runtime** (`app.updater_builder().endpoints(...)`) to put the Main Register mirror first and apply the device's channel. The config value is the fallback.

`Cargo.toml`: `tauri-plugin-updater = "2"`. The NSIS installer relaunches the app after a passive update, so `tauri-plugin-process` isn't needed on Windows.

### 4.3 Rust (`src-tauri/src/updater.rs`)

| Command | Does |
|---|---|
| `update_status()` | Current version, channel, last check time, pending update (version, notes, size, downloaded %), mandatory flag |
| `update_check()` | Builds the updater with runtime endpoints and checks. Caches the `Update` in managed state and emits `update://available` |
| `update_download()` | Calls `update.download(on_chunk, on_finish)`. Emits `update://progress` and keeps the verified bytes in memory, or in `%LOCALAPPDATA%\…\updates\` for the mirror (§6.2). Restartable if interrupted. |
| `update_install()` | Runs the install sequence below; never returns on success |

**Install sequence** (the order matters):

1. Re-check the guards (§3.3) on the Rust side. Never rely on the UI alone.
2. **Main Register only:**
   - `host::stop()`, the existing graceful stop: it asks the sidecar to stop Postgres, waits, and kills only as a last resort.
   - **Snapshot the database:** copy the now-cleanly-stopped Postgres data folder to `updates\pre-1.2.0\` (file copy of a cleanly shut-down cluster). No `pg_dump` is needed; the embedded `pgsql` doesn't ship one.
   - Keep the last 2 snapshots.
3. Write `updates\pending.json`: `{from, to, startedAt, snapshot}`. The restarted app reads it for the post-update check (§4.4).
4. Close the customer-display window and turn off kiosk close-protection for this exit only. The kiosk plan's `CloseRequested` handler checks an `UPDATING` flag.
5. `update.install(bytes)` launches the NSIS installer with `/P /UPDATE` and exits the process.

**Backstop in the installer** (`windows/installer-hooks.nsh`): `NSIS_HOOK_PREINSTALL` force-closes `sr-host.exe` and `postgres.exe` from `$INSTDIR`, so files are never locked even if step 2 failed. (Postgres was already stopped cleanly in the normal path; this only matters for crashes.)

### 4.4 After the restart (post-update check)

When `pending.json` exists at startup:

- **Main Register:**
  - Start `sr-host` as usual. It runs migrations on boot through the custom migrator, as today.
  - Wait for `/api/health` to report `ok` and the new version, for up to 3 min (migrations on a large store).
  - **Healthy:** delete `pending.json`, show the toast and record an audit entry `system.updated {from, to, by}` via the API.
  - **Unhealthy** (sidecar crash loop, migration failure): show the recovery screen: *"The update didn't finish. Your data is safe."* with three choices:
    - **Restore previous version:** reinstall the cached previous installer (kept from the last update), then put back the snapshot folder.
    - **Try again**
    - **Copy diagnostics:** host log tail plus versions.
- **Register:** health means connecting to the host succeeds and the versions are compatible (§5).

### 4.5 React (`frontend/src/features/update/`)

| Piece | Purpose |
|---|---|
| `useUpdate()` | Subscribes to `update://*` events and wraps the commands. Returns `{status, progress, check, install}`. No-op in the browser/Docker build (`isTauri()` false). |
| `UpdateBanner` | The slim banner on the lock screen and the badge on the Admin rail |
| `UpdateDialog` | *What's new*, size, the guard messages, **Update now** (with a manager-PIN override for agents), progress |
| `UpdatingOverlay` | The full-screen "Don't turn off this PC" overlay shown right before the process exits |
| Admin → **System** tab | Gains an "About & updates" card: version, channel, last check, **Check now**, the auto-install schedule toggle, and the list of registers' versions (host only) |

---

## 5. Host ↔ register compatibility

Registers bundle their own UI and call the Main Register's API, so versions can diverge for a while during a store's update.

- **`/api/health`** gains `{ version, apiLevel, minClientApiLevel }`. **`apiLevel`** is an integer bumped only when the API changes incompatibly (e.g. the tax-class change would have been one).
- Each register sends `X-SR-Version` / `X-SR-Api-Level` headers. The host records them on the device row, so Admin → Registers shows each register's version.
- **Rule:** the host supports clients with `apiLevel ≥ minClientApiLevel`. Policy: keep at least **one level** of backward compatibility, so a host update never stops registers mid-day.

| Situation | Register shows |
|---|---|
| Same version, or a compatible level | Nothing |
| Register older but still supported | Banner: *"Update available from the Main Register"*. The update is already mirrored (§6.2), so it's a LAN-speed download. |
| Register below `minClientApiLevel` | Blocking screen: *"This register needs the update the Main Register already has."* **Update now** (manager PIN for agents). Offline selling stays available until the update finishes. |
| Register **newer** than the host | Banner: *"Update the Main Register first"*. Works in compatibility mode if `apiLevel` allows; otherwise sells offline only. |

**Recommended order:** Main Register first (ideally at close of day), then the registers pick it up from the host.

---

## 6. Distribution

### 6.1 Update host (internet)

| Option | Pros | Cons |
|---|---|---|
| **Cloudflare R2 / S3 + CDN at `updates.syncretail.com` (recommended)** | Stable URL we control, channels, immutable releases, cheap egress (R2: free), easy rollback | One-time DNS/bucket setup |
| GitHub Releases (`releases/latest/download/latest.json`) | Zero infrastructure, `tauri-action` writes `latest.json` | Repo must be public (or each app embeds a token: no); no channels without extra repos; GitHub rate limits from a shop's shared IP are possible |
| Custom update server | Staged rollout %, per-store targeting | A service to run; not needed for v1 |

The URL is HTTPS-only (Tauri rejects HTTP endpoints in release builds unless explicitly allowed). Security doesn't depend on the CDN either way: the signature is checked against the public key compiled into the app.

### 6.2 Main Register as LAN mirror

Many shops have one decent connection, or registers on poor Wi-Fi.

- When the Main Register downloads a verified update, it keeps the installer in `updates\` and serves it at `GET /api/updates/latest.json` and `GET /api/updates/<file>`. Both are open to paired devices only (the existing `requireDevice`).
- The mirrored `latest.json` rewrites only the `url` (to the host's LAN address). The **signature is the original one**, so a register still verifies against the public key. A compromised host can't push its own build.
- Register endpoint order: `http://<host>/api/updates/latest.json`, then `https://updates.syncretail.com/<channel>/latest.json`. Tauri tries them in order.
- The LAN endpoint is plain HTTP until M6 (TLS). This is acceptable because the payload is signature-verified; it needs `dangerousInsecureTransportProtocol` for that endpoint only, and the plan says so explicitly.

---

## 7. Release pipeline

### 7.1 Keys (once)

```bash
npx tauri signer generate -w ~/.tauri/syncretail-updater.key   # prompts for a password
```

- **Public key** → `tauri.conf.json` `plugins.updater.pubkey` (committed).
- **Private key + password** → CI secrets `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, plus **two offline backups** (password manager + sealed USB).

> **If the private key is lost, installed apps can never be updated again**; every till would need a manual reinstall. If it leaks, an attacker still needs to get a manifest in front of the app, but rotate immediately: ship a release, signed with the old key, whose config carries the new pubkey.

### 7.2 Building a release

`npm run release -- 1.2.0` (new `scripts/release.mjs`):

1. Bump versions (one source of truth, §2). Require a clean git tree and a `CHANGELOG.md` entry, which becomes `notes`.
2. Run the existing pipeline: build the `sr-host` SEA, then `npm -w frontend run tauri build` (never a plain `cargo build`). With the signing env vars set this produces `…-setup.exe` and `…-setup.exe.sig`.
3. *(When the certificate exists)* Authenticode-sign `sr-host.exe`, `sync-retail.exe` and the setup `.exe` **before** the updater signature is computed, because the `.sig` must cover the final bytes.
4. Generate `latest.json` from the `.sig`, version, notes and channel.
5. Upload `/<channel>/1.2.0/` first, then `latest.json` last. Clients never see a manifest pointing at a missing file.
6. Tag `v1.2.0` and push.

CI: a GitHub Actions `windows-latest` job runs the same script on a tag (with `tauri-apps/tauri-action` or the script directly). Manual runs from a dev PC work the same way for v1.

### 7.3 Promoting and rolling back

- **Beta → stable:** copy `beta/latest.json` to `stable/latest.json`. Same files, no rebuild.
- **Rollback:** point `latest.json` at the previous version **with a higher version number**. Tauri only offers versions greater than the installed one, so a bad 1.2.0 is fixed by re-releasing 1.1.x content as 1.2.1. A stored "rollback" can't be pushed to tills that already updated, and the release guide says so.

---

## 8. Security

| Threat | Mitigation |
|---|---|
| Tampered installer (CDN, LAN mirror, network) | Updater signature checked against the public key compiled into the app; unverified bytes are discarded before anything runs |
| Downgrade to an old vulnerable build | Tauri only installs `version > current` |
| Malicious Main Register pushing its own build to registers | The mirror can't re-sign. Registers verify the original signature. |
| A cashier triggering a restart mid-trade | `system:update` permission plus manager PIN; guards on the Rust side |
| Data loss from a failed migration | Snapshot before install, health check after, one-click restore (§4.4) |
| SmartScreen / antivirus flagging the update | Authenticode signing (M5). Updates launched by the app carry no Mark-of-the-Web, so SmartScreen doesn't prompt, but AV heuristics still favour signed binaries. |
| Update service abuse (U5) | The service accepts only a local named-pipe request, re-verifies the updater signature **and** the Authenticode signer itself, and installs only from its own `updates\` folder |

---

## 9. U5: one-click updates on standard and kiosk accounts

A per-machine NSIS install needs administrator rights. The till accounts the kiosk plan recommends (and many shop PCs) are standard users, so a plain Tauri update would stop at a UAC password prompt.

**Recommended design:** a tiny **`SyncRetailUpdate` Windows service** (Rust, running as LocalSystem, installed by the per-machine installer, about 1 MB):

- The app downloads and verifies as usual, then asks the service over a named pipe (ACL: interactive users) to install `updates\<file>`.
- The service re-verifies the signature (and the Authenticode signer once signing exists), runs the installer silently, and the installer relaunches the app in the user's session.
- When the service is present the app uses it; otherwise it falls back to the UAC path.

Alternatives considered: switching to a **per-user** install (no UAC). That loses the firewall rule and splits installs per Windows account, so it isn't recommended. A **scheduled task** with highest privileges is similar to the service but clumsier to trigger and to secure.

---

## 10. Testing

**Local update server:** `python -m http.server` serving a hand-made `latest.json` and a 1.0.1 build signed with a **test key**. The test key's pubkey goes in a debug-only config overlay (`tauri.conf.test.json`).

| Scenario | Expect |
|---|---|
| 1.0.0 → 1.0.1 on a register | Banner → one click → restarted on 1.0.1, toast, audit entry |
| Main Register with 2 registers selling | Registers go offline about 1 min, queue sales, catch up. Host snapshot exists; migrations applied. |
| Tampered `.exe` (one byte flipped) or wrong signature | "Update couldn't be verified": nothing installed, check retried later |
| Download interrupted (unplug network at 50 %) | Resumes or restarts on next check; no partial install |
| Cart not empty / payment in progress | Install blocked with the right message |
| Offline queue pending, host unreachable | Update proceeds; queued sales survive and sync afterwards |
| Migration fails (deliberately broken test migration) | Recovery screen → **Restore previous version** brings back the old build and data, byte-identical |
| Register below `minClientApiLevel` | Blocking screen, offline selling works, update from host mirror at LAN speed |
| Register newer than host | "Update the Main Register first" |
| No internet, host has the update | Register updates from the mirror |
| Kiosk mode on | Update exits and relaunches full screen without the PIN prompt |
| Standard Windows account (U5) | No UAC prompt; service installs; tamper test rejected by the service too |
| Agent presses Update now | Manager PIN required |

Automated: Rust unit tests (guards, endpoint ordering, mirror manifest rewrite), backend tests (`/api/health` levels, device version recording, the mirror route requires pairing), the existing headless UI script extended for the banner and dialog.

---

## 11. Milestones

| # | Scope | Estimate | Done when |
|---|---|---|---|
| U1 | Keys, single version source, `createUpdaterArtifacts`, `scripts/release.mjs`, `latest.json` generation, R2/S3 bucket + domain | 2 days | `npm run release -- 1.0.1` produces a signed installer + manifest on the update host |
| U2 | `updater.rs`: plugin, commands, events, install sequence (host stop, snapshot, pending marker), NSIS pre-install backstop, post-update health check + restore | 3 days | A Main Register updates 1.0.0 → 1.0.1 with migrations; a forced failure restores cleanly |
| U3 | React: `useUpdate`, banner, dialog, overlay, Admin "About & updates", `system:update` + PIN override, guards, close-of-day schedule | 2 days | A manager updates with one click; an agent needs a PIN; blocked when the cart has items |
| U4 | Compatibility: `/api/health` levels, version headers, device versions in Admin → Registers, register prompts, **LAN mirror** | 2 days | Register updates from the host with no internet; skew cases behave as in §5 |
| U5 | `SyncRetailUpdate` service + installer integration | 2.5 days | Standard-account till updates with zero prompts; tampered file rejected by the service |
| U6 | Test matrix (§10), staff-facing release notes guide, owner doc "How updates work" | 1.5 days | Matrix signed off on a host + 2 registers |

**Total: about 2.5 weeks** (13 working days). U1–U4 (about 2 weeks) is a shippable first version for stores whose till accounts are administrators.

---

## 12. Interaction with other plans

- **LAN plan M5 (signing and release):** this plan absorbs M5's "updater + pre-update backup" item. Authenticode signing stays in M5 and plugs into §7.2 step 3.
- **Kiosk plan:** close interception must allow the updater's exit (§4.3 step 4), and kiosk relaunch-on-crash must not fight the installer. The kiosk watchdog pauses while `pending.json` exists. U5 is what makes kiosk tills updatable without an admin password.
- **Payments plan:** the "payment in progress" guard reads the same in-flight payment state as the Moniepoint status polling.
- **Docker / browser deployment:** not affected. The web app updates when the server is redeployed. `useUpdate()` is a no-op outside Tauri.

---

## 13. Open questions

1. **Update host:** Cloudflare R2/S3 at `updates.syncretail.com` (recommended), or GitHub Releases? Do you own the domain?
2. **Till accounts:** are the shop PCs' Windows accounts administrators? If yes, U5 can follow later; if no (or kiosk mode is coming soon), U5 is v1.
3. **Automatic install:** default the Main Register to "install at close of day" (recommended), or always wait for a person to press the button?
4. **Channels:** do you want a `beta` channel for one or two pilot stores before each stable release?
5. **Code-signing certificate:** has the purchase started (LAN plan, "start now")? Updates work without it, but antivirus false positives are likelier.
