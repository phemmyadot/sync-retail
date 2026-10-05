import clsx from 'clsx';
import { PAYMENT_LABEL, type PaymentMethod, type SaleDTO } from '@sync-retail/shared';
import { useMoney } from '@/lib/format';
import { useSettings } from '@/hooks/useSettings';

export interface ReceiptData {
  receiptNo: string;
  createdAt: string;
  cashierName: string;
  customer: { name: string; pointsBalance?: number } | null;
  lines: { name: string; quantity: number; unitPriceCents: number; discountCents: number; totalCents: number; returnedQty?: number }[];
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  tenders: { method: PaymentMethod; amountCents: number; tenderedCents?: number | null; pointsUsed?: number }[];
  changeCents: number;
  pointsEarned: number;
  status?: string;
  refundedCents?: number;
  pendingSync?: boolean;
}

export const saleToReceipt = (s: SaleDTO): ReceiptData => ({
  receiptNo: s.receiptNo,
  createdAt: s.createdAt,
  cashierName: s.cashier.name,
  customer: s.customer,
  lines: s.items.map((i) => ({
    name: i.name,
    quantity: i.quantity,
    unitPriceCents: i.unitPriceCents,
    discountCents: i.discountCents,
    totalCents: i.totalCents - i.taxCents,
    returnedQty: i.returnedQty,
  })),
  subtotalCents: s.subtotalCents,
  discountCents: s.discountCents,
  taxCents: s.taxCents,
  totalCents: s.totalCents,
  tenders: s.payments,
  changeCents: s.payments.reduce((a, p) => a + p.changeCents, 0),
  pointsEarned: s.pointsEarned,
  status: s.status,
  refundedCents: s.refundedCents,
});

/** Printable thermal receipt. `print-area` is the only thing visible when printing. */
export function Receipt({ data, animate }: { data: ReceiptData; animate?: boolean }) {
  const money = useMoney();
  const { data: settings } = useSettings();
  const voided = data.status === 'VOIDED';

  return (
    <div className={clsx('print-area paper tear-both relative mx-auto w-full max-w-[22rem] px-6 font-mono text-[0.8rem] leading-relaxed', animate && 'animate-print')}>
      {voided && (
        <span className="pointer-events-none absolute left-1/2 top-1/3 -translate-x-1/2 -rotate-12 rounded-sm border-4 border-vermilion px-4 py-1 font-sans text-4xl font-extrabold tracking-widest text-vermilion opacity-80">
          VOID
        </span>
      )}
      <div className="text-center">
        <p className="display text-3xl not-italic leading-tight">{settings?.storeName}</p>
        <p className="text-paper-dim">{new Date(data.createdAt).toLocaleString()}</p>
        <p className="text-paper-dim">
          #{data.receiptNo} · {data.cashierName}
        </p>
        {data.pendingSync && <p className="mt-1 inline-block bg-paper-ink px-2 text-paper">OFFLINE — WILL SYNC</p>}
      </div>
      <div className="dotted-rule my-3 text-paper-dim" />
      <ul>
        {data.lines.map((l, i) => (
          <li key={i} className="py-0.5">
            <div className="flex justify-between gap-3">
              <span className="truncate">{l.name}</span>
              <span>{money(l.totalCents)}</span>
            </div>
            <div className="flex justify-between text-paper-dim">
              <span>
                {l.quantity} × {money(l.unitPriceCents)}
                {l.returnedQty ? ` · ${l.returnedQty} returned` : ''}
              </span>
              {l.discountCents > 0 && <span>−{money(l.discountCents)}</span>}
            </div>
          </li>
        ))}
      </ul>
      <div className="dotted-rule my-3 text-paper-dim" />
      <Line k="Subtotal" v={money(data.subtotalCents)} />
      {data.discountCents > 0 && <Line k="Discounts" v={`−${money(data.discountCents)}`} />}
      <Line k="Tax" v={money(data.taxCents)} />
      <div className="mt-1 flex justify-between border-y-2 border-paper-ink py-1 text-base font-bold">
        <span>TOTAL</span>
        <span>{money(data.totalCents)}</span>
      </div>
      <div className="mt-2">
        {data.tenders.map((t, i) => (
          <Line
            key={i}
            k={`${PAYMENT_LABEL[t.method]}${t.pointsUsed ? ` (${t.pointsUsed} pts)` : ''}`}
            v={money(t.method === 'CASH' && t.tenderedCents ? t.tenderedCents : t.amountCents)}
          />
        ))}
        {data.changeCents > 0 && <Line k="Change" v={money(data.changeCents)} />}
        {!!data.refundedCents && !voided && <Line k="Refunded" v={`−${money(data.refundedCents)}`} />}
      </div>
      {data.customer && (
        <>
          <div className="dotted-rule my-3 text-paper-dim" />
          <p className="text-center">
            Member: {data.customer.name}
            <br />
            Points earned: {data.pointsEarned}
            {data.customer.pointsBalance !== undefined && (
              <>
                <br />
                Balance: {data.customer.pointsBalance.toLocaleString()} pts
              </>
            )}
          </p>
        </>
      )}
      <div className="dotted-rule my-3 text-paper-dim" />
      <p className="text-center text-paper-dim">{settings?.receiptFooter}</p>
      <svg viewBox="0 0 200 34" className="mx-auto mt-3 h-9 w-48 text-paper-ink" aria-hidden="true">
        {data.receiptNo.split('').flatMap((ch, i) => {
          const c = ch.charCodeAt(0);
          return [0, 1, 2].map((k) => <rect key={`${i}-${k}`} x={i * 12 + k * 4} y="0" width={((c >> k) & 1) + 1} height="34" fill="currentColor" />);
        })}
      </svg>
    </div>
  );
}

const Line = ({ k, v }: { k: string; v: string }) => (
  <div className="flex justify-between">
    <span>{k}</span>
    <span>{v}</span>
  </div>
);
