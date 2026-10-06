import type { Prisma, TaxClass } from '@prisma/client';
import { starterTaxClasses, type TaxClassDTO } from '@sync-retail/shared';
import { prisma, type Tx } from '../lib/db';
import { badRequest, conflict, notFound } from '../lib/http';
import { audit } from './audit';

/**
 * Tax class rules (plan §6.1):
 * - exactly one default; the default can't be archived or deleted
 * - a class with products can't be deleted or archived — reassign first
 * - archived classes can't be given to products
 * - every change is audited (rate changes record products affected)
 */

type Db = Tx | typeof prisma;

export const toTaxClassDTO = (c: TaxClass & { _count?: { products: number } }): TaxClassDTO => ({
  id: c.id,
  name: c.name,
  code: c.code,
  rateBps: c.rateBps,
  percentage: c.rateBps / 100,
  isDefault: c.isDefault,
  archived: !!c.archivedAt,
  sortOrder: c.sortOrder,
  productCount: c._count?.products,
});

export async function listTaxClasses(includeArchived = false) {
  const rows = await prisma.taxClass.findMany({
    where: includeArchived ? undefined : { archivedAt: null },
    include: { _count: { select: { products: true } } },
    orderBy: [{ isDefault: 'desc' }, { rateBps: 'desc' }, { name: 'asc' }],
  });
  return rows.map(toTaxClassDTO);
}

/** The default class id; throws a helpful error if a store somehow has none. */
export async function defaultTaxClassId(db: Db = prisma): Promise<string> {
  const d = await db.taxClass.findFirst({ where: { isDefault: true }, select: { id: true } });
  if (!d) throw conflict('No default tax class — create one in Admin → Tax first.');
  return d.id;
}

/** Validates a class can be assigned to a product (exists, not archived). */
export async function assertAssignable(taxClassId: string, db: Db = prisma) {
  const c = await db.taxClass.findUnique({ where: { id: taxClassId }, select: { archivedAt: true } });
  if (!c) throw badRequest('Unknown tax class');
  if (c.archivedAt) throw badRequest('That tax class is archived — choose another');
}

/** Creates the currency's starter classes when a store has none (setup, fresh DBs). */
export async function ensureStarterClasses(currency: string, db: Db = prisma) {
  if ((await db.taxClass.count()) > 0) return;
  for (const [i, c] of starterTaxClasses(currency).entries()) {
    await db.taxClass.create({ data: { ...c, sortOrder: i } });
  }
}

const nameTaken = async (name: string, exceptId?: string) =>
  !!(await prisma.taxClass.findFirst({ where: { name: { equals: name, mode: 'insensitive' }, NOT: exceptId ? { id: exceptId } : undefined } }));
const codeTaken = async (code: string, exceptId?: string) =>
  !!(await prisma.taxClass.findFirst({ where: { code: { equals: code, mode: 'insensitive' }, NOT: exceptId ? { id: exceptId } : undefined } }));

export async function createTaxClass(input: { name: string; code?: string | null; rateBps: number; isDefault?: boolean }, actorId: string) {
  if (await nameTaken(input.name)) throw conflict(`A tax class called "${input.name}" already exists`);
  if (input.code && (await codeTaken(input.code))) throw conflict(`Code "${input.code}" is already used`);
  const created = await prisma.$transaction(async (tx) => {
    const first = (await tx.taxClass.count()) === 0;
    const makeDefault = input.isDefault || first;
    if (makeDefault) await tx.taxClass.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    const c = await tx.taxClass.create({ data: { name: input.name, code: input.code || null, rateBps: input.rateBps, isDefault: makeDefault } });
    await audit({ actorId, action: 'tax_class.create', entity: 'TaxClass', entityId: c.id, details: { name: c.name, rateBps: c.rateBps, isDefault: c.isDefault } }, tx);
    return c;
  });
  return toTaxClassDTO(created);
}

