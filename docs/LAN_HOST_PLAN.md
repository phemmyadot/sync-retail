# Sync Retail — Local-Network Host Mode & Google Drive Backup

**Implementation plan · v1.2 · 2026-10-05** — updated after milestone M2

This plan turns Sync Retail from a cloud-hosted POS into one that can also run entirely on a store's own Windows PCs:

- One PC is the **Main Register (Host)**. It runs the API and a private PostgreSQL database.
- Every other PC is a **Register (Client)** that finds the host on the LAN and pairs with it.
- Backups are encrypted on the host and pushed to the owner's Google Drive.

The existing cloud/Docker deployment stays as a second deployment mode. Both modes share all business logic.

---

## 1. Status at a glance

| Area | State |
|---|---|
| Feasibility | **Confirmed.** The riskiest piece (desktop app ⇒ bundled API ⇒ embedded Postgres on Windows) is built and tested end to end. |
| M0 · POC | **Done.** Commit `f9405cf`. See §2. |
| M1 · Host mode | **Done.** A fresh PC installs per-machine, runs the setup wizard (no demo data), confirms a recovery key and makes its first sale. See §2.6. |
| M2 · Pairing | **Done**, with one item to verify on real hardware. Registers discover the Main Register, pair with a 6-digit code, sell under their own receipt prefix, can be removed instantly, and self-heal when the host's address changes. See §2.7. |
| Remaining build | M3 Drive backup → M4 restore → M5 signing and release. About 3.5 weeks for one engineer (§12). |
| Open decisions | 2 in §14 (nightly backups, platforms). Pairing-code length, recovery model and install scope are settled. |
| Verify on a second PC | Possible blank register window right after the first network scan (§2.7, "Open item"). |
| Start now (long lead time) | Code-signing certificate (needed by M5) · Google Cloud OAuth consent screen + brand verification (needed by M3; Google review takes 1–3 weeks). |

---

## 2. Proof of concept: what was built and measured

### 2.1 What it proves

A real NSIS installer, installed per-user on Windows 11, that:

1. launches the Tauri desktop app;
2. starts the bundled host runtime `sr-host.exe` with no console window;
3. on first launch: creates a PostgreSQL 17 cluster in the user's app-data folder, applies Prisma migrations and loads demo data;
4. serves the existing API on the LAN (port 47800) and points the UI at it;
5. completes a full sale. The sale is persisted in the host DB, and the customer-display window mirrors the cart.
6. on exit, stops Postgres cleanly, including when the app is force-killed.

### 2.2 Code added by the POC

```
backend/
  src/db/localPostgres.ts   private Postgres cluster: initdb (UTF-8, scram, loopback-only), start/stop, create DB
  src/db/migrate.ts         Prisma-compatible `migrate deploy` (writes _prisma_migrations), no Prisma CLI needed
  src/host/config.ts        per-install identity & secrets (host.json): storeId, PG password, JWT secret, ports
  src/host/runtime.ts       sr-host entry: config → Postgres → migrations → API; READY/FAILED protocol; shutdown
  scripts/build-host.mjs    bundles runtime (esbuild) → Node single-executable (SEA) → stages Tauri resources
  prisma/seed.ts            refactored to export seedDemo() for the host's first launch
  src/services/pdf.ts       font loading made bundle-safe (SR_FONT_DIR)
frontend/
  src-tauri/src/host.rs     sidecar supervisor: spawn, READY parsing, status events, graceful stop
  src-tauri/src/lib.rs      wires the supervisor into the app lifecycle
  src-tauri/tauri.conf.json externalBin: sr-host, resources: host/
  src/components/HostGate.tsx  "Opening the register…" gate + failure screen; sets API base at runtime
  src/lib/config.ts         API base is now runtime-configurable (getApiBase / setApiBase)
```

Build: `npm -w backend run build:host`, then `npm -w frontend run tauri build`. Output: `frontend/src-tauri/target/release/bundle/nsis/Sync Retail_1.0.0_x64-setup.exe`.

### 2.3 Measurements (Windows 11, x64)

| Metric | Result |
|---|---|
| Installer (NSIS, LZMA) | **49.2 MiB** |
| Installed size | 206 MB (sr-host.exe 93 MB + Postgres/resources 106 MB + app 7 MB) |
| First launch: host ready (initdb + migrate + demo seed) | **7.9 s** (initdb ≈ 5.3 s) |
| First launch: app window → login screen | 9.2 s |
| Warm launch: host ready | **0.71–0.87 s** |
| Warm launch: window → login | 1.4–1.6 s |
| API test suite against `sr-host.exe` | **33 / 33 pass** (RBAC, overrides, loyalty, voids/returns, offline sync, import, reports, PDF) |
| Graceful quit (close register window) | all processes gone in **1.4–2.6 s**, Postgres "stopped" logged |
| Hard kill of the app (Task Manager) | host + Postgres gone in **≤ 1.0 s** via parent watchdog |
| Reinstall/upgrade over existing data | data retained, migrations re-checked (0 applied) |

### 2.4 Problems the POC found and fixed

These would all have reached customers.

