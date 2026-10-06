import { describe, expect, it } from 'vitest';
import { priceCart } from './pricing';
import { percentToBps, resolveTaxValue, starterTaxClasses, taxBreakdown, taxMarkers, type TaxedLine } from './tax';
import { suggestMapping, validateImportRows } from './importer';

const VAT = { id: 'vat', name: 'VAT 7.5%', code: 'VAT', rateBps: 750, archived: false };
const ZR = { id: 'zr', name: 'Zero-rated', code: 'ZR', rateBps: 0, archived: false };
const EX = { id: 'ex', name: 'Exempt', code: 'EX', rateBps: 0, archived: false };
const LUX = { id: 'lux', name: 'Luxury', code: null, rateBps: 1500, archived: false };

describe('tax engine — plan §4.3 worked example', () => {
  const lines: TaxedLine[] = [
    { unitPriceCents: 8_500_000, quantity: 1, taxRateBps: 750, taxClassId: 'vat', taxClassName: 'VAT 7.5%' }, // Rice
    { unitPriceCents: 125_000, quantity: 3, taxRateBps: 750, taxClassId: 'vat', taxClassName: 'VAT 7.5%', discount: { type: 'PERCENT', value: 1000 } }, // Bread −10 %
    { unitPriceCents: 999_900, quantity: 2, taxRateBps: 0, taxClassId: 'zr', taxClassName: 'Zero-rated' }, // Formula
  ];
  const totals = priceCart(lines);
  const breakdown = taxBreakdown(lines, totals);

  it('computes item-level tax on the final (discounted) price, rounded half-up per line', () => {
    expect(totals.lines.map((l) => l.taxCents)).toEqual([637_500, 25_313, 0]); // ₦6,375.00 · ₦253.13 · ₦0
  });

  it('matches the printed totals', () => {
    expect(totals.subtotalCents).toBe(10_874_800); // ₦108,748.00
    expect(totals.discountCents).toBe(37_500); // ₦375.00
    expect(totals.taxCents).toBe(662_813); // ₦6,628.13
    expect(totals.totalCents).toBe(11_500_113); // ₦115,001.13
  });

  it('groups by class and the breakdown adds up exactly to total tax', () => {
    expect(breakdown).toEqual([
      { taxClassId: 'vat', name: 'VAT 7.5%', rateBps: 750, taxableCents: 8_837_500, taxCents: 662_813 },
      { taxClassId: 'zr', name: 'Zero-rated', rateBps: 0, taxableCents: 1_999_800, taxCents: 0 },
    ]);
    expect(breakdown.reduce((a, b) => a + b.taxCents, 0)).toBe(totals.taxCents);
  });

  it('assigns receipt markers by rate', () => {
    const m = taxMarkers(breakdown);
    expect(m.get('vat')).toBe('A');
    expect(m.get('zr')).toBe('B');
  });
});

describe('tax engine — edge cases', () => {
  it('rounds .5 kobo up', () => {
    // ₦0.70 at 7.5 % = 5.25 kobo → 5; ₦1.00 at 7.5 % = 7.5 kobo → 8
    const t = priceCart([
      { unitPriceCents: 70, quantity: 1, taxRateBps: 750 },
      { unitPriceCents: 100, quantity: 1, taxRateBps: 750 },
    ]);
    expect(t.lines.map((l) => l.taxCents)).toEqual([5, 8]);
  });

  it('applies amount discounts before tax and never taxes below zero', () => {
    const t = priceCart([{ unitPriceCents: 1_000, quantity: 1, taxRateBps: 1_500, discount: { type: 'AMOUNT', value: 5_000 } }]);
    expect(t.lines[0]).toMatchObject({ netCents: 0, taxCents: 0, totalCents: 0 });
  });

  it('handles 0 % and 100 % classes', () => {
    const t = priceCart([
      { unitPriceCents: 5_000, quantity: 2, taxRateBps: 0 },
      { unitPriceCents: 5_000, quantity: 1, taxRateBps: 10_000 },
    ]);
    expect(t.taxCents).toBe(5_000);
  });

  it('separates zero-rated and exempt even though both are 0 %', () => {
    const lines: TaxedLine[] = [
      { unitPriceCents: 100, quantity: 1, taxRateBps: 0, taxClassId: 'zr', taxClassName: 'Zero-rated' },
      { unitPriceCents: 100, quantity: 1, taxRateBps: 0, taxClassId: 'ex', taxClassName: 'Exempt' },
    ];
    expect(taxBreakdown(lines, priceCart(lines)).map((b) => b.name)).toEqual(['Exempt', 'Zero-rated']);
  });
});

