/**
 * Spreadsheet import: column mapping + row validation.
 * Runs in the browser for instant preview and on the server as the authority.
 */
import { parseMoneyToCents } from './pricing';
import { resolveTaxValue, taxValueKey, type TaxClassDTO, type TaxMapping } from './tax';

export const IMPORT_FIELDS = [
  { key: 'sku', label: 'SKU', required: true, aliases: ['sku', 'item code', 'product code', 'code', 'article', 'item #', 'item no'] },
  { key: 'barcode', label: 'Barcode', required: false, aliases: ['barcode', 'upc', 'ean', 'gtin', 'bar code'] },
  { key: 'name', label: 'Name', required: true, aliases: ['name', 'item name', 'product name', 'product', 'title', 'item', 'description'] },
  { key: 'category', label: 'Category', required: false, aliases: ['category', 'dept', 'department', 'group', 'section', 'type'] },
  { key: 'costPrice', label: 'Cost price', required: false, aliases: ['cost', 'cost price', 'unit cost', 'buy price', 'purchase price', 'wholesale'] },
  { key: 'retailPrice', label: 'Retail price', required: true, aliases: ['price', 'retail', 'retail price', 'sell price', 'selling price', 'msrp', 'unit price', 'sale price'] },
  // Tax class by name ("VAT 7.5%"), code ("VAT") or rate ("7.5%"); blank = store default.
  { key: 'taxClass', label: 'Tax class', required: false, aliases: ['tax class', 'tax', 'vat', 'tax rate', 'tax %', 'gst', 'sales tax', 'tax code'] },
  { key: 'stockQuantity', label: 'Stock qty', required: false, aliases: ['stock', 'qty', 'quantity', 'on hand', 'inventory', 'stock qty', 'stock quantity', 'count'] },
] as const;

export type ImportFieldKey = (typeof IMPORT_FIELDS)[number]['key'];
/** field → source column header (or null when unmapped). */
export type ColumnMapping = Record<ImportFieldKey, string | null>;
export type RawRow = Record<string, unknown>;

export interface NormalizedProduct {
  sku: string;
  barcode: string | null;
  name: string;
  category: string | null;
  costCents: number | null;
  priceCents: number;
  /** The tax cell as typed (null = blank). */
  taxValue: string | null;
  /**
   * Resolved class: an id, `null` = blank → default class for new products /
   * unchanged for existing ones, or `{ create }` when the admin chose to create
   * a class in the review step. Undefined when no tax context was supplied.
   */
  tax?: { taxClassId: string } | { useDefault: true } | { create: { name: string; rateBps: number } };
  stockQty: number | null;
}

export type RowAction = 'create' | 'update' | 'skip';

export interface ValidatedRow {
  /** 1-based row number as the user sees it in Excel (header = row 1). */
  rowNumber: number;
  /** Raw SKU / name as typed, so invalid rows can still be identified in the preview. */
  preview: { sku: string; name: string };
  data: NormalizedProduct | null;
  errors: string[];
  warnings: string[];
  action: RowAction;
}

export interface ValidationSummary {
  total: number;
  valid: number;
  invalid: number;
  creates: number;
  updates: number;
  warnings: number;
  /** Distinct tax values that need a decision in the review step. */
  taxIssues: TaxIssue[];
}

export interface TaxIssue {
  key: string; // normalised value (see taxValueKey)
  raw: string; // as first seen in the file
  rows: number;
  kind: 'unresolved' | 'ambiguous';
  candidates: string[]; // tax class ids sharing the rate (ambiguous)
}

/** Tax classes + review-step choices; omit to skip tax resolution entirely. */
export interface ImportTaxContext {
  classes: Pick<TaxClassDTO, 'id' | 'name' | 'code' | 'rateBps' | 'archived'>[];
  mapping?: TaxMapping;
}

export interface ExistingCatalog {
  /** sku → barcode currently stored. */
  skus: Map<string, string | null>;
  /** barcode → sku that owns it. */
  barcodes: Map<string, string>;
}

export type ImportMode = 'upsert' | 'createOnly';

const norm = (s: string) => s.toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();

export function suggestMapping(headers: string[]): ColumnMapping {
  const mapping = Object.fromEntries(IMPORT_FIELDS.map((f) => [f.key, null])) as ColumnMapping;
  const used = new Set<string>();
  const normalized = headers.map((h) => ({ h, n: norm(h) }));

  // Pass 1: exact alias matches. Pass 2: header contains an alias.
  for (const exact of [true, false]) {
    for (const field of IMPORT_FIELDS) {
      if (mapping[field.key]) continue;
      const hit = normalized.find(
        ({ h, n }) =>
          !used.has(h) && (field.aliases as readonly string[]).some((a) => (exact ? n === a : n.includes(a))),
      );
      if (hit) {
        mapping[field.key] = hit.h;
        used.add(hit.h);
      }
    }
  }
  return mapping;
}

export function missingRequiredFields(mapping: ColumnMapping): ImportFieldKey[] {
  return IMPORT_FIELDS.filter((f) => f.required && !mapping[f.key]).map((f) => f.key);
}

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());

