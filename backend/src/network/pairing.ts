import { createHash, randomBytes, randomInt } from 'node:crypto';
import os from 'node:os';

/**
 * Pairing codes for adding a register to this Main Register.
 *
 * - 6 digits, single use, valid for 2 minutes, at most 3 outstanding.
 * - Failed claims are limited per IP (5 per 10 min) and globally: 20 failures
 *   while codes are outstanding invalidates every code (someone is guessing).
 * - Held in memory only: restarting the host simply cancels pending codes.
 */

export const CODE_TTL_MS = 2 * 60_000;
const MAX_OUTSTANDING = 3;
const IP_MAX_FAILS = 5;
const IP_WINDOW_MS = 10 * 60_000;
const GLOBAL_MAX_FAILS = 20;

interface PendingCode {
  code: string;
  expiresAt: number;
  createdById: string;
}

const codes = new Map<string, PendingCode>();
const ipFails = new Map<string, { count: number; until: number }>();
let globalFails = 0;

function prune(now = Date.now()) {
  for (const [k, c] of codes) if (c.expiresAt <= now) codes.delete(k);
  if (!codes.size) globalFails = 0;
}

export function issueCode(createdById: string): PendingCode {
  prune();
  if (codes.size >= MAX_OUTSTANDING) {
    // Drop the oldest rather than refuse: the admin just wants a working code.
    const oldest = [...codes.values()].sort((a, b) => a.expiresAt - b.expiresAt)[0];
    codes.delete(oldest.code);
  }
  let code: string;
  do code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  while (codes.has(code));
  const entry = { code, expiresAt: Date.now() + CODE_TTL_MS, createdById };
  codes.set(code, entry);
  return entry;
}

export function cancelCode(code: string) {
  codes.delete(code);
}

export type ClaimCheck = { ok: true; createdById: string } | { ok: false; reason: 'locked' | 'invalid'; retryAfterSec?: number };

/** Validates and consumes a code, applying the attempt limits. */
export function consumeCode(code: string, ip: string): ClaimCheck {
  const now = Date.now();
  prune(now);
  const f = ipFails.get(ip);
  if (f && f.until > now && f.count >= IP_MAX_FAILS) return { ok: false, reason: 'locked', retryAfterSec: Math.ceil((f.until - now) / 1000) };

  const entry = codes.get(code);
  if (!entry) {
    const cur = f && f.until > now ? f : { count: 0, until: now + IP_WINDOW_MS };
    cur.count++;
    ipFails.set(ip, cur);
    if (++globalFails >= GLOBAL_MAX_FAILS) {
      codes.clear(); // under attack: void every outstanding code
      globalFails = 0;
    }
    return { ok: false, reason: 'invalid' };
  }
  codes.delete(code);
  ipFails.delete(ip);
  return { ok: true, createdById: entry.createdById };
}

export const newDeviceToken = () => randomBytes(32).toString('base64url');
export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

/** LAN IPv4 addresses, for "type this address" fallback when discovery is blocked. */
export function lanAddresses(): string[] {
  return Object.entries(os.networkInterfaces())
    .filter(([name]) => !/vethernet|virtual|vmware|vbox|docker|wsl|hyper-v|loopback/i.test(name))
    .flatMap(([, addrs]) => (addrs ?? []).filter((a) => a.family === 'IPv4' && !a.internal).map((a) => a.address));
}

/** Simple semver compare: -1 / 0 / 1 (pre-release tags ignored). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
  const pb = b.split(/[.+-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}
