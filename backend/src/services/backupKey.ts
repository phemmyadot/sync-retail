import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { Prisma } from '@prisma/client';
import { prisma, type Tx } from '../lib/db';

/**
 * The store's Backup Key (BK): 32 random bytes that encrypt every backup.
 *
 * - The owner sees it once at setup as a **recovery key**: 52 Base32
 *   characters in 13 groups of 4 (e.g. `K7QM-2XRA-…`).
 * - Optionally it is also wrapped with a passphrase (scrypt → AES-256-GCM),
 *   so a restore can use the passphrase instead of the key sheet.
 * - It is kept in the `Setting` table (key `backup.key`), which only the API
 *   can read; Postgres listens on loopback with a random password. Storing it
 *   inside the database it protects is safe: decrypting a backup needs the
 *   key in the first place. See docs/LAN_HOST_PLAN.md §7.1.
 */

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // RFC 4648 Base32

export const KDF = { N: 2 ** 17, r: 8, p: 1 } as const;

export interface WrappedKey {
  kdf: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: string;
  nonce: string;
  ct: string;
  tag: string;
}

export interface StoredBackupKey {
  /** Short fingerprint shown in the UI and written into backup headers. */
  keyId: string;
  key: string; // base64
  wrapped: WrappedKey | null;
  createdAt: string;
}

export const generateBackupKey = () => randomBytes(32);

export const keyId = (key: Buffer) => createHash('sha256').update(key).digest('hex').slice(0, 8).toUpperCase();

export function formatRecoveryKey(key: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of key) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out.match(/.{1,4}/g)!.join('-');
}

/** Accepts any spacing/dashes/case; maps the usual look-alikes (0→O, 1→I, 8→B). */
export function parseRecoveryKey(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s-]/g, '').replace(/0/g, 'O').replace(/1/g, 'I').replace(/8/g, 'B');
  if (clean.length !== 52 || /[^A-Z2-7]/.test(clean)) throw new Error('A recovery key is 52 letters and digits (13 groups of 4).');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes.slice(0, 32));
}

export async function wrapKey(key: Buffer, passphrase: string): Promise<WrappedKey> {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const kek = await scrypt(passphrase.normalize('NFKC'), salt, 32, { ...KDF, maxmem: 256 * 1024 * 1024 });
  const c = createCipheriv('aes-256-gcm', kek, nonce);
  const ct = Buffer.concat([c.update(key), c.final()]);
  return { kdf: 'scrypt', ...KDF, salt: salt.toString('base64'), nonce: nonce.toString('base64'), ct: ct.toString('base64'), tag: c.getAuthTag().toString('base64') };
}

export async function unwrapKey(w: WrappedKey, passphrase: string): Promise<Buffer> {
  const kek = await scrypt(passphrase.normalize('NFKC'), Buffer.from(w.salt, 'base64'), 32, { N: w.N, r: w.r, p: w.p, maxmem: 256 * 1024 * 1024 });
  const d = createDecipheriv('aes-256-gcm', kek, Buffer.from(w.nonce, 'base64'));
  d.setAuthTag(Buffer.from(w.tag, 'base64'));
  try {
    return Buffer.concat([d.update(Buffer.from(w.ct, 'base64')), d.final()]);
  } catch {
    throw new Error('Passphrase is incorrect');
  }
}

export const keysEqual = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

const SETTING_KEY = 'backup.key';

export async function saveBackupKey(key: Buffer, passphrase: string | undefined, db: Tx | typeof prisma = prisma): Promise<StoredBackupKey> {
  const stored: StoredBackupKey = {
    keyId: keyId(key),
    key: key.toString('base64'),
    wrapped: passphrase ? await wrapKey(key, passphrase) : null,
    createdAt: new Date().toISOString(),
  };
  await db.setting.upsert({
    where: { key: SETTING_KEY },
    create: { key: SETTING_KEY, value: stored as unknown as Prisma.InputJsonValue },
    update: { value: stored as unknown as Prisma.InputJsonValue },
  });
  return stored;
}

export async function loadBackupKey(): Promise<StoredBackupKey | null> {
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  return (row?.value as unknown as StoredBackupKey) ?? null;
}
