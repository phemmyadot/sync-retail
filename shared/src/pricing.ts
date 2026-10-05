/**
 * Money math. All amounts are integer cents; rates are integer basis points
 * (1 bp = 0.01%, so 825 = 8.25%). The server re-runs these exact functions on
 * every sale, so the client display and the stored totals can never drift.
 */
import type { LoyaltyConfig, PaymentMethod } from './domain';

export type DiscountType = 'PERCENT' | 'AMOUNT';

export interface LineDiscount {
  type: DiscountType;
  /** PERCENT → basis points; AMOUNT → cents off the whole line. */
  value: number;
}

export interface PricingLine {
  unitPriceCents: number;
  quantity: number;
  taxRateBps: number;
  discount?: LineDiscount | null;
}

export interface LineTotals {
  grossCents: number;
  discountCents: number;
  netCents: number;
  taxCents: number;
  totalCents: number;
}

export interface CartTotals {
  lines: LineTotals[];
  itemCount: number;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function priceLine(line: PricingLine): LineTotals {
  const grossCents = line.unitPriceCents * line.quantity;
  let discountCents = 0;
  if (line.discount && line.discount.value > 0) {
    discountCents =
      line.discount.type === 'PERCENT'
        ? Math.round((grossCents * clamp(line.discount.value, 0, 10_000)) / 10_000)
        : Math.round(line.discount.value);
  }
  discountCents = clamp(discountCents, 0, grossCents);
  const netCents = grossCents - discountCents;
  const taxCents = Math.round((netCents * line.taxRateBps) / 10_000);
  return { grossCents, discountCents, netCents, taxCents, totalCents: netCents + taxCents };
}

export function priceCart(lines: PricingLine[]): CartTotals {
  const priced = lines.map(priceLine);
  const sum = (k: keyof LineTotals) => priced.reduce((acc, l) => acc + l[k], 0);
  return {
    lines: priced,
    itemCount: lines.reduce((acc, l) => acc + l.quantity, 0),
    subtotalCents: sum('grossCents'),
    discountCents: sum('discountCents'),
    taxCents: sum('taxCents'),
    totalCents: sum('totalCents'),
  };
}

/** Effective discount of a line in basis points (used for the agent cap). */
export function effectiveDiscountBps(line: PricingLine): number {
  const t = priceLine(line);
  if (t.grossCents === 0) return 0;
  return Math.round((t.discountCents / t.grossCents) * 10_000);
}

// ─── Loyalty ────────────────────────────────────────────────────────────────

export function pointsToCents(points: number, cfg: LoyaltyConfig): number {
  if (cfg.redeemBlockPoints <= 0) return 0;
  return Math.floor(points / cfg.redeemBlockPoints) * cfg.redeemBlockValueCents;
}

/** Largest whole-block redemption that fits both the balance and amount due. */
export function maxRedeemablePoints(balance: number, dueCents: number, cfg: LoyaltyConfig): number {
  if (cfg.redeemBlockPoints <= 0 || cfg.redeemBlockValueCents <= 0) return 0;
  const byBalance = Math.floor(balance / cfg.redeemBlockPoints);
  const byDue = Math.floor(dueCents / cfg.redeemBlockValueCents);
  return Math.max(0, Math.min(byBalance, byDue)) * cfg.redeemBlockPoints;
}

export function pointsEarned(eligibleCents: number, cfg: LoyaltyConfig): number {
  return Math.max(0, Math.floor(eligibleCents / 100) * cfg.pointsPerDollar);
}

// ─── Tenders ────────────────────────────────────────────────────────────────

export interface TenderInput {
  method: PaymentMethod;
  /** Amount applied to the sale (cents). For LOYALTY this is derived from points. */
  amountCents: number;
  /** Cash handed over, if more than amountCents. */
  tenderedCents?: number;
  pointsUsed?: number;
  reference?: string;
}

export interface TenderSummary {
  paidCents: number;
  remainingCents: number;
  changeCents: number;
  loyaltyCents: number;
  /** Cents paid with real money: the base for earning points. */
  earningCents: number;
}

export function summarizeTenders(totalCents: number, tenders: TenderInput[]): TenderSummary {
  const paidCents = tenders.reduce((a, t) => a + t.amountCents, 0);
  const cashTendered = tenders
    .filter((t) => t.method === 'CASH')
    .reduce((a, t) => a + Math.max(t.tenderedCents ?? t.amountCents, t.amountCents), 0);
  const cashApplied = tenders.filter((t) => t.method === 'CASH').reduce((a, t) => a + t.amountCents, 0);
  const loyaltyCents = tenders.filter((t) => t.method === 'LOYALTY').reduce((a, t) => a + t.amountCents, 0);
  return {
    paidCents,
    remainingCents: Math.max(0, totalCents - paidCents),
    changeCents: Math.max(0, cashTendered - cashApplied),
    loyaltyCents,
    earningCents: Math.max(0, Math.min(paidCents, totalCents) - loyaltyCents),
  };
}

// ─── Formatting ─────────────────────────────────────────────────────────────

// `narrowSymbol` shows ₦ / ₹ / ₵ … instead of the ISO code when the locale
// has no symbol of its own for that currency (e.g. NGN under en-US).
const moneyFormatters = new Map<string, Intl.NumberFormat>();
function moneyFormatter(currency: string, locale: string): Intl.NumberFormat {
  const key = `${locale}|${currency}`;
  let f = moneyFormatters.get(key);
  if (!f) {
    try {
      f = new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'narrowSymbol' });
    } catch {
      f = new Intl.NumberFormat(locale, { style: 'currency', currency }); // older runtimes
    }
    moneyFormatters.set(key, f);
  }
  return f;
}

