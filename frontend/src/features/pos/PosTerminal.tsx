import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  effectiveDiscountBps,
  OVERRIDE_LABEL,
  priceCart,
  pointsEarned as calcPoints,
  summarizeTenders,
  type CreateSaleInput,
  type LineDiscount,
  type ProductDTO,
  type SaleDTO,
  type SaleTenderInput,
} from '@sync-retail/shared';
import { useCatalog } from '@/hooks/useCatalog';
import { useBarcodeScanner } from '@/hooks/useBarcodeScanner';
import { useCan, useOverride } from '@/hooks/useOverride';
import { useSettings } from '@/hooks/useSettings';
import { useCart, type CartLine } from '@/store/cart';
import { useAuth } from '@/store/auth';
import { OverrideCancelled } from '@/store/override';
import { toast } from '@/store/toast';
import { api, ApiError, NetworkError } from '@/lib/api';
import { localDb } from '@/lib/db';
import { DisplayPublisher } from '@/lib/display';
import { nextReceiptNo, openCustomerDisplay } from '@/lib/platform';
import { queueSale } from '@/lib/sync';
import { TERMINAL_ID } from '@/lib/config';
import { useMoney } from '@/lib/format';
import { Icon } from '@/components/ui/Icon';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/primitives';
import { ProductGrid } from './ProductGrid';
import { CartPanel } from './CartPanel';
import { DiscountModal } from './DiscountModal';
import { CustomerPicker } from './CustomerPicker';
import { CheckoutModal } from './CheckoutModal';
import { Receipt, saleToReceipt, type ReceiptData } from './Receipt';

