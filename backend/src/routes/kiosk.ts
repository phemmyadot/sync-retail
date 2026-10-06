import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { can } from '@sync-retail/shared';
import { prisma } from '../lib/db';
import { body, HttpError } from '../lib/http';
import { createLockout } from '../lib/rateLimit';
import { authenticate, requirePermission } from '../middleware/auth';
import { audit } from '../services/audit';
import { verifySession } from '../services/tokens';

/**
 * Kiosk mode support for desktop registers. The window lockdown itself lives
 * in the Tauri shell; the server checks manager PINs and keeps the audit trail.
 */
export const kioskRouter = Router();
const lockout = createLockout({ max: 5, windowMs: 10 * 60_000 });
const KEY = 'kiosk';

/**
 * Manager/admin PIN → maintenance unlock. Works from the lock screen too (no
 * session needed), so it is rate-limited and every attempt is logged.
 */
kioskRouter.post('/unlock', lockout.guard, async (req, res) => {
  const { pin, register } = body(req, z.object({ pin: z.string().regex(/^\d{4,8}$/), register: z.string().max(80).optional() }));
  const header = req.headers.authorization;
  const session = header?.startsWith('Bearer ') ? verifySession(header.slice(7)) : null;

  const approvers = await prisma.user.findMany({
    where: { active: true, role: { in: ['ADMIN', 'MANAGER'] } },
    select: { id: true, name: true, role: true, pinHash: true },
  });
  let approver: (typeof approvers)[number] | undefined;
  for (const c of approvers) {
    if (await bcrypt.compare(pin, c.pinHash)) {
      approver = c;
      break;
    }
  }
  const context = { register: register ?? null };
  if (!approver || !can(approver.role, 'devices:manage')) {
    lockout.fail(req.ip);
    if (session) {
      await prisma.overrideLog.create({ data: { action: 'KIOSK_EXIT', outcome: 'DENIED', requestedById: session.sub, context, ipAddress: req.ip } });
    }
    throw new HttpError(401, 'PIN not recognised for a manager or admin', 'OVERRIDE_DENIED');
  }
  lockout.reset(req.ip);
  const log = await prisma.overrideLog.create({
    data: {
      action: 'KIOSK_EXIT',
      outcome: 'APPROVED',
      requestedById: session?.sub ?? approver.id,
      approvedById: approver.id,
      context,
      ipAddress: req.ip,
      consumedAt: new Date(),
    },
  });
  res.json({ overrideId: log.id, approvedBy: { id: approver.id, name: approver.name } });
});

kioskRouter.use(authenticate);

/** Hash of the store's offline exit PIN (hashed on the register, never stored in plain text). */
kioskRouter.get('/offline-pin', async (_req, res) => {
  const row = await prisma.setting.findUnique({ where: { key: KEY } });
  res.json({ hash: ((row?.value ?? {}) as { offlinePinHash?: string | null }).offlinePinHash ?? null });
});

kioskRouter.put('/offline-pin', requirePermission('devices:manage'), async (req, res) => {
  const { hash } = body(req, z.object({ hash: z.string().startsWith('$argon2id$').max(200).nullable() }));
  await prisma.setting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: { offlinePinHash: hash } },
    update: { value: { offlinePinHash: hash } },
  });
  await audit({ actorId: req.user!.id, action: hash ? 'kiosk.offline_pin.set' : 'kiosk.offline_pin.clear', entity: 'Setting', entityId: KEY });
  res.json({ ok: true });
});

const EVENTS = ['settings', 'maintenance_end', 'exit', 'offline_unlock', 'offline_unlock_failed'] as const;

/** Kiosk events from a register (setting changes, exits, offline unlocks replayed after reconnecting). */
kioskRouter.post('/events', async (req, res) => {
  const events = body(
    req,
    z.array(z.object({ event: z.enum(EVENTS), register: z.string().max(80).optional(), at: z.string().datetime().optional(), details: z.record(z.unknown()).optional() })).max(50),
  );
  for (const e of events) {
    await audit({
      actorId: req.user!.id,
      action: `kiosk.${e.event}`,
      entity: 'Kiosk',
      entityId: e.register ?? null,
      details: { ...(e.details ?? {}), ...(e.at ? { at: e.at } : {}) } as object,
    });
  }
  res.json({ recorded: events.length });
});
