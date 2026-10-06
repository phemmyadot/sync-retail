import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { CreateSaleInput, SaleDTO } from '@sync-retail/shared';
import { prisma } from '../lib/db';
import { body, HttpError, query } from '../lib/http';
import { requirePermission } from '../middleware/auth';
import { audit } from '../services/audit';
import { createSale } from '../services/sales';
import { getSettings, saveSettings } from '../services/settings';
import { createSaleSchema } from './sales';
import { refreshAdvertisement } from '../network/advertise';
import { productInclude, toProductDTO } from './products';
import { listTaxClasses } from '../services/taxClasses';

// ─── Settings ───────────────────────────────────────────────────────────────

export const settingsRouter = Router();

/** Non-sensitive subset of settings for unauthenticated screens. */
export const publicSettings: RequestHandler = async (_req, res) => {
  const s = await getSettings();
  res.json({
    storeName: s.storeName,
    currency: s.currency,
    locale: s.locale,
    loyalty: s.loyalty,
    promoBanners: s.promoBanners,
    receiptFooter: s.receiptFooter,
  });
};

settingsRouter.get('/', async (_req, res) => {
  res.json(await getSettings());
});

settingsRouter.put('/', requirePermission('settings:write'), async (req, res) => {
  const patch = body(
    req,
    z
      .object({
        storeName: z.string().min(1).max(80),
        currency: z.string().length(3),
        locale: z.string().min(2).max(20),
        agentMaxDiscountBps: z.number().int().min(0).max(10_000),
        receiptFooter: z.string().max(300),
        loyalty: z.object({
          pointsPerDollar: z.number().int().min(0).max(100),
          redeemBlockPoints: z.number().int().min(1),
          redeemBlockValueCents: z.number().int().min(1),
        }),
        promoBanners: z.array(z.object({ title: z.string().max(80), subtitle: z.string().max(160) })).max(8),
      })
      .partial(),
  );
  const next = await saveSettings(patch);
  refreshAdvertisement(next.storeName);
  await audit({ actorId: req.user!.id, action: 'settings.update', entity: 'Setting', entityId: 'store', details: patch });
  res.json(next);
});

// ─── Audit trail ────────────────────────────────────────────────────────────

export const auditRouter = Router();

auditRouter.get('/', async (req, res) => {
  const q = query(req, z.object({ entity: z.string().optional(), take: z.coerce.number().int().min(1).max(500).default(100) }));
  res.json(
    await prisma.auditLog.findMany({
      where: q.entity ? { entity: q.entity } : undefined,
      include: { actor: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: q.take,
    }),
  );
});

// ─── Offline sync ───────────────────────────────────────────────────────────

export const syncRouter = Router();

/** Delta catalog pull for the terminal's IndexedDB cache. */
syncRouter.get('/catalog', async (req, res) => {
  const { since } = query(req, z.object({ since: z.string().datetime().optional() }));
  const where = since ? { updatedAt: { gt: new Date(since) } } : {};
  const [products, categories] = await Promise.all([
    prisma.product.findMany({ where, include: productInclude }),
    prisma.category.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
  ]);
  res.json({
    serverTime: new Date().toISOString(),
    full: !since,
    products: products.map(toProductDTO),
    categories,
    settings: await getSettings(),
    // Always the full list (a handful of rows): a rate change doesn't touch
    // product rows, so delta product sync alone would never carry it.
    taxClasses: await listTaxClasses(true),
  });
});

/**
 * Replays sales captured while offline. Each sale is independent: one bad
 * sale doesn't block the rest, and replays are idempotent on clientId.
 */
syncRouter.post('/sales', requirePermission('sales:create'), async (req, res) => {
  const { sales } = body(req, z.object({ sales: z.array(z.unknown()).max(200) }));
  const results: { clientId: string; ok: boolean; sale?: SaleDTO; error?: { code?: string; message: string } }[] = [];
  for (const raw of sales) {
    const clientId = (raw as { clientId?: string })?.clientId ?? 'unknown';
    try {
      const input = createSaleSchema.parse(raw) as CreateSaleInput;
      results.push({ clientId, ok: true, sale: await createSale(input, req.user!, { offline: true }) });
    } catch (err) {
      const e = err instanceof HttpError ? { code: err.code, message: err.message } : { message: (err as Error).message };
      results.push({ clientId, ok: false, error: e });
    }
  }
  res.json({ results });
});
