# Sync Retail — Pluggable Payments & Moniepoint Driver

**Implementation plan · v1 · 2026-10-05**

This plan adds a **payment abstraction layer** to Sync Retail:

- The checkout talks to one generic interface.
- Each payment gateway is a driver behind that interface. **Moniepoint** (card and POS transfer on Moniepoint terminals) is the first driver.
- Paystack, Stripe, Monnify or another terminal SDK can be added later without touching checkout code.

**Scope:**
- This work replaces the stubbed "Charge card" step in today's checkout.
- It runs in both deployment modes: cloud/Docker, and the desktop Main Register.
- The LAN-host milestones M3–M6 (Drive backup, restore, signing, TLS) are parked as future work; see `LAN_HOST_PLAN.md`.

---

## 1. Summary

| | |
|---|---|
| **Feasibility** | Yes. Moniepoint publishes a documented push-payment API for its POS terminals (OAuth client credentials, push, status query, signed webhooks). |
| **Shape** | Strategy pattern: `IPaymentProvider` contract → `PaymentFactory` registry → `PaymentService` orchestration → drivers. |
| **Effort** | About 3.5 weeks for one engineer to production-ready Moniepoint (§14). The generic layer plus a fake provider are usable after week 1. |
| **Blocking prerequisites** | From Moniepoint: API credentials, ERP integration enabled, a test terminal on app ≥ 1.7.2, and **sandbox access** (none is publicly documented) — §15. |
| **Spec corrections** | 4 points in the brief differ from Moniepoint's documentation and are handled differently here (§2.2). |

---

## 2. Moniepoint: what the API actually provides

### 2.1 Verified facts (Moniepoint POS developer documentation)

| Topic | Moniepoint behaviour |
|---|---|
| Product | **POS Push Payment.** The POS software pushes an amount to a registered **physical Moniepoint terminal** (by serial number). The customer pays **on the terminal** by card or by "POS transfer". The terminal app must be **≥ 1.7.2** and **ERP integration must be enabled** on the merchant account. |
| Base URL (production) | `https://channel.moniepoint.com` |
| Auth | `POST /v1/auth` with `{ clientId, clientSecret }` → `{ accessToken, tokenType: { value: "bearer" }, expiresIn, scope, jti }`, then `Authorization: Bearer …`. |
| Push payment | `POST /v1/transactions` with `{ terminalSerial, amount, merchantReference, transactionType: "PURCHASE", paymentMethod?: "CARD_PURCHASE" \| "POS_TRANSFER" \| "ANY" }` → **202 Accepted**. A duplicate `merchantReference` → "Transaction exists". |
| Status | `GET /v1/transactions/merchants/{merchantReference}` → `processingStatus` (**PENDING / PROCESSED / CANCELLED**), plus `responseCode`, `responseMessage`, `requestAmount`, `actualAmount`, `actualPaymentMethod`, `transactionReference`, `terminalSerial`, `metaData`. |
| Delivery to terminal | Through a per-terminal message queue (AMQP). Pushes are retained if the queue is briefly down, and the terminal consumes them when back. |
| Webhooks | Headers `moniepoint-webhook-id`, `moniepoint-webhook-timestamp` (epoch ms) and `moniepoint-webhook-signature`. Signature = **Base64(HMAC-SHA256(secret, id + "__" + timestamp + "__" + rawBody))**, with the secret taken from the webhook subscription. Event types include `V1_POS_PURCHASE_TRANSACTION` and `V1_POS_TRANSFER_TRANSACTION`. Payload `data.*` has `transactionStatus`, `responseCode` (e.g. `00`), `amount` in **kobo**, `merchantReference`, `transactionReference`, `terminalSerial`. |

### 2.2 Differences from the brief and how this plan handles them

| Brief says | Documentation says | Plan |
|---|---|---|
| Webhook signature HMAC-**SHA-512** in a `moniepoint-signature` header | HMAC-**SHA256** over `id__timestamp__body`, Base64, header `moniepoint-webhook-signature` | Implement the documented scheme. (HMAC-SHA-512 + `monnify-signature` is **Monnify**'s scheme, Moniepoint's online gateway; it would belong to a separate future `monnify` driver.) |
| `processingStatus` + `queueStatus` dual status | `processingStatus` values are documented; **`queueStatus` values are not published** | Map `processingStatus` + `responseCode` as the source of truth. Store `queueStatus` in metadata and treat it as informational until Moniepoint confirms its values (§15). |
| `cancelTransaction(reference)` | **No cancel endpoint documented.** The customer or cashier cancels on the terminal; status then becomes `CANCELLED`. | The interface keeps `cancelTransaction`, but providers declare `capabilities.remoteCancel`. For Moniepoint, "Cancel" stops waiting locally, tells the cashier to press cancel on the terminal, and **keeps reconciling** in case it was paid anyway (§6.4). |
| Dynamic transfer account shown on the customer display | With POS Push, the **terminal** runs the transfer flow and shows its own instructions | The interface supports provider-supplied **customer instructions** (`displayInstructions`). Moniepoint returns "Follow the instructions on the terminal". A future Monnify/Paystack driver can return a dynamic account number for the customer display (§4.3). |

