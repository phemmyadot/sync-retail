import type { PaymentMethod, ReportGranularity, ReportSummary } from '@sync-retail/shared';
import { prisma } from '../lib/db';

export interface ReportRange {
  from: Date;
  to: Date;
  granularity: ReportGranularity;
}

export function resolveRange(q: { from?: string; to?: string; granularity?: ReportGranularity; preset?: string }): ReportRange {
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  let from: Date;
  let to = q.to ? new Date(q.to) : now;
  let granularity: ReportGranularity = q.granularity ?? 'day';

  switch (q.preset) {
    case 'today':
      from = startOfDay(now);
      granularity = q.granularity ?? 'day';
      break;
    case 'week':
      from = startOfDay(new Date(now.getTime() - 6 * 864e5));
      break;
    case 'month':
      from = startOfDay(new Date(now.getTime() - 29 * 864e5));
      break;
    case 'quarter':
      from = startOfDay(new Date(now.getTime() - 89 * 864e5));
      granularity = q.granularity ?? 'week';
      break;
    case 'year':
      from = startOfDay(new Date(now.getTime() - 364 * 864e5));
      granularity = q.granularity ?? 'month';
      break;
    default:
      from = q.from ? new Date(q.from) : startOfDay(new Date(now.getTime() - 29 * 864e5));
  }
  if (q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to)) to = new Date(to.getTime() + 864e5 - 1); // inclusive end date
  return { from, to, granularity };
}

const n = (v: unknown) => Number(v ?? 0);

export async function buildReport({ from, to, granularity }: ReportRange): Promise<ReportSummary> {
  const counted = { createdAt: { gte: from, lte: to }, status: { not: 'VOIDED' as const } };

  const [agg, itemAgg, series, top, categories, payments, workers, voids, overrides, margin] = await Promise.all([
    prisma.sale.aggregate({
      where: counted,
      _sum: { totalCents: true, taxCents: true, discountCents: true, refundedCents: true },
      _count: { _all: true },
    }),
    prisma.saleItem.aggregate({ where: { sale: counted }, _sum: { quantity: true, returnedQty: true } }),
    prisma.$queryRaw<{ bucket: Date; total: bigint; tx: bigint }[]>`
      SELECT date_trunc(${granularity}, "createdAt") AS bucket,
             SUM("totalCents" - "refundedCents") AS total,
             COUNT(*) AS tx
      FROM "Sale"
      WHERE "createdAt" BETWEEN ${from} AND ${to} AND status <> 'VOIDED'
      GROUP BY 1 ORDER BY 1`,
    prisma.$queryRaw<{ productId: string; name: string; sku: string; qty: bigint; revenue: bigint }[]>`
      SELECT i."productId", MAX(i.name) AS name, MAX(i.sku) AS sku,
             SUM(i.quantity - i."returnedQty") AS qty,
             SUM(i."totalCents" - i."taxCents") AS revenue
      FROM "SaleItem" i JOIN "Sale" s ON s.id = i."saleId"
      WHERE s."createdAt" BETWEEN ${from} AND ${to} AND s.status <> 'VOIDED'
      GROUP BY i."productId" ORDER BY revenue DESC LIMIT 10`,
    prisma.$queryRaw<{ name: string | null; revenue: bigint; qty: bigint }[]>`
      SELECT COALESCE(i."categoryName", 'Uncategorised') AS name,
             SUM(i."totalCents" - i."taxCents") AS revenue,
             SUM(i.quantity - i."returnedQty") AS qty
      FROM "SaleItem" i JOIN "Sale" s ON s.id = i."saleId"
      WHERE s."createdAt" BETWEEN ${from} AND ${to} AND s.status <> 'VOIDED'
      GROUP BY 1 ORDER BY revenue DESC`,
    prisma.payment.groupBy({
      by: ['method'],
      where: { sale: counted },
      _sum: { amountCents: true },
      _count: { _all: true },
    }),
    prisma.sale.groupBy({
      by: ['cashierId'],
      where: counted,
      _sum: { totalCents: true, refundedCents: true },
      _count: { _all: true },
    }),
    prisma.sale.groupBy({ by: ['cashierId'], where: { createdAt: { gte: from, lte: to }, status: 'VOIDED' }, _count: { _all: true } }),
    prisma.overrideLog.groupBy({ by: ['requestedById'], where: { createdAt: { gte: from, lte: to } }, _count: { _all: true } }),
    prisma.$queryRaw<{ margin: bigint | null }[]>`
      SELECT SUM((i."totalCents" - i."taxCents") - i."costCents" * i.quantity) AS margin
      FROM "SaleItem" i JOIN "Sale" s ON s.id = i."saleId"
      WHERE s."createdAt" BETWEEN ${from} AND ${to} AND s.status <> 'VOIDED'`,
  ]);

  const userIds = [...new Set([...workers.map((w) => w.cashierId), ...voids.map((v) => v.cashierId)])];
  const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } });
  const nameOf = new Map(users.map((u) => [u.id, u.name]));

  const gross = agg._sum.totalCents ?? 0;
  const refunded = agg._sum.refundedCents ?? 0;
  const tx = agg._count._all;

  return {
    range: { from: from.toISOString(), to: to.toISOString(), granularity },
    totals: {
      grossCents: gross,
      netCents: gross - refunded,
      taxCents: agg._sum.taxCents ?? 0,
      discountCents: agg._sum.discountCents ?? 0,
      refundedCents: refunded,
      transactions: tx,
      averageTicketCents: tx ? Math.round((gross - refunded) / tx) : 0,
      itemsSold: (itemAgg._sum.quantity ?? 0) - (itemAgg._sum.returnedQty ?? 0),
      grossMarginCents: n(margin[0]?.margin),
    },
    series: series.map((r) => ({ bucket: r.bucket.toISOString(), totalCents: n(r.total), transactions: n(r.tx) })),
    topProducts: top.map((r) => ({ productId: r.productId, name: r.name, sku: r.sku, quantity: n(r.qty), revenueCents: n(r.revenue) })),
    categories: categories.map((r) => ({ name: r.name ?? 'Uncategorised', revenueCents: n(r.revenue), quantity: n(r.qty) })),
    payments: payments
      .map((p) => ({ method: p.method as PaymentMethod, amountCents: p._sum.amountCents ?? 0, count: p._count._all }))
      .sort((a, b) => b.amountCents - a.amountCents),
    workers: workers
      .map((w) => {
        const revenue = (w._sum.totalCents ?? 0) - (w._sum.refundedCents ?? 0);
        return {
          userId: w.cashierId,
          name: nameOf.get(w.cashierId) ?? 'Unknown',
          transactions: w._count._all,
          revenueCents: revenue,
          averageTicketCents: w._count._all ? Math.round(revenue / w._count._all) : 0,
          voids: voids.find((v) => v.cashierId === w.cashierId)?._count._all ?? 0,
          overrides: overrides.find((o) => o.requestedById === w.cashierId)?._count._all ?? 0,
        };
      })
      .sort((a, b) => b.revenueCents - a.revenueCents),
  };
}

