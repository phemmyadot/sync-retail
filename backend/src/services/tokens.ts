import jwt, { type SignOptions } from 'jsonwebtoken';
import type { OverrideAction, Role } from '@sync-retail/shared';
import { env } from '../lib/env';

interface SessionClaims {
  sub: string;
  role: Role;
  kind: 'session';
}

interface OverrideClaims {
  sub: string; // override log id
  action: OverrideAction;
  approver: string;
  requester: string;
  kind: 'override';
}

export function signSession(userId: string, role: Role): string {
  return jwt.sign({ role, kind: 'session' }, env.JWT_SECRET, {
    subject: userId,
    expiresIn: env.SESSION_TTL as SignOptions['expiresIn'],
  });
}

export function verifySession(token: string): SessionClaims | null {
  try {
    const claims = jwt.verify(token, env.JWT_SECRET) as SessionClaims;
    return claims.kind === 'session' ? claims : null;
  } catch {
    return null;
  }
}

export function signOverride(c: Omit<OverrideClaims, 'kind' | 'sub'> & { id: string }): { token: string; expiresAt: Date } {
  const token = jwt.sign(
    { action: c.action, approver: c.approver, requester: c.requester, kind: 'override' },
    env.JWT_SECRET,
    { subject: c.id, expiresIn: env.OVERRIDE_TTL_SECONDS },
  );
  return { token, expiresAt: new Date(Date.now() + env.OVERRIDE_TTL_SECONDS * 1000) };
}

/**
 * `ignoreExpiration` is used only when replaying sales that were rung up
 * offline: the approval was valid at the time, single-use is still enforced.
 */
export function verifyOverride(token: string, ignoreExpiration = false): OverrideClaims | null {
  try {
    const claims = jwt.verify(token, env.JWT_SECRET, { ignoreExpiration }) as OverrideClaims;
    return claims.kind === 'override' ? claims : null;
  } catch {
    return null;
  }
}
