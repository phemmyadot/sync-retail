/**
 * Tax classes — shared by the till, the server and reports.
 *
 * Rates are integer basis points (750 = 7.5 %). Tax is calculated per line on
 * the line's final price (after its discount) and rounded half-up to the minor
 * unit (see pricing.ts → priceLine); the breakdown below only groups lines, so
 * per-class amounts always add up exactly to the cart's tax total.
 */
import type { CartTotals, LineTotals, PricingLine } from './pricing';

export interface TaxClassDTO {
  id: string;
  name: string;
  code: string | null;
  rateBps: number;
  /** rateBps / 100 — what people type and read (7.5). */
  percentage: number;
  isDefault: boolean;
  archived: boolean;
  sortOrder: number;
  productCount?: number;
}

export interface TaxBreakdownLine {
  taxClassId: string | null;
  name: string;
  rateBps: number;
  /** Σ line final prices (after discounts, before tax). */
  taxableCents: number;
  taxCents: number;
}

/** A pricing line that knows which tax class it belongs to. */
export interface TaxedLine extends PricingLine {
  taxClassId?: string | null;
  taxClassName?: string | null;
}

export const bpsToPercent = (bps: number) => bps / 100;

/** 7.5 → 750. Accepts at most two decimals of a percent. Returns null when invalid. */
export function percentToBps(pct: number | string): number | null {
  const n = typeof pct === 'string' ? Number(pct.replace('%', '').trim()) : pct;
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  const bps = Math.round(n * 100);
  return Math.abs(bps - n * 100) < 1e-6 ? bps : null;
}

/** "VAT 7.5%"-style label used when a class has no name (e.g. legacy rows). */
export const formatRate = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;

/**
 * Groups priced lines by tax class. `totals` must come from priceCart(lines)
 * (same order), so the breakdown reuses the per-line rounded tax.
 */
export function taxBreakdown(lines: TaxedLine[], totals: Pick<CartTotals, 'lines'>): TaxBreakdownLine[] {
  const groups = new Map<string, TaxBreakdownLine>();
  lines.forEach((l, i) => {
    const t: LineTotals = totals.lines[i];
    const key = l.taxClassId ?? `rate:${l.taxRateBps}`;
    const g = groups.get(key) ?? {
      taxClassId: l.taxClassId ?? null,
      name: l.taxClassName ?? `Tax ${formatRate(l.taxRateBps)}`,
      rateBps: l.taxRateBps,
      taxableCents: 0,
      taxCents: 0,
    };
    g.taxableCents += t.netCents;
    g.taxCents += t.taxCents;
    groups.set(key, g);
  });
  // Highest rate first; zero-rated / exempt last.
  return [...groups.values()].sort((a, b) => b.rateBps - a.rateBps || a.name.localeCompare(b.name));
}

/** Short receipt markers: A, B, C… by rate (highest first). */
export function taxMarkers(breakdown: TaxBreakdownLine[]): Map<string, string> {
  const m = new Map<string, string>();
  breakdown.forEach((b, i) => m.set(b.taxClassId ?? `rate:${b.rateBps}`, String.fromCharCode(65 + i)));
  return m;
}

/** Starter classes offered for a store's currency (setup + empty state). */
export function starterTaxClasses(currency: string): { name: string; code: string; rateBps: number; isDefault: boolean }[] {
  if (currency === 'NGN') {
    return [
      { name: 'VAT 7.5%', code: 'VAT', rateBps: 750, isDefault: true },
      { name: 'Zero-rated', code: 'ZR', rateBps: 0, isDefault: false },
      { name: 'Exempt', code: 'EX', rateBps: 0, isDefault: false },
    ];
  }
  return [
    { name: 'Standard', code: 'STD', rateBps: 0, isDefault: true },
    { name: 'Zero-rated', code: 'ZR', rateBps: 0, isDefault: false },
  ];
}

// ─── Import resolution ──────────────────────────────────────────────────────

export type TaxResolution =
  | { kind: 'default' } // blank cell
  | { kind: 'class'; taxClassId: string }
  | { kind: 'ambiguous'; candidates: string[] } // several classes share the rate
  | { kind: 'unresolved' };

/** What an admin chose for an unresolved/ambiguous spreadsheet value. */
export type TaxMappingChoice = { taxClassId: string } | { useDefault: true } | { create: { name: string; rateBps: number } };
export type TaxMapping = Record<string, TaxMappingChoice>;

/** Normalised key for a spreadsheet tax value ("VAT 7.5 %" → "vat 7.5 %"). */
export const taxValueKey = (raw: string) => raw.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Resolves a spreadsheet tax cell: blank → default; class name or code
 * (case-insensitive); a percentage ("7.5%", "7.5", "0.075") → the single class
 * with that rate; anything else is unresolved.
 */
export function resolveTaxValue(raw: unknown, classes: Pick<TaxClassDTO, 'id' | 'name' | 'code' | 'rateBps' | 'archived'>[]): TaxResolution {
  const text = raw === null || raw === undefined ? '' : String(raw).trim();
  if (!text) return { kind: 'default' };
  const key = taxValueKey(text);
  const active = classes.filter((c) => !c.archived);
  const byName = active.find((c) => taxValueKey(c.name) === key || (c.code && taxValueKey(c.code) === key));
  if (byName) return { kind: 'class', taxClassId: byName.id };

  const numeric = text.replace(/[%\s]/g, '');
  if (/^\d+(\.\d+)?$/.test(numeric)) {
    const n = Number(numeric);
    const bps = text.includes('%') || n > 1 ? Math.round(n * 100) : Math.round(n * 10_000);
    const matches = active.filter((c) => c.rateBps === bps);
    if (matches.length === 1) return { kind: 'class', taxClassId: matches[0].id };
    if (matches.length > 1) return { kind: 'ambiguous', candidates: matches.map((m) => m.id) };
  }
  return { kind: 'unresolved' };
}

/** Best guess of a rate written inside free text ("VAT 7.5 percent" → 750), for "create class" defaults. */
export function guessRateBps(raw: string): number | null {
  const m = raw.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return n <= 1 && !raw.includes('%') ? Math.round(n * 10_000) : Math.round(n * 100);
}