### 2.3 Consequence for the desktop Main Register

Moniepoint sends webhooks to a **public HTTPS URL**. The desktop Main Register sits on a shop LAN and has none. So:

- **Cloud/Docker mode:** webhook + polling (webhook is the fast path, polling is the safety net).
- **Desktop host mode:** **polling only.** The status endpoint is authoritative, and the push flow is cashier-attended, so polling every few seconds is enough. An optional cloud "webhook relay" can be added later (§16).

---

## 3. Architecture

```
 Cashier (PaymentModal)                       Customer display
   │  "Pay ₦18,500 by Card | Transfer"           ▲  amount · "Tap or insert card on the terminal"
   ▼                                             │  (DisplayMessage 'payment')
 POST /api/payments            GET /api/payments/:id  (poll 1 s) / SSE
   │                                             ▲
   ▼                                             │
 ┌──────────────────────────── PaymentService ───┴──────────────────────────┐
 │ • creates PaymentTransaction (merchantReference, amount, register)      │
 │ • factory.get(storeConfig.activeProvider) → driver                      │
 │ • driver.initializePayment() → PENDING (+ displayInstructions)          │
 │ • Reconciler: poll driver.verifyTransaction() with backoff ┐            │
 │ • Webhook ingest: driver.handleWebhook() ──────────────────┴→ applyStatus│
 │   (compare-and-set state machine, idempotent, audited)                  │
 └──────────────────────────┬──────────────────────────────────────────────┘
                            │ IPaymentProvider
          ┌─────────────────┼──────────────────┬──────────────────┐
     MoniepointProvider   FakeProvider     (future) Paystack   (future) Monnify …
     auth · client · push   dev/tests
     status map · webhook
```

**Principles:**

- **Checkout never imports a driver.** It only sees `PaymentService` results: a generic status plus generic instructions.
- **The server owns the truth.** A card or transfer tender is accepted on a sale only if it references a `PaymentTransaction` in `SUCCESS` for the exact amount, not used by another sale. The terminal UI or a tampered client can't fake "paid".
- **One state machine** for poll and webhook updates. Whichever arrives first wins; duplicates are no-ops.
- **Restart-safe.** Pending transactions are resumed by the reconciler on boot.
- **Card data never touches Sync Retail.** The card is read by the Moniepoint terminal, so our PCI exposure is limited to references and amounts.

---

## 4. Core contracts

### 4.1 `IPaymentProvider` (`backend/src/payments/interfaces/IPaymentProvider.ts`)

