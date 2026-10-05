import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import type { AuthResponse, StaffTile } from '@sync-retail/shared';
import { prisma } from '../lib/db';
import { body, HttpError } from '../lib/http';
import { createLockout } from '../lib/rateLimit';
import { authenticate } from '../middleware/auth';
import { signSession } from '../services/tokens';
import { audit } from '../services/audit';

export const authRouter = Router();
const lockout = createLockout({ max: 5, windowMs: 60_000 });

const sessionUser = { id: true, name: true, email: true, role: true, color: true } as const;

async function issue(userId: string, method: 'password' | 'pin'): Promise<AuthResponse> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: sessionUser });
  await audit({ actorId: user.id, action: 'auth.login', entity: 'User', entityId: user.id, details: { method } });
  return { token: signSession(user.id, user.role), user };
}

authRouter.post('/login', lockout.guard, async (req, res) => {
  const { email, password } = body(req, z.object({ email: z.string().email(), password: z.string().min(1) }));
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user || !user.active || !(await bcrypt.compare(password, user.passwordHash))) {
    lockout.fail(req.ip);
    throw new HttpError(401, 'Email or password is incorrect', 'BAD_CREDENTIALS');
  }
  lockout.reset(req.ip);
  res.json(await issue(user.id, 'password'));
});

/** Quick-switch: tap your tile, punch your PIN. */
authRouter.post('/pin', lockout.guard, async (req, res) => {
  const { userId, pin } = body(req, z.object({ userId: z.string(), pin: z.string().regex(/^\d{4,8}$/) }));
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.active || !(await bcrypt.compare(pin, user.pinHash))) {
    lockout.fail(req.ip);
    throw new HttpError(401, 'Incorrect PIN', 'BAD_PIN');
  }
  lockout.reset(req.ip);
  res.json(await issue(user.id, 'pin'));
});

/** Staff tiles for the lock screen — names and roles only. */
authRouter.get('/staff', async (_req, res) => {
  const staff: StaffTile[] = await prisma.user.findMany({
    where: { active: true },
    select: { id: true, name: true, role: true, color: true },
    orderBy: [{ role: 'asc' }, { name: 'asc' }],
  });
  res.json(staff);
});

authRouter.get('/me', authenticate, async (req, res) => {
  res.json(await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: sessionUser }));
});
