# Sync Retail — Parked (Held) Sales

**Implementation plan · v1 · 2026-10-06**

A cashier can **hold** the sale in progress when a customer steps away (forgot an item, gone to fetch money, waiting for a price check) and serve the next person straight away. Later the cashier **resumes** it, on the same register or any other one in the store, and finishes it as if it had never left.

---

## 1. Summary

| | |
|---|---|
| **Feasibility** | Yes. Everything needed exists: the cart store, the shared pricing engine, server re-pricing, manager overrides, the register WebSocket relay and the offline queue. No new services. |
| **Key design points** | (1) **Resuming is an atomic claim**, so two registers can never resume the same held sale. (2) **Prices are re-checked on resume**, because a price or tax rate may have changed while it was held. (3) **Manager approvals carry over** (an approved over-limit discount survives the hold), even though approval tokens normally expire after 5 minutes and belong to one cashier. (4) **Holding works offline** on a register and is shared when it reconnects. |
| **Effort** | About 5 working days for one engineer (§11). |

---

## 2. Corrections to the brief (this codebase)

| Brief | In this codebase | Plan |
|---|---|---|
| `storeId` (tenant scope) | One database = one store (each Main Register or cloud deployment serves one store); no table has a `storeId` | No `storeId`. Record the **register** instead (`terminalId`, e.g. `R2`), which is what staff actually need ("held on Register 2"). |
| `subtotal`, `taxTotal`, `total` as Decimal | All money is **integer minor units** (kobo/cents); rates are basis points | `subtotalCents`, `discountCents`, `taxCents`, `totalCents` as `Int`, computed by the shared `priceCart` |
| `DELETE /api/parked-sales/:id` when resumed | Load-then-delete is a race: two registers can both load the same sale before either deletes it, and the customer gets charged twice or items double-counted. A hard delete also loses the audit trail. | **`POST /:id/resume`** claims it in one conditional update (`status PARKED → RESUMED`); a second claim gets 409. Rows keep a **status** (`PARKED`, `RESUMED`, `DISCARDED`, `EXPIRED`) and are purged after 90 days. |
| `cartItems` as JSON "or relational" | A held cart is a short-lived document, always read and written whole, never queried by line | **JSON** `lines`, validated by a shared zod schema (max 200 lines), with a per-line snapshot of the tax class |
| Approvals not mentioned | Over-limit discounts and item removals carry **manager override tokens** that expire after 5 minutes (`OVERRIDE_TTL_SECONDS`) and are bound to the requesting cashier. A held sale resumed later, or by another cashier, would be rejected at payment. | The server validates the tokens when the sale is held, remembers their override-log ids, and **re-issues fresh tokens** to whoever resumes it (§4.3) |
| "Synced in real time" | The existing WebSocket (`ws.ts`) is a per-register relay for the customer display | Add a store-wide `store` channel that pushes `parked:changed`. Registers also re-fetch on focus and every 30 s as a fallback. |
| Paths `/backend/routes/…`, `/frontend/components/pos/…` | Routes live in `backend/src/routes/`; POS UI in `frontend/src/features/pos/` | Paths in §9 |

---

## 3. What cashiers experience

### 3.1 Holding a sale

- **Hold** button in the cart's action bar, next to Void (shortcut **F6**). It is enabled when the cart has items.
- A small dialog: **"Who is this for?"** with an optional note (max 80 characters), e.g. *"Lady in green jacket"* or *"Mr Bello — gone for cash"*. The attached customer's name pre-fills it. **Enter** saves, so holding takes two key presses.
- **On save:**
  - the cart, attached customer and approvals are stored
  - the register clears, ready for the next customer
  - the customer display returns to the welcome screen
  - a toast: *"Sale held · Lady in green jacket · ₦45,500.00"*
- **Not held:** anything in mid-payment. While checkout is open, Hold is disabled; the cashier cancels payment first. A held sale never has partial tenders.

### 3.2 The held-sales list

