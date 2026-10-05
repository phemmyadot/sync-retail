import { useEffect, useState } from 'react';
import { effectiveDiscountBps, formatBps, priceLine, type DiscountType, type LineDiscount } from '@sync-retail/shared';
import { Modal } from '@/components/ui/Modal';
import { Button, Segmented } from '@/components/ui/primitives';
import { useCurrencySymbol, useMoney } from '@/lib/format';
import { useSettings } from '@/hooks/useSettings';
import { useCan } from '@/hooks/useOverride';
import type { CartLine } from '@/store/cart';

interface Props {
  line: CartLine | null;
  onClose: () => void;
  onApply: (line: CartLine, discount: LineDiscount | null) => void;
}

export function DiscountModal({ line, onClose, onApply }: Props) {
  const money = useMoney();
  const symbol = useCurrencySymbol();
  const can = useCan();
  const { data: settings } = useSettings();
  const [type, setType] = useState<DiscountType>('PERCENT');
  const [raw, setRaw] = useState('');

  useEffect(() => {
    if (!line) return;
    setType(line.discount?.type ?? 'PERCENT');
    setRaw(line.discount ? (line.discount.type === 'PERCENT' ? String(line.discount.value / 100) : (line.discount.value / 100).toFixed(2)) : '');
  }, [line]);

  if (!line) return null;

  const n = Number(raw) || 0;
  const discount: LineDiscount | null = n > 0 ? { type, value: Math.round(n * 100) } : null;
  const preview = priceLine({ ...line, discount });
  const bps = effectiveDiscountBps({ ...line, discount });
  const cap = settings?.agentMaxDiscountBps ?? 1000;
  const needsApproval = bps > cap && !can('cart:discount-unlimited');

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Line discount"
      title={line.name}
      width="sm"
      footer={
        <>
          {line.discount && (
            <Button variant="quiet" onClick={() => onApply(line, null)} className="mr-auto">
              Remove discount
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={needsApproval ? 'lock' : 'check'} onClick={() => onApply(line, discount)}>
            {needsApproval ? 'Request approval' : 'Apply'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Segmented
          value={type}
          onChange={(t) => {
            setType(t);
            setRaw('');
          }}
          options={[
            { value: 'PERCENT', label: 'Percent %' },
            { value: 'AMOUNT', label: 'Amount off' },
          ]}
          className="w-full [&>button]:flex-1"
        />
        <div className="relative">
          <input
            autoFocus
            inputMode="decimal"
            value={raw}
            onChange={(e) => setRaw(e.target.value.replace(/[^\d.]/g, ''))}
            className="field h-16 pr-12 text-right font-mono text-3xl"
            aria-label={type === 'PERCENT' ? 'Percent off' : 'Amount off'}
            placeholder="0"
          />
          <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 font-mono text-xl text-dust">{type === 'PERCENT' ? '%' : symbol}</span>
        </div>
        {type === 'PERCENT' && (
          <div className="flex flex-wrap gap-2">
            {[5, 10, 15, 20, 25, 50].map((p) => (
              <button
                key={p}
                onClick={() => setRaw(String(p))}
                className="rounded-sm border border-line px-3 py-1.5 font-mono text-sm text-dust transition-colors hover:border-amber hover:text-amber"
              >
                {p}%
              </button>
            ))}
          </div>
        )}
        <div className="rounded-sm border border-line bg-ink p-3 text-sm">
          <div className="flex justify-between text-dust">
            <span>Line before</span>
            <span className="num">{money(preview.grossCents)}</span>
          </div>
          <div className="flex justify-between text-amber">
            <span>Discount ({formatBps(bps)})</span>
            <span className="num">−{money(preview.discountCents)}</span>
          </div>
          <div className="mt-1 flex justify-between border-t border-line pt-1 font-medium text-bone">
            <span>Line after (ex tax)</span>
            <span className="num">{money(preview.netCents)}</span>
          </div>
        </div>
        <p className={needsApproval ? 'text-sm text-vermilion' : 'text-xs text-dust'}>
          {needsApproval
            ? `Above your ${formatBps(cap)} limit. A manager will need to approve it with their PIN.`
            : `Agents can discount up to ${formatBps(cap)} without approval.`}
        </p>
      </div>
    </Modal>
  );
}
