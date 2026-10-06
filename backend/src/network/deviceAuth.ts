import type { RequestHandler, Request } from 'express';
import { prisma } from '../lib/db';
import { HttpError } from '../lib/http';
import { hashToken } from './pairing';

/**
 * Desktop host mode only: every API call from another machine must carry the
 * `X-Device-Token` issued at pairing. The host's own window (loopback) and the
 * pairing endpoints are exempt. Staff still sign in with PIN/password on top.
 *
 * Lookups are cached for 30 s; revoking a device evicts it immediately.
 */

interface Cached {
  deviceId: string;
  code: string;
  revoked: boolean;
  at: number;
  lastSeenWrite: number;
}
const cache = new Map<string, Cached>();
const TTL = 30_000;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      device?: { id: string; code: string };
    }
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
export const isLoopback = (addr?: string) => LOOPBACK.has(addr ?? '');
export const hostMode = () => process.env.SR_HOST_MODE === '1';

const EXEMPT = [/^\/health$/, /^\/pair\/info$/, /^\/pair\/claim$/];
// Read-only and not sensitive: the logo is loaded by <img> tags, which can't send the device header.
const EXEMPT_GET = [/^\/branding\/logo$/];

export function evictDevice(deviceId: string) {
  for (const [k, v] of cache) if (v.deviceId === deviceId) cache.delete(k);
}

/** Resolves a device token → device (or a reason it's not accepted). */
export async function checkDeviceToken(token: string | undefined, ip?: string): Promise<{ ok: true; id: string; code: string } | { ok: false; code: 'DEVICE_REQUIRED' | 'DEVICE_REVOKED' }> {
  if (!token) return { ok: false, code: 'DEVICE_REQUIRED' };
  const hash = hashToken(token);
  const now = Date.now();
  let c = cache.get(hash);
  if (!c || now - c.at > TTL) {
    const d = await prisma.device.findUnique({ where: { tokenHash: hash }, select: { id: true, code: true, revokedAt: true } });
    if (!d) return { ok: false, code: 'DEVICE_REQUIRED' };
    c = { deviceId: d.id, code: d.code, revoked: !!d.revokedAt, at: now, lastSeenWrite: c?.lastSeenWrite ?? 0 };
    cache.set(hash, c);
  }
  if (c.revoked) return { ok: false, code: 'DEVICE_REVOKED' };
  // Record "last seen" at most once a minute per device.
  if (now - c.lastSeenWrite > 60_000) {
    c.lastSeenWrite = now;
    void prisma.device.update({ where: { id: c.deviceId }, data: { lastSeenAt: new Date(), lastIp: ip } }).catch(() => {});
  }
  return { ok: true, id: c.deviceId, code: c.code };
}

const clientIp = (req: Request) => (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');

export const requireDevice: RequestHandler = async (req, _res, next) => {
  if (!hostMode() || isLoopback(req.socket.remoteAddress) || EXEMPT.some((r) => r.test(req.path)) || (req.method === 'GET' && EXEMPT_GET.some((r) => r.test(req.path)))) return next();
  const result = await checkDeviceToken(req.header('x-device-token'), clientIp(req));
  if (!result.ok) {
    throw new HttpError(
      401,
      result.code === 'DEVICE_REVOKED' ? 'This register has been removed from the store.' : 'This device is not paired with the Main Register.',
      result.code,
    );
  }
  req.device = { id: result.id, code: result.code };
  next();
};