- A **Held** button with a badge counter (shortcut **F7**). The count is live across every register in the store.
- A drawer lists each held sale, newest first:
  - the note, or "No note"
  - time held ("12 min ago")
  - held by (cashier) on (register)
  - item count and total
  - the customer, if attached
- Sales held for more than 30 minutes are tinted amber, to remind staff.
- **Search** by note, cashier or customer. **Expand** a row to see its items without resuming.
- Each row has **Resume** and **Discard**.

### 3.3 Resuming

1. **Resume** → the server claims the sale. If someone else has just resumed it: *"Already resumed on Register 1 by Sam at 14:02."*
2. If the current cart has items, the cashier chooses:
   - **Hold current sale and resume** (one tap: swaps the two)
   - **Cancel**
   
   Merging two carts is never offered.
3. The items, customer and approvals load into the cart. The display shows the cart again.
4. **Changes since held:** if a price, tax rate or product changed, a notice lists them, e.g. *"Rice 50kg: ₦85,000 → ₦88,000"*, *"Sugar 1kg is no longer sold — removed"*, *"Only 2 Oat Milk in stock"*. The cart uses **current** prices; the server always charges current prices anyway.
5. The cashier finishes the sale as normal. The receipt number is assigned at completion; holding doesn't use one.

### 3.4 Discarding

- **Discard** asks for a reason (customer left, duplicate, …).
- A **Sales Agent** needs a manager PIN, using the existing **`CLEAR_CART`** override ("Void open transaction"). Discarding a held sale is the same act as voiding an open cart, so there is no new override type. Managers and admins discard directly.
- Held sales older than the **expiry** (store setting, default **24 hours**) expire on their own. Managers see them under an **Expired** filter for 7 days.

---

## 4. Design

### 4.1 Data model (Prisma)

```prisma
enum ParkedSaleStatus {
  PARKED
  RESUMED
  DISCARDED
  EXPIRED
}

model ParkedSale {
  id              String           @id @default(cuid())
  clientId        String           @unique            // set by the register; makes offline upload idempotent
  status          ParkedSaleStatus @default(PARKED)
  reference       String?          @db.VarChar(80)    // "Lady in green jacket"
  terminalId      String                              // register that held it, e.g. "R2"
  parkedById      String
  parkedBy        User             @relation("ParkedBy", fields: [parkedById], references: [id])
  customerId      String?
  customer        Customer?        @relation(fields: [customerId], references: [id], onDelete: SetNull)
  lines           Json                                // ParkedLine[] (§4.2)
  itemCount       Int
  subtotalCents   Int
  discountCents   Int
  taxCents        Int
  totalCents      Int
  approvalIds     String[]                            // OverrideLog ids carried with the sale (§4.3)
  heldOffline     Boolean          @default(false)
  resumedById     String?
  resumedBy       User?            @relation("ResumedBy", fields: [resumedById], references: [id])
  resumedAt       DateTime?
  resumedTerminal String?
  closedReason    String?          @db.VarChar(200)   // discard reason / "expired"
  closedById      String?
  createdAt       DateTime         @default(now())    // when it was held (device time for offline holds)
  updatedAt       DateTime         @updatedAt

  @@index([status, createdAt])
}
```

Migration: one hand-written, purely additive migration (`<ts>_parked_sales`): a new enum, a new table and back-relations on `User` and `Customer`. No existing data is touched.

### 4.2 Line snapshot (`shared/src/parked.ts`)

```ts
export interface ParkedLine {
  productId: string;
  sku: string;
  name: string;
  quantity: number;
  unitPriceCents: number;         // price when held (for display and change detection)
  taxClassId: string;
  taxClassName: string;
  taxRateBps: number;
  discount: LineDiscount | null;  // same shape as the cart
}
```

