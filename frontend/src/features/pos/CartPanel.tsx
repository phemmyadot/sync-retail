import { useEffect, useRef } from 'react';
import clsx from 'clsx';
import { formatBps, type CartTotals, type TaxBreakdownLine } from '@sync-retail/shared';
import { useMoney } from '@/lib/format';
import { useCart, type CartLine } from '@/store/cart';
import { useSettings } from '@/hooks/useSettings';
import { Icon } from '@/components/ui/Icon';
import { fitClass } from '@/components/ui/Price';
import { getTerminalId } from '@/lib/config';

interface Props {
  totals: CartTotals;
  /** Per-class tax lines (from calculateCartTax). */
  taxes: TaxBreakdownLine[];
  onInc: (l: CartLine) => void;
  onDec: (l: CartLine) => void;
  onRemove: (l: CartLine) => void;
  onDiscount: (l: CartLine) => void;
  onCustomer: () => void;
  onClear: () => void;
  onCharge: () => void;
}

/** The cart, rendered as a live thermal receipt. */
export function CartPanel({ totals, taxes, onInc, onDec, onRemove, onDiscount, onCustomer, onClear, onCharge }: Props) {
  const { lines, customer, lastAddedKey } = useCart();
  const { data: settings } = useSettings();
  const money = useMoney();
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-key="${lastAddedKey}"]`);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [lastAddedKey, lines.length]);

  return (
    <aside className="flex min-h-0 flex-col" aria-label="Current sale">
      <div className="paper tear-bottom flex min-h-0 flex-1 flex-col rounded-t-sm shadow-lift">
        {/* Receipt head */}
        <div className="px-5 pt-4 text-center lg:pt-5">
          <p className="hidden font-mono text-2xs uppercase tracking-[0.3em] text-paper-dim lg:block">
            {settings?.storeName} · {getTerminalId()}
          </p>
          <div className="dotted-rule my-3 hidden text-paper-rule lg:block" />
          <button
            onClick={onCustomer}
            className={clsx(
              'flex w-full items-center justify-between gap-3 rounded-sm border px-3 py-2 text-left transition-colors',
              customer ? 'border-paper-ink bg-paper-ink text-paper' : 'border-dashed border-paper-dim/60 text-paper-dim hover:border-paper-ink hover:text-paper-ink',
            )}
          >
            <span className="flex min-w-0 items-center gap-2">
              <Icon name={customer ? 'star' : 'user'} size={16} />
              <span className="truncate text-sm font-medium">{customer ? customer.name : 'Attach customer for rewards'}</span>
            </span>
            {customer ? (
              <span className="num shrink-0 text-xs text-amber">{customer.pointsBalance.toLocaleString()} pts</span>
            ) : (
              <span className="font-mono text-2xs">F4</span>
            )}
          </button>
        </div>

        {/* Lines */}
        <ul ref={listRef} className="scroll-fade mt-2 min-h-[4.5rem] flex-1 overflow-y-auto px-5 py-2">
          {lines.length === 0 && (
            <li className="flex h-full min-h-24 flex-col items-center justify-center text-center text-paper-dim">
              <Icon name="barcode" size={34} />
              <p className="display mt-2 text-2xl text-paper-ink">Ready to ring up</p>
              <p className="text-sm">Scan, search, or tap a tile.</p>
            </li>
          )}
          {lines.map((l, i) => {
            const t = totals.lines[i];
            return (
              <li
                key={l.key}
                data-key={l.key}
                className={clsx('group border-b border-dashed border-paper-rule py-2.5 last:border-b-0', l.key === lastAddedKey && 'animate-flash')}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 font-medium leading-snug">{l.name}</span>
                  <span className="num shrink-0 font-medium">{money(t.netCents)}</span>
                </div>
                <div className="mt-1.5 flex items-center justify-between gap-2">
                  <div className="flex items-center">
                    <StepBtn label={`Decrease ${l.name}`} onClick={() => onDec(l)} icon="minus" />
                    <span className="num w-9 text-center text-sm" aria-label="Quantity">
                      {l.quantity}
                    </span>
                    <StepBtn label={`Increase ${l.name}`} onClick={() => onInc(l)} icon="plus" />
                    <span className="num ml-2 text-xs text-paper-dim">@ {money(l.unitPriceCents)}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => onDiscount(l)}
                      className={clsx(
                        'flex items-center gap-1 rounded-xs px-1.5 py-1 font-mono text-2xs uppercase',
                        l.discount ? 'bg-amber text-amber-ink' : 'text-paper-dim hover:bg-paper-rule/60 hover:text-paper-ink',
                      )}
                      aria-label={`Discount ${l.name}`}
                    >
                      <Icon name="tag" size={13} />
                      {l.discount ? (l.discount.type === 'PERCENT' ? `-${formatBps(l.discount.value)}` : `-${money(l.discount.value)}`) : 'Disc'}
                    </button>
                    <button
                      onClick={() => onRemove(l)}
                      className="grid h-7 w-7 place-items-center rounded-xs text-paper-dim hover:bg-vermilion hover:text-paper"
                      aria-label={`Remove ${l.name}`}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                </div>
                {t.discountCents > 0 && (
                  <p className="num mt-1 text-right text-xs text-amber-deep">
                    was {money(t.grossCents)} · saved {money(t.discountCents)}
                  </p>
                )}
              </li>
            );
          })}
        </ul>

        {/* Totals */}
        <div className="px-5 pb-1 pt-2">
          <div className="dotted-rule mb-3 text-paper-rule" />
          <Row label={`Subtotal · ${totals.itemCount} item${totals.itemCount === 1 ? '' : 's'}`} value={money(totals.subtotalCents)} />
          {totals.discountCents > 0 && <Row label="Discounts" value={`−${money(totals.discountCents)}`} accent />}
          {taxes.length <= 1 ? (
            <Row label={taxes[0]?.name ?? 'Tax'} value={money(totals.taxCents)} />
          ) : (
            taxes.map((t) => <Row key={t.taxClassId ?? t.name} label={t.name} value={money(t.taxCents)} title={`on ${money(t.taxableCents)}`} />)
          )}
          <div className="mt-2 flex items-end justify-between border-t-2 border-paper-ink pt-2">
            <span className="font-mono text-xs uppercase tracking-[0.2em]">Total</span>
            <span
              className={clsx('display whitespace-nowrap leading-none', fitClass(money(totals.totalCents), [[9, 'text-5xl'], [12, 'text-4xl'], [15, 'text-3xl']], 'text-2xl'))}
              aria-live="polite"
            >
              {money(totals.totalCents)}
            </span>
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-[auto_1fr] gap-2">
        <button
          onClick={onClear}
          disabled={!lines.length}
          className="key flex h-16 items-center gap-2 rounded-sm border border-vermilion/50 px-4 text-vermilion transition-colors hover:bg-vermilion hover:text-ink disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-vermilion"
        >
          <Icon name="x" size={18} />
          <span className="font-medium">Void</span>
        </button>
        <button
          onClick={onCharge}
          disabled={!lines.length}
          className="key group flex h-16 items-center justify-between gap-3 rounded-sm bg-amber px-5 text-amber-ink transition-[filter,transform] hover:brightness-110 disabled:opacity-40"
        >
          <span className="flex items-center gap-2 text-lg font-semibold">
            Charge{' '}
            {money(totals.totalCents).length <= 10 && <span className="rounded-xs border border-amber-ink/30 px-1 font-mono text-2xs">F9</span>}
          </span>
          <span className={clsx('num flex items-center gap-2 whitespace-nowrap font-bold', fitClass(money(totals.totalCents), [[10, 'text-xl'], [13, 'text-lg']], 'text-base'))}>
            {money(totals.totalCents)}
            <Icon name="arrowRight" size={20} className="transition-transform group-hover:translate-x-1" />
          </span>
        </button>
      </div>
    </aside>
  );
}

function Row({ label, value, accent, title }: { label: string; value: string; accent?: boolean; title?: string }) {
  return (
    <div title={title} className={clsx('flex justify-between py-0.5 text-sm', accent ? 'text-amber-deep' : 'text-paper-dim')}>
      <span>{label}</span>
      <span className="num">{value}</span>
    </div>
  );
}

function StepBtn({ label, onClick, icon }: { label: string; onClick: () => void; icon: 'plus' | 'minus' }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className="grid h-7 w-7 place-items-center rounded-xs border border-paper-rule text-paper-ink transition-colors hover:border-paper-ink hover:bg-paper-ink hover:text-paper active:scale-90"
    >
      <Icon name={icon} size={14} strokeWidth={2.2} />
    </button>
  );
}
