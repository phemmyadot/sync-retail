import { Router } from 'express';
import { z } from 'zod';
import { percentToBps } from '@sync-retail/shared';
import { body, pid, query } from '../lib/http';
import { requirePermission } from '../middleware/auth';
import { archiveTaxClass, createTaxClass, deleteTaxClass, listTaxClasses, reassignProducts, updateTaxClass } from '../services/taxClasses';

export const taxRouter = Router();

/** Percentage 0–100 with at most two decimals → basis points. */
const percentage = z
  .union([z.number(), z.string()])
  .transform((v, ctx) => {
    const bps = percentToBps(v);
    if (bps === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Rate must be 0–100 % with at most two decimals' });
      return z.NEVER;
    }
    return bps;
  });
const name = z.string().trim().min(1).max(40);
const code = z.string().trim().max(10).regex(/^[A-Za-z0-9_-]*$/, 'Letters, digits, - and _ only').nullable().optional();

// Everyone at the till needs to read classes (names + rates).
taxRouter.get('/', async (req, res) => {
  const q = query(req, z.object({ includeArchived: z.coerce.boolean().optional() }));
  res.json(await listTaxClasses(q.includeArchived));
});

taxRouter.post('/', requirePermission('tax:manage'), async (req, res) => {
  const input = body(req, z.object({ name, code, percentage, isDefault: z.boolean().optional() }));
  res.status(201).json(await createTaxClass({ name: input.name, code: input.code, rateBps: input.percentage, isDefault: input.isDefault }, req.user!.id));
});

taxRouter.patch('/:id', requirePermission('tax:manage'), async (req, res) => {
  const input = body(req, z.object({ name: name.optional(), code, percentage: percentage.optional(), isDefault: z.boolean().optional() }));
  res.json(await updateTaxClass(pid(req), { name: input.name, code: input.code, rateBps: input.percentage, isDefault: input.isDefault }, req.user!.id));
});

taxRouter.post('/:id/reassign', requirePermission('tax:manage'), async (req, res) => {
  const { toClassId } = body(req, z.object({ toClassId: z.string().min(1) }));
  res.json(await reassignProducts(pid(req), toClassId, req.user!.id));
});

taxRouter.post('/:id/archive', requirePermission('tax:manage'), async (req, res) => {
  const { archived } = body(req, z.object({ archived: z.boolean().default(true) }));
  res.json(await archiveTaxClass(pid(req), archived, req.user!.id));
});

taxRouter.delete('/:id', requirePermission('tax:manage'), async (req, res) => {
  await deleteTaxClass(pid(req), req.user!.id);
  res.status(204).end();
});