```ts
export type PaymentType = 'CARD' | 'TRANSFER';          // CASH/LOYALTY never go through a provider
export type GatewayStatus = 'PENDING' | 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'EXPIRED' | 'UNKNOWN';

export interface ProviderCapabilities {
  paymentTypes: PaymentType[];        // what the provider can collect
  remoteCancel: boolean;              // can we cancel via API?
  webhooks: boolean;                  // does it push status?
  requiresTerminal: boolean;          // needs a device id per register (Moniepoint: yes)
  partialAmounts: boolean;            // can actual amount differ from requested?
}

export interface InitializePaymentPayload {
  merchantReference: string;          // generated by us, unique, idempotency key
  amountMinor: number;                // kobo / cents (Sync Retail already stores minor units)
  currency: string;                   // 'NGN'
  paymentType: PaymentType;
  terminalId?: string;                // e.g. Moniepoint terminalSerial for this register
  customer?: { name?: string; email?: string; phone?: string };
  description?: string;               // e.g. receipt number
}

export interface CustomerInstructions {
  title: string;                      // "Tap, insert or swipe on the terminal"
  lines?: string[];                   // e.g. bank name / account no. / expiry (transfer providers)
  expiresAt?: string;
}

export interface InitializeResult {
  status: GatewayStatus;              // usually PENDING
  gatewayReference?: string;          // provider's own id if issued immediately
  displayInstructions?: CustomerInstructions;
  raw: unknown;                       // stored as metadata (secrets stripped)
}

export interface VerifyResult {
  status: GatewayStatus;
  amountMinor?: number;               // actual collected amount, if reported
  paymentType?: PaymentType;          // actual method used (e.g. card vs transfer under "ANY")
  gatewayReference?: string;
  responseCode?: string;
  message?: string;                   // human readable, for the cashier
  raw: unknown;
}

export interface WebhookInput {
  headers: Record<string, string | undefined>;
  rawBody: Buffer;                    // exact bytes — required for signature checks
}

export interface WebhookResult {
  eventId: string;                    // for de-duplication
  merchantReference?: string;
  update?: VerifyResult;              // undefined = event not relevant (ignored, still 200)
}

export interface IPaymentProvider {
  readonly name: string;              // 'moniepoint'
  readonly capabilities: ProviderCapabilities;
  initializePayment(payload: InitializePaymentPayload): Promise<InitializeResult>;
  verifyTransaction(merchantReference: string): Promise<VerifyResult>;
  cancelTransaction(merchantReference: string): Promise<{ accepted: boolean; message: string }>;
  handleWebhook(input: WebhookInput): Promise<WebhookResult>;   // throws WebhookSignatureError
  testConnection(): Promise<{ ok: boolean; message: string }>;  // used by Admin "Test connection"
}
```

Errors are typed: `ProviderAuthError`, `ProviderUnavailableError` (retryable), `ProviderRejectedError` (not retryable, e.g. "Transaction exists", invalid terminal) and `WebhookSignatureError`. The service decides retry vs fail from the type, never from provider-specific strings.

### 4.2 `PaymentFactory` (`backend/src/payments/PaymentFactory.ts`)

```ts
type DriverCtor = (config: DecryptedGatewayConfig, deps: DriverDeps) => IPaymentProvider;

export class PaymentFactory {
  private drivers = new Map<string, { create: DriverCtor; configSchema: ZodSchema; label: string }>();
  register(name: string, entry: {...}) { ... }          // called once per driver at boot
  available() { ... }                                    // for the Admin provider dropdown
  async forStore(): Promise<IPaymentProvider> { ... }    // active config → cached instance
  invalidate() { ... }                                   // on config change (new keys, env switch)
}
// boot: factory.register('moniepoint', moniepointDriver); factory.register('fake', fakeDriver);
```

- Each driver ships its own **Zod config schema**: Moniepoint needs `clientId`, `clientSecret`, `webhookSecret?`, `environment`, `baseUrl?`. The Admin UI renders a form from it, and the factory validates before saving.
- Instances are cached per config version, so token caches survive between checkouts.

### 4.3 Generic customer-display message

A new `DisplayMessage`:

```
{ type: 'payment', amountMinor, method: 'CARD'|'TRANSFER', status, instructions?: CustomerInstructions }
```

- **Moniepoint** sends "Complete payment on the terminal".
- **A future transfer provider** sends account number / bank / expiry, shown large on the customer display.

---

## 5. Data model (Prisma)

