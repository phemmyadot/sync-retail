# Sync Retail — cloud-native POS

A cross-platform point of sale: React + Tailwind terminal (web **and** Tauri desktop), Express + Prisma API on PostgreSQL, offline-first local cache, dual-screen customer display, manager overrides, loyalty, spreadsheet import and reporting.

```
sync-retail/
├─ shared/                 @sync-retail/shared — code used by BOTH client and server
│  └─ src/
│     ├─ domain.ts         roles, permission matrix, override actions, settings
│     ├─ pricing.ts        integer-cents money math, tax, discounts, loyalty, tenders
│     ├─ importer.ts       column auto-mapping + row validation for CSV/XLSX
│     └─ contracts.ts      API DTOs and the customer-display message protocol
├─ backend/                Express 5 + Prisma 6 API
│  ├─ prisma/schema.prisma database schema (see "Data model")
│  ├─ prisma/seed.ts       demo store: staff, catalog, customers, 60 days of sales
│  └─ src/
│     ├─ app.ts / server.ts            HTTP app, routes, WebSocket relay boot
│     ├─ ws.ts                         customer-display relay (cross-device)
│     ├─ middleware/auth.ts            JWT auth, RBAC, role-or-override gate
│     ├─ routes/                       auth, users, products, customers, sales,
│     │                                overrides, reports, import, settings, audit, sync
│     └─ services/                     sales engine, overrides, importer, reports, PDF
├─ frontend/               React 19 + Vite + Tailwind + Tauri v2
│  ├─ src/
│  │  ├─ lib/              api client, IndexedDB (Dexie), offline sync engine,
│  │  │                    display channel, platform helpers
│  │  ├─ store/            zustand: auth, cart, override modal, sync status, toasts
│  │  ├─ hooks/            catalog, settings, barcode scanner, override/permission
│  │  ├─ components/       UI kit (PinPad, Modal, …), AppShell, OverrideModal
│  │  └─ features/         pos, display, inventory (+ import), customers, sales,
│  │                       reports, admin, auth
│  └─ src-tauri/           desktop shell (Windows/macOS/Linux)
└─ samples/products-import.csv   a deliberately messy file for trying the importer
```

---

## Quick start (Docker): recommended

Requires Docker Desktop (or Docker Engine + Compose v2).

```bash
cp .env.example .env        # then set POSTGRES_PASSWORD and JWT_SECRET
docker compose up -d --build
```

Open **http://localhost:8080** and sign in with the demo logins below.

| Service | Container | Host port | What it does |
|---|---|---|---|
| `web` | nginx | `8080` | Serves the built app; proxies `/api` and `/ws` to the API, so everything is same-origin |
| `api` | Node 22 | `4000` | On start: `prisma migrate deploy` → demo seed (**only if the DB is empty** and `SEED_DEMO_DATA=true`) → server |
| `db` | Postgres 17 | `5433` | Data in the `sync-retail_pgdata` volume; UTF-8 |

Useful commands:

```bash
docker compose logs -f api                           # API logs
docker compose exec api npx tsx prisma/seed.ts       # reset to fresh demo data (wipes everything!)
docker compose exec db psql -U postgres sync_retail  # SQL shell
docker compose up -d --build                         # rebuild after code changes
docker compose down                                  # stop (data kept)
docker compose down -v                               # stop and DELETE the database volume
```

**Hybrid dev:** run only the database in Docker (`docker compose up -d db`) and point `backend/.env` at `postgresql://postgres:<POSTGRES_PASSWORD>@localhost:5433/sync_retail?schema=public`. Then use `npm run dev` for hot reload on :5173.

For production, set `SEED_DEMO_DATA=false` and put TLS in front of `web` (or your own reverse proxy).

## Quick start (local, without Docker)

