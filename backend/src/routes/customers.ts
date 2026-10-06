import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { CustomerDTO } from '@sync-retail/shared';
import { prisma } from '../lib/db';
import { body, notFound, query, pid } from '../lib/http';
import { requirePermission } from '../middleware/auth';
import { audit } from '../services/audit';

export const customersRouter = Router();

export const toCustomerDTO = (c: Prisma.CustomerGetPayload<object>): CustomerDTO => ({
  id: c.id,
  name: c.name,
  phone: c.phone,
  email: c.email,
  lifetimeSpendCents: c.lifetimeSpendCents,
  pointsBalance: c.pointsBalance,
  createdAt: c.createdAt.toISOString(),
});

const normalizePhone = (p?: string | null) => (p ? p.replace(/[^\d+]/g, '') || null : p);

const customerInput = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(32).nullable().optional(),
  email: z.string().trim().email().nullable().optional().or(z.literal('').transform(() => null)),
  notes: z.string().max(1000).nullable().optional(),
});

customersRouter.get('/', requirePermission('customers:read'), async (req, res) => {
  const q = query(req, z.object({ search: z.string().trim().optional(), take: z.coerce.number().int().min(1).max(500).default(50) }));
  const digits = q.search?.replace(/[^\d]/g, '');
  const rows = await prisma.customer.findMany({
    where: q.search
      ? {
          OR: [
            { name: { contains: q.search, mode: 'insensitive' } },
            { email: { contains: q.search, mode: 'insensitive' } },
            ...(digits && digits.length >= 3 ? [{ phone: { contains: digits } }] : []),
          ],
        }
      : undefined,
    orderBy: q.search ? { name: 'asc' } : { lifetimeSpendCents: 'desc' },
    take: q.take,
  });
  res.json(rows.map(toCustomerDTO));
});

customersRouter.get('/:id', requirePermission('customers:read'), async (req, res) => {
  const c = await prisma.customer.findUnique({
    where: { id: pid(req) },
    include: {
      sales: { orderBy: { createdAt: 'desc' }, take: 15, select: { id: true, receiptNo: true, totalCents: true, status: true, createdAt: true, pointsEarned: true, pointsRedeemed: true } },
      loyaltyLedger: { orderBy: { createdAt: 'desc' }, take: 25 },
    },
  });
  if (!c) throw notFound('Customer');
  res.json({ ...toCustomerDTO(c), notes: c.notes, sales: c.sales, loyaltyLedger: c.loyaltyLedger });
});

customersRouter.post('/', requirePermission('customers:create'), async (req, res) => {
  const input = body(req, customerInput);
  const c = await prisma.customer.create({ data: { ...input, phone: normalizePhone(input.phone), email: input.email?.toLowerCase() ?? null } });
  await audit({ actorId: req.user!.id, action: 'customer.create', entity: 'Customer', entityId: c.id });
  res.status(201).json(toCustomerDTO(c));
});

customersRouter.patch('/:id', requirePermission('customers:write'), async (req, res) => {
  const input = body(req, customerInput.partial());
  const c = await prisma.customer.update({
    where: { id: pid(req) },
    data: { ...input, ...(input.phone !== undefined && { phone: normalizePhone(input.phone) }), ...(input.email !== undefined && { email: input.email?.toLowerCase() ?? null }) },
  });
  await audit({ actorId: req.user!.id, action: 'customer.update', entity: 'Customer', entityId: c.id, details: { fields: Object.keys(input) } });
  res.json(toCustomerDTO(c));
});

/** Manual points adjustment (goodwill, corrections) — always audited. */
customersRouter.post('/:id/points', requirePermission('customers:write'), async (req, res) => {
  const { points, reason } = body(req, z.object({ points: z.number().int().refine((n) => n !== 0), reason: z.string().min(3).max(200) }));
  const c = await prisma.$transaction(async (tx) => {
    const current = await tx.customer.findUniqueOrThrow({ where: { id: pid(req) } });
    const applied = Math.max(-current.pointsBalance, points);
    await tx.loyaltyTransaction.create({ data: { customerId: current.id, points: applied, reason: `Manual: ${reason}` } });
    return tx.customer.update({ where: { id: current.id }, data: { pointsBalance: { increment: applied } } });
  });
  await audit({ actorId: req.user!.id, action: 'customer.points_adjust', entity: 'Customer', entityId: c.id, details: { points, reason } });
  res.json(toCustomerDTO(c));
});