function normalizeRow(raw: RawRow, mapping: ColumnMapping) {
  const get = (k: ImportFieldKey) => (mapping[k] ? raw[mapping[k] as string] : undefined);
  const errors: string[] = [];
  const warnings: string[] = [];

  const sku = str(get('sku'));
  const name = str(get('name'));
  const barcode = str(get('barcode')).replace(/\.0+$/, '') || null; // Excel loves 1.23E+12 / "123.0"
  const category = str(get('category')) || null;

  if (!sku) errors.push('Missing SKU');
  if (!name) errors.push('Missing product name');
  if (barcode && !/^[\w\-]+$/.test(barcode)) errors.push(`Barcode "${barcode}" contains invalid characters`);

  const priceRaw = get('retailPrice');
  const priceCents = parseMoneyToCents(priceRaw);
  if (priceCents === null) errors.push(str(priceRaw) ? `Retail price "${str(priceRaw)}" is not a number` : 'Missing retail price');
  else if (priceCents < 0) errors.push('Retail price cannot be negative');
  else if (priceCents === 0) warnings.push('Retail price is 0.00');

  const costRaw = get('costPrice');
  const costCents = parseMoneyToCents(costRaw);
  if (str(costRaw) && costCents === null) errors.push(`Cost price "${str(costRaw)}" is not a number`);
  else if (costCents !== null && costCents < 0) errors.push('Cost price cannot be negative');
  else if (costCents !== null && priceCents !== null && costCents > priceCents)
    warnings.push('Cost is higher than retail price (selling at a loss)');

  const taxValue = str(get('taxClass')) || null;

  const stockRaw = str(get('stockQuantity'));
  let stockQty: number | null = null;
  if (stockRaw) {
    const n = Number(stockRaw.replace(/,/g, ''));
    if (!Number.isFinite(n)) errors.push(`Stock "${stockRaw}" is not a number`);
    else if (n < 0) errors.push(`Negative stock (${n}) is not allowed`);
    else if (!Number.isInteger(n)) {
      stockQty = Math.floor(n);
      warnings.push(`Stock ${n} rounded down to ${stockQty}`);
    } else stockQty = n;
  }

  const data: NormalizedProduct | null = errors.length
    ? null
    : {
        sku,
        barcode,
        name,
        category,
        costCents,
        priceCents: priceCents as number,
        taxValue,
        stockQty,
      };
  return { data, errors, warnings, sku, barcode, name };
}

export function validateImportRows(
  rows: RawRow[],
  mapping: ColumnMapping,
  existing: ExistingCatalog = { skus: new Map(), barcodes: new Map() },
  mode: ImportMode = 'upsert',
  tax?: ImportTaxContext,
): { rows: ValidatedRow[]; summary: ValidationSummary } {
  const seenSku = new Map<string, number>();
  const issues = new Map<string, TaxIssue>();
  const seenBarcode = new Map<string, number>();
  const out: ValidatedRow[] = [];

  rows.forEach((raw, i) => {
    const rowNumber = i + 2;
    const { data, errors, warnings, sku, barcode, name } = normalizeRow(raw, mapping);

    if (sku) {
      const key = sku.toUpperCase();
      const first = seenSku.get(key);
      if (first) errors.push(`Duplicate SKU — already used on row ${first}`);
      else seenSku.set(key, rowNumber);
    }
    if (barcode) {
      const first = seenBarcode.get(barcode);
      if (first) errors.push(`Duplicate barcode — already used on row ${first}`);
      else seenBarcode.set(barcode, rowNumber);
      const owner = existing.barcodes.get(barcode);
      if (owner && owner.toUpperCase() !== sku.toUpperCase())
        errors.push(`Barcode already belongs to existing SKU ${owner}`);
    }

    // Tax class: resolve, or apply the admin's review-step choice, or flag it.
    if (tax && data) {
      const r = resolveTaxValue(data.taxValue, tax.classes);
      if (r.kind === 'class') data.tax = { taxClassId: r.taxClassId };
      else if (r.kind === 'default') data.tax = { useDefault: true };
      else {
        const key = taxValueKey(data.taxValue!);
        const choice = tax.mapping?.[key];
        if (choice) data.tax = choice;
        else {
          const issue = issues.get(key) ?? { key, raw: data.taxValue!, rows: 0, kind: r.kind, candidates: r.kind === 'ambiguous' ? r.candidates : [] };
          issue.rows++;
          issues.set(key, issue);
          errors.push(
            r.kind === 'ambiguous'
              ? `Tax "${data.taxValue}" matches more than one tax class — choose one in the review step`
              : `Unknown tax class "${data.taxValue}" — map it in the review step`,
          );
        }
      }
    }

    let action: RowAction = 'create';
    if (sku && existing.skus.has(sku)) {
      if (mode === 'createOnly') errors.push('SKU already exists in catalog');
      else {
        action = 'update';
        warnings.push('Existing SKU — product will be updated');
      }
    }
    if (errors.length) action = 'skip';
    out.push({ rowNumber, preview: { sku, name }, data: errors.length ? null : data, errors, warnings, action });
  });

  const summary: ValidationSummary = {
    total: out.length,
    valid: out.filter((r) => r.action !== 'skip').length,
    invalid: out.filter((r) => r.action === 'skip').length,
    creates: out.filter((r) => r.action === 'create').length,
    updates: out.filter((r) => r.action === 'update').length,
    warnings: out.filter((r) => r.warnings.length > 0).length,
    taxIssues: [...issues.values()].sort((a, b) => b.rows - a.rows),
  };
  return { rows: out, summary };
}
