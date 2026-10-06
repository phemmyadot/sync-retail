# Sync Retail — Store Branding & Custom Logo

**Implementation plan · v1 · 2026-10-06 — implemented 2026-10-06 (B1–B2; see §9)**

An admin uploads the store's logo once. It replaces the default **Sr** mark in the top-left of the navigation on every register, and updates live. Images are checked in the browser before upload and again on the server.

---

## 1. Summary

| | |
|---|---|
| **Feasibility** | Yes, with no new services or native dependencies. |
| **Key decisions** | (1) The logo is stored **in the database**, not as a file, so it works the same in Docker and on the desktop Main Register, and is included in database backups. (2) The same validation rules and image-header readers live in `shared`, so the browser and server can't disagree. (3) SVGs are **checked for scripts and served with a sandboxing CSP**. (4) Live updates reuse the store WebSocket channel added for held sales. |
| **Effort** | About 2 days. |

---

## 2. Corrections to the brief (this codebase)

| Brief | In this codebase | Plan |
|---|---|---|
| `StoreConfig.logoUrl` (Prisma) | No `StoreConfig` model: store settings are one JSON row (`Setting` key `store`) behind `getSettings()` | `logoUrl` becomes a **read-only field of `StoreSettings`** (set only by the branding route; `PUT /settings` ignores it). The image bytes go in a new `StoreAsset` table. |
| Save the file to the host's app-data folder via Tauri FS or upload middleware | Files on disk need path handling per deployment, are lost with an un-mounted Docker container, and wouldn't be in the (future) database backup. Tauri FS isn't available to browser registers. | `StoreAsset` row (`bytea`, ≤ 512 KB). Served by the API at a **versioned URL** (`/api/branding/logo?v=<hash>`), so every register, browser or desktop, fetches it the same way and caches it forever. |
| Upload handler with "upload middleware" | No multer in the project; the desktop host is a single bundled executable | `express.raw()` on the route: the file is the request body, typed by `Content-Type`. No new dependency. |
| Pixel limits for SVG | An SVG has no pixel resolution | SVG: **aspect ratio** from `viewBox` (or `width`/`height`) must be 1:1 to 4:1, and the file must be ≤ 512 KB. Pixel limits apply to PNG/JPEG. |
| `/frontend/components/layout/Navbar.tsx` | The navigation is `components/layout/AppShell.tsx` (desktop rail + mobile top bar) | New `components/layout/StoreLogo.tsx`, used in both places |
| `/frontend/components/admin/…`, `/frontend/utils/…` | Admin UI lives in `features/admin/`; `frontend/src/utils/` exists | `features/admin/StoreBrandingSettings.tsx`, `utils/validateLogo.ts` |

---

## 3. Validation rules (`shared/src/branding.ts`)

| Rule | Value | Where checked |
|---|---|---|
| Types | PNG, JPEG, SVG, by **file signature**, not by name or browser MIME | Browser and server |
| Size | ≤ 512 KB | Browser and server (`express.raw` limit too) |
| PNG/JPEG resolution | 100–500 px in **each** dimension | Browser (`naturalWidth`/`naturalHeight`) and server (PNG IHDR / JPEG SOF header) |
| Aspect ratio | width ÷ height between **1 and 4** (1 % tolerance on the lower bound, so 495×500 counts as square). Portrait is rejected. | Browser and server |
| SVG safety | Rejected if it contains `<script>`, `on…=` handlers, `<foreignObject>`, `javascript:` / external `href`s, `<!ENTITY`, or `<iframe>`/`<embed>`/`<object>` | Browser (early message) and server (authoritative) |

Messages are written for staff, e.g. *"Logo must be horizontal or square and between 100×100 and 500×500 pixels — this one is 300×600 (portrait)."*

---

## 4. Design

### 4.1 Data