- The **same type** the cart uses (`CartLine` minus the client-only `key`), so holding and resuming are lossless.
- A zod schema `parkedLineSchema` is shared by the API and the client. Limits: 200 lines, quantity 1–9,999.
- Totals are **recomputed on the server** with `priceCart` from the snapshot, so a tampered client can't store a misleading total.

### 4.3 Carrying manager approvals

1. **Hold:** the client sends the cart's approval tokens. The server checks each one:
   - it's valid for the requesting cashier (expiry ignored if the hold was made offline, the same rule as offline sales)
   - it hasn't been used yet
   
   The override-log ids go in `approvalIds`; the tokens themselves aren't stored.
2. **Resume:** after the claim succeeds, the server **re-signs** a fresh single-use token for each `approvalId`, bound to the **resuming** cashier, and returns them. A new `reissueOverride(logId, requesterId)` in `services/overrides.ts` signs a token for an existing APPROVED, unconsumed log row.
3. The audit trail records `override.carried {logId, parkedSaleId, from, to}`. The approval stays one approval: whichever sale consumes it marks it used, as today.
4. **Discard or expiry:** the carried approvals are simply never consumed, the same as abandoning a cart today.

### 4.4 API (`backend/src/routes/parkedSales.ts`)

All routes require a signed-in session. `sales:park` is a new permission for **all roles**.

| Method | Path | Does |
|---|---|---|
| `POST` | `/api/parked-sales` | Hold. Body: `{clientId, reference?, terminalId, customerId?, lines, approvals[], heldAt?, offline?}`. Validates the products exist, recomputes totals, checks approvals (§4.3), stores, broadcasts. **Idempotent on `clientId`**: a repeat returns the existing row (offline upload retries). Limit: 100 open held sales per store (409 above that). |
| `GET` | `/api/parked-sales?status=PARKED` | List for the drawer, including lines (small). `status=EXPIRED` and `DISCARDED` need `audit:read`. Expires due rows lazily before listing. |
| `GET` | `/api/parked-sales/count` | `{count}` for the badge (cheap; used by polling) |
| `POST` | `/api/parked-sales/:id/resume` | `UPDATE … SET status='RESUMED', resumedBy…, resumedAt… WHERE id=$1 AND status='PARKED'` in a transaction. 0 rows → **409** with who/where/when. Returns `{lines, customer, approvals: freshTokens[], priceChanges[]}` (§4.5). Broadcasts. |
| `POST` | `/api/parked-sales/:id/discard` | Body `{reason}`. Agents need `X-Override-Token` for `CLEAR_CART`; managers don't. Sets `DISCARDED`, broadcasts, audits. |

Housekeeping (in the existing server startup and hourly timer):
- mark `PARKED` rows older than `parkedSaleExpiryHours` as `EXPIRED` (audited)
- delete closed rows older than 90 days

### 4.5 Re-pricing on resume

The server compares each snapshot line with the current product and tax class, and returns `priceChanges[]`:

| Kind | Example | Client behaviour |
|---|---|---|
| `price` | ₦85,000 → ₦88,000 | Line uses the new price; listed in the notice |
| `tax` | VAT 7.5% → 10% | New rate; listed |
| `removed` | product archived or deleted | Line dropped; listed |
| `stock` | only 2 left (wanted 3) | Warning only; selling into negative stock works as it does today |

The client applies them through the normal cart and catalog path, so totals come from the same engine as every other sale. If the register's catalog cache is older than the change, it pulls the catalog first, the same mechanism as the tax-rate "stale total" fix.

### 4.6 Real-time count across registers

- `ws.ts` gains a **store channel**: a register connects with `?channel=store&device=…&token=…` (same device-token check as today).
- After every hold, resume, discard or expiry the server publishes `{type: 'parked:changed', count}`.
- Fallback when the socket is down: `GET /count` every 30 s and on window focus. The badge never needs more than that.

### 4.7 Offline (register can't reach the Main Register)

