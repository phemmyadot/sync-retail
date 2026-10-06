import { createHash } from 'node:crypto';
import express, { Router } from 'express';
import { checkLogo, LOGO_MIME, LOGO_RULES, readImageInfo, svgDanger } from '@sync-retail/shared';
import { prisma } from '../lib/db';
import { badRequest, HttpError, notFound } from '../lib/http';
import { authenticate, requirePermission } from '../middleware/auth';
import { audit } from '../services/audit';
import { saveSettings } from '../services/settings';
import { publishStore } from '../ws';

/**
 * Store logo. Stored in the database (StoreAsset "logo") and served at a
 * versioned URL so every register caches it forever. See docs/done/BRANDING_PLAN.md.
 */
export const brandingRouter = Router();
const KEY = 'logo';
const ACCEPTED = Object.values(LOGO_MIME);

/** Public: the navigation and lock screen render it with a plain <img>. */
brandingRouter.get('/logo', async (req, res) => {
  const asset = await prisma.storeAsset.findUnique({ where: { key: KEY } });
  if (!asset) throw notFound('Logo');
  const etag = `"${asset.sha256.slice(0, 32)}"`;
  const versioned = typeof req.query.v === 'string' && asset.sha256.startsWith(req.query.v);
  res.setHeader('Content-Type', asset.mimeType);
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', versioned ? 'public, max-age=31536000, immutable' : 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // An SVG opened directly must never run anything, even if a check missed it.
  if (asset.mimeType === LOGO_MIME.svg) res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
  if (req.headers['if-none-match'] === etag) return void res.status(304).end();
  res.send(Buffer.from(asset.bytes));
});

const raw = express.raw({ type: ACCEPTED, limit: LOGO_RULES.maxBytes });

brandingRouter.put('/logo', authenticate, requirePermission('settings:write'), (req, res, next) => {
  if (!ACCEPTED.includes((req.headers['content-type'] ?? '').split(';')[0].trim())) {
    throw new HttpError(415, 'Upload a PNG, JPEG or SVG logo.', 'UNSUPPORTED_TYPE');
  }
  raw(req, res, (err?: unknown) => {
    if (err && (err as { type?: string }).type === 'entity.too.large') {
      return next(badRequest(`Logo files must be ${LOGO_RULES.maxBytes / 1024} KB or smaller.`));
    }
    next(err);
  });
}, async (req, res) => {
  const bytes = req.body instanceof Buffer ? new Uint8Array(req.body) : new Uint8Array();
  if (!bytes.length) throw badRequest('The upload was empty.');
  // Trust the bytes, not the name or Content-Type.
  const info = readImageInfo(bytes);
  if (!info) throw badRequest('That file isn’t a PNG, JPEG or SVG image (or its size can’t be read).');
  if (info.type === 'svg') {
    const danger = svgDanger(Buffer.from(bytes).toString('utf8'));
    if (danger) throw badRequest(danger);
  }
  const problem = checkLogo({ ...info, bytes: bytes.length });
  if (problem) throw badRequest(problem);

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const data = { mimeType: LOGO_MIME[info.type], bytes: Buffer.from(bytes), sha256, width: Math.round(info.width), height: Math.round(info.height), updatedById: req.user!.id };
  await prisma.storeAsset.upsert({ where: { key: KEY }, create: { key: KEY, ...data }, update: data });
  const logoUrl = `/api/branding/logo?v=${sha256.slice(0, 12)}`;
  await saveSettings({ logoUrl });
  await audit({ actorId: req.user!.id, action: 'branding.logo.set', entity: 'StoreAsset', entityId: KEY, details: { type: info.type, width: data.width, height: data.height, bytes: bytes.length, sha256 } });
  publishStore({ type: 'branding:changed', logoUrl });
  res.json({ logoUrl, type: info.type, width: data.width, height: data.height, bytes: bytes.length });
});

brandingRouter.delete('/logo', authenticate, requirePermission('settings:write'), async (req, res) => {
  await prisma.storeAsset.deleteMany({ where: { key: KEY } });
  await saveSettings({ logoUrl: null });
  await audit({ actorId: req.user!.id, action: 'branding.logo.clear', entity: 'StoreAsset', entityId: KEY });
  publishStore({ type: 'branding:changed', logoUrl: null });
  res.status(204).end();
});
