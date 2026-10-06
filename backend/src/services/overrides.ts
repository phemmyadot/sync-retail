import bcrypt from 'bcryptjs';
import type { Prisma } from '@prisma/client';
import { can, OVERRIDE_BYPASS, type OverrideAction, type Permission } from '@sync-retail/shared';
import { prisma, type Tx } from '../lib/db';
import { HttpError, overrideRequired } from '../lib/http';
import { signOverride, verifyOverride } from './tokens';

interface AuthorizeInput {
  /** The manager/admin chosen on the register: their PIN is the only one checked. */
  approverId: string;
  pin: string;
  action: OverrideAction;
  reason?: string;
  saleId?: string;
  context?: Record<string, unknown>;
  requesterId: string;
  ip?: string;
}

/**
 * Checks the PIN of one named approver. Staff may share PINs, so the person is
 * chosen on the register and only their PIN is compared — the log then names
 * exactly who approved.
 */
export async function checkApproverPin(approverId: string, pin: string, permission: Permission) {
  const approver = await prisma.user.findUnique({ where: { id: approverId }, select: { id: true, name: true, role: true, active: true, pinHash: true } });
  if (!approver || !approver.active || !can(approver.role, permission)) {
    return { ok: false as const, approver: null, message: `${approver?.name ?? 'That person'} can’t approve this` };
  }
  if (!(await bcrypt.compare(pin, approver.pinHash))) {
    return { ok: false as const, approver, message: `That PIN doesn’t match ${approver.name}` };
  }
  return { ok: true as const, approver, message: '' };
}

/**
 * Checks the chosen manager/admin's PIN and records the attempt. Approved
 * attempts get a short-lived, single-use token scoped to (action, requester).
 */
export async function authorizeOverride(input: AuthorizeInput) {
  const check = await checkApproverPin(input.approverId, input.pin, OVERRIDE_BYPASS[input.action]);
  const base = {
    action: input.action,
    reason: input.reason,
    requestedById: input.requesterId,
    saleId: input.saleId,
    ipAddress: input.ip,
  };

  if (!check.ok) {
    // Denied: record whose PIN was tried, but they didn't approve anything.
    await prisma.overrideLog.create({
      data: { ...base, outcome: 'DENIED', context: { ...(input.context ?? {}), attemptedApproverId: input.approverId, attemptedApprover: check.approver?.name ?? null } as Prisma.InputJsonValue },
    });
    throw new HttpError(401, check.message, 'OVERRIDE_DENIED');
  }
  const approver = check.approver;

  const log = await prisma.overrideLog.create({
    data: { ...base, context: input.context as Prisma.InputJsonValue | undefined, outcome: 'APPROVED', approvedById: approver.id },
  });
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