describe('percentToBps', () => {
  it('accepts up to two decimals in 0–100', () => {
    expect(percentToBps(7.5)).toBe(750);
    expect(percentToBps('12.25%')).toBe(1225);
    expect(percentToBps(0)).toBe(0);
    expect(percentToBps(100)).toBe(10_000);
    expect(percentToBps(7.555)).toBeNull();
    expect(percentToBps(-1)).toBeNull();
    expect(percentToBps(101)).toBeNull();
    expect(percentToBps('abc')).toBeNull();
  });
});

describe('starter classes', () => {
  it('NGN stores get VAT 7.5 % (default), Zero-rated and Exempt', () => {
    const s = starterTaxClasses('NGN');
    expect(s.map((c) => [c.name, c.rateBps, c.isDefault])).toEqual([
      ['VAT 7.5%', 750, true],
      ['Zero-rated', 0, false],
      ['Exempt', 0, false],
    ]);
  });
});

describe('import resolution', () => {
  const classes = [VAT, ZR, EX, LUX];
  it.each([
    ['', { kind: 'default' }],
    ['VAT 7.5%', { kind: 'class', taxClassId: 'vat' }],
    ['vat', { kind: 'class', taxClassId: 'vat' }],
    ['  zero-RATED ', { kind: 'class', taxClassId: 'zr' }],
    ['7.5%', { kind: 'class', taxClassId: 'vat' }],
    ['7.5', { kind: 'class', taxClassId: 'vat' }],
    ['0.075', { kind: 'class', taxClassId: 'vat' }],
    ['15', { kind: 'class', taxClassId: 'lux' }],
    ['0%', { kind: 'ambiguous', candidates: ['zr', 'ex'] }],
    ['VAT 7.5 percent', { kind: 'unresolved' }],
    ['12%', { kind: 'unresolved' }],
  ])('"%s"', (raw, expected) => {
    expect(resolveTaxValue(raw, classes)).toEqual(expected);
  });

  it('ignores archived classes', () => {
    expect(resolveTaxValue('Luxury', [{ ...LUX, archived: true }])).toEqual({ kind: 'unresolved' });
  });

  const headers = ['SKU', 'Item Name', 'Sell Price', 'VAT'];
  const mapping = suggestMapping(headers);
  const rows = [
    { SKU: 'A1', 'Item Name': 'Rice', 'Sell Price': '85000', VAT: 'VAT 7.5%' },
    { SKU: 'A2', 'Item Name': 'Bread', 'Sell Price': '1250', VAT: '' },
    { SKU: 'A3', 'Item Name': 'Formula', 'Sell Price': '9999', VAT: '0%' },
    { SKU: 'A4', 'Item Name': 'Wine', 'Sell Price': '15000', VAT: 'Luxury tax 15 %' },
    { SKU: 'A5', 'Item Name': 'Cognac', 'Sell Price': '45000', VAT: 'luxury tax 15 %' },
  ];

  it('maps a "VAT" column to the tax class field', () => {
    expect(mapping.taxClass).toBe('VAT');
  });

  it('flags unknown and ambiguous values for review, grouped by value', () => {
    const r = validateImportRows(rows, mapping, undefined, 'upsert', { classes });
    expect(r.rows[0].data?.tax).toEqual({ taxClassId: 'vat' });
    expect(r.rows[1].data?.tax).toEqual({ useDefault: true });
    expect(r.summary.invalid).toBe(3);
    expect(r.summary.taxIssues).toEqual([
      { key: 'luxury tax 15 %', raw: 'Luxury tax 15 %', rows: 2, kind: 'unresolved', candidates: [] },
      { key: '0%', raw: '0%', rows: 1, kind: 'ambiguous', candidates: ['zr', 'ex'] },
    ]);
  });

  it('applies review-step choices (existing class, create, default)', () => {
    const r = validateImportRows(rows, mapping, undefined, 'upsert', {
      classes,
      mapping: { '0%': { taxClassId: 'zr' }, 'luxury tax 15 %': { create: { name: 'Luxury 15%', rateBps: 1500 } } },
    });
    expect(r.summary.invalid).toBe(0);
    expect(r.summary.taxIssues).toEqual([]);
    expect(r.rows[2].data?.tax).toEqual({ taxClassId: 'zr' });
    expect(r.rows[3].data?.tax).toEqual({ create: { name: 'Luxury 15%', rateBps: 1500 } });
  });
});