export function formatMoney(cents: number, currency = 'USD', locale = 'en-US'): string {
  return moneyFormatter(currency, locale).format(cents / 100);
}

/**
 * Splits a price for typographic display: "₦1,250,000.50" →
 * { symbol: "₦", whole: "1,250,000", fraction: ".50", symbolFirst: true }.
 */
export function moneyParts(cents: number, currency = 'USD', locale = 'en-US') {
  const parts = moneyFormatter(currency, locale).formatToParts(cents / 100);
  const symbolIdx = parts.findIndex((p) => p.type === 'currency');
  const firstNumIdx = parts.findIndex((p) => p.type === 'integer');
  let whole = '';
  let fraction = '';
  for (const p of parts) {
    if (p.type === 'minusSign' || p.type === 'integer' || p.type === 'group') whole += p.value;
    else if (p.type === 'decimal' || p.type === 'fraction') fraction += p.value;
  }
  return {
    symbol: symbolIdx >= 0 ? parts[symbolIdx].value : currency,
    whole,
    fraction,
    symbolFirst: symbolIdx < firstNumIdx,
  };
}

/** Just the symbol, e.g. "₦" for NGN — for input adornments and labels. */
export function currencySymbol(currency = 'USD', locale = 'en-US'): string {
  return moneyFormatter(currency, locale).formatToParts(0).find((p) => p.type === 'currency')?.value ?? currency;
}

export function formatBps(bps: number): string {
  const pct = bps / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2)}%`;
}

/** "12.50", "$1,299", "€4,5" → cents. Returns null for blanks/garbage. */
export function parseMoneyToCents(input: unknown): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? Math.round(input * 100) : null;
  const raw = String(input).trim();
  if (!raw) return null;
  const negative = /^\(.*\)$/.test(raw) || raw.includes('-');
  let s = raw.replace(/[^\d.,]/g, '');
  // "1.234,56" (EU) vs "1,234.56" (US): the last separator is the decimal one.
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  if (!s || s === '.') return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round((negative ? -n : n) * 100);
}