| # | Problem | Fix |
|---|---|---|
| 1 | `pg_ctl start` never "finishes": on Windows, the postgres process inherits pg_ctl's stdout/stderr pipes and holds them open | wait for the process **exit** event, not stream close (`localPostgres.ts`) |
| 2 | Tauri returns Windows "verbatim" paths (`\\?\C:\…`); `initdb` can't find `postgres.exe` through them | strip the prefix for drive-letter paths (`runtime.ts › plainPath`) |
| 3 | Rust status enum serialised `api_base`/`log_dir`; UI expects camelCase | `#[serde(rename_all_fields = "camelCase")]` |
| 4 | Closing the sidecar's stdin from Rust is **not** reliably observed as EOF → app quit left 6 orphaned `postgres.exe` | explicit `shutdown\n` command on stdin **plus** `--parent-pid` watchdog (2 s poll) |
| 5 | Prisma's engine and PDFKit's font files can't be loaded from inside a single-executable bundle | real `require` via `createRequire(process.execPath)`; engine path via `PRISMA_QUERY_ENGINE_LIBRARY`; PDFKit default font set to the bundled DejaVu |
| 6 | Pre-existing orphaned Postgres (e.g. after a power cut) | `pg_ctl status` check: an already-running cluster is reused, not double-started |

Test-tooling findings, recorded so nobody chases them again:

- Playwright's `page.screenshot()` over CDP makes WebView2 drop the Tauri window. Use raw `Page.captureScreenshot`.
- `browser.close()` on a CDP connection closes WebView2, and with it the app.
- PowerShell passes `$null` to a native `string` parameter as `""`. Use `[NullString]::Value`.

### 2.5 Not yet proven

- `pg_dump`/`pg_restore`: **the embedded-postgres package does not ship them** (verified). They must be bundled separately (§7.2).
- LAN discovery, pairing, and multiple registers against one host.
- Code signing. `sr-host.exe` currently carries Node's now-invalid signature; the build prints "signature seems corrupted".
- Windows Firewall behaviour. Listening on `0.0.0.0` triggers the "Allow access" prompt on first run.
- macOS/Linux builds.

### 2.6 Milestone M1 — delivered

**What a store owner now sees on a fresh PC**

1. **Install:** a per-machine NSIS installer (one UAC prompt) to `C:\Program Files\Sync Retail`. It adds the firewall rule *Sync Retail Host*: inbound, allow, **Private + Domain profiles only**, program `sr-host.exe`. The rule is removed on uninstall.
2. **Role chooser:** "How will this PC be used?" offers **Main Register**. *Connect to Main Register* (M2) and *Restore from backup* (M4) are shown but disabled. No host process runs until a role is chosen.
3. **Main Register:** the private database is provisioned, and the wizard opens in **3.7 s**.
4. **Store:** name and currency (12 common currencies; NGN preselected with locale `en-NG`), with a live price preview (`₦1,250,000.00`).
5. **Owner account:** name, email, password (8+), PIN (4–8 digits); both are confirmed.
6. **Security:** optional restore passphrase (12+ characters).
7. **Recovery key:** 13 groups of 4 Base32 characters on a printable sheet, with *Print* and *Save as text file*. *Open the register* stays locked until the owner types back two randomly chosen groups and ticks "I've stored it".
8. **Signed in as owner** on an empty register. No demo data.

**Code added in M1**

```
backend/src/services/backupKey.ts   BK generation, recovery-key Base32 format/parse (tolerates 0/O, 1/I),
                                    scrypt(N=2^17)+AES-256-GCM passphrase wrap, stored as Setting `backup.key`
backend/src/routes/setup.ts         GET /api/setup/status · POST /api/setup (only while 0 users; loopback-only
                                    unless SETUP_ALLOW_REMOTE=true; advisory lock prevents double setup)
backend/src/routes/diagnostics.ts   GET /api/admin/diagnostics — text report, credentials redacted
backend/src/host/{config,runtime}.ts  API port remembered in host.json; next free port if taken;
                                    no demo seed by default; READY reports needsSetup; host env for the API
frontend/src-tauri/src/mode.rs      mode.json + commands app_mode / configure_host
frontend/src-tauri/src/host.rs      NotConfigured state, --app-version, keep-system-awake (ES_SYSTEM_REQUIRED)
frontend/src-tauri/windows/installer-hooks.nsh   firewall rule add/remove
frontend/src/features/setup/        RoleChooser, SetupWizard (+ recovery key step), SetupGate (desktop + web)
frontend/src/features/admin/        Admin → System tab: install info + "Download diagnostics"
.gitattributes                      *.sql eol=lf (migration checksums stay stable across checkouts)
docker-compose.yml                  SETUP_ALLOW_REMOTE (fresh server installs without demo data)
```

**Verification**

| Suite | Result |
|---|---|
| Recovery-key crypto (200 random round trips, look-alikes, truncation, wrong passphrase, tampering) | 7 / 7 pass; scrypt wrap ≈ 240 ms |
| `sr-host.exe` M1 checks | **18 / 18 pass**. They cover:<br>• port 47810 taken → 47811 used and remembered after restart<br>• no demo data<br>• setup refused from the LAN address (403) and allowed on loopback<br>• invalid PIN rejected (400); second setup refused (409)<br>• owner PIN login<br>• diagnostics contain no PG password, JWT secret, recovery key, owner password or passphrase |
| Installed-app end-to-end (per-machine build) | **20 / 20 pass**. They cover:<br>• role chooser → wizard → recovery-key confirmation (wrong group rejected)<br>• owner signed in; empty catalog<br>• first product, then first sale ₦85,000 + 7.5% VAT = ₦91,375.00, stored online<br>• diagnostics report<br>• clean quit in 1.1 s<br>• relaunch goes straight to the lock screen |
| Firewall rule after install | Present: In / Allow / Domain,Private / `C:\Program Files\Sync Retail\sr-host.exe` |
| Docker deployment after M1 | Unchanged store; `/api/setup` refused through nginx (403); diagnostics report says "Server (cloud/Docker)" |

**Not verified in M1**