```prisma
enum PaymentTxStatus { PENDING SUCCESS FAILED CANCELLED EXPIRED UNKNOWN }
enum GatewayPaymentType { CARD TRANSFER CASH }

model PaymentTransaction {
  id                String             @id @default(cuid())
  merchantReference String             @unique          // our idempotency key, sent to the provider
  gatewayReference  String?                             // provider's id (Moniepoint transactionReference)
  provider          String                              // 'moniepoint'
  paymentType       GatewayPaymentType
  amountMinor       Int                                 // requested
  actualAmountMinor Int?                                // reported by provider
  currency          String
  status            PaymentTxStatus    @default(PENDING)
  terminalId        String?                             // terminalSerial used
  deviceCode        String?                             // register R1/R2…
  saleId            String?            @unique          // set when a sale consumes it (one-to-one)
  sale              Sale?              @relation(fields: [saleId], references: [id])
  initiatedById     String
  responseCode      String?
  message           String?
  metadata          Json?                               // raw provider payloads (secrets stripped)
  attempts          Int                @default(0)      // status checks made
  nextCheckAt       DateTime?                           // reconciler schedule
  createdAt         DateTime           @default(now())
  updatedAt         DateTime           @updatedAt
  finalizedAt       DateTime?
  events            PaymentEvent[]
  @@index([status, nextCheckAt])
}

/// Every poll result / webhook / manual action, append-only (audit + webhook de-duplication).
model PaymentEvent {
  id            String   @id @default(cuid())
  transactionId String
  transaction   PaymentTransaction @relation(fields: [transactionId], references: [id], onDelete: Cascade)
  source        String   // INIT | POLL | WEBHOOK | CANCEL | MANUAL
  externalId    String?  @unique   // moniepoint-webhook-id → duplicate deliveries ignored
  fromStatus    PaymentTxStatus?
  toStatus      PaymentTxStatus?
  payload       Json?
  createdAt     DateTime @default(now())
}

/// Per-store gateway configuration; secrets encrypted at rest.
model PaymentGatewayConfig {
  id            String   @id @default(cuid())
  provider      String   @unique            // one row per configured provider
  environment   String                      // 'sandbox' | 'production'
  isActive      Boolean  @default(false)    // exactly one active (enforced in service)
  publicConfig  Json                        // non-secret: baseUrl, defaults
  secretsCipher String                      // AES-256-GCM(JSON of secrets)
  secretsKeyId  String                      // which master key version encrypted it
  updatedById   String?
  updatedAt     DateTime @updatedAt
}

/// Which terminal serves which register (Moniepoint push targets a terminal).
model PaymentTerminal {
  id          String  @id @default(cuid())
  provider    String
  terminalId  String                         // terminalSerial
  label       String                         // "Counter 1 terminal"
  deviceCode  String?                        // R1 / R2… (null = shared/unassigned)
  active      Boolean @default(true)
  @@unique([provider, terminalId])
}
```

**Changes to existing models:**

- **Tender method:** `PaymentMethod` gains **`TRANSFER`**. Today it is `CASH | CARD | LOYALTY`, and the existing `Payment` row stays the tender record on the sale.
- **Link to the gateway record:** `Payment` gains `paymentTransactionId String? @unique`. A CARD/TRANSFER tender must point at a SUCCESS `PaymentTransaction` with a matching amount, which the sale service enforces.
- **Secrets encryption:** AES-256-GCM using a master key:
  - **cloud:** `PAYMENT_CONFIG_KEY` env var (32 bytes, base64)
  - **desktop host:** generated into `host.json` beside the other host secrets
  - Key rotation is supported via `secretsKeyId`, and secrets are never returned by any API. The Admin form shows "••••1a2b" plus "replace".

---

## 6. Payment lifecycle

### 6.1 Sequence (Moniepoint card / transfer)

1. **Cashier** presses *Card* or *Transfer* in the payment modal. The client calls `POST /api/payments { amountMinor, paymentType, saleDraftRef }`.
2. **Server:**
   - checks the register has an assigned terminal
   - creates a `PaymentTransaction` (PENDING) with `merchantReference = SR-{storeShort}-{deviceCode}-{yyMMddHHmmss}-{random6}`, which is unique, readable and under 40 chars
   - calls `driver.initializePayment`
3. **Moniepoint driver** POSTs `/v1/transactions` → 202. The status stays `PENDING`, and the driver returns its display instructions.
4. **Reconciler** schedules checks. **Webhook** events (cloud mode) can finalize earlier.
5. **Client** polls `GET /api/payments/:id` every 1 s, which reads the DB only and never calls the provider. It shows live status, and the customer display mirrors it.
6. On **SUCCESS**, the modal adds a tender `{ method: CARD|TRANSFER, amountMinor, paymentTransactionId }`. The sale is completed via the existing `POST /sales`, and the server verifies and links the transaction.
7. On **FAILED / CANCELLED / EXPIRED**, the modal offers *Try again* (new reference) or *another method*.

### 6.2 State machine

```
            initialize ok              verify/webhook: PROCESSED + approved
 (new) ──► PENDING ───────────────────────────────────────────────► SUCCESS ─► consumed by sale
              │  PROCESSED + declined/failed code ─────────────────► FAILED
              │  processingStatus CANCELLED ───────────────────────► CANCELLED
              │  no final status by deadline (default 3 min) ──────► UNKNOWN ─► background sweep (24 h)
              │                                                       │  late result → SUCCESS/FAILED
              └─ init rejected (bad terminal, auth) ─► FAILED          └► still unknown → manual review
```

- **Transitions are compare-and-set:** `UPDATE … WHERE id=? AND status='PENDING'`. A late webhook can't overwrite a final state.
- **One exception:** `UNKNOWN → SUCCESS/FAILED` is allowed. If a SUCCESS arrives after the cashier gave up (customer actually paid), the transaction is flagged **"paid but not on a sale"** for the manager to refund on the terminal or attach to a sale.

