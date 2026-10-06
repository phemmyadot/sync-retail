import { Router, type Request } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { DEFAULT_SETTINGS, type AuthResponse } from '@sync-retail/shared';
import { prisma } from '../lib/db';
import { body, conflict, forbidden } from '../lib/http';
import { createLockout } from '../lib/rateLimit';
import { audit } from '../services/audit';
import { formatRecoveryKey, generateBackupKey, saveBackupKey } from '../services/backupKey';
import { saveSettings } from '../services/settings';
import { signSession } from '../services/tokens';
import { refreshAdvertisement } from '../network/advertise';
import { ensureStarterClasses } from '../services/taxClasses';

/**
 * First-run store setup. Only available while the database has no users,
 * and — unless SETUP_ALLOW_REMOTE=true (e.g. a Docker install behind nginx) —
 * only from the host machine itself, so another device on the LAN can't race
 * the owner to claim a freshly installed Main Register.
 */
export const setupRouter = Router();
const lockout = createLockout({ max: 10, windowMs: 60_000 });

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
// The socket address, not req.ip: X-Forwarded-For must not be able to fake "local".
const isLocal = (req: Request) => LOOPBACK.has(req.socket.remoteAddress ?? '');
const remoteAllowed = () => process.env.SETUP_ALLOW_REMOTE === 'true';

setupRouter.get('/status', async (req, res) => {
  const users = await prisma.user.count();
  res.json({
    needsSetup: users === 0,
    canSetupHere: users === 0 && (isLocal(req) || remoteAllowed()),
    hostMode: process.env.SR_HOST_MODE === '1',
  });
});

const setupSchema = z.object({
  store: z.object({
    name: z.string().trim().min(1).max(80),
    currency: z.string().trim().length(3).transform((s) => s.toUpperCase()),
    locale: z.string().trim().min(2).max(20),
  }),
  owner: z.object({
    name: z.string().trim().min(1).max(80),
    email: z.string().trim().email(),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    pin: z.string().regex(/^\d{4,8}$/, 'PIN must be 4–8 digits'),
  }),
  /** Optional: lets the owner restore with a passphrase instead of the key sheet. */
  passphrase: z.string().min(12, 'Passphrase must be at least 12 characters').max(200).optional(),
});

setupRouter.post('/', lockout.guard, async (req, res) => {
  if (!isLocal(req) && !remoteAllowed()) {
    lockout.fail(req.ip);
    throw forbidden('Store setup must be completed on the Main Register itself.');
  }
  const input = body(req, setupSchema);
  try {
    new Intl.NumberFormat(input.store.locale, { style: 'currency', currency: input.store.currency });
  } catch {
    throw conflict(`"${input.store.currency}" / "${input.store.locale}" is not a valid currency / locale`);
  }

  const passwordHash = await bcrypt.hash(input.owner.password, 12);
  const pinHash = await bcrypt.hash(input.owner.pin, 10);
  const key = generateBackupKey();

  const { owner, stored } = await prisma.$transaction(async (tx) => {
    // Serialise concurrent setup attempts; the loser sees users > 0.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(424242)`;
    if ((await tx.user.count()) > 0) throw conflict('This store has already been set up.');
    const owner = await tx.user.create({
      data: { name: input.owner.name, email: input.owner.email.toLowerCase(), role: 'ADMIN', color: '#FFB547', passwordHash, pinHash },
      select: { id: true, name: true, email: true, role: true, color: true },
    });
    const stored = await saveBackupKey(key, input.passphrase, tx);
    // Starter tax classes for the store's currency (NGN: VAT 7.5% default, Zero-rated, Exempt).
    await ensureStarterClasses(input.store.currency, tx);
    await audit(
      { actorId: owner.id, action: 'store.setup', entity: 'System', details: { storeName: input.store.name, currency: input.store.currency, keyId: stored.keyId, passphrase: !!input.passphrase } },
      tx,
    );
    return { owner, stored };
  });

  await saveSettings({
    storeName: input.store.name,
    currency: input.store.currency,
    locale: input.store.locale,
    promoBanners: DEFAULT_SETTINGS.promoBanners,
  });
  lockout.reset(req.ip);
  refreshAdvertisement(input.store.name);

  const auth: AuthResponse = { token: signSession(owner.id, owner.role), user: owner };
  // The recovery key is returned exactly once and never logged.
  res.status(201).json({ ...auth, recoveryKey: formatRecoveryKey(key), keyId: stored.keyId, passphraseSet: !!stored.wrapped });
});