```prisma
model StoreAsset {
  key         String   @id          // "logo"
  mimeType    String
  bytes       Bytes
  sha256      String
  width       Int?                  // PNG/JPEG pixels; SVG viewBox units
  height      Int?
  updatedById String?
  updatedAt   DateTime @updatedAt
}
```

`StoreSettings.logoUrl: string | null` is `/api/branding/logo?v=<first 12 hex of sha256>` while a logo exists, otherwise `null`. It is included in the **public** settings, so lock screens and browser registers that aren't signed in see it too.

### 4.2 API (`backend/src/routes/branding.ts`)

| Method | Path | Auth | Does |
|---|---|---|---|
| `GET` | `/api/branding/logo` | none (exempt from device pairing, because an `<img>` can't send the device header; a logo isn't sensitive) | Streams the image. `Cache-Control: public, max-age=31536000, immutable` when `?v=` matches, otherwise `no-cache`; ETag. SVG gets `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox` and `X-Content-Type-Options: nosniff`. 404 when none. |
| `PUT` | `/api/branding/logo` | `settings:write` (admin) | Raw body (`image/png`, `image/jpeg`, `image/svg+xml`, ≤ 512 KB). Validates (§3), stores, updates `logoUrl`, audits `branding.logo.set`, broadcasts. |
| `DELETE` | `/api/branding/logo` | `settings:write` | Removes it: back to **Sr**. Audited and broadcast. |

### 4.3 Live update

- The server publishes `{type: 'branding:changed', logoUrl}` on the store WebSocket channel.
- `AppShell` now owns the single store-channel connection (it was in the held-sales hook) and re-broadcasts events in the window as `sr:store`. Held sales and branding both listen to that.
- On `branding:changed`, registers invalidate the settings query, so the new versioned URL loads at once.
- Lock screens (no session, so no socket) pick it up on the next settings refresh.

### 4.4 UI

- **`StoreLogo`:** renders `<img>` fitted inside the slot (rail 64×40, mobile bar 112×28, `object-contain`). On load error (Main Register unreachable, no cache) it falls back to **Sr** silently. The URL is resolved against the API base, so desktop registers load it from the Main Register.
- The **kiosk unlock hold** (3 s) stays on the logo slot.
- **Admin → Store & loyalty → Branding:**
  - a dropzone (`data-allow-drop`, so it works in kiosk mode) and a file picker
  - runs `validateLogo` and shows the result before uploading
  - a **live preview of the real rail and mobile bar** with the new logo
  - Upload and Remove buttons, with the rules listed under the dropzone

### 4.5 `validateLogo(file)` (`frontend/src/utils/validateLogo.ts`)

1. Size check, then signature sniffing (first bytes) with the shared reader.
2. PNG/JPEG: load into an in-memory `Image` from an object URL. Check `naturalWidth`/`naturalHeight` and the ratio, and cross-check them against the header.
3. SVG: read the text, run the shared safety check, parse with `DOMParser`, and take the ratio from `viewBox` or `width`/`height`. Also confirm it renders in an `Image`.
4. Returns `{ ok, error?, width, height, type, previewUrl }`.

---

## 5. Deliverables → paths

| Brief deliverable | Path |
|---|---|
| Schema (`logoUrl`) | `backend/prisma/schema.prisma` (`StoreAsset`) + migration `<ts>_store_assets`; `shared/src/domain.ts` (`StoreSettings.logoUrl`) |
| Upload handler + server validation | `backend/src/routes/branding.ts`, `shared/src/branding.ts` (rules, header readers, SVG check) |
| `validateLogo.ts` | `frontend/src/utils/validateLogo.ts` |
| `StoreBrandingSettings.tsx` | `frontend/src/features/admin/StoreBrandingSettings.tsx` |
| Navbar with logo / Sr fallback | `frontend/src/components/layout/StoreLogo.tsx`, `AppShell.tsx` |

---

## 6. Testing