### 6.3 Moniepoint status mapping (`drivers/moniepoint/statusMap.ts`)

| `processingStatus` | `responseCode` | → Generic |
|---|---|---|
| `PENDING` | any / none | PENDING |
| `PROCESSED` | `00` (approved) | SUCCESS (check `actualAmount` = requested; mismatch → UNKNOWN + flag) |
| `PROCESSED` | other code | FAILED (keep `responseMessage` for the cashier) |
| `CANCELLED` | — | CANCELLED |
| HTTP 404 on status query just after push | — | PENDING (propagation delay), until 20 s, then FAILED "not delivered to terminal" |

- `queueStatus` (if present) is stored in `metadata.queueStatus` and shown as a hint ("Delivered to terminal" / "Waiting for terminal"). Its exact values must be confirmed with Moniepoint (§15).
- Webhook `data.transactionStatus` (`APPROVED`/`COMPLETED` with `responseCode 00`) maps the same way.
- The mapping table is **data-driven and unit-tested** with recorded payloads.

### 6.4 Cancel semantics

- **If a provider has `remoteCancel`**, cancel calls the API, then verifies.
- **Moniepoint (no remote cancel):**
  1. The UI changes to "Press **Cancel** on the terminal".
  2. The service keeps polling until `CANCELLED`/`PROCESSED`, or the deadline.
  3. If the customer completed payment anyway, it's SUCCESS and the sale proceeds normally.
  4. If the cashier closes the modal while still PENDING, the transaction goes to the background sweep. A late success raises the "paid but not on a sale" alert.

### 6.5 Reconciliation service (`backend/src/payments/reconciler.ts`)

- **Attended polling** while a modal is open: checks at 2 s, then backoff ×1.5 with jitter, capped at 5 s, until the deadline (3 min; configurable).
- **Background sweep** every 60 s for `PENDING`/`UNKNOWN` older than the deadline: backoff 1 min → 5 min → 15 min, for 24 h. Then it marks `UNKNOWN` final and raises a manager task.
- **Network resilience:** timeouts (5 s connect, 10 s total); `ProviderUnavailableError` → retry with backoff; 401 → refresh token once, then retry; circuit breaker after 5 consecutive failures (the UI shows "Payment service unreachable — use another method").
- **Restart-safe:** on boot, the reconciler loads all non-final transactions and continues.
- **Single-flight:** the attended poller and the sweeper never query the same reference at the same time (a per-reference in-memory lock; one process per store).

### 6.6 Webhooks (cloud mode)

`POST /api/payments/webhooks/:provider`. Raw body capture is mounted **before** `express.json()` for this path only.

The handler:

1. Calls `driver.handleWebhook({ headers, rawBody })`. Moniepoint:
   - verifies Base64 HMAC-SHA256 over `id__timestamp__body` with `crypto.timingSafeEqual`
   - rejects timestamps more than **5 min** away from now (replay guard)
2. **De-duplicates** on `PaymentEvent.externalId = moniepoint-webhook-id`.
3. Finds the transaction by `merchantReference`. If the reference is unknown, it records an orphan event and returns 200 (no retry storm).
4. Applies the status via the shared state machine.
5. Responds **200** quickly. Heavy work is done after the response.

Invalid signature → 401 + audit entry. The webhook URL and secret are shown in Admin → Payments for pasting into the Moniepoint dashboard.

---

## 7. Moniepoint driver (`backend/src/payments/drivers/moniepoint/`)