**Prerequisites:** Node 20+ (22/24 recommended) and a PostgreSQL 14+ database — local, Docker, [Neon](https://neon.tech) or [Supabase](https://supabase.com).

```bash
# 1. Install all workspaces
npm install

# 2. Configure the API
cp backend/.env.example backend/.env       # then edit DATABASE_URL and JWT_SECRET

# 3. Create the schema and load demo data
npm run db:migrate          # prisma migrate dev — creates tables (name the migration "init")
npm run db:seed             # demo staff / catalog / customers / sales history

# 4. Run API (http://localhost:4000) + web app (http://localhost:5173)
npm run dev
```

Need a throwaway database? `docker run -d --name pos-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:17` matches the default `DATABASE_URL`.

### Demo logins

| Role        | Email                     | Password      | PIN  |
|-------------|---------------------------|---------------|------|
| Admin       | `admin@syncretail.dev`    | `admin1234`   | 1111 |
| Manager     | `manager@syncretail.dev`  | `manager1234` | 2222 |
| Sales Agent | `agent@syncretail.dev`    | `agent1234`   | 3333 |
| Sales Agent | `jordan@syncretail.dev`   | `agent1234`   | 4444 |

To see the override workflow: sign in as **Sam (3333)**, ring up a few items and press the trash icon. The modal accepts **2222** or **1111**.

---

## Environment variables

### `backend/.env`

| Variable               | Required | Default                 | Notes |
|------------------------|----------|-------------------------|-------|
| `DATABASE_URL`         | ✔        | —                       | Postgres URL. Neon: use the pooled URL with `?sslmode=require`. Supabase: use the connection-pooler URL with `?pgbouncer=true` for the app, and the direct URL when running migrations. |
| `JWT_SECRET`           | ✔        | —                       | ≥16 chars; signs sessions **and** override tokens. |
| `PORT`                 |          | `4000`                  | |
| `CORS_ORIGIN`          |          | `http://localhost:5173` | Comma-separated. Add `http://tauri.localhost` (Windows) and `tauri://localhost` (macOS/Linux) for desktop builds. |
| `SESSION_TTL`          |          | `12h`                   | Staff session length (any `jsonwebtoken` duration). |
| `OVERRIDE_TTL_SECONDS` |          | `300`                   | How long a manager approval stays valid. |

### `frontend/.env` (optional)

| Variable           | Default | Notes |
|--------------------|---------|-------|
| `VITE_API_URL`     | *(empty)* | Empty = same origin (Vite proxies `/api` and `/ws` to `:4000` in dev). **Set it for desktop builds**, e.g. `https://pos-api.example.com`. |
| `VITE_TERMINAL_ID` | `T1`    | Register ID. Used as the receipt-number prefix and the display-relay room. Give each till its own value. |
| `VITE_DEV_API`     | `http://localhost:4000` | Dev-proxy target (read by `vite.config.ts`). |

---

## Desktop app (Tauri v2)

Extra prerequisites: [Rust (stable)](https://rustup.rs) plus the [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/). On Windows that means **Microsoft C++ Build Tools** ("Desktop development with C++") and **WebView2**, which ships with Windows 11.

```bash
# Dev: native window, hot reload (API must be running)
npm run desktop:dev

# Windows installer (.msi + NSIS .exe)
#   1. point the build at your deployed API
echo VITE_API_URL=https://pos-api.example.com > frontend/.env.production
#   2. build
npm run desktop:build
#   → frontend/src-tauri/target/release/bundle/{msi,nsis}/
```

Icons are generated from `frontend/src-tauri/app-icon.svg`. To regenerate them, run `npm -w frontend run tauri icon src-tauri/app-icon.svg -o src-tauri/icons`. For macOS/Linux, run `desktop:build` on that OS. Change `bundle.targets` in `tauri.conf.json` (or use `"all"`) to produce `.dmg` / `.AppImage` / `.deb`.

**Second monitor:** the monitor icon in the rail (or *Customer display* in the register header) opens a native `customer-display` window. Drag it onto the customer-facing screen and press <kbd>F11</kbd> / maximise.

---

## How the pieces work

### Money
Every amount is an **integer number of cents** and every tax rate is in **basis points** (825 = 8.25%). `shared/src/pricing.ts` is the only pricing implementation. The terminal uses it for display, and the API runs the same functions with **database prices** when it records a sale. The client sends only product IDs, quantities, discounts and tenders, so a tampered client cannot change prices.

### RBAC & quick-switch
`shared/src/domain.ts → PERMISSIONS` is the single permission matrix. The server enforces it with `requirePermission`, and the UI uses the same matrix to hide what you can't do.

| | Sales Agent | Manager | Admin |
|---|:-:|:-:|:-:|
| Ring up sales, look up products & customers, enrol members | ✔ | ✔ | ✔ |
| Remove/decrease scanned items, void open cart, big discounts | PIN override | ✔ | ✔ |
| Void / refund / edit completed sales | PIN override | ✔ | ✔ |
| Inventory edits, CSV/XLSX import, reports, audit log | | ✔ | ✔ |
| Staff, PINs, store & loyalty settings | | | ✔ |

The lock screen lists staff tiles; tap a name and enter a PIN to take over the till in about two seconds. PIN and password endpoints are rate-limited (5 failures per minute per IP).

### Manager override workflow
1. An agent triggers a guarded action. The client (`useOverride`) opens the **Manager Override** modal; managers and admins skip it.
2. The manager enters their PIN. `POST /api/overrides/authorize` checks it against every active manager/admin, then **writes an `OverrideLog` row whether the attempt is approved or denied**. On approval it returns a JWT scoped to *(action, requesting user)* that expires in 5 minutes.
3. That token is single-use:
   - **Completed-sale actions** (void, return, edit) send it as `X-Override-Token`. `requireRoleOrOverride` consumes it atomically (`consumedAt`) and links it to the sale.
   - **In-cart actions** (remove item, reduce quantity, discount above the agent's limit) attach it to the sale's `approvals[]`. Those approvals are consumed and linked when the sale is recorded. The server rejects an over-limit discount that has no valid `PRICE_DISCOUNT` approval.
4. **Audit → Manager overrides** shows a timeline: who asked, who approved, why, which receipt, and denied attempts.

### Customer-facing display
`/display` is a login-free route. The register publishes `DisplayMessage`s (`cart`, `checkout`, `complete`, `idle`) through:
- **`BroadcastChannel`**: a second window on the same machine (browser popup or Tauri window). Zero latency, no server involved. A late-opening display says `hello` and gets the current state back.
- **WebSocket relay** (`/ws?terminal=T1`): a display on another device, such as a tablet on the counter. Open `https://your-app/display?relay=1`. Only authenticated terminals can publish; displays can only subscribe.

The display has an idle promo carousel with a ticker (banners are edited in Admin → Store), a live itemised cart with savings, the loyalty card when a member is attached, the remaining balance during split tender, and a thank-you screen with change and points earned.

### Offline-first
- **Catalog:** the register reads products and categories from **IndexedDB** (Dexie). `GET /api/sync/catalog?since=` delta-pulls on boot, on reconnect and every 30 s. Search, the category grid and barcode scanning work with no network.
- **Sales:** if `POST /api/sales` fails on the network, the sale goes into the IndexedDB **outbox** with its client UUID and receipt number. The receipt prints marked *OFFLINE — WILL SYNC*. `POST /api/sync/sales` replays the outbox, and `clientId` is a unique key, so retries never double-charge. Sales that fail validation (e.g. a customer spent their points elsewhere in the meantime) are kept as *failed* and shown on the Sales page for review.
- The sync lamp at the bottom of the rail shows online / queued / failed. Click it to retry.
- **Trade-off:** manager overrides need a connection to verify the PIN. Hashed PINs are never cached on terminals.

### Loyalty
Members earn `pointsPerDollar` on the part of a sale paid in **cash or card**. Points redeemed as a tender don't earn more points. Points are redeemed in blocks (default **100 pts = $5**) as a payment method at checkout, and can be split with cash and card. Every change is written to `LoyaltyTransaction`. Voids and returns claw back points proportionally, and admins can make audited manual adjustments.

### CSV / XLSX import
1. **Upload:** drag and drop `.csv`, `.xlsx` or `.xls`. The file is parsed **in the browser** with SheetJS and is never uploaded raw.
2. **Map columns:** headers are auto-mapped using aliases ("Item Name" → *Name*, "UPC" → *Barcode*, "Sell Price" → *Retail price*, …). Each field shows sample values.
3. **Validate:** an instant local pass, then the authoritative server pass against the live catalog. It flags missing SKU, name or price; non-numeric and negative prices; **negative stock**; **duplicate SKUs and barcodes within the file**; barcodes owned by another SKU; existing SKUs (update vs. error, depending on mode); cost above retail; and fractional stock. Money parsing handles `$1,299.00` and `1.299,00`. Tax accepts `8.25%`, `8.25` or `0.0825`.
4. **Commit:** valid rows are upserted in **one transaction**, categories are auto-created, stock movements are recorded, and an `ImportBatch` and audit entry are written. Invalid rows are skipped and listed.

Try `samples/products-import.csv`. It contains a duplicate SKU, negative stock, a missing price and fractional stock. API clients can also `POST /api/import/parse` (multipart) to parse server-side.

### Reports
`GET /api/reports/summary?preset=today|week|month|quarter|year|custom&from&to&granularity=day|week|month` returns:
- totals: gross, net, refunds, tax, discounts, gross margin, transactions, average ticket, items sold
- a time series
- top 10 products
- category breakdown
- payment mix
- staff performance: sales, revenue, average ticket, voids, overrides requested

Exports: `/api/reports/export?format=csv|pdf&dataset=summary|ledger`. The ledger is one row per receipt. The PDF is rendered server-side with PDFKit.

---

## Data model (Prisma)

| Model | Purpose |
|---|---|
| `User` | staff, `role` (ADMIN / MANAGER / SALES_AGENT), bcrypt `passwordHash` + `pinHash` |
| `Category`, `Product` | catalog: SKU, barcode, cost/price (cents), `taxRateBps`, `stockQty`, low-stock threshold, soft-delete `active` |
| `Customer` | name, phone, email, `lifetimeSpendCents`, `pointsBalance` |
| `Sale` | receipt #, **`clientId` (idempotency)**, totals, status (COMPLETED / VOIDED / PARTIALLY_REFUNDED / REFUNDED), points earned/redeemed, `offline` flag |
| `SaleItem` | snapshots of SKU, name, category, cost and price at time of sale; line discount + tax; `returnedQty` |
| `Payment` | CASH / CARD / LOYALTY, tendered + change, points used, card reference |
| `Refund` | per-line returns with restock flag and override link |
| `OverrideLog` | every override attempt: action, outcome, requester, approver, reason, context, `consumedAt` |
| `LoyaltyTransaction` | points ledger |
| `StockMovement` | every stock change: SALE / RETURN / VOID / ADJUSTMENT / IMPORT |
| `ImportBatch`, `AuditLog`, `Setting` | import history, general audit trail, store settings (JSON) |

## API surface

All routes are under `/api`. Every route except `/auth/*` and `/health` requires `Authorization: Bearer <token>`.

```
POST /auth/login           {email,password}            → {token,user}
POST /auth/pin             {userId,pin}                → {token,user}
GET  /auth/staff                                       → lock-screen tiles
GET  /products?search&categoryId&includeInactive       GET /products/lookup/:barcodeOrSku
POST /products   PATCH /products/:id   DELETE /products/:id   POST /products/:id/adjust-stock
GET|POST|PATCH|DELETE /categories
GET  /customers?search    GET /customers/:id    POST /customers    PATCH /customers/:id    POST /customers/:id/points
POST /sales                GET /sales?search&status&cursor     GET /sales/:idOrReceipt
POST /sales/:id/void       POST /sales/:id/returns      PATCH /sales/:id   (X-Override-Token for agents)
POST /overrides/authorize  GET /overrides
POST /import/parse (multipart)   POST /import/validate   POST /import/commit   GET /import/history
GET  /reports/summary      GET /reports/export
GET|PUT /settings          GET /audit         GET|POST|PATCH /users
GET  /sync/catalog?since   POST /sync/sales
WS   /ws?terminal=T1[&token=…]
```

## Production notes

- **Deploy the API** anywhere that runs Node (Fly.io, Render, Railway, ECS…). Use `npm -w backend run build`, `npm -w backend run db:deploy`, then `node backend/dist/server.js`. Run behind HTTPS; `trust proxy` is already enabled.
- **Deploy the web app** as static files from `frontend/dist`. Rewrite unknown paths to `index.html`, and proxy `/api` and `/ws` to the API (or set `VITE_API_URL`).
- **Card payments:** `CheckoutModal.addTender` has a clearly marked stub. Replace it with your terminal SDK (Stripe Terminal, Adyen, Square…) and store the authorisation reference.
- **Scaling the API horizontally:** move the PIN rate limiter (`lib/rateLimit.ts`) and the display relay (`ws.ts`) to Redis.
- **Printing:** receipts use a print stylesheet (`window.print()`). For ESC/POS thermal printers, add a Tauri command that sends raw bytes.