- **Sleep prevention.** `powercfg /requests` needs an elevated prompt. To check manually: run it as admin while the app is open; it should list `sync-retail.exe` under SYSTEM.
- **Code signing.** Still M5.

**Changes from the original plan**

- **Where the Backup Key lives:** in the `Setting` table rather than Windows Credential Manager. Both the API (for backups, M3) and a restored host (M4) can then read it without an extra Rust↔Node channel. Postgres is loopback-only with a random password, and backups are encrypted with this key, so including it in the backup leaks nothing. DPAPI/Credential Manager hardening is a candidate for M5.
- **Data folder:** stays per Windows user (`%LOCALAPPDATA%\dev.syncretail.pos`) even with a per-machine install. Fine for the usual single-account till PC. If shops share one PC across Windows accounts, move it to `%ProgramData%` (M5 decision).

### 2.7 Milestone M2 — delivered

**What a store now does to add a register**

1. On the new PC: install Sync Retail → **Connect to Main Register**. Stores on the network appear within about 3 s, with name, address and version. If discovery is blocked, the Main Register's address can be typed in instead.
2. On the Main Register: **Admin → Registers → Add register** shows a **6-digit code**. It is single use and expires after 2 minutes (countdown shown), alongside the address for manual entry.
3. On the new PC: enter the code and a name (e.g. "Front counter"). The register is paired, goes to the staff lock screen, and gets its own code (**R2, R3, …**; the Main Register is R1), which becomes its receipt prefix.
4. **Admin → Registers** lists each register: online status, last seen, IP, app version, and a **Remove** button.
5. **Removing** a register stops it on its very next request. It shows "Register removed", with a warning if it still holds unsynced offline sales, and a button to pair again.

**Code added in M2**

```
backend/prisma/migrations/*_devices   Device model (code R2…, name, kind, tokenHash, appVersion, lastSeen/IP, revokedAt)
backend/src/network/pairing.ts        codes (6 digits, 2-min TTL, single use, ≤3 outstanding), per-IP lockout (5/10 min),
                                      global guess cap (20 → all codes voided), device tokens (256-bit; SHA-256 stored)
backend/src/network/deviceAuth.ts     host mode: X-Device-Token required from other machines (loopback exempt);
                                      30 s lookup cache, evicted on revoke; last-seen/IP recorded ≤ 1×/min
backend/src/network/routes.ts         GET /api/pair/info · POST /api/pair/claim · /api/devices (codes, list, rename, revoke)
backend/src/network/advertise.ts      bonjour-service: _syncretail._tcp, TXT {sid, v, api}; re-announced on rename
backend/src/ws.ts                     display relay: device token checked during the HTTP upgrade (refused → 401)
backend/src/host/runtime.ts           Postgres port fallback (moves + remembers if another program took it)
frontend/src-tauri/src/discovery.rs   mdns-sd browse (one long-lived daemon); address ranking: primary subnet first
frontend/src-tauri/src/client.rs      pairing persisted: token → Windows Credential Manager, rest → mode.json;
                                      client_connect: last address, else re-find by store id and save (self-heal)
frontend/src-tauri/src/windows.rs     windows created in code so the customer display shares the register's WebView2 profile
frontend/src-tauri/src/profile.rs     SR_PROFILE=<name>: separate data + WebView2 profile per instance (testing only)
frontend/src/features/setup/ClientPairing.tsx   discover list, manual address, 6-digit code + register name
frontend/src/components/HostGate.tsx  routes by role: chooser / host / client (finding host, offline banner, "Register removed")
frontend/src/features/admin/DevicesTab.tsx      Admin → Registers: add (code + countdown), list, remove
frontend/src/lib/config.ts, api.ts    runtime register code + device token on every request; DEVICE_REVOKED handling
shared/src/domain.ts                  permission devices:manage (Admin, Manager)
```

**Verification**

| Suite | Result |
|---|---|
| `sr-host.exe` M2 checks (fresh store each run) | **28 / 28 pass**. They cover:<br>• both migrations applied on a fresh store<br>• mDNS browse finds the host by store id (TXT port / version / api)<br>• `/health` and `/pair/info` open to other machines; everything else needs a device token (401); loopback exempt<br>• codes can't be issued from an unpaired machine<br>• wrong code refused; register newer than the host refused (409); a code works once<br>• 3 registers paired as R2, R3, R4; the device token is required in addition to a staff session<br>• display socket without a token refused at the handshake<br>• revoke takes effect on the next request; others unaffected<br>• 5 wrong codes lock the IP out (429) |
| Multi-register end-to-end: installed Main Register + 3 register instances on one PC | **23 / 23 pass**. They cover:<br>• the store is discovered in 2.9–3.0 s<br>• each register is **paired and at its lock screen in 4.1–4.4 s** (target < 30 s), and the host shows "Paired"<br>• every register sells online under its own prefix, and all sales are on the host<br>• registers reach the host on the LAN address, not a virtual adapter<br>• removal shows "Register removed" instantly<br>• a stale host address self-heals in 5.5 s (and the host had moved to port 47801 because 47800 was still being released — the register found it by store id)<br>• no page errors; clean shutdown |
| Upgrade over the M1 store | Devices migration applied automatically on launch |

**Bugs found and fixed during M2**

| # | Problem | Fix |
|---|---|---|
| 1 | Another program holding the store's Postgres port stopped the host from starting | Move to the next free port, remember it, pass it with `pg_ctl -o "-p …"` |
| 2 | An unpaired display socket was accepted, then closed (briefly open) | Check the token in `verifyClient` during the upgrade |
| 3 | A register talked to the host via the WSL/Hyper-V virtual adapter address (unreachable from other PCs) | Rank advertised addresses: primary-network subnet first, then directly routed, then private |
| 4 | Two registers with the same name were indistinguishable in Admin | Remove buttons carry the register code: "Remove Drive-thru (R4)" |
| 5 | The customer display opened in a different WebView2 profile from the register (would break BroadcastChannel per profile) | Windows created in Rust with the register's data directory |

