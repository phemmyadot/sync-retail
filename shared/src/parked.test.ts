import { describe, expect, it } from 'vitest';
import { priceCart } from './pricing';
import { reconcileParkedLines, type CurrentProduct, type ParkedLine } from './parked';

const line = (over: Partial<ParkedLine> = {}): ParkedLine => ({
  productId: 'rice',
  sku: 'RICE-50',
  name: 'Rice 50kg',
  quantity: 1,
  unitPriceCents: 8_500_000,
  taxRateBps: 750,
  taxClassId: 'vat',
  taxClassName: 'VAT 7.5%',
  discount: null,
  ...over,
});
const product = (over: Partial<CurrentProduct> = {}): CurrentProduct => ({
  name: 'Rice 50kg',
  priceCents: 8_500_000,
  taxRateBps: 750,
  taxClassId: 'vat',
  taxClassName: 'VAT 7.5%',
  stockQty: 10,
  ...over,
});

describe('reconcileParkedLines', () => {
  it('returns the lines unchanged when nothing moved', () => {
    const held = [line(), line({ productId: 'oil', name: 'Oil', unitPriceCents: 250_000 })];
    const r = reconcileParkedLines(held, (id) => (id === 'rice' ? product() : product({ name: 'Oil', priceCents: 250_000 })));
    expect(r.changes).toEqual([]);
    expect(r.lines).toEqual(held);
    expect(priceCart(r.lines)).toEqual(priceCart(held));
  });

  it('uses the current price and reports the change', () => {
    const r = reconcileParkedLines([line()], () => product({ priceCents: 8_800_000 }));
    expect(r.lines[0].unitPriceCents).toBe(8_800_000);
    expect(r.changes).toEqual([{ kind: 'price', productId: 'rice', name: 'Rice 50kg', from: 8_500_000, to: 8_800_000 }]);
  });

  it('picks up a tax class rate change', () => {
    const r = reconcileParkedLines([line()], () => product({ taxRateBps: 1000, taxClassName: 'VAT 10%' }));
    expect(r.lines[0]).toMatchObject({ taxRateBps: 1000, taxClassName: 'VAT 10%' });
    expect(r.changes[0]).toMatchObject({ kind: 'tax', from: 750, to: 1000 });
  });

  it('drops products that are no longer sold', () => {
    const r = reconcileParkedLines([line(), line({ productId: 'gone', name: 'Sugar 1kg' })], (id) => (id === 'rice' ? product() : undefined));
    expect(r.lines.map((l) => l.productId)).toEqual(['rice']);
    expect(r.changes).toEqual([{ kind: 'removed', productId: 'gone', name: 'Sugar 1kg' }]);
  });

  it('warns once per product when stock is short, summing split lines', () => {
    const held = [line({ quantity: 2 }), line({ quantity: 2, discount: { type: 'PERCENT', value: 1000 } })];
    const r = reconcileParkedLines(held, () => product({ stockQty: 3 }));
    expect(r.lines).toHaveLength(2);
    expect(r.changes).toEqual([{ kind: 'stock', productId: 'rice', name: 'Rice 50kg', from: 4, to: 3 }]);
  });

  it('keeps line discounts through re-pricing', () => {
    const r = reconcileParkedLines([line({ discount: { type: 'PERCENT', value: 1000 } })], () => product({ priceCents: 9_000_000 }));
    const t = priceCart(r.lines);
    expect(t.discountCents).toBe(900_000);
    expect(t.subtotalCents).toBe(9_000_000);
  });
});
