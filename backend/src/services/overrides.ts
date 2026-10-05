import bcrypt from 'bcryptjs';
import type { Prisma } from '@prisma/client';
import { can, OVERRIDE_BYPASS, type OverrideAction } from '@sync-retail/shared';
import { prisma, type Tx } from '../lib/db';
import { HttpError, overrideRequired } from '../lib/http';
import { signOverride, verifyOverride } from './tokens';

interface AuthorizeInput {
  pin: string;
  action: OverrideAction;
  reason?: string;
  saleId?: string;
  context?: Record<string, unknown>;
  requesterId: string;
  ip?: string;
}

/**
 * Checks a manager/admin PIN and records the attempt. Approved attempts get a
 * short-lived, single-use token scoped to (action, requester).
 */
export async function authorizeOverride(input: AuthorizeInput) {
  const approvers = await prisma.user.findMany({
    where: { active: true, role: { in: ['ADMIN', 'MANAGER'] } },
    select: { id: true, name: true, role: true, pinHash: true },
  });

  let approver: (typeof approvers)[number] | undefined;
  for (const candidate of approvers) {
    if (await bcrypt.compare(input.pin, candidate.pinHash)) {
      approver = candidate;
      break;
    }
  }

  const base = {
    action: input.action,
    reason: input.reason,
    requestedById: input.requesterId,
    saleId: input.saleId,
    context: input.context as Prisma.InputJsonValue | undefined,
    ipAddress: input.ip,
  };

  if (!approver || !can(approver.role, OVERRIDE_BYPASS[input.action])) {
    await prisma.overrideLog.create({ data: { ...base, outcome: 'DENIED' } });
    throw new HttpError(401, 'PIN not recognised for a manager or admin', 'OVERRIDE_DENIED');
  }

  const log = await prisma.overrideLog.create({ data: { ...base, outcome: 'APPROVED', approvedById: approver.id } });
  const { token, expiresAt } = signOverride({
    id: log.id,
    action: input.action,
    approver: approver.id,
    requester: input.requesterId,
  });
  return {
    overrideToken: token,
    overrideId: log.id,
    approvedBy: { id: approver.id, name: approver.name },
    expiresAt: expiresAt.toISOString(),
  };
}

/** Marks a token as used. Throws OVERRIDE_REQUIRED when it is invalid, stale, or reused. */
export async function consumeOverride(
  token: string,
  action: OverrideAction,
  requesterId: string,
  opts: { saleId?: string; ignoreExpiration?: boolean; tx?: Tx } = {},
): Promise<string> {
  const claims = verifyOverride(token, opts.ignoreExpiration);
  if (!claims || claims.action !== action || claims.requester !== requesterId) {
    throw overrideRequired(action, 'Override approval is invalid or expired');
  }
  const db = opts.tx ?? prisma;
  const { count } = await db.overrideLog.updateMany({
    where: { id: claims.sub, outcome: 'APPROVED', consumedAt: null },
    data: { consumedAt: new Date(), ...(opts.saleId ? { saleId: opts.saleId } : {}) },
  });
  if (count === 0) throw overrideRequired(action, 'Override approval has already been used');
  return claims.sub;
}
