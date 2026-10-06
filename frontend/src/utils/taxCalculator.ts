/**
 * Cart tax calculation for the POS screens.
 *
 * Deliberately has no maths of its own: it re-exports the shared engine that
 * the server also runs on every sale, so the totals a customer sees are
 * exactly the totals they're charged (docs/TAX_PLAN.md §2 T2).
 */
import { priceCart, taxBreakdown, taxMarkers, type CartTotals, type TaxBreakdownLine, type TaxedLine } from '@sync-retail/shared';

export type { TaxBreakdownLine, TaxedLine } from '@sync-retail/shared';
export { formatRate, taxMarkers } from '@sync-retail/shared';

export interface CartTax {
  totals: CartTotals;
  breakdown: TaxBreakdownLine[];
}

/** Item-level tax, subtotal, per-class breakdown and total for a cart. */
export function calculateCartTax(lines: TaxedLine[]): CartTax {
  const totals = priceCart(lines);
  return { totals, breakdown: taxBreakdown(lines, totals) };
}

/** Marker letter per line (A = highest rate …) for receipts. */
export function lineMarkers(lines: TaxedLine[], breakdown: TaxBreakdownLine[]): string[] {
  const m = taxMarkers(breakdown);
  return lines.map((l) => m.get(l.taxClassId ?? `rate:${l.taxRateBps}`) ?? '');
}
