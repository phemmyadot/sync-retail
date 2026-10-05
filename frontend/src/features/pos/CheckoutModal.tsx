import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import {
  maxRedeemablePoints,
  PAYMENT_LABEL,
  pointsEarned,
  pointsToCents,
  summarizeTenders,
  type CustomerDTO,
  type PaymentMethod,
  type SaleTenderInput,
} from '@sync-retail/shared';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/primitives';
import { Icon, type IconName } from '@/components/ui/Icon';
import { centsToInput, inputToCents, useMoney } from '@/lib/format';
import { useSettings } from '@/hooks/useSettings';

interface Props {
  open: boolean;
  totalCents: number;
  customer: CustomerDTO | null;
  onClose: () => void;
  onProgress: (paidCents: number, remainingCents: number) => void;
  onComplete: (tenders: SaleTenderInput[]) => Promise<void>;
}

const METHOD_ICON: Record<PaymentMethod, IconName> = { CASH: 'cash', CARD: 'card', LOYALTY: 'star' };

/** Split-tender checkout: any mix of cash, card and loyalty points. */
export function CheckoutModal({ open, totalCents, customer, onClose, onProgress, onComplete }: Props) {
  const money = useMoney();
  const { data: settings } = useSettings();
  const loyalty = settings!.loyalty;
  const [tenders, setTenders] = useState<SaleTenderInput[]>([]);
  const [method, setMethod] = useState<PaymentMethod>('CARD');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [blocks, setBlocks] = useState(1);
  const [processing, setProcessing] = useState<null | 'card' | 'sale'>(null);
  const [error, setError] = useState<string | null>(null);

  const summary = useMemo(() => summarizeTenders(totalCents, tenders), [totalCents, tenders]);
  const remaining = summary.remainingCents;
  const pointsUsed = tenders.reduce((a, t) => a + (t.pointsUsed ?? 0), 0);
  const availablePoints = Math.max(0, (customer?.pointsBalance ?? 0) - pointsUsed);
  const maxPoints = maxRedeemablePoints(availablePoints, remaining, loyalty);
  const maxBlocks = Math.floor(maxPoints / loyalty.redeemBlockPoints);
  const projectedEarn = customer ? pointsEarned(summary.earningCents + (method !== 'LOYALTY' ? remaining : 0), loyalty) : 0;

  useEffect(() => {
    if (!open) return;
    setTenders([]);
    setMethod('CARD');
    setError(null);
    setReference('');
  }, [open]);

  useEffect(() => {
    setAmount(centsToInput(remaining));
    setBlocks(Math.min(Math.max(1, blocks), Math.max(1, maxBlocks)));
    if (open) onProgress(summary.paidCents, remaining);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remaining, open]);

  const done = remaining === 0 && tenders.length > 0;

  const addTender = async () => {
    setError(null);
    if (method === 'LOYALTY') {
      if (!customer || maxBlocks < 1) return;
      const pts = Math.min(blocks, maxBlocks) * loyalty.redeemBlockPoints;
      setTenders((t) => [...t, { method: 'LOYALTY', amountCents: pointsToCents(pts, loyalty), pointsUsed: pts }]);
      return;
    }
    const cents = inputToCents(amount);
    if (cents <= 0) return setError('Enter an amount.');
    if (method === 'CARD') {
      if (cents > remaining) return setError('Card amount can’t exceed what’s due.');
      setProcessing('card');
      await new Promise((r) => setTimeout(r, 900)); // integrate your card terminal SDK here
      setProcessing(null);
      setTenders((t) => [...t, { method: 'CARD', amountCents: cents, reference: reference || undefined }]);
      setReference('');
      return;
    }
    // Cash: anything over the remaining due becomes change.
    setTenders((t) => [...t, { method: 'CASH', amountCents: Math.min(cents, remaining), tenderedCents: cents }]);
  };

  const finish = async () => {
    setProcessing('sale');
    setError(null);
    try {
      await onComplete(tenders);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setProcessing(null);
    }
  };

  const cashQuick = useMemo(() => {
    const r = remaining;
    const set = new Set([r, Math.ceil(r / 500) * 500, Math.ceil(r / 1000) * 1000, Math.ceil(r / 2000) * 2000, 5000, 10000]);
    return [...set].filter((v) => v >= r && v > 0).sort((a, b) => a - b).slice(0, 5);
  }, [remaining]);

  return (
    <Modal open={open} onClose={onClose} eyebrow="Checkout" title="Take payment" width="lg" locked={!!processing}>
      <div className="grid gap-6 md:grid-cols-[1fr_1.1fr]">
        {/* Left: due + applied tenders */}
        <div className="flex flex-col">
          <div className="rounded-sm border border-line bg-ink p-5">
            <p className="eyebrow">{done ? 'Paid in full' : 'Amount due'}</p>
            <p className={clsx('display mt-1 text-6xl leading-none transition-colors', done ? 'text-mint' : 'text-bone')}>{money(remaining)}</p>
            <p className="num mt-2 text-sm text-dust">of {money(totalCents)}</p>
            {summary.changeCents > 0 && (
              <div className="mt-4 flex items-center justify-between rounded-sm bg-amber px-3 py-2 text-amber-ink animate-pop">
                <span className="font-semibold">Change due</span>
                <span className="num text-2xl font-bold">{money(summary.changeCents)}</span>
              </div>
            )}
          </div>

          <ul className="mt-4 space-y-1.5">
            {tenders.map((t, i) => (
              <li key={i} className="flex items-center justify-between rounded-sm border border-line px-3 py-2 animate-rise">
                <span className="flex items-center gap-2 text-sm">
                  <Icon name={METHOD_ICON[t.method]} size={16} className="text-dust" />
                  {PAYMENT_LABEL[t.method]}
                  {t.pointsUsed ? <span className="num text-xs text-dust">({t.pointsUsed} pts)</span> : null}
                  {t.tenderedCents && t.tenderedCents > t.amountCents ? (
                    <span className="num text-xs text-dust">tendered {money(t.tenderedCents)}</span>
                  ) : null}
                </span>
                <span className="flex items-center gap-2">
                  <span className="num">{money(t.amountCents)}</span>
                  {!processing && (
                    <button onClick={() => setTenders((x) => x.filter((_, j) => j !== i))} aria-label="Remove payment" className="text-dust hover:text-vermilion">
                      <Icon name="x" size={14} />
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>

          {customer && (
            <p className="mt-auto pt-4 text-sm text-dust">
              <Icon name="star" size={14} className="mr-1 inline text-amber" />
              {customer.name} will earn <span className="num text-amber">{projectedEarn}</span> pts on this sale.
            </p>
          )}
        </div>

        {/* Right: tender entry */}
        <div>
          <div className="grid grid-cols-3 gap-2" role="tablist" aria-label="Payment method">
            {(['CARD', 'CASH', 'LOYALTY'] as PaymentMethod[]).map((m) => {
              const disabled = done || (m === 'LOYALTY' && (!customer || maxBlocks < 1));
              return (
                <button
                  key={m}
                  role="tab"
                  aria-selected={method === m}
                  disabled={disabled}
                  onClick={() => setMethod(m)}
                  className={clsx(
                    'key flex flex-col items-center gap-1.5 rounded-sm border py-3 transition-colors disabled:opacity-35',
                    method === m ? 'border-amber bg-amber/10 text-amber' : 'border-line bg-ink-3 text-dust hover:text-bone',
                  )}
                >
                  <Icon name={METHOD_ICON[m]} size={22} />
                  <span className="text-sm font-medium">{m === 'LOYALTY' ? 'Points' : PAYMENT_LABEL[m]}</span>
                </button>
              );
            })}
          </div>

          {!done && (
            <div className="mt-4 space-y-3 animate-rise" key={method}>
              {method === 'LOYALTY' ? (
                <div className="rounded-sm border border-line bg-ink p-4">
                  <p className="text-sm text-dust">
                    Balance <span className="num text-bone">{availablePoints.toLocaleString()} pts</span> · {loyalty.redeemBlockPoints} pts ={' '}
                    {money(loyalty.redeemBlockValueCents)}
                  </p>
                  <div className="mt-3 flex items-center justify-between">
                    <Button size="sm" icon="minus" aria-label="Fewer points" onClick={() => setBlocks((b) => Math.max(1, b - 1))} />
                    <div className="text-center">
                      <p className="num text-3xl">{(Math.min(blocks, maxBlocks) * loyalty.redeemBlockPoints).toLocaleString()} pts</p>
                      <p className="num text-sm text-amber">−{money(pointsToCents(Math.min(blocks, maxBlocks) * loyalty.redeemBlockPoints, loyalty))}</p>
                    </div>
                    <Button size="sm" icon="plus" aria-label="More points" onClick={() => setBlocks((b) => Math.min(maxBlocks, b + 1))} />
                  </div>
                </div>
              ) : (
                <>
                  <div className="relative">
                    <input
                      inputMode="decimal"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
                      onKeyDown={(e) => e.key === 'Enter' && void addTender()}
                      className="field h-16 text-right font-mono text-3xl"
                      aria-label={`${PAYMENT_LABEL[method]} amount`}
                    />
                  </div>
                  {method === 'CASH' && (
                    <div className="flex flex-wrap gap-2">
                      {cashQuick.map((v) => (
                        <button
                          key={v}
                          onClick={() => setAmount(centsToInput(v))}
                          className="key rounded-sm border border-line bg-ink-3 px-3 py-2 font-mono text-sm hover:border-amber hover:text-amber"
                        >
                          {v === remaining ? 'Exact' : money(v)}
                        </button>
                      ))}
                    </div>
                  )}
                  {method === 'CARD' && (
                    <input
                      value={reference}
                      onChange={(e) => setReference(e.target.value.slice(0, 20))}
                      className="field"
                      placeholder="Auth code / last 4 (optional)"
                      aria-label="Card reference"
                    />
                  )}
                </>
              )}
              <Button variant="outline" size="lg" className="w-full" onClick={() => void addTender()} loading={processing === 'card'} icon={METHOD_ICON[method]}>
                {processing === 'card' ? 'Waiting for card terminal…' : method === 'LOYALTY' ? 'Redeem points' : method === 'CASH' ? 'Take cash' : 'Charge card'}
              </Button>
            </div>
          )}

          {error && (
            <p className="mt-3 text-sm text-vermilion" role="alert">
              {error}
            </p>
          )}

          <Button
            variant="primary"
            size="xl"
            className={clsx('mt-5 w-full', done && 'shadow-glow')}
            disabled={!done}
            loading={processing === 'sale'}
            onClick={() => void finish()}
            iconRight="check"
          >
            Complete sale
          </Button>
        </div>
      </div>
    </Modal>
  );
}
