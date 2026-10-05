# Sync Retail — Tax Classes & Item-Level Tax Engine

**Implementation plan · v1 · 2026-10-05**

Admins and managers define **tax classes** (e.g. *VAT 7.5%*, *Zero-rated*, *Exempt*, *Luxury 15%*) and attach one to each product. The checkout calculates tax per item in real time, and shows the customer a clear breakdown by class. Bulk imports resolve tax classes by name or rate.

---

## 1. Summary

| | |
|---|---|
| **Starting point** | Tax already exists, but as a free-typed rate on each product (`Product.taxRateBps`, integer basis points). There is no shared definition: changing VAT from 7.5% means editing every product. |
| **Change** | Products point to a `TaxClass`. The rate lives in one place, and changing it updates every product in that class. |
| **Engine** | The existing shared pricing engine (`shared/src/pricing.ts`) already computes per-item tax, and the server re-runs it on every sale. It is **extended, not replaced**: same maths on till and server, plus a per-class breakdown. |
| **Effort** | About 1.5 weeks for one engineer (§12). |
| **Risk** | Low. The main care point is migrating existing products onto classes (§5) and keeping offline registers in sync when a rate changes (§6.3). |

---

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| T1 | **Store rates as integer basis points** (`rateBps`: 7.5% = 750). The API and UI speak *percentage* (7.5). | The whole money stack is integer (kobo/cents + bps); this avoids float drift. Up to two decimals of percentage are supported (12.25% = 1225). The brief's `percentage Decimal` is exposed as a computed API field. |
| T2 | **One calculation engine in `shared/`.** `frontend/src/utils/taxCalculator.ts` is a thin re-export. | If the till and server calculated separately, displayed totals could differ from charged totals. Today's single engine prevents that; keep it. |
| T3 | **Tax per line, on the line's final price after line discounts; rounded per line (half-up, to the kobo); totals are sums of lines.** | Matches the brief's formula. Every printed line adds up exactly to the printed total. |
| T4 | **Prices are tax-exclusive by default**, with a store setting `pricesIncludeTax` planned but **off in v1** (see open question Q1). | The brief's formula is exclusive. Many Nigerian retailers price VAT-inclusive, so the engine is designed to support both (§4.2). |
| T5 | **Sales snapshot the class** (`taxClassId`, `taxClassName`, `taxRateBps` on each sale line). | Editing or deleting a class never changes past receipts, reports or refunds. |
| T6 | **No `storeId` column.** | Each Sync Retail database is one store (cloud install or desktop Main Register). If multi-tenant hosting arrives later, `TaxClass` joins the other tables in gaining a tenant key. |
| T7 | **Delete only when unused; otherwise reassign first.** Archive is allowed only for classes with zero products. | Keeps the brief's "no deletion while products are assigned" rule. The UI makes moving products to another class one step, so this is never a dead end. |

---

## 3. Data model (Prisma)

```prisma
model TaxClass {
  id         String    @id @default(cuid())
  name       String    @unique                 // "VAT 7.5%", "Zero-rated", "Exempt"
  code       String?   @unique                 // optional short code for imports/reports: "VAT", "ZR"
  rateBps    Int                               // 750 = 7.5 %; 0 allowed; max 10000
  isDefault  Boolean   @default(false)         // exactly one true (enforced in service + partial unique index)
  archivedAt DateTime?                         // archived = hidden from pickers; only when no products use it
  sortOrder  Int       @default(0)
  createdAt  DateTime  @default(now())
  updatedAt  DateTime  @updatedAt
  products   Product[]
}

model Product {
  // …existing fields…
  taxClassId String                            // required after migration
  taxClass   TaxClass  @relation(fields: [taxClassId], references: [id], onDelete: Restrict)
  // taxRateBps removed (rate now comes from the class) — see §5 migration
}

model SaleItem {
  // …existing fields… (taxRateBps already snapshotted)
  taxClassId   String?                         // snapshot (nullable for historical rows)
  taxClassName String?                         // snapshot, e.g. "VAT 7.5%"
}
```

- **Database guarantees:**
  - `onDelete: Restrict` blocks deleting a class that still has products, even if the API check were bypassed.
  - A partial unique index allows only one default class: `CREATE UNIQUE INDEX taxclass_one_default ON "TaxClass"("isDefault") WHERE "isDefault"`.
- **History:** rate changes are written to `AuditLog` (`tax_class.update`, from → to, products affected). A separate history table isn't needed, because sales snapshot their rates.

---

## 4. Calculation engine

### 4.1 Where it lives

