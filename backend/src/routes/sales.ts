import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { can, PAYMENT_METHODS } from '@sync-retail/shared';
import { prisma } from '../lib/db';
import { body, notFound, query, pid } from '../lib/http';
import { requirePermission, requireRoleOrOverride } from '../middleware/auth';
import { attachCustomer, createSale, returnItems, saleInclude, toSaleDTO, voidSale } from '../services/sales';

export const salesRouter = Router();

export const createSaleSchema = z.object({
  clientId: z.string().uuid(),
  receiptNo: z.string().min(3).max(40),
  terminalId: z.string().max(40).optional(),
  customerId: z.string().nullable().optional(),
  lines: z
    .array(
      z.object({
        productId: z.string(),
        quantity: z.number().int().positive().max(9999),
        discount: z.object({ type: z.enum(['PERCENT', 'AMOUNT']), value: z.number().int().min(0) }).nullable().optional(),
      }),
    )
    .min(1)
    .max(500),
  tenders: z
    .array(
      z.object({
        method: z.enum(PAYMENT_METHODS),
        amountCents: z.number().int().min(0),
        tenderedCents: z.number().int().min(0).optional(),
        pointsUsed: z.number().int().min(0).optional(),
        reference: z.string().max(60).optional(),
      }),
    )
    .min(1),
  approvals: z.array(z.string()).max(50).optional(),
  createdAt: z.string().datetime().optional(),
});

salesRouter.post('/', requirePermission('sales:create'), async (req, res) => {
  const sale = await createSale(body(req, createSaleSchema), req.user!);
  res.status(201).json(sale);
});

salesRouter.get('/', requirePermission('sales:read'), async (req, res) => {
  const q = query(
    req,
    z.object({
      search: z.string().trim().optional(),
      status: z.enum(['COMPLETED', 'VOIDED', 'PARTIALLY_REFUNDED', 'REFUNDED']).optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      mine: z.coerce.boolean().optional(),
      take: z.coerce.number().int().min(1).max(200).default(50),
      cursor: z.string().optional(),
    }),
  );
  // Agents only see their own sales history.
  const onlyMine = q.mine || !can(req.user!.role, 'reports:read');
  const where: Prisma.SaleWhereInput = {
    ...(onlyMine && { cashierId: req.user!.id }),
    ...(q.status && { status: q.status }),
    ...((q.from || q.to) && { createdAt: { ...(q.from && { gte: new Date(q.from) }), ...(q.to && { lte: new Date(q.to) }) } }),
    ...(q.search && {
      OR: [
        { receiptNo: { contains: q.search, mode: 'insensitive' } },
        { customer: { name: { contains: q.search, mode: 'insensitive' } } },
      ],
    }),
  };
  const rows = await prisma.sale.findMany({
    where,
    include: saleInclude,
    orderBy: { createdAt: 'desc' },
    take: q.take + 1,
    ...(q.cursor && { cursor: { id: q.cursor }, skip: 1 }),
  });
  const hasMore = rows.length > q.take;
  const page = rows.slice(0, q.take);
  res.json({ items: page.map(toSaleDTO), nextCursor: hasMore ? page[page.length - 1].id : null });
});

salesRouter.get('/:id', requirePermission('sales:read'), async (req, res) => {
  const sale = await prisma.sale.findFirst({
    where: { OR: [{ id: pid(req) }, { receiptNo: pid(req) }] },
    include: saleInclude,
  });
  if (!sale) throw notFound('Sale');
  res.json(toSaleDTO(sale));
});

salesRouter.post('/:id/void', requireRoleOrOverride('VOID_SALE'), async (req, res) => {
  const { reason } = body(req, z.object({ reason: z.string().trim().min(3, 'Give a reason for the void').max(300) }));
  res.json(await voidSale(pid(req), req.user!, reason, req.overrideId));
});

salesRouter.post('/:id/returns', requireRoleOrOverride('RETURN_ITEM'), async (req, res) => {
  const input = body(
    req,
    z.object({
      items: z.array(z.object({ saleItemId: z.string(), quantity: z.number().int().positive(), restock: z.boolean().default(true) })).min(1),
      reason: z.string().max(300).optional(),
    }),
  );
  res.json(await returnItems(pid(req), req.user!, input, req.overrideId));
});

salesRouter.patch('/:id', requireRoleOrOverride('EDIT_SALE'), async (req, res) => {
  const { customerId } = body(req, z.object({ customerId: z.string() }));
  res.json(await attachCustomer(pid(req), customerId, req.user!, req.overrideId));
});
