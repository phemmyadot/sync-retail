import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { ProductDTO } from '@sync-retail/shared';
import { prisma } from '../lib/db';
import { body, notFound, query, pid } from '../lib/http';
import { requirePermission } from '../middleware/auth';
import { audit } from '../services/audit';
import { assertAssignable, defaultTaxClassId } from '../services/taxClasses';

export const productsRouter = Router();
export const categoriesRouter = Router();

export const productInclude = { category: { select: { name: true } }, taxClass: { select: { name: true, rateBps: true } } } as const;
const include = productInclude;
type ProductRow = Prisma.ProductGetPayload<{ include: typeof include }>;

export const toProductDTO = (p: ProductRow): ProductDTO => ({
  id: p.id,
  sku: p.sku,
  barcode: p.barcode,
  name: p.name,
  categoryId: p.categoryId,
  categoryName: p.category?.name ?? null,
  costCents: p.costCents,
  priceCents: p.priceCents,
  // The rate always comes from the product's tax class.
  taxRateBps: p.taxClass.rateBps,
  taxClassId: p.taxClassId,
  taxClassName: p.taxClass.name,
  stockQty: p.stockQty,
  lowStockThreshold: p.lowStockThreshold,
  active: p.active,
  updatedAt: p.updatedAt.toISOString(),
});

const productInput = z.object({
  sku: z.string().trim().min(1).max(64),
  barcode: z.string().trim().max(64).nullable().optional(),
  name: z.string().trim().min(1).max(200),
  categoryId: z.string().nullable().optional(),
  costCents: z.number().int().min(0).default(0),
  priceCents: z.number().int().min(0),
  /** Omitted on create → the store's default tax class. */
  taxClassId: z.string().min(1).optional(),
  stockQty: z.number().int().min(0).default(0),
  lowStockThreshold: z.number().int().min(0).default(5),
  active: z.boolean().default(true),
});

productsRouter.get('/', async (req, res) => {
  const q = query(
    req,
    z.object({
      search: z.string().trim().optional(),
      categoryId: z.string().optional(),
      includeInactive: z.coerce.boolean().optional(),
      lowStock: z.coerce.boolean().optional(),
      take: z.coerce.number().int().min(1).max(5000).default(500),
    }),
  );
  const where: Prisma.ProductWhereInput = {
    ...(q.includeInactive ? {} : { active: true }),
    ...(q.categoryId && { categoryId: q.categoryId }),
    ...(q.search && {
      OR: [
        { name: { contains: q.search, mode: 'insensitive' } },
        { sku: { startsWith: q.search, mode: 'insensitive' } },
        { barcode: q.search },
      ],
    }),
  };
  let rows = await prisma.product.findMany({ where, include, orderBy: { name: 'asc' }, take: q.take });
  if (q.lowStock) rows = rows.filter((p) => p.stockQty <= p.lowStockThreshold);
  res.json(rows.map(toProductDTO));
});

/** Scanner lookup — barcode first, SKU as a fallback. */
productsRouter.get('/lookup/:code', async (req, res) => {
  const code = pid(req, 'code').trim();
  const p =
    (await prisma.product.findUnique({ where: { barcode: code }, include })) ??
    (await prisma.product.findUnique({ where: { sku: code }, include }));
  if (!p || !p.active) throw notFound('Product');
  res.json(toProductDTO(p));
});

productsRouter.get('/:id', async (req, res) => {
  const p = await prisma.product.findUnique({ where: { id: pid(req) }, include });
  if (!p) throw notFound('Product');
  const movements = await prisma.stockMovement.findMany({
    where: { productId: p.id },
    orderBy: { createdAt: 'desc' },
    take: 25,
    include: { user: { select: { name: true } } },
  });
  res.json({ ...toProductDTO(p), movements });
});