| File | Role |
|---|---|
| `shared/src/pricing.ts` | Existing `priceLine` / `priceCart`, extended (below). Used by the till, offline sales, the server and reports. |
| `shared/src/tax.ts` *(new)* | Class helpers: `rateFor(product, classes)`, percent ↔ bps, label formatting, `summarizeTax(lines)` breakdown. |
| `frontend/src/utils/taxCalculator.ts` | The brief's deliverable: re-exports the shared functions with UI-friendly names (`calculateCartTax`, `formatTaxBreakdown`). No maths of its own. |

### 4.2 Formulas (integer kobo, rates in bps)

For each cart line:

```
gross    = unitPrice × quantity
discount = line discount (percent or amount), capped at gross
final    = gross − discount                                    // "Item Final Price"
tax      = round_half_up(final × rateBps / 10 000)             // exclusive (v1)
total    = final + tax
```

The inclusive mode (planned, §2 T4) uses the same structure: `tax = final − round_half_up(final × 10 000 / (10 000 + rateBps))` and `total = final`.

Cart:

```
subtotal       = Σ gross
discounts      = Σ discount
taxBreakdown[] = group lines by taxClassId → { classId, name, rateBps, taxableAmount: Σ final, tax: Σ tax }
taxTotal       = Σ tax                    (= Σ taxBreakdown.tax)
totalDue       = subtotal − discounts + taxTotal
```

- **Zero-rated vs exempt:** both have 0%, but they stay separate classes so they report separately (VAT returns distinguish them).
- **Loyalty points:** these are a *payment method* in Sync Retail, not a discount, so they don't reduce taxable amounts (unchanged behaviour). This is noted in the admin help text.

### 4.3 Worked example (VAT 7.5% and Zero-rated)

| Item | Qty × price | Line discount | Final | Class | Tax |
|---|---|---|---|---|---|
| Rice 50 kg | 1 × ₦85,000.00 | — | ₦85,000.00 | VAT 7.5% | ₦6,375.00 |
| Bread | 3 × ₦1,250.00 | 10% (₦375.00) | ₦3,375.00 | VAT 7.5% | ₦253.13 |
| Infant formula | 2 × ₦9,999.00 | — | ₦19,998.00 | Zero-rated | ₦0.00 |

```
Subtotal                     ₦108,748.00
Discounts                       −₦375.00
VAT 7.5% on ₦88,375.00         ₦6,628.13
Zero-rated on ₦19,998.00           ₦0.00
Total due                    ₦115,001.13
```

The 2-line VAT sum ₦6,375.00 + ₦253.13 = ₦6,628.13 rounds per line. (₦3,375 × 7.5% = ₦253.125 → ₦253.13.)

This example becomes a unit-test fixture.

### 4.4 Server authority

When a sale is posted, the server resolves each product's **current** class and rate from the database and recalculates (as today). If the till's total differs, for example because a rate changed mid-sale, the sale is rejected with the correct total. The till refreshes its catalog and shows "Tax rates changed — totals updated", and the cashier re-confirms. This already happens for prices; it now covers rates too.

---

## 5. Migration of existing data

1. Create `TaxClass` from the **distinct rates already on products**:
   - **0 bps → "Zero-rated"** (code `ZR`)
   - **750 → "VAT 7.5%"** (code `VAT`)
   - any other rate *r* → "Tax *r*%"
2. **Default class:**
   - stores with currency NGN: "VAT 7.5%" (created if missing)
   - otherwise: the class covering the most products
3. Set every product's `taxClassId` from its current rate. Every product maps exactly, so **no prices or totals change**.
4. Snapshot backfill: existing `SaleItem` rows keep `taxRateBps`. `taxClassName` is filled where the rate matches a class (cosmetic; reports group by class or rate).
5. Drop `Product.taxRateBps` in a **second migration** after the code no longer reads it, so the release can be rolled back safely.

**Verification:** a migration test on a copy of a real store asserts that every product's resolved rate equals its old `taxRateBps`, and that re-pricing sample carts gives identical totals.

---

## 6. Backend

### 6.1 API (`backend/src/routes/tax.ts`)

| Method & path | Who | Behaviour |
|---|---|---|
| `GET /api/tax-classes` | any signed-in staff | Active classes with `percentage` (= rateBps/100) and `productCount`; `?includeArchived=1` |
| `POST /api/tax-classes` | Admin, Manager (`tax:manage`) | `{ name, code?, percentage, isDefault? }`. Percentage 0–100, at most 2 decimals; name unique (case-insensitive) |
| `PATCH /api/tax-classes/:id` | `tax:manage` | Rename / change rate / set default. A rate change returns `productsAffected` and is audited |
| `POST /api/tax-classes/:id/reassign` | `tax:manage` | `{ toClassId }`: moves all products in one transaction (the way to empty a class) |
| `DELETE /api/tax-classes/:id` | `tax:manage` | **409** if products are assigned (message includes the count) or if it's the default; otherwise deleted. Archived-only rule as in T7 |
| `POST /api/tax-classes/:id/archive` | `tax:manage` | Allowed only with 0 products; archived classes can't be chosen for products |

