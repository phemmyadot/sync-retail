import * as XLSX from 'xlsx';
import {
  missingRequiredFields,
  validateImportRows,
  type ColumnMapping,
  type ExistingCatalog,
  type ImportMode,
  type NormalizedProduct,
  type RawRow,
  type SessionUser,
  type TaxMapping,
} from '@sync-retail/shared';
import { prisma, type Tx } from '../lib/db';
import { badRequest } from '../lib/http';
import { audit } from './audit';
import { defaultTaxClassId, listTaxClasses } from './taxClasses';

export const MAX_IMPORT_ROWS = 20_000;

/** Parses the first sheet of a CSV/XLS/XLSX buffer into header + row objects. */
export function parseSpreadsheet(buffer: Buffer): { sheetName: string; headers: string[]; rows: RawRow[] } {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, raw: false });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw badRequest('The file contains no sheets');
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<RawRow>(sheet, { defval: '', raw: false });
  const headerRow = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, blankrows: false })[0] ?? [];
  const headers = headerRow.map((h) => String(h).trim()).filter(Boolean);
  if (rows.length > MAX_IMPORT_ROWS) throw badRequest(`Files are limited to ${MAX_IMPORT_ROWS.toLocaleString()} rows`);
  return { sheetName, headers, rows };
}

async function loadExisting(skus: string[], barcodes: string[]): Promise<ExistingCatalog> {
  const found = await prisma.product.findMany({
    where: { OR: [{ sku: { in: skus } }, { barcode: { in: barcodes } }] },
    select: { sku: true, barcode: true },
  });
  return {
    skus: new Map(found.filter((p) => skus.includes(p.sku)).map((p) => [p.sku, p.barcode])),
    barcodes: new Map(found.filter((p) => p.barcode).map((p) => [p.barcode as string, p.sku])),
  };
}

/** Review-step choices must point at real, unarchived classes; new names must be free. */
async function checkTaxMapping(taxMapping: TaxMapping | undefined) {
  if (!taxMapping) return;
  const classes = await listTaxClasses(true);
  for (const [value, choice] of Object.entries(taxMapping)) {
    if ('taxClassId' in choice) {
      const c = classes.find((x) => x.id === choice.taxClassId);
      if (!c || c.archived) throw badRequest(`Tax mapping for "${value}" points at an unknown or archived class`);
    } else if ('create' in choice) {
      if (!choice.create.name.trim() || choice.create.rateBps < 0 || choice.create.rateBps > 10_000) {
        throw badRequest(`Tax mapping for "${value}": new class needs a name and a rate between 0 and 100 %`);
      }
    }
  }
}

export async function validateImport(rows: RawRow[], mapping: ColumnMapping, mode: ImportMode, taxMapping?: TaxMapping) {
  const missing = missingRequiredFields(mapping);
  if (missing.length) throw badRequest(`Map these required fields first: ${missing.join(', ')}`);
  if (rows.length > MAX_IMPORT_ROWS) throw badRequest(`Imports are limited to ${MAX_IMPORT_ROWS} rows`);

  const pick = (key: keyof ColumnMapping) =>
    mapping[key] ? rows.map((r) => String(r[mapping[key] as string] ?? '').trim()).filter(Boolean) : [];
  const existing = await loadExisting(pick('sku'), pick('barcode').map((b) => b.replace(/\.0+$/, '')));
  await checkTaxMapping(taxMapping);
  return validateImportRows(rows, mapping, existing, mode, { classes: await listTaxClasses(true), mapping: taxMapping });
}

/**
 * Turns a row's tax decision into a class id.
 * - new products: blank / "use default" → default class
 * - existing products: blank → unchanged (undefined); explicit "use default" → default class
 */
function taxClassFor(d: NormalizedProduct, isUpdate: boolean, defaultId: string, created: Map<string, string>): string | undefined {
  const t = d.tax;
  if (!t) return isUpdate ? undefined : defaultId;
  if ('taxClassId' in t) return t.taxClassId;
  if ('create' in t) return created.get(t.create.name.trim().toLowerCase());
  return isUpdate && d.taxValue === null ? undefined : defaultId;
}

