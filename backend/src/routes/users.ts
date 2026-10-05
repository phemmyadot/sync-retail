import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { ROLES } from '@sync-retail/shared';
import { prisma } from '../lib/db';
import { badRequest, body, pid } from '../lib/http';
import { requirePermission } from '../middleware/auth';
import { audit } from '../services/audit';

export const usersRouter = Router();
usersRouter.use(requirePermission('users:manage'));

const select = { id: true, name: true, email: true, role: true, color: true, active: true, createdAt: true } as const;
const pin = z.string().regex(/^\d{4,8}$/, 'PIN must be 4–8 digits');
const color = z.string().regex(/^#[0-9a-f]{6}$/i);

usersRouter.get('/', async (_req, res) => {
  res.json(await prisma.user.findMany({ select, orderBy: { name: 'asc' } }));
});

usersRouter.post('/', async (req, res) => {
  const input = body(
    req,
    z.object({ name: z.string().min(1), email: z.string().email(), password: z.string().min(8), pin, role: z.enum(ROLES), color: color.optional() }),
  );
  const user = await prisma.user.create({
    data: {
      name: input.name,
      email: input.email.toLowerCase(),
      role: input.role,
      color: input.color,
      passwordHash: await bcrypt.hash(input.password, 12),
      pinHash: await bcrypt.hash(input.pin, 10),
    },
    select,
  });
  await audit({ actorId: req.user!.id, action: 'user.create', entity: 'User', entityId: user.id, details: { role: user.role } });
  res.status(201).json(user);
});

usersRouter.patch('/:id', async (req, res) => {
  const input = body(
    req,
    z.object({
      name: z.string().min(1).optional(),
      email: z.string().email().optional(),
      password: z.string().min(8).optional(),
      pin: pin.optional(),
      role: z.enum(ROLES).optional(),
      color: color.nullable().optional(),
      active: z.boolean().optional(),
    }),
  );
  if (pid(req) === req.user!.id && (input.active === false || (input.role && input.role !== 'ADMIN'))) {
    throw badRequest('You cannot demote or deactivate your own account');
  }
  const user = await prisma.user.update({
    where: { id: pid(req) },
    data: {
      name: input.name,
      email: input.email?.toLowerCase(),
      role: input.role,
      color: input.color,
      active: input.active,
      ...(input.password && { passwordHash: await bcrypt.hash(input.password, 12) }),
      ...(input.pin && { pinHash: await bcrypt.hash(input.pin, 10) }),
    },
    select,
  });
  // Never write secrets to the audit trail — only which fields changed.
  await audit({ actorId: req.user!.id, action: 'user.update', entity: 'User', entityId: user.id, details: { fields: Object.keys(input) } });
  res.json(user);
});