| File | Responsibility |
|---|---|
| `auth.ts` | `TokenManager`:<br>• `POST /v1/auth` with `{ clientId, clientSecret }`<br>• caches `accessToken` until `expiresIn − max(60 s, 10 %)` (refreshes ahead of expiry)<br>• **single-flight**: concurrent checkouts share one refresh<br>• on 401 from any call, invalidate → refresh → retry once<br>• never logs secrets or tokens |
| `client.ts` | Typed HTTP client (`undici`/fetch) with base URL per environment, timeouts, retry policy for 5xx/network errors (not 4xx), request-id logging, error mapping to the typed errors in §4.1. |
| `references.ts` | `merchantReference` builder + validation (charset `[A-Z0-9-]`, ≤ 40 chars). Stable across retries of the same attempt; a new attempt gets a new reference. |
| `push.ts` | Builds `POST /v1/transactions`:<br>• `terminalSerial`<br>• `amount` (minor units — **confirm unit with Moniepoint**, §15)<br>• `merchantReference`<br>• `transactionType: "PURCHASE"`<br>• `paymentMethod`: `CARD_PURCHASE` \| `POS_TRANSFER` from `paymentType`; `ANY` when the cashier picks "Let customer choose"<br>• "Transaction exists" → treated as idempotent success of a previous identical push, followed by a status check |
| `status.ts` | `GET /v1/transactions/merchants/{merchantReference}` → `VerifyResult` via `statusMap.ts`. |
| `statusMap.ts` | Table in §6.3, plus `actualPaymentMethod` → `CARD`/`TRANSFER`. |
| `webhook.ts` | Signature verification (§6.6), payload parsing (`V1_POS_PURCHASE_TRANSACTION`, `V1_POS_TRANSFER_TRANSACTION`), mapping to `WebhookResult`. Other event types are acknowledged and ignored. |
| `config.ts` | Zod schema: `clientId`, `clientSecret`, `webhookSecret?`, `environment`, `baseUrl` (defaults to `https://channel.moniepoint.com`; sandbox URL to be supplied by Moniepoint). |
| `index.ts` | `MoniepointProvider implements IPaymentProvider`. Capabilities: `{ paymentTypes: ['CARD','TRANSFER'], remoteCancel: false, webhooks: true, requiresTerminal: true, partialAmounts: false }`. |

**Also needed:**

- **`FakeProvider`** (`drivers/fake/`): deterministic outcomes driven by amount, e.g. ₦…01 → declined, ₦…02 → cancelled, ₦…03 → stays pending. Used for development, end-to-end tests and demo stores. It's enabled automatically when no real provider is configured, labelled "Test payments" in the UI.
- **Moniepoint mock server** (`tests/mocks/moniepoint.ts`): emulates `/v1/auth`, `/v1/transactions` and the status endpoint, with configurable latency and failures, and emits **correctly signed webhooks**. CI exercises the real driver against it.

---

## 8. API (new)

| Method & path | Who | Purpose |
|---|---|---|
| `POST /api/payments` | `sales:create` | Start a card/transfer payment `{ amountMinor, paymentType, saleDraftRef?, customerId? }` → `{ id, merchantReference, status, displayInstructions, capabilities }` |
| `GET /api/payments/:id` | `sales:create` (own register) | Current status (DB read only) — polled by the modal |
| `POST /api/payments/:id/cancel` | `sales:create` | Cancel / stop waiting (§6.4) |
| `POST /api/payments/:id/recheck` | `sales:create` | Force an immediate provider check ("Check again" button) |
| `GET /api/payments?status=UNKNOWN&unattached=1` | Manager+ | Exceptions list: paid-but-not-on-a-sale, unknown outcomes |
| `POST /api/payments/:id/resolve` | Manager+ (override) | Attach to a sale, or mark as refunded on the terminal; audited |
| `POST /api/payments/webhooks/:provider` | Provider (signed) | Webhook ingest (cloud mode) |
| `GET/PUT /api/payment-config` | Admin | Provider list, active provider, non-secret config; secrets write-only |
| `POST /api/payment-config/test` | Admin | `driver.testConnection()`, e.g. obtains a Moniepoint token |
| `GET/POST/PATCH/DELETE /api/payment-terminals` | Admin | Terminal serials, assigned to registers |

**Sale integration:** `POST /api/sales` accepts tenders `{ method: 'CARD'|'TRANSFER', amountCents, paymentTransactionId }`. Within the sale transaction it checks:

- the referenced transaction is `SUCCESS`
- its amount matches the tender
- it isn't already linked to a sale

It then links the transaction (`saleId`). Offline sales cannot include card/transfer tenders; the modal disables those methods while offline.

---

## 9. Frontend

### 9.1 `frontend/src/components/checkout/PaymentModal.tsx`

This replaces the stubbed "Charge card" step inside `CheckoutModal`. Split tender keeps working: a card or transfer payment covers part or all of the remaining amount.

| State | Cashier sees | Customer display |
|---|---|---|
| Choose | **Card** · **Transfer** · *Let customer choose* (only methods the active provider supports; disabled with a reason when offline or no terminal is assigned) | Amount due |
| Sending | "Sending ₦18,500.00 to terminal *Counter 1*…" | "Get ready to pay ₦18,500.00" |
| Waiting | Live timer · "Complete payment on the terminal" · queue hint (Delivered / Waiting for terminal) · **Check again** · **Cancel** | Provider instructions (Moniepoint: "Tap, insert or swipe on the terminal") |
| Cancelling | "Press Cancel on the terminal" (no remote cancel) — still watching for a late result | "Payment cancelled" when final |
| Success | ✓ "Approved · Card · ref …" → tender added automatically; actual method shown if the customer chose | "Payment received" |
| Failed / Cancelled | Reason from the provider (e.g. "Insufficient funds") · **Try again** · **Other method** | "Payment not completed" |
| Unknown | "We couldn't confirm this payment yet. Don't charge again — check the terminal." Options: **Keep waiting**, or **Ask a manager** (resolve with an override) | "Please wait" |

