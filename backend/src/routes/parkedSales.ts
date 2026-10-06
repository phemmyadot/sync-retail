import { Router } from 'express';
import { z } from 'zod';
import { can, PARKED_MAX_LINES, PARKED_REFERENCE_MAX } from '@sync-retail/shared';
import { body, forbidden, pid, query } from '../lib/http';
import { requirePermission } from '../middleware/auth';
import { discardParked, holdSale, housekeeping, listParked, openCount, resumeParked } from '../services/parkedSales';

/** Held ("parked") sales — see docs/done/PARKED_SALES_PLAN.md. */
export const parkedSalesRouter = Router();

const holdSchema = z.object({
  clientId: z.string().min(8).max(64),
  reference: z.string().max(PARKED_REFERENCE_MAX).nullable().optional(),
  terminalId: z.string().min(1).max(40),
  customerId: z.string().nullable().optional(),
  lines: z
    .array(
      z.object({
        productId: z.string(),
        quantity: z.number().int().min(1).max(9_999),
        discount: z.object({ type: z.enum(['PERCENT', 'AMOUNT']), value: z.number().int().min(0) }).nullable().optional(),
      }),
    )
    .min(1)
    .max(PARKED_MAX_LINES),
  approvals: z.array(z.string()).max(50).optional(),
  heldAt: z.string().datetime().optional(),
  offline: z.boolean().optional(),
});

parkedSalesRouter.post('/', requirePermission('sales:park'), async (req, res) => {
  res.status(201).json(await holdSale(body(req, holdSchema), req.user!));
});

parkedSalesRouter.get('/', async (req, res) => {
  const { status } = query(req, z.object({ status: z.enum(['PARKED', 'RESUMED', 'DISCARDED', 'EXPIRED']).default('PARKED') }));
  if (status !== 'PARKED' && !can(req.user!.role, 'audit:read')) throw forbidden();
  res.json(await listParked(status));
});

parkedSalesRouter.get('/count', async (_req, res) => {
  await housekeeping();
  res.json({ count: await openCount() });
});

parkedSalesRouter.post('/:id/resume', requirePermission('sales:park'), async (req, res) => {
  const { terminalId } = body(req, z.object({ terminalId: z.string().min(1).max(40) }));
  res.json(await resumeParked(pid(req), req.user!, terminalId));
});

parkedSalesRouter.post('/:id/discard', async (req, res) => {
  const { reason } = body(req, z.object({ reason: z.string().trim().min(2).max(200) }));
  await discardParked(pid(req), req.user!, reason, req.header('x-override-token') ?? undefined);
  res.status(204).end();
});
