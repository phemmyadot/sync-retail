import type { RequestHandler } from 'express';
import { can, OVERRIDE_BYPASS, type OverrideAction, type Permission, type SessionUser } from '@sync-retail/shared';
import { prisma } from '../lib/db';
import { forbidden, overrideRequired, unauthorized, pid } from '../lib/http';
import { consumeOverride } from '../services/overrides';
import { verifySession } from '../services/tokens';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
      /** Set when the request was authorised by a manager override rather than role. */
      overrideId?: string;
    }
  }
}


export const authenticate: RequestHandler = async (req, _res, next) => {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token) throw unauthorized();
  const claims = verifySession(token);
  if (!claims) throw unauthorized('Session expired — please sign in again');
  const user = await prisma.user.findUnique({
    where: { id: claims.sub },
    select: { id: true, name: true, email: true, role: true, color: true, active: true },
  });
  if (!user || !user.active) throw unauthorized('Account disabled');
  req.user = { id: user.id, name: user.name, email: user.email, role: user.role, color: user.color };
  next();
};

export const requirePermission =
  (permission: Permission): RequestHandler =>
  (req, _res, next) => {
    if (!can(req.user?.role, permission)) throw forbidden();
    next();
  };

/**
 * Lets privileged roles through directly; everyone else must present a fresh,
 * single-use manager override token in `X-Override-Token` for this action.
 */
export const requireRoleOrOverride =
  (action: OverrideAction): RequestHandler =>
  async (req, _res, next) => {
    if (can(req.user?.role, OVERRIDE_BYPASS[action])) return next();
    const token = req.header('x-override-token');
    if (!token) throw overrideRequired(action);
    req.overrideId = await consumeOverride(token, action, req.user!.id, { saleId: pid(req) });
    next();
  };