- **Unit (shared):** PNG/JPEG header readers on real files of known size (including a progressive JPEG); every rule boundary (99/100/500/501 px, ratio 0.99/1/4/4.01, portrait); SVG ratio from `viewBox` vs `width`/`height`; SVG safety rejections.
- **API:**
  - admin-only upload
  - wrong signature (a PNG renamed `.jpg` is accepted as PNG; a `.png` that is really a text file is rejected)
  - each rule rejection
  - versioned caching headers and ETag
  - SVG response CSP
  - delete
  - public settings expose `logoUrl`
  - the WebSocket event
- **UI (headless):**
  - client-side rejection messages (portrait, too small, too large, wrong type) without a request being made
  - preview
  - upload replaces **Sr** on a second register live
  - remove restores **Sr**
  - broken URL falls back to **Sr**

---

## 7. Milestones

| # | Scope | Estimate |
|---|---|---|
| B1 | Shared rules and readers + tests, `StoreAsset` migration, branding routes, settings field, store event | 1 day |
| B2 | `validateLogo`, `StoreBrandingSettings` with preview, `StoreLogo` in the shell, single store-channel owner, end-to-end tests | 1 day |

## 8. Open questions

1. Should the logo also appear on the **lock screen**, the **customer display** and **printed receipts**? (v1: navigation only, as briefed.)
2. Should managers be able to change it, or admins only? (v1: admins, matching the other store settings.)

---

## 9. Implementation status (2026-10-06)

B1–B2 are implemented as designed. The open questions in §8 remain: v1 shows the logo in the navigation only, and only admins can change it.

| Area | What shipped |
|---|---|
| Rules and readers | `shared/src/branding.ts`: `LOGO_RULES`, `readImageInfo` (PNG IHDR, baseline/progressive JPEG SOF, SVG by content), `svgSize`, `svgDanger`, `checkLogo`, with staff-facing messages. Used unchanged by the browser and the server. |
| Data | `StoreAsset` table (migration `20261006220000_store_assets`, additive; matches the schema per `migrate diff`). `StoreSettings.logoUrl` is read-only: `PUT /settings` drops it. |
| API | `GET /api/branding/logo` (public, and exempt from device pairing **for GET only**; immutable cache when versioned, ETag/304, `nosniff`, sandboxing CSP for SVG). `PUT` (admin, raw body, 415 for other types, 512 KB limit with a friendly message). `DELETE`. Both audited and broadcast. |
| Live update | `AppShell` now owns the single store-channel socket and re-dispatches events as `sr:store`. Held sales listen there, and `branding:changed` refreshes settings. |
| UI | `StoreLogo` in the rail (72×40 slot) and the mobile bar (112×28), `object-contain`, falling back to **Sr** on error. Admin → Store & loyalty → **Branding**: dropzone (works in kiosk), checks before upload, a mock rail and mobile-bar preview, *Use this logo* and *Remove logo*. |

**Verification**
- Unit: 16 new tests (47 shared in total). They cover header readers on synthetic PNG/JPEG (baseline, progressive, fill bytes), SVG detection and ratio, six SVG attack patterns plus allowed internal refs, and every rule boundary.
- API (Docker, real canvas-rendered PNG/JPEG): **23/23**. They cover auth (401/403 for a manager); portrait, too small, too large, 5:1, an SVG `onload`, a text file named `.png`, a 600 KB file and a wrong Content-Type all refused; a JPEG labelled PNG stored as JPEG; exact bytes served; immutable cache, 304 and a no-cache unversioned URL; `PUT /settings` can't change `logoUrl`; SVG CSP; the WebSocket event; remove; audit.
- UI (headless, admin plus a second register): **16/16**. Six client-side rejections with clear messages and **no request sent**; preview; upload replaces **Sr** on the other register live; a 4:1 logo fits the slot without distortion; an unloadable logo falls back to **Sr**; remove restores **Sr** live.
- Held-sales UI suite re-run after moving the socket: 16/16.

