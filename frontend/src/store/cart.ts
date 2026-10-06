import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { priceCart, type CustomerDTO, type LineDiscount, type ParkedLine, type ProductDTO } from '@sync-retail/shared';

export interface CartLine {
  key: string;
  productId: string;
  sku: string;
  name: string;
  unitPriceCents: number;
  taxRateBps: number;
  quantity: number;
  discount: LineDiscount | null;
}

interface CartState {
  lines: CartLine[];
  customer: CustomerDTO | null;
  /** Override tokens collected while ringing up; sent with the sale for the audit trail. */
  approvals: string[];
  lastAddedKey: string | null;
  add: (p: ProductDTO, qty?: number) => void;
  setQty: (key: string, qty: number) => void;
  remove: (key: string) => void;
  setDiscount: (key: string, d: LineDiscount | null) => void;
  setCustomer: (c: CustomerDTO | null) => void;
  addApproval: (token: string) => void;
  /** Replaces the cart with a resumed held sale. */
  load: (lines: ParkedLine[], customer: CustomerDTO | null, approvals: string[]) => void;
  clear: () => void;
}

export const useCart = create<CartState>()(
  persist(
    (set) => ({
      lines: [],
      customer: null,
      approvals: [],
      lastAddedKey: null,
      add: (p, qty = 1) =>
        set((s) => {
          const existing = s.lines.find((l) => l.productId === p.id && !l.discount);
          if (existing) {
            return {
              lastAddedKey: existing.key,
              lines: s.lines.map((l) => (l.key === existing.key ? { ...l, quantity: l.quantity + qty } : l)),
            };
          }
          const key = `${p.id}:${Date.now().toString(36)}`;
          return {
            lastAddedKey: key,
            lines: [
              ...s.lines,
              { key, productId: p.id, sku: p.sku, name: p.name, unitPriceCents: p.priceCents, taxRateBps: p.taxRateBps, quantity: qty, discount: null },
            ],
          };
        }),
      setQty: (key, qty) =>
        set((s) => ({ lines: qty <= 0 ? s.lines.filter((l) => l.key !== key) : s.lines.map((l) => (l.key === key ? { ...l, quantity: qty } : l)) })),
      remove: (key) => set((s) => ({ lines: s.lines.filter((l) => l.key !== key) })),
      setDiscount: (key, d) => set((s) => ({ lines: s.lines.map((l) => (l.key === key ? { ...l, discount: d } : l)) })),
      setCustomer: (customer) => set({ customer }),
      addApproval: (token) => set((s) => ({ approvals: [...s.approvals, token] })),
      load: (lines, customer, approvals) =>
        set({
          lines: lines.map((l, i) => ({
            key: `${l.productId}:${Date.now().toString(36)}${i}`,
            productId: l.productId,
            sku: l.sku,
            name: l.name,
            unitPriceCents: l.unitPriceCents,
            taxRateBps: l.taxRateBps,
            quantity: l.quantity,
            discount: l.discount,
          })),
          customer,
          approvals,
          lastAddedKey: null,
        }),
      clear: () => set({ lines: [], customer: null, approvals: [], lastAddedKey: null }),
    }),
    { name: 'sr-cart' }, // survives an accidental reload mid-sale
  ),
);

export const cartTotals = (lines: CartLine[]) => priceCart(lines);