/** Creates classes chosen in the review step (or reuses one that already has that name). */
async function createMappedClasses(tx: Tx, taxMapping: TaxMapping | undefined, userId: string) {
  const created = new Map<string, string>();
  for (const choice of Object.values(taxMapping ?? {})) {
    if (!('create' in choice)) continue;
    const name = choice.create.name.trim();
    const key = name.toLowerCase();
    if (created.has(key)) continue;
    const existing = await tx.taxClass.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
    const c = existing ?? (await tx.taxClass.create({ data: { name, rateBps: choice.create.rateBps } }));
    if (!existing) await audit({ actorId: userId, action: 'tax_class.create', entity: 'TaxClass', entityId: c.id, details: { name, rateBps: c.rateBps, via: 'import' } }, tx);
    created.set(key, c.id);
  }
  return created;
}

/**
 * Re-validates server side, then upserts every valid row in a single
 * transaction. Invalid rows are skipped and reported back.
 */
export async function commitImport(
  input: { fileName: string; rows: RawRow[]; mapping: ColumnMapping; mode: ImportMode; taxMapping?: TaxMapping },
  user: SessionUser,
) {
  const result = await validateImport(input.rows, input.mapping, input.mode, input.taxMapping);
  const valid = result.rows.filter((r) => r.data);

  const categoryNames = [...new Set(valid.map((r) => r.data!.category).filter((c): c is string => !!c))];

  const batch = await prisma.$transaction(
    async (tx) => {
      const defaultId = await defaultTaxClassId(tx);
      const createdClasses = await createMappedClasses(tx, input.taxMapping, user.id);
      const categoryIds = new Map<string, string>();
      for (const name of categoryNames) {
        const c = await tx.category.upsert({ where: { name }, create: { name }, update: {} });
        categoryIds.set(name, c.id);
      }

      let created = 0;
      let updated = 0;
      for (const { data, action } of valid) {
        const d = data!;
        const categoryId = d.category ? categoryIds.get(d.category) : undefined;
        if (action === 'update') {
          const before = await tx.product.findUniqueOrThrow({ where: { sku: d.sku }, select: { id: true, stockQty: true } });
          await tx.product.update({
            where: { sku: d.sku },
            data: {
              name: d.name,
              barcode: d.barcode ?? undefined,
              priceCents: d.priceCents,
              ...(d.costCents !== null && { costCents: d.costCents }),
              ...(taxClassFor(d, true, defaultId, createdClasses) && { taxClassId: taxClassFor(d, true, defaultId, createdClasses) }),
              ...(d.stockQty !== null && { stockQty: d.stockQty }),
              ...(categoryId && { categoryId }),
              active: true,
            },
          });
          if (d.stockQty !== null && d.stockQty !== before.stockQty) {
            await tx.stockMovement.create({
              data: { productId: before.id, type: 'IMPORT', quantity: d.stockQty - before.stockQty, reference: input.fileName, userId: user.id },
            });
          }
          updated++;
        } else {
          const p = await tx.product.create({
            data: {
              sku: d.sku,
              barcode: d.barcode,
              name: d.name,
              priceCents: d.priceCents,
              costCents: d.costCents ?? 0,
              taxClassId: taxClassFor(d, false, defaultId, createdClasses)!,
              stockQty: d.stockQty ?? 0,
              categoryId,
            },
          });
          if (p.stockQty) {
            await tx.stockMovement.create({
              data: { productId: p.id, type: 'IMPORT', quantity: p.stockQty, reference: input.fileName, userId: user.id },
            });
          }
          created++;
        }
      }

      const b = await tx.importBatch.create({
        data: { fileName: input.fileName, userId: user.id, mode: input.mode, created, updated, skipped: result.summary.invalid },
      });
      await audit({ actorId: user.id, action: 'inventory.import', entity: 'ImportBatch', entityId: b.id, details: { created, updated, skipped: b.skipped } }, tx);
      return b;
    },
    { timeout: 120_000, maxWait: 10_000 },
  );

  return {
    batchId: batch.id,
    created: batch.created,
    updated: batch.updated,
    skipped: batch.skipped,
    errors: result.rows.filter((r) => r.errors.length).map((r) => ({ rowNumber: r.rowNumber, errors: r.errors })),
  };
}