Rules enforced in the service and covered by tests:
- exactly one default
- you can't archive or delete the default
- only one change of default at a time (transaction plus partial unique index)

### 6.2 Products

- `POST /api/products`: `taxClassId` is optional and defaults to the default class.
- `PATCH /api/products/:id` accepts `taxClassId` (archived classes are refused).
- `ProductDTO` adds `taxClassId` and `taxClassName`. It **keeps `taxRateBps` as a resolved value**, so the till's existing code and offline caches keep working.
- Sales snapshot `taxClassId`, `taxClassName` and `taxRateBps` per line.

### 6.3 Keeping registers in sync when a rate changes

Registers pull the catalog as a **delta** (products with `updatedAt > lastSync`). Changing a class rate doesn't touch product rows, so on its own the change would **never reach registers**. Fix:

- `/api/sync/catalog` also returns **all tax classes** on every pull (a handful of rows).
- The till resolves each product's rate from its class at calculation time, not from a stored rate.
- So a rate change applies on the next sync, within 30 s, including on paired registers and offline caches.

### 6.4 Bulk import (`backend/src/services/importer.ts` + `shared/src/importer.ts`)

- **Import field:** the old *Tax rate* field becomes **Tax class**, with aliases including `tax`, `tax class`, `vat`, `tax rate` and `tax %`. Existing spreadsheets keep mapping automatically.
- **Resolving each cell, in order:**
  1. **blank** → default class
  2. **class name or code**, case-insensitive (`VAT 7.5%`, `vat`, `Zero-rated`, `ZR`)
  3. **a percentage** (`7.5%`, `7.5`, `0.075`) → the single class with that rate. If several classes share the rate (e.g. Zero-rated and Exempt at 0%), the value is **ambiguous**.
  4. otherwise **unresolved**
- **New "Tax classes" review step** in the import wizard, between *Map columns* and *Validate*. It appears only when unresolved or ambiguous values exist. For each distinct value (e.g. "VAT 7.5 percent" in 212 rows), the admin chooses one of:
  - **map to an existing class**
  - **create a new class** (name + rate pre-filled when a number can be read from the text)
  - **use the default class**

  The choices are sent with the commit as a `taxMapping` object.
- **Server checks:** validation re-resolves on the server; unresolved values without a mapping → row error "Unknown tax class". Classes created in the review step are created inside the import transaction.
- **Updating existing products:** a blank tax cell **keeps** the product's current class. Only new products get the default.

---

## 7. Frontend

### 7.1 Admin → Tax (`frontend/src/features/admin/TaxManagement.tsx`)

Visible to Admin and Manager, as a new tab next to *Store & loyalty*.

- **Table:** name · code · rate · products · default badge · actions.
- **Create / edit** in a side panel:
  - name, optional code, percentage with live preview ("₦10,000.00 → tax ₦750.00")
  - "Make default" toggle
  - an edit that changes the rate shows a **confirmation**: "This changes the price customers pay on **312 products** from the next sale. Past receipts are not affected."
- **Delete:** disabled while products are assigned, with a **Move products…** action (pick a target class → reassign → then delete). The default class can't be deleted; another must be made default first.
- **Archive:** for unused classes that should stay visible in reports.
- **Empty state:** offers starter classes for the store's currency (NGN: *VAT 7.5%*, *Zero-rated*, *Exempt*).

### 7.2 Products

- **Product editor:** the free-typed *Tax rate %* becomes a **Tax class** picker (shows "VAT 7.5%"), preselected to the default class on new products.
- **Inventory table:** the *Tax* column shows the class name and rate.
- **Bulk action** on the inventory list: "Set tax class" for selected products.

### 7.3 Checkout & receipts

- **Cart and checkout modal:**
  - *Subtotal*
  - *Discounts*
  - one line per tax class ("VAT 7.5% · ₦6,628.13", with the taxable amount on hover/tap)
  - *Total due*
  - With a single class in the cart, it collapses to one tax line.
- **Customer display:** the same per-class lines as the till.
- **Receipt:**
  - a tax summary block (class, taxable amount, tax) — what VAT invoices typically need
  - each line shows a small class marker (e.g. **A** = VAT 7.5%, **Z** = Zero-rated), with a legend under the summary

