import type { Prisma } from '@prisma/client';
import {
  can,
  effectiveDiscountBps,
  pointsEarned,
  pointsToCents,
  priceCart,
  summarizeTenders,
  type CreateSaleInput,
  type OverrideAction,
  type SaleDTO,
  type SessionUser,
} from '@sync-retail/shared';
import { prisma, type Tx } from '../lib/db';
import { badRequest, conflict, HttpError, notFound, overrideRequired } from '../lib/http';
import { verifyOverride } from './tokens';
import { consumeOverride } from './overrides';
import { getSettings } from './settings';
import { audit } from './audit';

export const saleInclude = {
  cashier: { select: { id: true, name: true } },
  customer: { select: { id: true, name: true, pointsBalance: true } },
  items: true,
  payments: true,
} satisfies Prisma.SaleInclude;

type SaleWithRelations = Prisma.SaleGetPayload<{ include: typeof saleInclude }>;

export function toSaleDTO(s: SaleWithRelations): SaleDTO {
  return {
    id: s.id,
    receiptNo: s.receiptNo,
    clientId: s.clientId,
    status: s.status,
    cashier: s.cashier,
    customer: s.customer,
    subtotalCents: s.subtotalCents,
    discountCents: s.discountCents,
    taxCents: s.taxCents,
    totalCents: s.totalCents,
    refundedCents: s.refundedCents,
    pointsEarned: s.pointsEarned,
    pointsRedeemed: s.pointsRedeemed,
    offline: s.offline,
    voidReason: s.voidReason,
    createdAt: s.createdAt.toISOString(),
    items: s.items.map((i) => ({
      id: i.id,
      productId: i.productId,
      sku: i.sku,
      name: i.name,
      unitPriceCents: i.unitPriceCents,
      quantity: i.quantity,
      returnedQty: i.returnedQty,
      discountType: i.discountType,
      discountValue: i.discountValue,
      discountCents: i.discountCents,
      taxRateBps: i.taxRateBps,
      taxClassId: i.taxClassId,
      taxClassName: i.taxClassName,
      taxCents: i.taxCents,
      totalCents: i.totalCents,
    })),
    payments: s.payments.map((p) => ({
      id: p.id,
      method: p.method,
      amountCents: p.amountCents,
      tenderedCents: p.tenderedCents,
      changeCents: p.changeCents,
      pointsUsed: p.pointsUsed,
      reference: p.reference,
    })),
  };
}

async function uniqueReceiptNo(tx: Tx, wanted: string): Promise<string> {
  let candidate = wanted;
  for (let i = 1; await tx.sale.findUnique({ where: { receiptNo: candidate }, select: { id: true } }); i++) {
    candidate = `${wanted}-${i}`;
  }
  return candidate;
}

/**
 * Creates a completed sale. Prices and tax always come from the database —
 * the terminal only supplies product ids, quantities, discounts and tenders.
 * Idempotent on `clientId` so offline terminals can safely retry.
 */