**Open item — verify on a second PC**

On the "Find your Main Register" screen, a register's WebView2 process sometimes exited about 2.5 s after its first network scan.

- **What was seen:** the app process stayed up and the window went blank. There was no crash record in the Windows event log. It happened in roughly 1 in 4–5 runs of a dedicated probe. A control run on the same screen without discovery never failed (6/6), and moving to one long-lived mDNS daemon didn't remove it.
- **What has not been seen:** the full multi-register run on the final build (above) had **no** occurrence across three first scans.
- **Why it's unresolved:** every failure happened with WebView2's remote-debugging port enabled for the test tooling, so the harness itself may be involved.
- **Next step:** install the release build on a second physical PC with no debugging, and pair it 10+ times.
- **If it reproduces:** move discovery into a short-lived helper process (`sr-host --discover`), so mDNS never shares a process with WebView2.

**Changes from the original plan**

- **Register codes:** each register has a short code (R2, R3, …) used as its receipt prefix. Device ids alone made receipts unreadable.
- **Customer display on another device:** deferred. Registers' own displays work as before (same machine). A tablet display needs the host to serve the web UI, which it doesn't in host mode; that is a later item (M5 or after).
- **Test-only `SR_PROFILE`:** lets several registers run on one PC. It is documented, not exposed in the UI.
- **Rebuild trap:** `cargo build --release` alone produces a binary that loads the dev server (`localhost:5173`). Always build with `tauri build` (or `npm run desktop:build`). This is now noted in §10.1.

---

## 3. Target architecture

```
                         ┌────────────────────────── Store LAN ───────────────────────────┐
                         │                                                                 │
 ┌───────────────────────┴───────────┐        mDNS: _syncretail._tcp         ┌────────────┴──────────────┐
 │ MAIN REGISTER (Host PC)           │  ◀──────────── discover ───────────── │ REGISTER 2..n (Client PC) │
 │                                   │                                       │                           │
 │  Tauri shell (sync-retail.exe)    │   HTTP :47800  /api  + WS /ws         │  Tauri shell              │
 │   ├─ UI (React)                   │  ◀───────────── pair, sell ────────── │   ├─ UI (React)           │
 │   └─ host.rs supervisor           │                                       │   ├─ discovery.rs (mDNS)  │
 │        │ stdin/stdout + parent-pid│                                       │   └─ device token (OS     │
 │  sr-host.exe (Node SEA)           │                                       │      credential store)    │
 │   ├─ Express API (existing)       │                                       │  IndexedDB catalog +      │
 │   ├─ network/: mDNS advertise,    │                                       │  sale outbox (existing)   │
 │   │   pairing, device registry    │                                       └───────────────────────────┘
 │   ├─ services/backup/: snapshot,  │
 │   │   AES-256-GCM, Drive, queue   │──── HTTPS (when online) ────▶  Google Drive /SyncRetail_Backups
 │   └─ Postgres 17 (127.0.0.1 only) │
 └───────────────────────────────────┘
```

**Principles**

- **One API, two deployments.** Cloud (Docker) and LAN host run the same `createApp()`. Mode only changes how the process boots and where secrets live.
- **The host is the only writer.** Clients never hold a database. They keep the existing IndexedDB catalog cache and offline sale outbox, so a host reboot or sleep doesn't stop selling (§6.5).
- **Postgres is never exposed.** It is bound to `127.0.0.1` with a random password; only the API talks to it.
- **Secrets never leave the host unencrypted.** Backups carry them only inside the AES-256-GCM envelope.

---

## 4. Decisions

| # | Decision | Alternatives considered | Why |
|---|---|---|---|
| D1 | **Embedded PostgreSQL 17** (as POC) | SQLite | Reports and search use Postgres-only features in four files (`date_trunc`, case-insensitive search). SQLite means rewriting and re-testing them, and it handles concurrent registers less well. Cost: about 100 MB installed (reducible, §10.3). |
| D2 | **Node single-executable sidecar** (as POC) | Electron; `pkg`; Bun compile | Keeps Tauri's small, secure shell. Node SEA is official. Proven in the POC including Prisma's native engine. |
| D3 | **Own Prisma-compatible migrator** (as POC) | Ship Prisma CLI + schema engine (~40 MB) | Smaller, no extra native binary, and writes the same `_prisma_migrations` rows so the Prisma CLI keeps working on the DB. Also refuses to run against a DB from a newer app version. |
| D4 | **Pairing code is primary; QR is optional** | QR-first | Counter PCs rarely have cameras. QR stays for tablets used as registers or displays. |
| D5 | **6-digit pairing code, 2-minute TTL, 5 attempts** | 4-digit as specified | 4 digits is a 1-in-10,000 space; 6 digits plus lockout costs the cashier nothing. If the spec must stay at 4, keep the TTL and lockout. |
| D6 | **HTTP + per-device tokens for v1; TLS with certificate pinning in v1.1** | TLS from day one | Self-signed TLS inside WebView2 requires a native HTTP path (Rust) for all API calls, which is a large change. v1 compensates: device tokens, PIN rate limits, LAN-only bind option, and short JWT lifetimes. |
| D7 | **Recovery key generated at setup** | Key only on the host | Without it, a dead host means unreadable backups and the restore wizard cannot work. |
| D8 | **Drive scope `drive.file`** | `drive` (full) | `drive.file` only sees files the app created: lighter Google verification and less access. A replacement PC on the same Google account still sees the backups. |
| D9 | **Keep the cloud/Docker mode** | Replace cloud with LAN | Same codebase; some customers will want hosted. |