### 7.4 Reports

A new **Tax summary** panel and CSV/PDF section shows tax by class for the selected period: taxable amount, tax collected, refunds adjusted. It uses the sale-line snapshots, so historical rates are reported correctly.

---

## 8. Permissions

- New permission `tax:manage` → Admin, Manager (matches the brief).
- Sales Agents can see class names and rates (needed at the till) but can't change classes or product assignments.
- Every create, rate change, default change, reassign, archive and delete is written to the audit log with before/after values.

---

## 9. Deliverables → paths

| Brief | Path in this codebase |
|---|---|
| 1. Prisma schema with `TaxClass` + relation | `backend/prisma/schema.prisma` + migrations `*_tax_classes` (add + backfill) and `*_drop_product_tax_rate` (later) |
| 2. Tax CRUD routes | `backend/src/routes/tax.ts` (+ `backend/src/services/taxClasses.ts` for rules) |
| 3. Admin UI | `frontend/src/features/admin/TaxManagement.tsx` |
| 4. Cart tax calculator | `shared/src/tax.ts` + extended `shared/src/pricing.ts`; `frontend/src/utils/taxCalculator.ts` re-exports them (§2 T2) |
| Importer mapping | `shared/src/importer.ts`, `backend/src/services/importer.ts`, `frontend/src/features/inventory/ImportPage.tsx` (review step) |

The codebase keeps components under `features/<area>/` rather than `/frontend/components/admin/`; the module boundaries are the same.

---

## 10. Testing

| Layer | Cases |
|---|---|
| Engine (unit) | §4.3 example exactly; 0% classes; 100% edge; half-up rounding at ₦x.xx5; line discounts (percent and amount) before tax; mixed classes; breakdown sums equal total tax; inclusive-mode formulas behind a flag |
| Migration | Every product's resolved rate equals the old rate; sample carts re-priced identically; one default; NGN store gets "VAT 7.5%" |
| API | Create/edit validation (0–100, 2 decimals, unique name); one default; delete blocked with products (409 + count) and for the default; reassign moves all products atomically; archive rules; managers allowed, agents refused; audit entries written |
| Import | Name, code and percentage resolution; ambiguous 0% values; blank → default (new) / unchanged (existing); review-step mappings incl. "create class"; server rejects unmapped values |
| Sync | A rate change reaches an offline-cached register on the next pull without touching products |
| End-to-end | Create class → assign to product → ring up → per-class lines on till, customer display and receipt → change rate → open register shows new tax within one sync → server rejects a stale-total sale and the till recovers |

---

## 11. Out of scope (v1)

- Compound or stacked taxes on one item (e.g. VAT + consumption tax).
- Tax-exempt customers and exemption certificates.
- Per-location or jurisdiction rates.
- E-invoicing / FIRS integration.
- Automatic VAT return filing.

The data model (classes + per-line snapshots) doesn't block any of these.

---

## 12. Milestones

| # | Scope | Estimate | Done when |
|---|---|---|---|
| X1 | Schema, migration + backfill, tax service and routes, product API changes, sale snapshots, sync of classes | 3 days | Existing store migrates with identical totals; API rules pass tests |
| X2 | Engine extension (breakdown, class resolution), till/checkout/customer display/receipt breakdown | 2 days | §4.3 example renders identically on till, display and receipt; server agrees |
| X3 | Admin → Tax UI, product editor picker, bulk "Set tax class" | 2 days | A manager can create, edit, set default, reassign and delete without developer help |
| X4 | Import resolution + review step | 1.5 days | Mixed spreadsheet (names, codes, percentages, blanks, unknowns) imports correctly with the review step |
| X5 | Tax summary report, final end-to-end, docs | 1 day | Report totals match the sum of receipts for a period |

**Total: about 1.5 weeks** (9.5 working days).

---

## 13. Open questions

1. **Tax-inclusive pricing:** do your stores price shelf items **including** VAT? If yes, `pricesIncludeTax` becomes v1 scope (+1 day; the engine already accounts for it).
2. **Starter classes:** for NGN, are *VAT 7.5%*, *Zero-rated* and *Exempt* the right defaults? Is a separate *Luxury 15%* expected?
3. **Agents and the per-class breakdown:** should Sales Agents see it at the till, or only the customer-facing total? (Default: everyone sees it.)
4. **Receipt format:** do you need a specific VAT invoice layout? For example a TIN on the receipt (would add a `taxId` store setting), or "VAT inclusive" wording.