export async function createSale(input: CreateSaleInput, user: SessionUser, opts: { offline?: boolean } = {}): Promise<SaleDTO> {
  const existing = await prisma.sale.findUnique({ where: { clientId: input.clientId }, include: saleInclude });
  if (existing) return toSaleDTO(existing);

  if (!input.lines.length) throw badRequest('A sale needs at least one item');
  const settings = await getSettings();

  const productIds = [...new Set(input.lines.map((l) => l.productId))];
  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    include: { category: { select: { name: true } }, taxClass: { select: { id: true, name: true, rateBps: true } } },
  });
  const byId = new Map(products.map((p) => [p.id, p]));
  for (const id of productIds) {
    const p = byId.get(id);
    if (!p) throw badRequest(`Unknown product ${id}`);
    if (!p.active && !opts.offline) throw badRequest(`${p.name} is no longer for sale`);
  }

  const pricingLines = input.lines.map((l) => {
    const p = byId.get(l.productId)!;
    if (!Number.isInteger(l.quantity) || l.quantity <= 0) throw badRequest(`Invalid quantity for ${p.name}`);
    // Server authority: the rate always comes from the product's current tax class.
    return { unitPriceCents: p.priceCents, quantity: l.quantity, taxRateBps: p.taxClass.rateBps, discount: l.discount ?? null };
  });
  const totals = priceCart(pricingLines);

  // ── Approvals: sort tokens by action, then require one for big discounts.
  const approvals = (input.approvals ?? []).map((token) => ({ token, claims: verifyOverride(token, opts.offline) }));
  const approvalFor = (action: OverrideAction) => approvals.find((a) => a.claims?.action === action);
  const overDiscount = pricingLines.some((l) => effectiveDiscountBps(l) > settings.agentMaxDiscountBps);
  if (overDiscount && !can(user.role, 'cart:discount-unlimited') && !approvalFor('PRICE_DISCOUNT')) {
    throw overrideRequired('PRICE_DISCOUNT', 'Discount exceeds your limit — manager approval required');
  }

  // ── Tenders
  const customer = input.customerId ? await prisma.customer.findUnique({ where: { id: input.customerId } }) : null;
  if (input.customerId && !customer) throw badRequest('Customer not found');

  let pointsRedeemed = 0;
  for (const t of input.tenders) {
    if (t.amountCents < 0) throw badRequest('Tender amounts must be positive');
    if (t.method === 'LOYALTY') {
      if (!customer) throw badRequest('Attach a customer to pay with loyalty points');
      const pts = t.pointsUsed ?? 0;
      if (pts <= 0 || pts % settings.loyalty.redeemBlockPoints !== 0)
        throw badRequest(`Points must be redeemed in blocks of ${settings.loyalty.redeemBlockPoints}`);
      if (pointsToCents(pts, settings.loyalty) !== t.amountCents) throw badRequest('Loyalty tender value mismatch');
      pointsRedeemed += pts;
    }
    if (t.method === 'CASH' && t.tenderedCents !== undefined && t.tenderedCents < t.amountCents)
      throw badRequest('Cash tendered is less than the amount applied');
  }
  if (customer && pointsRedeemed > customer.pointsBalance) throw conflict('Customer does not have enough points');

  const tenderSummary = summarizeTenders(totals.totalCents, input.tenders);
  if (tenderSummary.paidCents !== totals.totalCents) {
    throw badRequest(`Payments (${tenderSummary.paidCents}) must equal the sale total (${totals.totalCents})`, {
      expectedTotalCents: totals.totalCents,
    });
  }
  const earned = customer ? pointsEarned(tenderSummary.earningCents, settings.loyalty) : 0;
  const createdAt = opts.offline && input.createdAt ? new Date(input.createdAt) : new Date();

  const sale = await prisma.$transaction(async (tx) => {
    const receiptNo = await uniqueReceiptNo(tx, input.receiptNo);
    const created = await tx.sale.create({
      data: {
        receiptNo,
        clientId: input.clientId,
        terminalId: input.terminalId,
        cashierId: user.id,
        customerId: customer?.id,
        subtotalCents: totals.subtotalCents,
        discountCents: totals.discountCents,
        taxCents: totals.taxCents,
        totalCents: totals.totalCents,
        pointsEarned: earned,
        pointsRedeemed,
        offline: !!opts.offline,
        createdAt,
        items: {
          create: input.lines.map((l, i) => {
            const p = byId.get(l.productId)!;
            const t = totals.lines[i];
            return {
              productId: p.id,
              sku: p.sku,
              name: p.name,
              categoryName: p.category?.name ?? null,
              costCents: p.costCents,
              unitPriceCents: p.priceCents,
              quantity: l.quantity,
              discountType: l.discount?.value ? l.discount.type : null,
              discountValue: l.discount?.value ?? 0,
              discountCents: t.discountCents,
              taxRateBps: p.taxClass.rateBps,
              taxClassId: p.taxClass.id,
              taxClassName: p.taxClass.name,
              taxCents: t.taxCents,
              totalCents: t.totalCents,
            };
          }),
        },
        payments: {
          create: input.tenders.map((t) => ({
            method: t.method,
            amountCents: t.amountCents,
            tenderedCents: t.method === 'CASH' ? (t.tenderedCents ?? t.amountCents) : null,
            changeCents: t.method === 'CASH' ? Math.max(0, (t.tenderedCents ?? t.amountCents) - t.amountCents) : 0,
            pointsUsed: t.method === 'LOYALTY' ? (t.pointsUsed ?? 0) : 0,
            reference: t.reference,
          })),
        },
      },
      include: saleInclude,
    });

    for (const l of input.lines) {
      await tx.product.update({ where: { id: l.productId }, data: { stockQty: { decrement: l.quantity } } });
      await tx.stockMovement.create({
        data: { productId: l.productId, type: 'SALE', quantity: -l.quantity, reference: receiptNo, userId: user.id },
      });
    }

    if (customer) {
      const delta = earned - pointsRedeemed;
      const { count } = await tx.customer.updateMany({
        where: { id: customer.id, pointsBalance: { gte: pointsRedeemed } },
        data: { pointsBalance: { increment: delta }, lifetimeSpendCents: { increment: totals.totalCents } },
      });
      if (count === 0) throw conflict('Customer does not have enough points');
      const ledger = [];
      if (pointsRedeemed) ledger.push({ customerId: customer.id, saleId: created.id, points: -pointsRedeemed, reason: `Redeemed on ${receiptNo}` });
      if (earned) ledger.push({ customerId: customer.id, saleId: created.id, points: earned, reason: `Earned on ${receiptNo}` });
      if (ledger.length) await tx.loyaltyTransaction.createMany({ data: ledger });
    }

    // Link approvals to the sale. Only the discount approval is load-bearing;
    // in-cart removals were already logged when the manager entered their PIN.
    let discountApproved = !overDiscount || can(user.role, 'cart:discount-unlimited');
    for (const a of approvals) {
      if (!a.claims) continue;
      try {
        await consumeOverride(a.token, a.claims.action, user.id, { saleId: created.id, ignoreExpiration: opts.offline, tx });
        if (a.claims.action === 'PRICE_DISCOUNT') discountApproved = true;
      } catch {
        /* stale/duplicate non-critical approval — already in the override log */
      }
    }
    if (!discountApproved) throw overrideRequired('PRICE_DISCOUNT', 'Discount approval is invalid or already used');

    return tx.sale.findUniqueOrThrow({ where: { id: created.id }, include: saleInclude });
  });

  return toSaleDTO(sale);
}