---

## 5. Deliverables and module layout

The requested paths map onto the existing `backend/src` layout as follows. POC files are marked ✅.

### 5.1 `backend/src/db` — schema and local database

| File | Purpose |
|---|---|
| ✅ `localPostgres.ts` | Cluster lifecycle (init/start/stop/status), DB creation |
| ✅ `migrate.ts` | Prisma-compatible migrate deploy + forward-only version guard |
| `snapshot.ts` | `pg_dump -Fc` to a temp file; verifies it with `pg_restore --list` |
| `restore.ts` | Fresh cluster → `pg_restore` → `migrateDeploy` → integrity checks (row counts, latest sale) |
| `prisma/schema.prisma` | + `Device`, `BackupJob`, `PairingAttempt` (§5.5) |

### 5.2 `backend/src/network` — discovery and pairing

| File | Purpose |
|---|---|
| `advertise.ts` | `bonjour-service`: publishes `_syncretail._tcp` with TXT `{ sid: storeId, name, v: appVersion, api: 1 }`. Re-announces on network change; unpublishes on shutdown. |
| `pairing.ts` | Issues a code (6 digits, 2-min TTL, single use), verifies it, mints a device token (32 random bytes; stores SHA-256 only), rate-limits per IP and per code |
| `devices.ts` (routes) | `POST /api/pair/start` (admin, shows code) · `POST /api/pair/claim` (client: code + device name) · `GET/DELETE /api/devices` (admin: list/revoke) · `POST /api/devices/heartbeat` |
| `middleware/device.ts` | Requires a valid `X-Device-Token` on every `/api` call in LAN mode, alongside the staff JWT. A revoked register loses access immediately. |
| `qr.ts` | Optional: `qrcode` SVG of `syncretail://pair?h=<ip>:<port>&sid=<storeId>&c=<code>` |

**Client-side discovery runs in Rust** (`frontend/src-tauri/src/discovery.rs`, crate `mdns-sd`), because browser JavaScript cannot send multicast. It is exposed as the Tauri command `discover_hosts() -> Vec<{name, storeId, addrs, port, version}>`.

### 5.3 `backend/src/services/backup` — snapshot, encryption, Drive, queue

| File | Purpose |
|---|---|
| `snapshot.ts` | Orchestrates `db/snapshot.ts` + manifest (§7.3) → plaintext stream |
| `crypto.ts` | SRBK v1 envelope: chunked AES-256-GCM, key handling (§7) |
| `drive.ts` | OAuth (installed-app loopback + PKCE), token refresh, folder `SyncRetail_Backups` find-or-create, **resumable** upload, list/download for restore |
| `queue.ts` | Persistent job queue (`BackupJob` table + files in `<data>/backups/outbox`). Exponential backoff (1 min → 1 h), resumes on network change, survives reboot. |
| `scheduler.ts` | Optional automatic nightly backup at a configured time (recommended on) |
| `retention.ts` | Drive: keep 30 daily + 12 monthly. Local outbox: keep last 7 encrypted files. |
| routes `backup.ts` | `POST /api/backup/run` · `GET /api/backup/status` · `GET /api/backup/history` · `POST /api/backup/drive/connect` · `DELETE /api/backup/drive` (Manager/Admin) |

### 5.4 `frontend/src/features/setup` — first launch, backup, restore

| Component | Purpose |
|---|---|
| `SetupWizard.tsx` | First launch: **Main Register** / **Connect to Register** / **Restore from backup** |
| `HostSetup.tsx` | Store name, currency/locale, owner admin account and PIN, **recovery key** screen (show → print → confirm by retyping two groups), firewall check, optional Drive connection |
| `ClientPairing.tsx` | Auto-discovered host list (with store name and version match), manual IP fallback, 6-digit code entry, register name. Optional QR via a tablet camera. |
| `BackupDashboard.tsx` | In Admin: Drive status, **Backup to Google Drive now** (big end-of-day button), last success, queue state, history, retention, nightly schedule toggle |
| `RestoreWizard.tsx` | Connect Drive → pick backup → enter recovery key → progress → summary → "Registers will reconnect automatically" |
| `DevicesPanel.tsx` | Paired registers: last seen, app version, revoke |

Tauri additions: `mode.json` in app data (`host` or `client` + host identity), `discovery.rs`, and `secure_store.rs` (Windows Credential Manager via the `keyring` crate) for the device token and Drive refresh token.

### 5.5 Data model additions

```prisma
model Device {
  id          String    @id @default(cuid())
  name        String                 // "Register 2 — front"
  kind        DeviceKind             // HOST | REGISTER | DISPLAY
  tokenHash   String    @unique      // sha256(device token)
  appVersion  String?
  pairedAt    DateTime  @default(now())
  pairedById  String?                // admin who issued the code
  lastSeenAt  DateTime?
  lastIp      String?
  revokedAt   DateTime?
}

model BackupJob {
  id          String       @id @default(cuid())
  trigger     BackupTrigger          // MANUAL | SCHEDULED | PRE_UPDATE
  status      BackupStatus           // SNAPSHOT | QUEUED | UPLOADING | DONE | FAILED
  fileName    String
  sizeBytes   BigInt?
  sha256      String?                // of the encrypted file
  driveFileId String?
  attempts    Int          @default(0)
  lastError   String?
  createdById String?
  createdAt   DateTime     @default(now())
  uploadedAt  DateTime?
}
```

