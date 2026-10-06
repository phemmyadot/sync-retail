import type { Prisma } from '@prisma/client';
import {
  can,
  priceCart,
  reconcileParkedLines,
  PARKED_MAX_OPEN,
  type CurrentProduct,
  type HoldSaleInput,
  type ParkedLine,
  type ParkedSaleDTO,
  type ParkedSaleStatus,
  type ResumeResult,
  type Role,
} from '@sync-retail/shared';
import { prisma } from '../lib/db';
import { badRequest, conflict, HttpError, notFound, overrideRequired } from '../lib/http';
import { toCustomerDTO } from '../routes/customers';
import { publishStore } from '../ws';
import { audit } from './audit';
import { consumeOverride } from './overrides';
import { getSettings } from './settings';
import { signOverride, verifyOverride } from './tokens';

interface Actor {
  id: string;
  name: string;
  role: Role;
}

const include = {
  parkedBy: { select: { id: true, name: true } },
  resumedBy: { select: { id: true, name: true } },
  customer: { select: { id: true, name: true } },
} as const;
type Row = Prisma.ParkedSaleGetPayload<{ include: typeof include }>;

export const toParkedDTO = (r: Row): ParkedSaleDTO => ({
  id: r.id,
  clientId: r.clientId,
  status: r.status as ParkedSaleStatus,
  reference: r.reference,
  terminalId: r.terminalId,
  parkedBy: r.parkedBy,
  customer: r.customer,
  lines: r.lines as unknown as ParkedLine[],
  itemCount: r.itemCount,
  subtotalCents: r.subtotalCents,
  discountCents: r.discountCents,
  taxCents: r.taxCents,
  totalCents: r.totalCents,
  approvalCount: r.approvalIds.length,
  heldOffline: r.heldOffline,
  createdAt: r.createdAt.toISOString(),
  resumedBy: r.resumedBy,
  resumedAt: r.resumedAt?.toISOString() ?? null,
  resumedTerminal: r.resumedTerminal,
  closedReason: r.closedReason,
});

/** Current catalog view of some products (archived or missing → undefined). */
async function currentProducts(ids: string[]): Promise<Map<string, CurrentProduct>> {
  const rows = await prisma.product.findMany({
    where: { id: { in: [...new Set(ids)] }, active: true },
    include: { taxClass: { select: { id: true, name: true, rateBps: true } } },
  });
  return new Map(
    rows.map((p) => [
      p.id,
      {
        name: p.name,
        priceCents: p.priceCents,
        taxRateBps: p.taxClass.rateBps,
        taxClassId: p.taxClass.id,
        taxClassName: p.taxClass.name,
        stockQty: p.stockQty,
      },
    ]),
  );
}

export const openCount = () => prisma.parkedSale.count({ where: { status: 'PARKED' } });

async function broadcast() {
  publishStore({ type: 'parked:changed', count: await openCount() });
}

let lastHousekeeping = 0;

/** Expires old held sales and purges closed ones after 90 days. Runs at most once a minute. */
export async function housekeeping(force = false) {
  if (!force && Date.now() - lastHousekeeping < 60_000) return;
  lastHousekeeping = Date.now();
  const { parkedSaleExpiryHours } = await getSettings();
  if (parkedSaleExpiryHours > 0) {
    const cutoff = new Date(Date.now() - parkedSaleExpiryHours * 3_600_000);
    const due = await prisma.parkedSale.findMany({ where: { status: 'PARKED', createdAt: { lt: cutoff } }, select: { id: true, totalCents: true } });
    if (due.length) {
      await prisma.parkedSale.updateMany({ where: { id: { in: due.map((d) => d.id) }, status: 'PARKED' }, data: { status: 'EXPIRED', closedReason: 'expired' } });
      for (const d of due) await audit({ action: 'parked.expire', entity: 'ParkedSale', entityId: d.id, details: { totalCents: d.totalCents } });
      await broadcast();
    }
  }
  await prisma.parkedSale.deleteMany({ where: { status: { not: 'PARKED' }, updatedAt: { lt: new Date(Date.now() - 90 * 86_400_000) } } });
}