export async function voidSale(saleId: string, user: SessionUser, reason: string, overrideId?: string): Promise<SaleDTO> {
  const sale = await prisma.sale.findUnique({ where: { id: saleId }, include: { items: true } });
  if (!sale) throw notFound('Sale');
  if (sale.status !== 'COMPLETED') throw conflict(`Only completed sales without refunds can be voided (status: ${sale.status})`);

  const updated = await prisma.$transaction(async (tx) => {
    for (const item of sale.items) {
      await tx.product.update({ where: { id: item.productId }, data: { stockQty: { increment: item.quantity } } });
      await tx.stockMovement.create({
        data: { productId: item.productId, type: 'VOID', quantity: item.quantity, reference: sale.receiptNo, userId: user.id },
      });
    }
    if (sale.customerId) {
      const c = await tx.customer.findUniqueOrThrow({ where: { id: sale.customerId } });
      const nextBalance = Math.max(0, c.pointsBalance - sale.pointsEarned + sale.pointsRedeemed);
      await tx.customer.update({
        where: { id: c.id },
        data: { pointsBalance: nextBalance, lifetimeSpendCents: { decrement: sale.totalCents } },
      });
      await tx.loyaltyTransaction.create({
        data: { customerId: c.id, saleId: sale.id, points: nextBalance - c.pointsBalance, reason: `Void of ${sale.receiptNo}` },
      });
    }
    await audit({ actorId: user.id, action: 'sale.void', entity: 'Sale', entityId: sale.id, details: { reason, overrideId: overrideId ?? null } }, tx);
    return tx.sale.update({
      where: { id: sale.id },
      data: { status: 'VOIDED', voidedAt: new Date(), voidReason: reason, refundedCents: sale.totalCents },
      include: saleInclude,
    });
  });
  return toSaleDTO(updated);
}