`Sale.terminalId` already exists. It becomes the paired `Device.id`, so reports can break sales down by register.

---

## 6. Local network: protocols and behaviour

### 6.1 First launch — Host

1. Wizard → **Main Register**.
2. `sr-host` provisions identity, Postgres and migrations (as POC). Seeding is replaced by the wizard's store profile and owner account.
3. Recovery key is generated, shown and confirmed (§7.1).
4. Firewall: the installer already added a **private-profile** allow rule for `sr-host.exe` (§10.2). The wizard verifies the port is reachable from the LAN interface and warns if the network is marked *Public*.
5. mDNS advertising starts. Admin → *Devices* → **Add register** shows the pairing code (and QR).

### 6.2 First launch — Client

1. Wizard → **Connect to Register** → `discover_hosts()` lists hosts within about 3 s. Version mismatches are flagged (the host must be ≥ client).
2. The cashier picks the host (or types an IP), enters the **6-digit code** and names the register.
3. `POST /api/pair/claim` returns `{ deviceId, deviceToken, storeId, hostName }`. The token goes to Windows Credential Manager; `mode.json` stores `storeId` and the last known address.
4. The app reloads in client mode. The API base is resolved from mDNS by `storeId` on every launch (§6.4).

### 6.3 Pairing security

- Codes: 6 digits, single-use, 2-minute TTL, at most 3 outstanding.
- Claiming: 5 attempts per code, 10 per IP per 10 minutes. Every attempt goes into `AuditLog`.
- Tokens: 256-bit random, hashed at rest, revocable instantly. Every request also needs a staff session (PIN/password), as today.
- Optional setting "**LAN only**": the API rejects non-RFC1918 source addresses.
- v1.1 (D6): the host generates a self-signed certificate at setup. Its SHA-256 fingerprint goes in the mDNS TXT record and the QR code and is confirmed during pairing; clients then pin it, with API calls made through a Rust HTTP client.

### 6.4 Finding the host after IP changes

DHCP can hand the host a new IP. The client resolves `_syncretail._tcp` instances, matches `sid == storeId`, and uses that address. It falls back to the last known IP, then shows "Looking for Main Register…" with a manual override. Recommendation in the setup guide: give the host a DHCP reservation.

### 6.5 Host unavailable (sleep, reboot, crash)

- Clients already work offline: IndexedDB catalog, local sale outbox, receipts marked *will sync* (built in v1). The sync lamp shows *Host offline*.
- **Limits while the host is down:** manager overrides, new customer enrolment, and stock checks against other registers.
- Host-side mitigations:
  - the installer sets "Sync Retail Host" to prevent sleep while the app is open (`SetThreadExecutionState`);
  - a Windows logon task can auto-start the app.

### 6.6 Customer display

Same-machine displays keep using BroadcastChannel. A counter tablet uses the existing `/ws` relay on the host (`/display?relay=1`), now discoverable the same way.

---

## 7. Backup and recovery

### 7.1 Keys

```
Backup Key (BK)        32 random bytes, generated at host setup
Recovery Key (RK)      = BK, shown once as 13 groups of 4 Base32 chars, e.g.
                         K7QM-2XRA-…   (printable sheet + "I've stored it" confirmation)
On the host            BK stored in Windows Credential Manager (DPAPI-protected)
Optional passphrase    BK also wrapped with scrypt(passphrase, N=2^17, r=8, p=1) → KEK,
                       so an owner can restore with a passphrase instead of the key sheet
```

- **Rotating** the recovery key generates a new BK. Older backups still need the old key, which the dashboard warns about.
- **Losing both** the key sheet and the passphrase makes backups unrecoverable. This is by design, and the setup wizard says so plainly.

### 7.2 Snapshot

1. Bundle `pg_dump.exe` and `pg_restore.exe` (PostgreSQL 17 Windows binaries, about 10 MB with their DLLs) into `resources/host/pgsql/bin`. **Required: not included in embedded-postgres.**
2. Run `pg_dump -Fc -Z 6 --no-owner` against the live DB. It's consistent without stopping sales (MVCC snapshot).
3. Verify with `pg_restore --list`.
4. A typical small store DB is 5–50 MB, so the dump takes 1–5 s.

### 7.3 File format (SRBK v1)

```
offset  field
0       magic "SRBK"            4 bytes
4       version 0x01            1 byte
5       flags (bit0: passphrase-wrapped key present)
6       header length (u32 LE)
10      header JSON (UTF-8):    { createdAt, storeId, storeName, appVersion, migrations:[…],
                                  chunkSize: 4194304, cipher: "AES-256-GCM",
                                  wrappedKey?: { kdf:"scrypt", N,r,p, salt, nonce, ct, tag } }
…       chunk*: [u32 length][12-byte nonce][ciphertext][16-byte tag]
        nonce = 8-byte random prefix (per file) ‖ 4-byte chunk counter
        AAD   = header bytes ‖ chunk index ‖ isLast flag   (detects reordering/truncation)
plaintext = tar { manifest.json, db.dump (pg_dump -Fc), host-secrets.json }
```

- **What `host-secrets.json` carries:** the JWT secret, the device-token hashes (already in the DB), and the store identity. That is what lets registers reconnect to a restored host without re-pairing.
- **File name:** `SyncRetail_<store>_<yyyy-mm-dd_HHmm>_<appVersion>.srbk`.

### 7.4 Google Drive