// ─── Export ─────────────────────────────────────────────────────────────────

const money = (c: number) => (c / 100).toFixed(2);
const csvCell = (v: unknown) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n');

export function reportToCsv(r: ReportSummary, currency: string): string {
  const t = r.totals;
  const c = `(${currency})`;
  const sections: unknown[][] = [
    ['Sync Retail report', `${r.range.from.slice(0, 10)} → ${r.range.to.slice(0, 10)}`],
    [],
    ['Metric', `Value ${c}`],
    ['Gross sales', money(t.grossCents)],
    ['Refunds', money(t.refundedCents)],
    ['Net sales', money(t.netCents)],
    ['Tax collected', money(t.taxCents)],
    ['Discounts given', money(t.discountCents)],
    ['Gross margin', money(t.grossMarginCents)],
    ['Transactions', t.transactions],
    ['Average ticket', money(t.averageTicketCents)],
    ['Items sold', t.itemsSold],
    [],
    [`Sales by ${r.range.granularity}`, `Net sales ${c}`, 'Transactions'],
    ...r.series.map((s) => [s.bucket.slice(0, 10), money(s.totalCents), s.transactions]),
    [],
    ['Top products', 'SKU', 'Qty', `Revenue ex tax ${c}`],
    ...r.topProducts.map((p) => [p.name, p.sku, p.quantity, money(p.revenueCents)]),
    [],
    ['Category', 'Qty', `Revenue ex tax ${c}`],
    ...r.categories.map((c) => [c.name, c.quantity, money(c.revenueCents)]),
    [],
    ['Payment method', 'Count', `Amount ${c}`],
    ...r.payments.map((p) => [p.method, p.count, money(p.amountCents)]),
    [],
    ['Staff', 'Transactions', `Net sales ${c}`, `Avg ticket ${c}`, 'Voids', 'Overrides requested'],
    ...r.workers.map((w) => [w.name, w.transactions, money(w.revenueCents), money(w.averageTicketCents), w.voids, w.overrides]),
  ];
  return '﻿' + csv(sections); // BOM so Excel opens UTF-8 correctly
}

export async function salesLedgerCsv(range: ReportRange, currency: string): Promise<string> {
  const c = `(${currency})`;
  const sales = await prisma.sale.findMany({
    where: { createdAt: { gte: range.from, lte: range.to } },
    include: { cashier: { select: { name: true } }, customer: { select: { name: true } }, payments: true },
    orderBy: { createdAt: 'asc' },
  });
  const rows: unknown[][] = [
    ['Receipt', 'Date', 'Status', 'Cashier', 'Customer', `Subtotal ${c}`, `Discount ${c}`, `Tax ${c}`, `Total ${c}`, `Refunded ${c}`, `Payments ${c}`],
    ...sales.map((s) => [
      s.receiptNo,
      s.createdAt.toISOString(),
      s.status,
      s.cashier.name,
      s.customer?.name ?? '',
      money(s.subtotalCents),
      money(s.discountCents),
      money(s.taxCents),
      money(s.totalCents),
      money(s.refundedCents),
      s.payments.map((p) => `${p.method}:${money(p.amountCents)}`).join(' | '),
    ]),
  ];
  return '﻿' + csv(rows);
}

