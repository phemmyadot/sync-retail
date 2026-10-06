import { Router } from 'express';
import { z } from 'zod';
import { OVERRIDE_ACTIONS } from '@sync-retail/shared';
import { prisma } from '../lib/db';
import { body, query } from '../lib/http';
import { createLockout } from '../lib/rateLimit';
import { requirePermission } from '../middleware/auth';
import { authorizeOverride } from '../services/overrides';

export const overridesRouter = Router();
const lockout = createLockout({ max: 6, windowMs: 120_000 });

overridesRouter.post('/authorize', lockout.guard, async (req, res) => {
  const input = body(
    req,
    z.object({
      approverId: z.string().min(1),
      pin: z.string().regex(/^\d{4,8}$/),
      action: z.enum(OVERRIDE_ACTIONS),
      reason: z.string().max(500).optional(),
      saleId: z.string().optional(),
      context: z.record(z.unknown()).optional(),
    }),
  );
  try {
    const grant = await authorizeOverride({ ...input, requesterId: req.user!.id, ip: req.ip });
    lockout.reset(req.ip);
    res.json(grant);
  } catch (err) {
    lockout.fail(req.ip);
    throw err;
  }
});

overridesRouter.get('/', requirePermission('audit:read'), async (req, res) => {
  const q = query(req, z.object({ take: z.coerce.number().int().min(1).max(500).default(100), action: z.enum(OVERRIDE_ACTIONS).optional() }));
  const logs = await prisma.overrideLog.findMany({
    where: q.action ? { action: q.action } : undefined,
    include: {
      requestedBy: { select: { id: true, name: true } },
      approvedBy: { select: { id: true, name: true } },
      sale: { select: { id: true, receiptNo: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: q.take,
  });
  res.json(logs);
});