| Item | Plan |
|---|---|
| OAuth client | Google Cloud project "Sync Retail", **Desktop app** client type, loopback redirect `http://127.0.0.1:<random>/` + PKCE. The client secret is not treated as secret (Google's guidance for installed apps). |
| Scope | `https://www.googleapis.com/auth/drive.file` only |
| Consent screen | Must be **In production**. In *Testing* status, refresh tokens expire after **7 days** and backups silently stop. Brand verification is required to remove the "unverified app" screen and the 100-user cap. |
| Token storage | Refresh token in Credential Manager on the host; never sent to clients |
| Folder | Find or create `SyncRetail_Backups` (app-created, so visible under `drive.file`); `appProperties.storeId` tags files per store |
| Upload | Resumable upload in 8 MB parts; checksum compared after upload |
| Failure handling | Revoked or expired consent puts the dashboard into *Reconnect Google Drive*. Uploads stay queued; nothing is lost. |

### 7.5 Manual end-of-day backup with offline grace

```
[Backup to Google Drive] ─▶ snapshot ─▶ encrypt ─▶ <data>/backups/outbox/*.srbk ─▶ BackupJob QUEUED
                                                              │
                         online? ── yes ──▶ upload (resumable) ─▶ DONE (+ retention prune)
                            │
                            no ──▶ stays QUEUED · retry with backoff · retry on network change
```

The button reports "Backup saved — will upload when online" immediately. The dashboard shows queued, uploading and failed counts, and admins see a banner after 48 h without a successful upload.

### 7.6 Restore wizard (replacement host)

1. Fresh install → **Restore from backup** → connect Google Drive.
2. List `.srbk` files for the account, grouped by store, newest first, showing app version and size.
3. Enter the recovery key or passphrase. The key-wrap and first-chunk tags are checked before downloading the whole file.
4. Download → decrypt → verify manifest. **Refuse if the backup's app version is newer than this app**; offer to update first.
5. Provision a fresh cluster → `pg_restore` → `migrateDeploy` (forward-migrate older backups) → restore host secrets → sanity checks.
6. Start advertising with the **same storeId**. Clients find it by `storeId` and reconnect with their existing device tokens; nobody re-pairs. If the old host might come back, the wizard offers **Revoke previous host identity**.
7. Clients' offline outboxes flush into the restored host. Sales made after the backup but before the failure are recovered from each register's outbox, as long as those registers didn't sync to the dead host after the snapshot. The plan documents this window and the nightly schedule minimises it.

---

## 8. Updates and version skew

- **Rule:** the host version must be ≥ client versions. Clients refuse to pair with an older host and prompt "Update the Main Register first".
- **Before every update:** the host takes a `PRE_UPDATE` backup (local + queued upload).
- **Migrations are forward-only.** The migrator already refuses a DB with unknown (newer) migrations.
- **Auto-update:** `tauri-plugin-updater` with signed update manifests, staged rollout, and the host updating outside trading hours.

---

## 9. Security model

| Threat | Mitigation |
|---|---|
| Rogue device on the store Wi-Fi calls the API | Device token required (LAN mode) + staff session; pairing needs an admin-issued code; LAN-only option |
| Brute-forcing pairing codes or PINs | 6-digit single-use codes with TTL + attempt limits; existing PIN lockout |
| Sniffing on shared Wi-Fi | v1: per-device tokens, short JWT TTLs, guidance to put registers on a private SSID/VLAN. v1.1: TLS with pinned certificate (D6). |
| Database file theft from the host | Postgres bound to loopback only; app-data folder ACL'd to the user. Optional future: BitLocker guidance. |
| Backup file theft (Drive compromise) | AES-256-GCM; key never uploaded; authenticated chunks |
| Lost recovery key | Clear warnings, printable sheet, optional passphrase wrap, rotation flow |
| Tampered installer or update | Authenticode signing of the installer, `sync-retail.exe` and `sr-host.exe`; signed updater manifests |
| Orphaned DB processes after a crash | POC: stdin command + parent watchdog + reuse of a running cluster |

---

## 10. Packaging and distribution (Windows first)

### 10.1 Build pipeline

```
npm ci
npm -w backend run db:generate
npm -w backend run build:host        # esbuild → Node SEA → stage resources (POC)
signtool remove /s sr-host.exe        # strip Node's invalidated signature
signtool sign /fd sha256 /tr <tsa> /td sha256 sr-host.exe   # EV / OV code-signing cert
npm -w frontend run tauri build      # Tauri signs app + installer via bundle.windows.signCommand
                                     # NB: never ship a plain `cargo build --release` exe — without Tauri's
                                     # custom-protocol feature it loads the dev server (localhost:5173)
```

CI: a GitHub Actions `windows-latest` runner with the signing certificate in a hardware-backed service (Azure Trusted Signing or similar).

### 10.2 Installer (NSIS)

- **Install mode:** per-machine (`Program Files`) for production. The POC used per-user. Per-machine needs elevation once, which is also when the firewall rule is added.
- **Firewall:** an `NSIS_HOOK_POSTINSTALL` hook runs `netsh advfirewall firewall add rule name="Sync Retail Host" dir=in action=allow program="$INSTDIR\sr-host.exe" profile=private`. It is removed on uninstall.
- **WebView2:** use the bootstrapper. It's already present on Windows 11, and Windows 10 installs it silently.
- **Uninstall:** keeps `%LOCALAPPDATA%\dev.syncretail.pos`, which holds the database and backups, unless the user ticks *Remove store data*.

### 10.3 Size reduction (target ≈ 35 MiB installer)

- Remove Postgres `share/` locales and the timezone sets the app doesn't use, plus contrib extension DLLs it doesn't need in `lib/`.
- Point SEA at the system's Node, or use `--build-sea` (newer Node) with `useCodeCache` and strip the intl data the API doesn't need. Measure first.

### 10.4 Other platforms

The design is cross-platform:
- **Postgres binaries:** use the macOS (arm64/x64) and Linux packages from embedded-postgres.
- **Discovery:** `mdns-sd` works on all three.
- **macOS:** shows a Local Network permission prompt. The installer must request it via Info.plist `NSLocalNetworkUsageDescription`.
- **Linux:** the sidecar runs under the user session.

Schedule these after Windows ships.

---

## 11. Testing strategy

| Layer | What | How |
|---|---|---|
| Unit | Migrator (fresh, re-run, failed, newer-DB guard); SRBK crypto (round trip, tamper, truncation, wrong key, reordering); pairing (TTL, attempts, single use) | Vitest |
| Host integration | The POC harness, formalised: launch `sr-host.exe` on a fresh dir → READY → API suite → shutdown → no orphans; warm restart; kill −9 recovery | Node script in CI (Windows runner) |
| Desktop E2E | Installed app via WebView2 CDP (`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port`). **Use raw `Page.captureScreenshot`, never `page.screenshot()`.** | Playwright-core, as in the POC |
| Backup drills | Backup → wipe → restore on a second VM → registers reconnect without re-pairing → totals match | Scripted, run before every release |
| LAN lab | Consumer router, mesh Wi-Fi, guest network with AP isolation, Ethernet + Wi-Fi mix, DHCP change, host sleep/hibernate, host power loss mid-sale (Postgres crash recovery), 3 registers + 1 tablet display | Manual matrix, signed off per release |

---

## 12. Milestones

Estimates are for one experienced engineer. *Done when* items are acceptance criteria.

| # | Milestone | Scope | Estimate | Done when |
|---|---|---|---|---|
| **M0** | **POC** | §2 | **done** | Installed app sells end to end on Windows; clean shutdown under quit and kill |
| **M1** | **Host mode, production-ready** | Setup wizard (host path), owner account instead of demo seed, recovery key, port conflict handling, sleep prevention, installer firewall rule, per-machine install, logs/diagnostics export | **done** (§2.6) | A fresh PC runs setup and makes a first sale without seeing demo data; installer adds the firewall rule ✔ |
| **M2** | **Discovery and pairing** | `network/*`, `Device` model, device middleware, `discovery.rs`, client wizard, devices panel, mode switching, IP-change handling | **done** (§2.7) | 3 registers pair via code in under 30 s each ✔ (4.1–4.4 s) · revoking blocks a register immediately ✔ · host IP change self-heals ✔ · *verify on a second physical PC* |
| M3 | Backup to Drive | `pg_dump` bundling, SRBK crypto, Drive OAuth + resumable upload, queue, scheduler, retention, dashboard | 1.5 wk | Manual and nightly backups land in `SyncRetail_Backups`; offline backups upload after reconnect; tamper tests fail closed |
| M4 | Restore | Restore wizard, version guards, identity carry-over, client auto-reconnect, outbox replay | 1 wk | Drill: kill host VM → restore on a new VM → all registers resume without re-pairing; totals reconcile |
| M5 | Hardening and release | Code signing in CI, updater + pre-update backup, LAN lab matrix, size reduction, docs (owner setup guide, recovery key sheet) | 1 wk | Signed installer passes SmartScreen; LAN matrix signed off |
| M6 *(v1.1)* | TLS pinning | Self-signed certificate at setup, fingerprint in TXT/QR, Rust HTTP path for API calls | 1 wk | No plaintext API traffic on the LAN |

**Total to v1 (M1–M5): about 6 weeks**, M6 one more. Google OAuth brand verification takes 1–3 weeks of Google review; **start it in M3, week 1**.

---

## 13. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Multicast blocked (AP/client isolation, mesh, enterprise Wi-Fi) | Medium | Clients can't auto-discover | Manual IP fallback; DHCP reservation guidance; QR carries the IP |
| Windows Firewall / network marked *Public* | High | Clients can't connect | Installer rule (private profile) + wizard check that explains how to switch the network to Private |
| Host PC sleeps or is switched off at night | High | Clients go offline-mode; overrides unavailable | Sleep prevention while open; auto-start task; offline mode already covers sales |
| Recovery key lost | Medium | Backups unrecoverable | Printable sheet, confirm step, optional passphrase, periodic "verify your recovery key" prompt |
| Google OAuth left in Testing | Medium | Backups stop after 7 days | Release checklist item; dashboard alert on refresh failure |
| SmartScreen / AV flags an unsigned Node SEA | High until signed | Install friction, quarantined `sr-host.exe` | Code signing (M5); submit to Microsoft for reputation; AV vendor allow-listing |
| Postgres crash recovery after power loss | Low | Startup delay | Postgres WAL handles it; `pg_ctl status` reuse; startup log shown in the failure screen |
| Data written to the old host after the last backup is lost | Medium | Missing sales after restore | Nightly auto-backup + client outbox replay; document the window |

---

## 14. Open questions for the product owner

1. ~~**Pairing code length**~~ — **settled:** 6 digits, 2-minute TTL, single use, attempt limits (implemented in M2).
2. **Automatic backups:** the spec asks only for a manual end-of-day trigger. Approve adding an automatic nightly backup (recommended), and choose a default time.
3. ~~**Recovery model**~~ — **settled in M1:** recovery key sheet always, plus an *optional* passphrase (12+ characters, scrypt N=2^17).
4. ~~**Install scope**~~ — **settled in M1:** per-machine install (one UAC prompt); it adds the firewall rule.
5. **Platforms:** is Windows-only acceptable for v1, with macOS later?