productsRouter.post('/', requirePermission('products:write'), async (req, res) => {
  const input = body(req, productInput);
  const taxClassId = input.taxClassId ?? (await defaultTaxClassId());
  await assertAssignable(taxClassId);
  const p = await prisma.product.create({ data: { ...input, taxClassId, barcode: input.barcode || null }, include });
  if (p.stockQty)
    await prisma.stockMovement.create({ data: { productId: p.id, type: 'ADJUSTMENT', quantity: p.stockQty, reference: 'Initial stock', userId: req.user!.id } });
  await audit({ actorId: req.user!.id, action: 'product.create', entity: 'Product', entityId: p.id, details: { sku: p.sku } });
  res.status(201).json(toProductDTO(p));
});

productsRouter.patch('/:id', requirePermission('products:write'), async (req, res) => {
  // Stock is changed only through /adjust-stock so every change has a movement row.
  const input = body(req, productInput.omit({ stockQty: true }).partial());
  if (input.taxClassId) await assertAssignable(input.taxClassId);
  const before = await prisma.product.findUnique({ where: { id: pid(req) } });
  if (!before) throw notFound('Product');
  const p = await prisma.product.update({
    where: { id: pid(req) },
    data: { ...input, ...(input.barcode !== undefined && { barcode: input.barcode || null }) },
    include,
  });
  const changed = Object.fromEntries(
    Object.entries(input).filter(([k, v]) => (before as Record<string, unknown>)[k] !== v).map(([k, v]) => [k, { from: (before as Record<string, unknown>)[k] ?? null, to: v ?? null }]),
  );
  await audit({ actorId: req.user!.id, action: 'product.update', entity: 'Product', entityId: p.id, details: changed as Prisma.InputJsonValue });
  res.json(toProductDTO(p));
});

/** Inventory bulk action: "Set tax class" for selected products. */
productsRouter.post('/bulk/tax-class', requirePermission('products:write'), async (req, res) => {
  const { productIds, taxClassId } = body(req, z.object({ productIds: z.array(z.string()).min(1).max(5000), taxClassId: z.string().min(1) }));
  await assertAssignable(taxClassId);
  const { count } = await prisma.product.updateMany({ where: { id: { in: productIds } }, data: { taxClassId } });
  await audit({ actorId: req.user!.id, action: 'product.bulk_tax_class', entity: 'Product', details: { taxClassId, count } });
  res.json({ updated: count });
});

productsRouter.post('/:id/adjust-stock', requirePermission('products:write'), async (req, res) => {
  const { delta, reason } = body(req, z.object({ delta: z.number().int().refine((n) => n !== 0, 'Delta cannot be 0'), reason: z.string().max(200).default('Manual adjustment') }));
  const p = await prisma.$transaction(async (tx) => {
    const updated = await tx.product.update({ where: { id: pid(req) }, data: { stockQty: { increment: delta } }, include });
    await tx.stockMovement.create({ data: { productId: updated.id, type: 'ADJUSTMENT', quantity: delta, reference: reason, userId: req.user!.id } });
    return updated;
  });
  res.json(toProductDTO(p));
});

productsRouter.delete('/:id', requirePermission('products:write'), async (req, res) => {
  // Soft-delete: sale history keeps referencing the product.
  const p = await prisma.product.update({ where: { id: pid(req) }, data: { active: false }, include });
  await audit({ actorId: req.user!.id, action: 'product.archive', entity: 'Product', entityId: p.id });
  res.json(toProductDTO(p));
});

// ─── Categories ─────────────────────────────────────────────────────────────

categoriesRouter.get('/', async (_req, res) => {
  res.json(await prisma.category.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }));
});

const categoryInput = z.object({
  name: z.string().trim().min(1).max(60),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).nullable().optional(),
  sortOrder: z.number().int().default(0),
});

categoriesRouter.post('/', requirePermission('products:write'), async (req, res) => {
  res.status(201).json(await prisma.category.create({ data: body(req, categoryInput) }));
});

categoriesRouter.patch('/:id', requirePermission('products:write'), async (req, res) => {
  res.json(await prisma.category.update({ where: { id: pid(req) }, data: body(req, categoryInput.partial()) }));
});

categoriesRouter.delete('/:id', requirePermission('products:write'), async (req, res) => {
  await prisma.category.delete({ where: { id: pid(req) } });
  res.status(204).end();
});