/** Hold the register's cart. Idempotent on clientId (offline upload retries). */
export async function holdSale(input: HoldSaleInput, user: Actor): Promise<ParkedSaleDTO> {
  const existing = await prisma.parkedSale.findUnique({ where: { clientId: input.clientId }, include });
  if (existing) return toParkedDTO(existing);
  if ((await openCount()) >= PARKED_MAX_OPEN) throw conflict(`There are already ${PARKED_MAX_OPEN} held sales. Resume or discard some first.`);

  // Prices and tax come from the catalog, never from the client.
  const current = await currentProducts(input.lines.map((l) => l.productId));
  const missing = input.lines.filter((l) => !current.has(l.productId));
  if (missing.length) throw badRequest('Some items are no longer sold — remove them before holding the sale', { productIds: missing.map((m) => m.productId) });
  const products = await prisma.product.findMany({ where: { id: { in: input.lines.map((l) => l.productId) } }, select: { id: true, sku: true } });
  const sku = new Map(products.map((p) => [p.id, p.sku]));
  const lines: ParkedLine[] = input.lines.map((l) => {
    const p = current.get(l.productId)!;
    return {
      productId: l.productId,
      sku: sku.get(l.productId)!,
      name: p.name,
      quantity: l.quantity,
      unitPriceCents: p.priceCents,
      taxRateBps: p.taxRateBps,
      taxClassId: p.taxClassId,
      taxClassName: p.taxClassName,
      discount: l.discount ?? null,
    };
  });
  const totals = priceCart(lines);

  if (input.customerId && !(await prisma.customer.findUnique({ where: { id: input.customerId }, select: { id: true } }))) {
    throw badRequest('Customer not found');
  }

  // Remember which manager approvals travel with the sale (the tokens
  // themselves expire in minutes and belong to this cashier).
  const approvalIds: string[] = [];
  for (const token of input.approvals ?? []) {
    const claims = verifyOverride(token, input.offline === true);
    if (!claims || claims.requester !== user.id) continue;
    const log = await prisma.overrideLog.findFirst({ where: { id: claims.sub, outcome: 'APPROVED', consumedAt: null }, select: { id: true } });
    if (log) approvalIds.push(log.id);
  }

  const heldAt = input.heldAt ? new Date(input.heldAt) : new Date();
  const row = await prisma.parkedSale.create({
    data: {
      clientId: input.clientId,
      reference: input.reference?.trim() || null,
      terminalId: input.terminalId,
      parkedById: user.id,
      customerId: input.customerId ?? null,
      lines: lines as unknown as Prisma.InputJsonValue,
      itemCount: totals.itemCount,
      subtotalCents: totals.subtotalCents,
      discountCents: totals.discountCents,
      taxCents: totals.taxCents,
      totalCents: totals.totalCents,
      approvalIds,
      heldOffline: input.offline === true,
      createdAt: heldAt > new Date() ? new Date() : heldAt,
    },
    include,
  });
  await audit({
    actorId: user.id,
    action: 'parked.hold',
    entity: 'ParkedSale',
    entityId: row.id,
    details: { terminalId: row.terminalId, reference: row.reference, totalCents: row.totalCents, items: row.itemCount, approvals: approvalIds.length, offline: row.heldOffline },
  });
  await broadcast();
  return toParkedDTO(row);
}

export async function listParked(status: ParkedSaleStatus) {
  await housekeeping();
  const rows = await prisma.parkedSale.findMany({
    where: { status },
    include,
    orderBy: { createdAt: 'desc' },
    take: status === 'PARKED' ? PARKED_MAX_OPEN : 200,
  });
  return rows.map(toParkedDTO);
}