export async function returnItems(
  saleId: string,
  user: SessionUser,
  input: { items: { saleItemId: string; quantity: number; restock: boolean }[]; reason?: string },
  overrideId?: string,
): Promise<SaleDTO> {
  const sale = await prisma.sale.findUnique({ where: { id: saleId }, include: { items: true } });
  if (!sale) throw notFound('Sale');
  if (sale.status === 'VOIDED' || sale.status === 'REFUNDED') throw conflict('This sale has already been fully reversed');

  const updated = await prisma.$transaction(async (tx) => {
    let refundTotal = 0;
    for (const r of input.items) {
      const item = sale.items.find((i) => i.id === r.saleItemId);
      if (!item) throw badRequest('Item does not belong to this sale');
      const remaining = item.quantity - item.returnedQty;
      if (r.quantity <= 0 || r.quantity > remaining) throw badRequest(`Only ${remaining} × ${item.name} can be returned`);
      // Last unit absorbs rounding so refunds never exceed what was paid.
      const amount =
        r.quantity === remaining
          ? item.totalCents - Math.round((item.totalCents * item.returnedQty) / item.quantity)
          : Math.round((item.totalCents * r.quantity) / item.quantity);
      refundTotal += amount;
      await tx.saleItem.update({ where: { id: item.id }, data: { returnedQty: { increment: r.quantity } } });
      await tx.refund.create({
        data: { saleId, saleItemId: item.id, quantity: r.quantity, amountCents: amount, reason: input.reason, restock: r.restock, processedById: user.id, overrideId },
      });
      if (r.restock) {
        await tx.product.update({ where: { id: item.productId }, data: { stockQty: { increment: r.quantity } } });
        await tx.stockMovement.create({
          data: { productId: item.productId, type: 'RETURN', quantity: r.quantity, reference: sale.receiptNo, userId: user.id },
        });
      }
    }

    const refundedCents = sale.refundedCents + refundTotal;
    if (sale.customerId && sale.totalCents > 0) {
      const clawback = Math.floor((sale.pointsEarned * refundTotal) / sale.totalCents);
      const c = await tx.customer.findUniqueOrThrow({ where: { id: sale.customerId } });
      const next = Math.max(0, c.pointsBalance - clawback);
      await tx.customer.update({ where: { id: c.id }, data: { pointsBalance: next, lifetimeSpendCents: { decrement: refundTotal } } });
      if (next !== c.pointsBalance)
        await tx.loyaltyTransaction.create({ data: { customerId: c.id, saleId, points: next - c.pointsBalance, reason: `Return on ${sale.receiptNo}` } });
    }
    await audit({ actorId: user.id, action: 'sale.return', entity: 'Sale', entityId: saleId, details: { ...input, refundTotal, overrideId: overrideId ?? null } }, tx);
    return tx.sale.update({
      where: { id: saleId },
      data: { refundedCents, status: refundedCents >= sale.totalCents ? 'REFUNDED' : 'PARTIALLY_REFUNDED' },
      include: saleInclude,
    });
  });
  return toSaleDTO(updated);
}

/** Post-sale edit: attach the loyalty account the cashier forgot to scan. */
export async function attachCustomer(saleId: string, customerId: string, user: SessionUser, overrideId?: string): Promise<SaleDTO> {
  const sale = await prisma.sale.findUnique({ where: { id: saleId }, include: { payments: true } });
  if (!sale) throw notFound('Sale');
  if (sale.customerId) throw conflict('Sale already has a customer');
  if (sale.status !== 'COMPLETED') throw new HttpError(409, 'Only completed sales can be edited', 'CONFLICT');
  const settings = await getSettings();
  const earningCents = sale.payments.filter((p) => p.method !== 'LOYALTY').reduce((a, p) => a + p.amountCents, 0);
  const earned = pointsEarned(earningCents, settings.loyalty);

  const updated = await prisma.$transaction(async (tx) => {
    await tx.customer.update({
      where: { id: customerId },
      data: { pointsBalance: { increment: earned }, lifetimeSpendCents: { increment: sale.totalCents } },
    });
    if (earned) await tx.loyaltyTransaction.create({ data: { customerId, saleId, points: earned, reason: `Earned on ${sale.receiptNo} (attached later)` } });
    await audit({ actorId: user.id, action: 'sale.attach_customer', entity: 'Sale', entityId: saleId, details: { customerId, overrideId: overrideId ?? null } }, tx);
    return tx.sale.update({ where: { id: saleId }, data: { customerId, pointsEarned: earned }, include: saleInclude });
  });
  return toSaleDTO(updated);
}