- **Polling:** `GET /api/payments/:id` every 1 s while open, which reads the DB only. An SSE/WebSocket push can replace it later without changing the modal.
- **Keyboard:** Esc only closes when the state is final (no accidental abandon). Enter → primary action.
- **Accessibility:** status changes are announced via `aria-live`, and colour is never the only signal.
- **Guard:** retrying never reuses a reference that might still succeed. "Try again" requires the previous attempt to be final, or confirmation that it was cancelled on the terminal.

### 9.2 Admin → Payments (new tab)

- **Provider:** choose the active provider. A form is rendered from the driver's config schema, with Sandbox / Production toggles and **Test connection**.
- **Webhook (cloud mode):** the URL to paste into Moniepoint, plus the secret field. In desktop host mode it shows "Not needed — this register checks payment status directly".
- **Terminals:** add serials, give them labels, and assign them to registers (R1, R2, …). Each register shows its terminal in the checkout header.
- **Exceptions:** a list of unknown and paid-but-unattached transactions with resolve actions, and a badge in the nav when any exist.

---

## 10. Module layout (requested deliverables → paths)

```
backend/src/payments/
  interfaces/IPaymentProvider.ts      ← deliverable 1 (contract + typed errors)
  PaymentFactory.ts                   ← deliverable 2 (registry, config validation, instance cache)
  PaymentService.ts                   orchestration: create, initialize, applyStatus, consume for sale
  reconciler.ts                       attended poll + background sweep + boot resume
  stateMachine.ts                     compare-and-set transitions + PaymentEvent writes
  secrets.ts                          AES-256-GCM encrypt/decrypt for gateway config
  routes.ts                           §8 endpoints (+ raw-body webhook route)
  drivers/
    moniepoint/                       ← deliverable 3
      auth.ts  client.ts  references.ts  push.ts  status.ts  statusMap.ts  webhook.ts  config.ts  index.ts
    fake/index.ts
  __tests__/                          contract tests (every driver), state machine, reconciler, moniepoint
frontend/src/components/checkout/
  PaymentModal.tsx                    ← deliverable 4
  usePaymentStatus.ts                 polling hook
frontend/src/features/admin/PaymentsTab.tsx
shared/src/payments.ts                PaymentType, GatewayStatus, DTOs, DisplayMessage 'payment'
```

---

## 11. Adding another gateway later (e.g. Paystack)

1. Create `drivers/paystack/` implementing `IPaymentProvider`, with its config schema and capabilities (e.g. `requiresTerminal: false`, `remoteCancel: true`, transfer instructions with a dynamic account).
2. Register it: `factory.register('paystack', paystackDriver)`.
3. Make it pass the **shared driver contract test suite** against its mock.
4. Done. Checkout, PaymentModal, the state machine, reconciliation, admin config, auditing and reports need **no changes**, because the UI adapts to `capabilities` and `displayInstructions`.

---

## 12. Security

| Risk | Control |
|---|---|
| Leaked gateway credentials | Encrypted at rest (AES-256-GCM, master key outside the DB); write-only API; never logged; admin-only; changes audited |
| Faked "paid" from a modified client | Sales accept card/transfer tenders only for server-verified `SUCCESS` transactions, matched on amount and single use |
| Double charge | One reference per attempt; "Try again" blocked while the previous attempt could still succeed; `Transaction exists` handled idempotently |
| Forged/replayed webhooks | HMAC-SHA256 verification with timing-safe compare, 5-min timestamp window, de-duplication by webhook id |
| Card data exposure | None handled: card capture happens on the Moniepoint terminal |
| Lost results | Restart-safe reconciler; 24 h background sweep; exceptions queue with manager resolution |
| Staff abuse (manual "paid") | Manual resolution needs a manager override (existing override flow) and is audited |

---

## 13. Testing strategy