- **Hold offline:** the sale goes into a new IndexedDB table `parkedLocal` (Dexie v3) with its `clientId`. The drawer shows it in an **"On this register"** section, marked *not shared yet*.
- **Resume offline:** only local held sales can be resumed (shared ones need the claim). Shared ones show greyed out: *"Reconnect to resume"*.
- **Reconnect:** the existing sync loop uploads `parkedLocal` rows (`offline: true`, original `heldAt`) and deletes each after a 2xx. They then appear on every register.
- **Browser/cloud registers:** the same, with IndexedDB in the browser.

### 4.8 Frontend

| Piece | Path | Notes |
|---|---|---|
| `HoldSaleDialog` | `features/pos/HoldSaleDialog.tsx` | Note field, Enter to save |
| `ParkedSalesDrawer` | `features/pos/ParkedSalesDrawer.tsx` | The brief's `ParkedSalesModal`. A right-side drawer (keeps the product grid visible) with list, search, expand, Resume and Discard (with override), plus an Expired filter for managers |
| `useParkedSales()` | `hooks/useParkedSales.ts` | React Query list and count, store-channel subscription, local rows merged in, `hold()`, `resume()`, `discard()` |
| Cart store | `store/cart.ts` | `snapshot()` → `ParkedLine[]` + customer + approvals; `load(parked, priceChanges)`. Keeps the persisted cart behaviour (survives reload and idle lock). |
| Action bar | `features/pos/CartPanel.tsx` | **Hold** button beside Void; **Held · 3** button with badge |
| Shortcuts | `features/pos/PosTerminal.tsx` | **F6** hold, **F7** held list. **Kiosk guard update:** F6 and F7 are currently blocked in kiosk mode and move to the allow-list. |
| Change notice | `features/pos/ResumeChanges.tsx` | Dismissible panel above the cart lines |
| Offline table | `lib/db.ts` (v3), `lib/sync.ts` | `parkedLocal` + upload step |

---

## 5. Interaction with existing features

| Feature | Consideration |
|---|---|
| **Idle logout** | Unchanged: the active cart stays on the register through an idle lock. An optional later setting could auto-hold on idle lock (open question 4). |
| **Customer display** | Hold → welcome screen; resume → cart. No customer data from other held sales is ever shown. |
| **Tax classes** | Lines snapshot the class name and rate; resume re-resolves from the current class (§4.5) |
| **Loyalty** | The customer is attached on resume; points are only earned when the sale completes |
| **Manager overrides** | Carried and re-issued (§4.3). Discard uses `CLEAR_CART`. |
| **Stock** | Holding **doesn't reserve** stock (open question 1). Resume warns if stock is now short. |
| **Kiosk mode** | Works unchanged; F6 and F7 allowed |
| **Payments (future)** | Hold is disabled while a payment is in progress, so a held sale never has a pending terminal payment |
| **Reports** | A "Held sales" line: held / resumed / discarded / expired today, plus value abandoned (discarded + expired totals) |
| **Updater (future)** | Held sales live on the host database, so they survive an app update. Local offline holds live in the register's IndexedDB, which updates don't touch. |

---

## 6. Permissions & audit

