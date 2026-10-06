import type { LineDiscount } from './pricing';
import type { CustomerDTO } from './contracts';

/** Held ("parked") sales — see docs/done/PARKED_SALES_PLAN.md. */

export const PARKED_MAX_LINES = 200;
export const PARKED_MAX_OPEN = 100;
export const PARKED_REFERENCE_MAX = 80;

export type ParkedSaleStatus = 'PARKED' | 'RESUMED' | 'DISCARDED' | 'EXPIRED';

/** One cart line as held. Same shape as the register's cart line (minus its UI key). */
export interface ParkedLine {
  productId: string;
  sku: string;
  name: string;
  quantity: number;
  /** Price when held; resume re-prices from the current catalog. */
  unitPriceCents: number;
  taxRateBps: number;
  taxClassId: string | null;
  taxClassName: string | null;
  discount: LineDiscount | null;
}

export interface HoldSaleInput {
  /** Set by the register; makes offline upload retries idempotent. */
  clientId: string;
  reference?: string | null;
  terminalId: string;
  customerId?: string | null;
  lines: { productId: string; quantity: number; discount?: LineDiscount | null }[];
  /** Manager-override tokens collected in the cart (carried to whoever resumes). */
  approvals?: string[];
  /** Held while the register was offline: original time, lenient approval expiry. */
  heldAt?: string;
  offline?: boolean;
}

export interface ParkedSaleDTO {
  id: string;
  clientId: string;
  status: ParkedSaleStatus;
  reference: string | null;
  terminalId: string;
  parkedBy: { id: string; name: string };
  customer: { id: string; name: string } | null;
  lines: ParkedLine[];
  itemCount: number;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  approvalCount: number;
  heldOffline: boolean;
  createdAt: string;
  resumedBy: { id: string; name: string } | null;
  resumedAt: string | null;
  resumedTerminal: string | null;
  closedReason: string | null;
}

export type ParkedChangeKind = 'price' | 'tax' | 'removed' | 'stock';

export interface ParkedChange {
  kind: ParkedChangeKind;
  productId: string;
  name: string;
  /** price/tax: old and new values (cents or bps); stock: wanted and available. */
  from?: number;
  to?: number;
}

export interface ResumeResult {
  sale: ParkedSaleDTO;
  /** Lines at current prices and tax rates (removed products dropped). */
  lines: ParkedLine[];
  customer: CustomerDTO | null;
  /** Fresh single-use override tokens, now bound to the cashier who resumed. */
  approvals: string[];
  changes: ParkedChange[];
}

/** What the catalog says about a product now (undefined = gone or archived). */
export interface CurrentProduct {
  name: string;
  priceCents: number;
  taxRateBps: number;
  taxClassId: string | null;
  taxClassName: string | null;
  stockQty: number;
}

/**
 * Compares held lines with the current catalog. Returns the lines to load
 * (current prices, removed products dropped) and a list of what changed.
 */
export function reconcileParkedLines(
  lines: ParkedLine[],
  current: (productId: string) => CurrentProduct | undefined,
): { lines: ParkedLine[]; changes: ParkedChange[] } {
  const out: ParkedLine[] = [];
  const changes: ParkedChange[] = [];
  const wanted = new Map<string, number>();
  for (const l of lines) wanted.set(l.productId, (wanted.get(l.productId) ?? 0) + l.quantity);

  for (const l of lines) {
    const p = current(l.productId);
    if (!p) {
      changes.push({ kind: 'removed', productId: l.productId, name: l.name });
      continue;
    }
    if (p.priceCents !== l.unitPriceCents && !changes.some((c) => c.kind === 'price' && c.productId === l.productId)) {
      changes.push({ kind: 'price', productId: l.productId, name: p.name, from: l.unitPriceCents, to: p.priceCents });
    }
    if (p.taxRateBps !== l.taxRateBps && !changes.some((c) => c.kind === 'tax' && c.productId === l.productId)) {
      changes.push({ kind: 'tax', productId: l.productId, name: p.name, from: l.taxRateBps, to: p.taxRateBps });
    }
    out.push({ ...l, name: p.name, unitPriceCents: p.priceCents, taxRateBps: p.taxRateBps, taxClassId: p.taxClassId, taxClassName: p.taxClassName });
  }
  for (const [productId, qty] of wanted) {
    const p = current(productId);
    if (p && p.stockQty < qty) changes.push({ kind: 'stock', productId, name: p.name, from: qty, to: Math.max(0, p.stockQty) });
  }
  return { lines: out, changes };
}