function alreadyClosed(r: Row) {
  const when = (d: Date | null) => (d ? d.toISOString() : null);
  if (r.status === 'RESUMED') {
    return new HttpError(409, `Already resumed${r.resumedTerminal ? ` on ${r.resumedTerminal}` : ''} by ${r.resumedBy?.name ?? 'someone'}`, 'PARKED_CLOSED', {
      status: r.status,
      by: r.resumedBy?.name ?? null,
      terminalId: r.resumedTerminal,
      at: when(r.resumedAt),
    });
  }
  return new HttpError(409, r.status === 'EXPIRED' ? 'This held sale has expired' : 'This held sale was discarded', 'PARKED_CLOSED', { status: r.status });
}

/**
 * Claims a held sale for this register in one conditional update, so two
 * registers can never both resume it. Returns the lines at current prices,
 * what changed while it was held, and fresh approval tokens for this cashier.
 */
export async function resumeParked(id: string, user: Actor, terminalId: string): Promise<ResumeResult> {
  const { count } = await prisma.parkedSale.updateMany({
    where: { id, status: 'PARKED' },
    data: { status: 'RESUMED', resumedById: user.id, resumedAt: new Date(), resumedTerminal: terminalId },
  });
  const row = await prisma.parkedSale.findUnique({ where: { id }, include });
  if (!row) throw notFound('Held sale');
  if (count === 0) throw alreadyClosed(row);

  const held = row.lines as unknown as ParkedLine[];
  const current = await currentProducts(held.map((l) => l.productId));
  const { lines, changes } = reconcileParkedLines(held, (pid) => current.get(pid));

  const approvals: string[] = [];
  for (const logId of row.approvalIds) {
    const log = await prisma.overrideLog.findFirst({ where: { id: logId, outcome: 'APPROVED', consumedAt: null } });
    if (!log?.approvedById) continue;
    approvals.push(signOverride({ id: log.id, action: log.action, approver: log.approvedById, requester: user.id }).token);
    if (log.requestedById !== user.id) {
      await audit({ actorId: user.id, action: 'override.carried', entity: 'OverrideLog', entityId: log.id, details: { parkedSaleId: id, from: log.requestedById, to: user.id } });
    }
  }

  const customer = row.customerId ? await prisma.customer.findUnique({ where: { id: row.customerId } }) : null;
  await audit({
    actorId: user.id,
    action: 'parked.resume',
    entity: 'ParkedSale',
    entityId: id,
    details: { terminalId, heldBy: row.parkedBy.name, heldOn: row.terminalId, totalCents: row.totalCents, changes: changes.length },
  });
  await broadcast();
  return { sale: toParkedDTO(row), lines, customer: customer && toCustomerDTO(customer), approvals, changes };
}

/** Discard: managers directly; sales agents with a CLEAR_CART manager override. */
export async function discardParked(id: string, user: Actor, reason: string, overrideToken?: string) {
  const row = await prisma.parkedSale.findUnique({ where: { id }, include });
  if (!row) throw notFound('Held sale');
  if (row.status !== 'PARKED') throw alreadyClosed(row);
  let overrideId: string | null = null;
  if (!can(user.role, 'cart:remove')) {
    if (!overrideToken) throw overrideRequired('CLEAR_CART', 'Discarding a held sale needs a manager');
    overrideId = await consumeOverride(overrideToken, 'CLEAR_CART', user.id);
  }
  const { count } = await prisma.parkedSale.updateMany({
    where: { id, status: 'PARKED' },
    data: { status: 'DISCARDED', closedReason: reason, closedById: user.id },
  });
  if (count === 0) throw alreadyClosed((await prisma.parkedSale.findUnique({ where: { id }, include }))!);
  await audit({
    actorId: user.id,
    action: 'parked.discard',
    entity: 'ParkedSale',
    entityId: id,
    details: { reason, overrideId, totalCents: row.totalCents, heldBy: row.parkedBy.name, terminalId: row.terminalId },
  });
  await broadcast();
}