| Action | Sales Agent | Manager / Admin |
|---|---|---|
| Hold, view, resume (anyone's) | ✓ | ✓ |
| Discard | Manager PIN (`CLEAR_CART`) | ✓ |
| View expired or discarded | — | ✓ (`audit:read`) |

Audit entries: `parked.hold`, `parked.resume`, `parked.discard` (with reason and approver), `parked.expire` and `override.carried`.

---

## 7. Security & integrity

- **Totals** are server-computed when held, and the sale itself is re-priced at payment as always. A held total is informational only.
- **Double resume** is impossible: one conditional update; the loser gets 409.
- **Approvals** can't be minted: re-issue only covers override-log rows that the original cashier legitimately held, that were APPROVED and unconsumed, and that are listed on that held sale.
- **Limits:** 200 lines per held sale, 100 open per store, notes 80 characters (plain text, rendered escaped).
- **Paired registers only** in host mode (existing `requireDevice`), including the store WebSocket channel.

---

## 8. Settings

Admin → Store & loyalty:

| Setting | Default |
|---|---|
| Held sales expire after (hours) | 24 |
| Remind after (minutes) | 30 (amber tint in the list) |

---

## 9. Deliverables → paths

| Brief deliverable | Path |
|---|---|
| Prisma `ParkedSale` model | `backend/prisma/schema.prisma` + `backend/prisma/migrations/<ts>_parked_sales/` |
| Backend routes | `backend/src/routes/parkedSales.ts`, `backend/src/services/parkedSales.ts`, `services/overrides.ts` (`reissueOverride`), `ws.ts` (store channel), `app.ts` (mount) |
| Shared types and validation | `shared/src/parked.ts` (types, zod schema, change detection), `shared/src/contracts.ts` (DTOs), `shared/src/domain.ts` (`sales:park`, settings) |
| `ParkedSalesModal.tsx` | `frontend/src/features/pos/ParkedSalesDrawer.tsx` (+ `HoldSaleDialog.tsx`, `ResumeChanges.tsx`) |
| Hold/Resume buttons | `frontend/src/features/pos/CartPanel.tsx`, `PosTerminal.tsx`, `store/cart.ts`, `hooks/useParkedSales.ts` |
| Offline | `frontend/src/lib/db.ts`, `frontend/src/lib/sync.ts` |

---

## 10. Testing

**Unit (vitest, shared):** snapshot ↔ cart round trip; totals equal `priceCart`; change detection (price, tax, removed, stock).

**API script:**
- hold → list → count
- resume → 409 on a second resume
- idempotent `clientId`
- totals recomputed (tampered client total ignored)
- approvals: an over-limit discount held by agent A, resumed by agent B 10 minutes later, still passes payment, and a token can't be reused
- discard needs `CLEAR_CART` for agents
- expiry
- an archived product is reported as `removed`
- the 100-open limit

**Headless UI:**
- hold with a note (F6, Enter)
- badge updates on a second browser tab within 1 s (WebSocket) and within 30 s with the socket blocked
- resume with a non-empty cart offers the swap
- the change notice after a price edit
- the customer display clears on hold and refills on resume
- an agent discarding needs a PIN
- kiosk: F6/F7 work

**Desktop LAN:**
- hold on R2, resume on R1
- R2 offline: hold locally, "not shared yet", reconnect → visible on R1
- both registers press Resume together → exactly one wins

---

## 11. Milestones

| # | Scope | Estimate | Done when |
|---|---|---|---|
| P1 | Schema + migration, shared types/validation, service and routes, approval carry-over, housekeeping, API tests | 1.5 days | API script passes, including race and approval transfer |
| P2 | Hold dialog, held drawer, badge, shortcuts (+ kiosk allow-list), swap on resume, change notice, display handling | 1.5 days | A cashier holds and resumes with keyboard only; UI checks pass |
| P3 | Store WebSocket channel + polling fallback; offline holds (Dexie v3) and upload | 1 day | Live badge across registers; offline hold appears after reconnect |
| P4 | Discard with override, expiry setting, Expired filter, reports line, audit, docs | 1 day | Full test matrix (§10) signed off on a host + 1 register |

**Total: about 5 working days.**

---

## 12. Open questions

1. **Reserve stock while held?** Default **no** (simpler; the shelf count is what matters at payment). If yes, held quantities are subtracted from "available" and released on discard or expiry.
2. **Expiry:** 24 hours (default), or "at closing time" each day?
3. **Agents discarding their own held sale:** require a manager PIN (default, matching "void open transaction"), or allow it within, say, 10 minutes of holding?
4. **Auto-hold:** should the idle lock or a cashier switching user automatically hold an open cart, so the next cashier starts clean? Default: no, the cart stays on the register as now.
5. **Visibility:** every register sees every held sale (default; the customer may come back to any till), or only the register that held it?
