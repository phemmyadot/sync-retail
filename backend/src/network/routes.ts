import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/db';
import { body, conflict, HttpError, notFound, pid } from '../lib/http';
import { authenticate, requirePermission } from '../middleware/auth';
import { audit } from '../services/audit';
import { getSettings } from '../services/settings';
import { evictDevice, hostMode } from './deviceAuth';
import { CODE_TTL_MS, cancelCode, compareVersions, consumeCode, hashToken, issueCode, lanAddresses, newDeviceToken } from './pairing';

const appVersion = () => process.env.SR_APP_VERSION ?? 'dev';

// ─── Pairing (public endpoints are exempt from the device gate) ────────────

export const pairRouter = Router();

/** What a register sees before pairing (discovery check / manual address entry). */
pairRouter.get('/info', async (_req, res) => {
  const s = await getSettings();
  res.json({ storeId: process.env.SR_STORE_ID ?? null, storeName: s.storeName, appVersion: appVersion(), hostMode: hostMode(), pairing: true });
});

pairRouter.post('/claim', async (req, res) => {
  const input = body(
    req,
    z.object({
      code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code shown on the Main Register'),
      deviceName: z.string().trim().min(1).max(60),
      appVersion: z.string().max(40).default('dev'),
    }),
  );
  if (!hostMode()) throw new HttpError(404, 'Pairing is only available on a desktop Main Register', 'NOT_FOUND');

  const ip = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  const check = consumeCode(input.code, ip);
  if (!check.ok) {
    await audit({ action: 'device.pair_failed', entity: 'Device', details: { ip, reason: check.reason } });
    if (check.reason === 'locked') throw new HttpError(429, `Too many wrong codes. Try again in ${check.retryAfterSec}s.`, 'LOCKED');
    throw new HttpError(401, 'That code is wrong or has expired. Ask for a new one on the Main Register.', 'BAD_CODE');
  }
  // A register must never be newer than the host it talks to.
  if (appVersion() !== 'dev' && input.appVersion !== 'dev' && compareVersions(input.appVersion, appVersion()) > 0) {
    throw conflict(`This register runs ${input.appVersion} but the Main Register runs ${appVersion()}. Update the Main Register first.`);
  }

  const token = newDeviceToken();
  const device = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(424243)`;
    const n = await tx.device.count();
    return tx.device.create({
      data: { code: `R${n + 2}`, name: input.deviceName, tokenHash: hashToken(token), appVersion: input.appVersion, pairedById: check.createdById, lastSeenAt: new Date(), lastIp: ip },
    });
  });
  await audit({ actorId: check.createdById, action: 'device.paired', entity: 'Device', entityId: device.id, details: { name: device.name, code: device.code, ip } });

  const s = await getSettings();
  res.status(201).json({
    deviceId: device.id,
    deviceCode: device.code,
    deviceToken: token, // returned once; only its hash is stored
    store: { id: process.env.SR_STORE_ID ?? null, name: s.storeName },
    hostVersion: appVersion(),
  });
});

// ─── Device management (staff session + permission) ────────────────────────

export const devicesRouter = Router();
devicesRouter.use(authenticate, requirePermission('devices:manage'));

devicesRouter.post('/codes', async (req, res) => {
  if (!hostMode()) throw new HttpError(404, 'Pairing is only available on a desktop Main Register', 'NOT_FOUND');
  const c = issueCode(req.user!.id);
  await audit({ actorId: req.user!.id, action: 'device.code_issued', entity: 'Device' });
  res.status(201).json({ code: c.code, expiresAt: new Date(c.expiresAt).toISOString(), ttlSeconds: CODE_TTL_MS / 1000, addresses: lanAddresses(), port: Number(process.env.PORT) });
});

devicesRouter.delete('/codes/:code', (req, res) => {
  cancelCode(pid(req, 'code'));
  res.status(204).end();
});

devicesRouter.get('/', async (_req, res) => {
  const devices = await prisma.device.findMany({
    orderBy: [{ revokedAt: { sort: 'asc', nulls: 'first' } }, { pairedAt: 'asc' }],
    select: { id: true, code: true, name: true, kind: true, appVersion: true, pairedAt: true, lastSeenAt: true, lastIp: true, revokedAt: true, pairedBy: { select: { name: true } } },
  });
  res.json({ host: { code: 'R1', appVersion: appVersion(), hostMode: hostMode() }, devices });
});

devicesRouter.patch('/:id', async (req, res) => {
  const { name } = body(req, z.object({ name: z.string().trim().min(1).max(60) }));
  const d = await prisma.device.update({ where: { id: pid(req) }, data: { name } });
  res.json(d);
});

devicesRouter.delete('/:id', async (req, res) => {
  const d = await prisma.device.findUnique({ where: { id: pid(req) } });
  if (!d) throw notFound('Device');
  if (!d.revokedAt) {
    await prisma.device.update({ where: { id: d.id }, data: { revokedAt: new Date() } });
    evictDevice(d.id); // takes effect on the register's very next request
    await audit({ actorId: req.user!.id, action: 'device.revoked', entity: 'Device', entityId: d.id, details: { name: d.name, code: d.code } });
  }
  res.status(204).end();
});