export async function updateTaxClass(
  id: string,
  input: { name?: string; code?: string | null; rateBps?: number; isDefault?: boolean },
  actorId: string,
) {
  const before = await prisma.taxClass.findUnique({ where: { id }, include: { _count: { select: { products: true } } } });
  if (!before) throw notFound('Tax class');
  if (input.name && (await nameTaken(input.name, id))) throw conflict(`A tax class called "${input.name}" already exists`);
  if (input.code && (await codeTaken(input.code, id))) throw conflict(`Code "${input.code}" is already used`);
  if (input.isDefault === false && before.isDefault) throw badRequest('Make another class the default instead');
  if (input.isDefault && before.archivedAt) throw badRequest('An archived class can’t be the default');

  const updated = await prisma.$transaction(async (tx) => {
    if (input.isDefault && !before.isDefault) await tx.taxClass.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    const c = await tx.taxClass.update({
      where: { id },
      data: { name: input.name, code: input.code === undefined ? undefined : input.code || null, rateBps: input.rateBps, isDefault: input.isDefault || undefined },
      include: { _count: { select: { products: true } } },
    });
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const k of ['name', 'code', 'rateBps', 'isDefault'] as const) {
      if (input[k] !== undefined && before[k] !== c[k]) changes[k] = { from: before[k], to: c[k] };
    }
    if (Object.keys(changes).length) {
      await audit(
        { actorId, action: 'tax_class.update', entity: 'TaxClass', entityId: id, details: { ...changes, productsAffected: changes.rateBps ? before._count.products : 0 } as Prisma.InputJsonValue },
        tx,
      );
    }
    return c;
  });
  return { taxClass: toTaxClassDTO(updated), productsAffected: input.rateBps !== undefined && input.rateBps !== before.rateBps ? before._count.products : 0 };
}

/** Moves every product of `fromId` to `toId` in one transaction. */
export async function reassignProducts(fromId: string, toId: string, actorId: string) {
  if (fromId === toId) throw badRequest('Choose a different tax class');
  await assertAssignable(toId);
  return prisma.$transaction(async (tx) => {
    const from = await tx.taxClass.findUnique({ where: { id: fromId } });
    if (!from) throw notFound('Tax class');
    const { count } = await tx.product.updateMany({ where: { taxClassId: fromId }, data: { taxClassId: toId } });
    await audit({ actorId, action: 'tax_class.reassign', entity: 'TaxClass', entityId: fromId, details: { toId, products: count } }, tx);
    return { moved: count };
  });
}

async function assertRemovable(id: string, verb: 'delete' | 'archive') {
  const c = await prisma.taxClass.findUnique({ where: { id }, include: { _count: { select: { products: true } } } });
  if (!c) throw notFound('Tax class');
  if (c.isDefault) throw conflict(`The default tax class can’t be ${verb}d — make another class the default first`);
  if (c._count.products > 0) {
    throw conflict(`${c._count.products} product${c._count.products === 1 ? ' uses' : 's use'} “${c.name}”. Move them to another class first.`);
  }
  return c;
}

export async function archiveTaxClass(id: string, archived: boolean, actorId: string) {
  if (archived) await assertRemovable(id, 'archive');
  const c = await prisma.taxClass.update({ where: { id }, data: { archivedAt: archived ? new Date() : null }, include: { _count: { select: { products: true } } } });
  await audit({ actorId, action: archived ? 'tax_class.archive' : 'tax_class.restore', entity: 'TaxClass', entityId: id, details: { name: c.name } });
  return toTaxClassDTO(c);
}

export async function deleteTaxClass(id: string, actorId: string) {
  const c = await assertRemovable(id, 'delete');
  await prisma.taxClass.delete({ where: { id } }); // FK RESTRICT is the database-level backstop
  await audit({ actorId, action: 'tax_class.delete', entity: 'TaxClass', entityId: id, details: { name: c.name, rateBps: c.rateBps } });
}
