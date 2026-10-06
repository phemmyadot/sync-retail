import {
  priceCart,
  reconcileParkedLines,
  type CurrentProduct,
  type HoldSaleInput,
  type ParkedLine,
  type ParkedSaleDTO,
  type ResumeResult,
} from '@sync-retail/shared';
import { api, ApiError, NetworkError } from './api';
import { getDeviceToken, getTerminalId, wsUrl } from './config';
import { localDb, type LocalParkedSale } from './db';
import { useAuth } from '@/store/auth';
import { useCart } from '@/store/cart';

/** Held ("parked") sales on the register — see docs/done/PARKED_SALES_PLAN.md. */

const changed = () => window.dispatchEvent(new CustomEvent('sr:parked'));

/** Current catalog view from the register's offline cache (for offline resume). */
async function localCurrent(ids: string[]): Promise<Map<string, CurrentProduct>> {
  const [products, classes] = await Promise.all([localDb.products.bulkGet(ids), localDb.taxClasses.toArray()]);
  const byId = new Map(classes.map((c) => [c.id, c]));
  const out = new Map<string, CurrentProduct>();
  for (const p of products) {
    if (!p || !p.active) continue;
    const c = byId.get(p.taxClassId);
    out.set(p.id, {
      name: p.name,
      priceCents: p.priceCents,
      taxRateBps: c?.rateBps ?? p.taxRateBps,
      taxClassId: c?.id ?? p.taxClassId,
      taxClassName: c?.name ?? p.taxClassName,
      stockQty: p.stockQty,
    });
  }
  return out;
}

/**
 * Holds the current cart. Online: stored on the Main Register for every
 * register to see. Offline: kept on this register and shared on reconnect.
 */
export async function holdCart(reference: string): Promise<{ offline: boolean; sale?: ParkedSaleDTO }> {
  const cart = useCart.getState();
  const { user, token } = useAuth.getState();
  const input: HoldSaleInput = {
    clientId: crypto.randomUUID(),
    reference: reference.trim() || null,
    terminalId: getTerminalId(),
    customerId: cart.customer?.id ?? null,
    lines: cart.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, discount: l.discount })),
    approvals: cart.approvals,
  };
  try {
    const sale = await api<ParkedSaleDTO>('/parked-sales', { method: 'POST', body: input });
    cart.clear();
    changed();
    return { offline: false, sale };
  } catch (err) {
    if (!(err instanceof NetworkError)) throw err;
  }
  const current = await localCurrent(cart.lines.map((l) => l.productId));
  const lines: ParkedLine[] = cart.lines.map((l) => {
    const p = current.get(l.productId);
    return {
      productId: l.productId,
      sku: l.sku,
      name: l.name,
      quantity: l.quantity,
      unitPriceCents: l.unitPriceCents,
      taxRateBps: p?.taxRateBps ?? l.taxRateBps,
      taxClassId: p?.taxClassId ?? null,
      taxClassName: p?.taxClassName ?? null,
      discount: l.discount,
    };
  });
  const totals = priceCart(lines);
  const createdAt = new Date().toISOString();
  await localDb.parkedLocal.put({
    clientId: input.clientId,
    input: { ...input, offline: true, heldAt: createdAt },
    token,
    lines,
    customer: cart.customer,
    approvals: cart.approvals,
    cashierName: user?.name ?? '',
    totalCents: totals.totalCents,
    itemCount: totals.itemCount,
    createdAt,
  });
  cart.clear();
  changed();
  return { offline: true };
}

/** Claims a shared held sale (atomic on the server) and loads it into the cart. */
export async function resumeShared(id: string): Promise<ResumeResult> {
  const r = await api<ResumeResult>(`/parked-sales/${id}/resume`, { method: 'POST', body: { terminalId: getTerminalId() } });
  useCart.getState().load(r.lines, r.customer, r.approvals);
  changed();
  // Prices or tax rates moved while it was held: bring this register's
  // catalog up to date now, so grid and cart tax match what the server charges.
  if (r.changes.some((c) => c.kind === 'price' || c.kind === 'tax' || c.kind === 'removed')) {
    void import('./sync').then((m) => m.pullCatalog());
  }
  return r;
}

/** Resumes a sale held on this register while offline (never shared yet). */
export async function resumeLocal(clientId: string) {
  const row = await localDb.parkedLocal.get(clientId);
  if (!row) throw new Error('This held sale is no longer on this register');
  const current = await localCurrent(row.lines.map((l) => l.productId));
  const r = reconcileParkedLines(row.lines, (pid) => current.get(pid));
  await localDb.parkedLocal.delete(clientId);
  useCart.getState().load(r.lines, row.customer, row.approvals);
  changed();
  return r;
}

export async function discardShared(id: string, reason: string, overrideToken: string | null) {
  await api(`/parked-sales/${id}/discard`, { method: 'POST', body: { reason }, overrideToken });
  changed();
}

export async function discardLocal(clientId: string) {
  await localDb.parkedLocal.delete(clientId);
  changed();
}

export const localParked = () => localDb.parkedLocal.orderBy('createdAt').reverse().toArray();

let flushing = false;

/** Shares sales held offline with the Main Register (idempotent on clientId). */
export async function flushParked(): Promise<number> {
  if (flushing || !useAuth.getState().token) return 0;
  const rows = await localDb.parkedLocal.toArray();
  if (!rows.length) return 0;
  flushing = true;
  let shared = 0;
  try {
    for (const row of rows) {
      try {
        await api('/parked-sales', { method: 'POST', body: row.input, token: row.token ?? undefined });
        await localDb.parkedLocal.delete(row.clientId);
        shared++;
      } catch (err) {
        if (err instanceof NetworkError) break;
        // The cashier's session expired → attribute to whoever is signed in now.
        if (err instanceof ApiError && err.status === 401 && row.token) {
          await localDb.parkedLocal.put({ ...row, token: null });
          continue;
        }
        await localDb.parkedLocal.put({ ...row, error: err instanceof Error ? err.message : String(err) } satisfies LocalParkedSale);
      }
    }
  } finally {
    flushing = false;
    if (shared) changed();
  }
  return shared;
}

/**
 * Live store events (held-sales count). Reconnects with backoff; the caller
 * also polls, so a dropped socket only delays the badge.
 */
export function subscribeStore(onEvent: (e: { type: string; count?: number }) => void): () => void {
  let ws: WebSocket | null = null;
  let stopped = false;
  let retry = 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const connect = () => {
    const token = useAuth.getState().token;
    if (stopped || !token) return;
    const device = getDeviceToken();
    ws = new WebSocket(wsUrl(`/ws?channel=store&token=${encodeURIComponent(token)}${device ? `&device=${encodeURIComponent(device)}` : ''}`));
    ws.onopen = () => (retry = 1000);
    ws.onmessage = (m) => {
      try {
        onEvent(JSON.parse(String(m.data)));
      } catch {
        /* ignore malformed */
      }
    };
    ws.onclose = () => {
      if (stopped) return;
      timer = setTimeout(connect, retry);
      retry = Math.min(retry * 2, 30_000);
    };
  };
  connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    ws?.close();
  };
}