export function PosTerminal() {
  const { products, categories, ready, lookup } = useCatalog();
  const cart = useCart();
  const user = useAuth((s) => s.user)!;
  const authorize = useOverride();
  const can = useCan();
  const money = useMoney();
  const { data: settings } = useSettings();

  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [scanMiss, setScanMiss] = useState<string | null>(null);
  const [discountLine, setDiscountLine] = useState<CartLine | null>(null);
  const [pickingCustomer, setPickingCustomer] = useState(false);
  const [checkingOut, setCheckingOut] = useState(false);
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const totals = useMemo(() => priceCart(cart.lines), [cart.lines]);

  // ── Customer display sync ────────────────────────────────────────────────
  const publisher = useRef<DisplayPublisher | null>(null);
  useEffect(() => {
    publisher.current = new DisplayPublisher();
    return () => publisher.current?.close();
  }, []);
  useEffect(() => {
    if (receipt) return; // keep the "thank you" screen up until next sale starts
    publisher.current?.send(
      cart.lines.length
        ? {
            type: 'cart',
            lines: cart.lines.map((l, i) => ({
              name: l.name,
              quantity: l.quantity,
              unitPriceCents: l.unitPriceCents,
              discountCents: totals.lines[i].discountCents,
              totalCents: totals.lines[i].netCents,
            })),
            subtotalCents: totals.subtotalCents,
            discountCents: totals.discountCents,
            taxCents: totals.taxCents,
            totalCents: totals.totalCents,
            customer: cart.customer && { name: cart.customer.name, pointsBalance: cart.customer.pointsBalance },
            loyaltyAppliedCents: 0,
          }
        : { type: 'idle' },
    );
  }, [cart.lines, cart.customer, totals, receipt]);

  // ── Adding items ─────────────────────────────────────────────────────────
  const addProduct = useCallback(
    (p: ProductDTO) => {
      cart.add(p);
      setFlashId(p.id);
      setTimeout(() => setFlashId((f) => (f === p.id ? null : f)), 600);
      if (receipt) setReceipt(null);
      if (p.stockQty <= 0) toast.warn(`${p.name} shows 0 in stock`, 'Sale allowed — stock will go negative.');
    },
    [cart, receipt],
  );

  const scan = useCallback(
    async (code: string) => {
      const local = lookup(code);
      if (local) return addProduct(local);
      try {
        const p = await api<ProductDTO>(`/products/lookup/${encodeURIComponent(code)}`);
        await localDb.products.put(p);
        addProduct(p);
      } catch {
        setScanMiss(code);
        setTimeout(() => setScanMiss(null), 2500);
      }
    },
    [lookup, addProduct],
  );

  useBarcodeScanner((code) => void scan(code), { enabled: !checkingOut && !pickingCustomer && !discountLine });

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products.filter(
      (p) =>
        (!category || p.categoryId === category) &&
        (!q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().startsWith(q) || p.barcode === q),
    );
  }, [products, query, category]);

  // ── Guarded cart edits (manager override for agents) ────────────────────
  const guarded = async (action: Parameters<typeof authorize>[0], fn: () => void) => {
    try {
      const token = await authorize(action);
      if (token) cart.addApproval(token);
      fn();
    } catch (err) {
      if (!(err instanceof OverrideCancelled)) throw err;
    }
  };

  const onDec = (l: CartLine) =>
    guarded({ action: 'DECREASE_QTY', detail: `${l.name}: ${l.quantity} → ${l.quantity - 1}`, context: { sku: l.sku, from: l.quantity } }, () =>
      cart.setQty(l.key, l.quantity - 1),
    );
  const onRemove = (l: CartLine) =>
    guarded({ action: 'REMOVE_ITEM', detail: `Remove ${l.quantity} × ${l.name}`, context: { sku: l.sku, quantity: l.quantity } }, () =>
      cart.remove(l.key),
    );
  const onClear = () =>
    guarded(
      { action: 'CLEAR_CART', detail: `Void open sale of ${money(totals.totalCents)} (${totals.itemCount} items)`, requireReason: true },
      () => {
        cart.clear();
        toast.info('Transaction voided');
      },
    );

  const applyDiscount = async (line: CartLine, d: LineDiscount | null) => {
    const bps = effectiveDiscountBps({ ...line, discount: d });
    if (d && bps > (settings?.agentMaxDiscountBps ?? 1000) && !can('cart:discount-unlimited')) {
      try {
        const token = await authorize({ action: 'PRICE_DISCOUNT', detail: `${line.name}: ${(bps / 100).toFixed(1)}% off`, context: { sku: line.sku, bps } });
        if (token) cart.addApproval(token);
      } catch (err) {
        if (err instanceof OverrideCancelled) return;
        throw err;
      }
    }
    cart.setDiscount(line.key, d);
    setDiscountLine(null);
  };

  // ── Completing the sale ──────────────────────────────────────────────────
  const complete = async (tenders: SaleTenderInput[]) => {
    const payload: CreateSaleInput = {
      clientId: crypto.randomUUID(),
      receiptNo: nextReceiptNo(TERMINAL_ID),
      terminalId: TERMINAL_ID,
      customerId: cart.customer?.id ?? null,
      lines: cart.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, discount: l.discount })),
      tenders,
      approvals: cart.approvals,
      createdAt: new Date().toISOString(),
    };
    const t = summarizeTenders(totals.totalCents, tenders);
    let data: ReceiptData;
    try {
      const sale = await api<SaleDTO>('/sales', { method: 'POST', body: payload });
      data = saleToReceipt(sale);
      if (sale.customer) await localDb.customers.update(sale.customer.id, { pointsBalance: sale.customer.pointsBalance });
      for (const l of payload.lines) {
        const p = await localDb.products.get(l.productId);
        if (p) await localDb.products.put({ ...p, stockQty: p.stockQty - l.quantity });
      }
      window.dispatchEvent(new CustomEvent('sr:catalog'));
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.overrideAction) throw new Error(`${OVERRIDE_LABEL[err.overrideAction as keyof typeof OVERRIDE_LABEL] ?? 'Approval'} needs a manager. ${err.message}`);
        throw err;
      }
      if (!(err instanceof NetworkError)) throw err;
      // Offline: queue locally, print a provisional receipt, keep selling.
      await queueSale(payload, totals.totalCents);
      const earned = cart.customer ? calcPoints(t.earningCents, settings!.loyalty) : 0;
      data = {
        receiptNo: payload.receiptNo,
        createdAt: payload.createdAt!,
        cashierName: user.name,
        customer: cart.customer && { name: cart.customer.name },
        lines: cart.lines.map((l, i) => ({
          name: l.name,
          quantity: l.quantity,
          unitPriceCents: l.unitPriceCents,
          discountCents: totals.lines[i].discountCents,
          totalCents: totals.lines[i].netCents,
        })),
        subtotalCents: totals.subtotalCents,
        discountCents: totals.discountCents,
        taxCents: totals.taxCents,
        totalCents: totals.totalCents,
        tenders,
        changeCents: t.changeCents,
        pointsEarned: earned,
        pendingSync: true,
      };
      toast.warn('Offline — sale saved on this register', 'It will sync automatically when the connection returns.');
    }

    publisher.current?.send({
      type: 'complete',
      receiptNo: data.receiptNo,
      totalCents: data.totalCents,
      changeCents: data.changeCents,
      pointsEarned: data.pointsEarned,
      pointsBalance: data.customer?.pointsBalance ?? null,
    });
    setCheckingOut(false);
    setReceipt(data);
    cart.clear();
  };

  // ── Keyboard shortcuts ───────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F2') {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === 'F4') {
        e.preventDefault();
        setPickingCustomer(true);
      } else if (e.key === 'F9' && cart.lines.length) {
        e.preventDefault();
        setCheckingOut(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cart.lines.length]);

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)_auto] lg:grid-cols-[minmax(0,1fr)_minmax(22rem,26rem)] lg:grid-rows-1">
      {/* Catalog side */}
      <section className="flex min-h-0 min-w-0 flex-col">
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4 lg:px-7">
          <div className="relative min-w-[16rem] flex-1">
            <Icon name="search" size={20} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-dust" />
            <input
              ref={searchRef}
              data-scanner="own"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && query.trim()) {
                  const exact = lookup(query);
                  if (exact) addProduct(exact);
                  else if (visible.length === 1) addProduct(visible[0]);
                  else return;
                  setQuery('');
                }
                if (e.key === 'Escape') setQuery('');
              }}
              placeholder="Search name or SKU — or just scan"
              aria-label="Search products"
              className="field h-12 pl-11 pr-16 text-base"
            />
            <kbd className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded-xs border border-line px-1.5 py-0.5 font-mono text-2xs text-dust">F2</kbd>
          </div>
          <div
            className={clsx(
              'hidden h-12 items-center gap-2 rounded-sm border px-3 font-mono text-2xs uppercase tracking-wider transition-colors sm:flex',
              scanMiss ? 'border-vermilion bg-vermilion/10 text-vermilion animate-shake' : 'border-line text-dust',
            )}
            role="status"
          >
            <Icon name="barcode" size={18} />
            {scanMiss ? `No match: ${scanMiss}` : 'Scanner armed'}
            {!scanMiss && <span className="h-1.5 w-1.5 rounded-full bg-mint animate-blink" />}
          </div>
          <Button variant="ghost" icon="monitor" onClick={() => void openCustomerDisplay()} className="hidden xl:inline-flex">
            Customer display
          </Button>
        </div>

        <div className="flex gap-2 overflow-x-auto border-b border-line px-5 py-3 lg:px-7" role="tablist" aria-label="Categories">
          <CategoryChip active={!category} onClick={() => setCategory(null)} label="All" count={products.length} />
          {categories.map((c) => (
            <CategoryChip
              key={c.id}
              active={category === c.id}
              onClick={() => setCategory(c.id)}
              label={c.name}
              color={c.color}
              count={products.filter((p) => p.categoryId === c.id).length}
            />
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 lg:px-7">
          {ready ? (
            <ProductGrid products={visible} categories={categories} onAdd={addProduct} flashId={flashId} />
          ) : (
            <p className="eyebrow animate-blink">Loading catalog…</p>
          )}
        </div>
      </section>

      {/* Receipt side */}
      <div className="flex max-h-[52vh] min-h-0 min-w-0 flex-col border-t border-line bg-ink-2/60 p-4 lg:max-h-none lg:border-l lg:border-t-0 lg:p-5">
        <CartPanel
          totals={totals}
          onInc={(l) => cart.setQty(l.key, l.quantity + 1)}
          onDec={(l) => void onDec(l)}
          onRemove={(l) => void onRemove(l)}
          onDiscount={setDiscountLine}
          onCustomer={() => setPickingCustomer(true)}
          onClear={() => void onClear()}
          onCharge={() => setCheckingOut(true)}
        />
      </div>

      <DiscountModal line={discountLine} onClose={() => setDiscountLine(null)} onApply={(l, d) => void applyDiscount(l, d)} />
      <CustomerPicker
        open={pickingCustomer}
        current={cart.customer}
        onClose={() => setPickingCustomer(false)}
        onPick={(c) => {
          cart.setCustomer(c);
          setPickingCustomer(false);
        }}
      />
      <CheckoutModal
        open={checkingOut}
        totalCents={totals.totalCents}
        customer={cart.customer}
        onClose={() => setCheckingOut(false)}
        onProgress={(paid, remaining) => publisher.current?.send({ type: 'checkout', totalCents: totals.totalCents, paidCents: paid, remainingCents: remaining })}
        onComplete={complete}
      />
      <Modal
        open={!!receipt}
        onClose={() => setReceipt(null)}
        eyebrow={receipt?.pendingSync ? 'Saved offline' : 'Sale complete'}
        title={receipt && receipt.changeCents > 0 ? `Change ${money(receipt.changeCents)}` : 'Thank you'}
        width="sm"
        footer={
          <>
            <Button icon="receipt" onClick={() => window.print()}>
              Print
            </Button>
            <Button variant="primary" iconRight="arrowRight" onClick={() => setReceipt(null)} autoFocus>
              New sale
            </Button>
          </>
        }
      >
        {receipt && <Receipt data={receipt} animate />}
      </Modal>
    </div>
  );
}

function CategoryChip({ active, onClick, label, color, count }: { active: boolean; onClick: () => void; label: string; color?: string | null; count: number }) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={clsx(
        'flex shrink-0 items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm transition-all duration-200',
        active ? 'border-bone bg-bone text-ink' : 'border-line text-dust hover:border-line-strong hover:text-bone',
      )}
    >
      {color && <span className="h-2 w-2 rounded-full" style={{ background: color }} />}
      {label}
      <span className={clsx('font-mono text-2xs', active ? 'text-ink/60' : 'text-dust/80')}>{count}</span>
    </button>
  );
}