| Layer | What |
|---|---|
| Unit | Status mapping (recorded payloads); state machine (every transition, compare-and-set races); token manager (expiry, pre-refresh, single-flight, 401 retry); reference builder; webhook signature (valid, tampered body, wrong secret, old timestamp, duplicate id) |
| Contract | One suite every driver must pass (Fake, Moniepoint-against-mock, future drivers) |
| Integration | Moniepoint driver ↔ mock server with injected latency (5–15 s), 5xx bursts, 401 mid-flow, duplicate and out-of-order webhooks, and a process restart while pending |
| End-to-end (UI) | Checkout through the PaymentModal with FakeProvider: approve, decline, cancel, timeout → unknown → late success → exceptions queue; split tender cash + card; offline register (card/transfer disabled) |
| Pilot | Moniepoint sandbox (if provided) or a production test terminal with small amounts: card approve and decline, POS transfer, terminal cancel, network drop during payment, webhook in cloud mode, desktop host polling only |

---

## 14. Milestones

| # | Milestone | Scope | Estimate | Done when |
|---|---|---|---|---|
| P1 | Payment core | Prisma models + migration, contracts, factory, service, state machine, secrets, routes, FakeProvider, sale-tender verification | 1 wk | A sale can be paid by "card" through FakeProvider end to end; tampered tenders are rejected |
| P2 | Checkout UI | PaymentModal (all states), customer-display payment messages, usePaymentStatus, offline rules | 0.5 wk | All Fake scenarios (approve, decline, cancel, timeout, late success) work in the UI |
| P3 | Moniepoint driver | auth/client/push/status/statusMap/webhook, mock server, contract and integration tests | 1 wk | Driver passes the contract suite and failure-injection tests against the mock |
| P4 | Admin & operations | Payments tab (provider config, test connection, terminals ↔ registers), exceptions queue + manager resolution, reports by method | 0.5 wk | An admin can configure Moniepoint, assign terminals and resolve exceptions without a developer |
| P5 | Pilot | Sandbox or test terminal; fix mapping details (response codes, `queueStatus`, amount units) | 0.5 wk + Moniepoint lead time | Real card and transfer payments complete and reconcile in both deployment modes |

**Total: about 3.5 weeks.** P1–P2 don't depend on Moniepoint and can start immediately.

---

## 15. Prerequisites and open questions for Moniepoint

**Needed before P5:**

1. **API credentials** (`clientId`, `clientSecret`) from the Moniepoint business dashboard, and **ERP integration enabled** on the account.
2. **At least one test terminal** on app ≥ 1.7.2, with its **serial number**.
3. **Sandbox environment:** base URL and whether test terminals exist. Not in the public documentation.
4. **Webhook subscription** (cloud mode) and its secret.

**Questions to confirm:**

1. **`amount` unit for the push request:** naira or kobo? Webhooks report kobo; the push spec says only "Integer".
2. **`queueStatus`:** its field name, its values, and where it appears (status response vs webhook).
3. **Response codes:** the full list for `PROCESSED` outcomes (approved, declined, reversed).
4. **Cancellation:** is there any API to withdraw a push before the customer acts? Is `processingStatus` set to `CANCELLED` when the cashier cancels on the terminal?
5. **Webhooks:** retry policy, recommended timestamp tolerance, and source IP ranges (optional allow-listing).
6. **Rate limits:** on the auth and status endpoints.
7. **Refunds and reversals:** is there an API, or is it done only on the terminal? This affects returns (today's refund flow records a refund but doesn't move money).
8. **Status query lookback:** how long can a `merchantReference` still be queried (for the 24 h sweep)?

---

## 16. Out of scope now / later

- **Webhook relay for desktop host mode** (a small cloud function that forwards signed events to the store over an outbound connection). Polling covers v1.
- **Automated refunds through the gateway:** depends on Moniepoint's answer to question 7.
- **Online/pay-by-link flows and a Monnify driver** (dynamic accounts, HMAC-SHA-512 `monnify-signature`), plus Paystack and Stripe: the interface supports them, but they aren't built now.
- **Settlement reconciliation reports** against Moniepoint settlement files.

---

### Sources

- [Moniepoint — Push Payment Request (API Reference)](https://teamapt.atlassian.net/wiki/spaces/EI/pages/1039826999/Push+Payment+Request+API+Reference)
- [Moniepoint — Webhooks](https://teamapt.atlassian.net/wiki/spaces/EI/pages/1492648078/Webhooks)
- [Moniepoint POS Apps Developer Support (Confluence space)](https://teamapt.atlassian.net/wiki/spaces/EI/pages/1072889880/Moniepoint+Communication+Library+Documentation)
