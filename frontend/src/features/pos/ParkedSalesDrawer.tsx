import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import type { ParkedLine, ParkedSaleDTO } from '@sync-retail/shared';
import type { LocalParkedSale } from '@/lib/db';
import { useMoney } from '@/lib/format';
import { useSettings } from '@/hooks/useSettings';
import { Icon } from '@/components/ui/Icon';
import { Badge, Button } from '@/components/ui/primitives';

export type HeldItem = { kind: 'shared'; sale: ParkedSaleDTO } | { kind: 'local'; row: LocalParkedSale };

interface Props {
  open: boolean;
  shared: ParkedSaleDTO[];
  local: LocalParkedSale[];
  loading: boolean;
  offline: boolean;
  onClose: () => void;
  onResume: (item: HeldItem) => Promise<void>;
  onDiscard: (item: HeldItem, reason: string) => Promise<void>;
}

const minutesAgo = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
function ago(iso: string) {
  const m = minutesAgo(iso);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} h ${m % 60} min ago` : new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

interface RowView {
  key: string;
  item: HeldItem;
  reference: string | null;
  createdAt: string;
  cashier: string;
  terminal: string | null;
  customer: string | null;
  itemCount: number;
  totalCents: number;
  lines: ParkedLine[];
  note?: string;
}

/** Held sales across the store: search, peek at items, resume or discard. */
export function ParkedSalesDrawer({ open, shared, local, loading, offline, onClose, onResume, onDiscard }: Props) {
  const money = useMoney();
  const remind = useSettings().data?.parkedRemindMinutes ?? 30;
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState<string | null>(null);
  const [reason, setReason] = useState('Customer left');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSearch('');
    setDiscarding(null);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const rows = useMemo(() => {
    const all: RowView[] = [
      ...local.map((r) => ({
        key: `l:${r.clientId}`,
        item: { kind: 'local' as const, row: r },
        reference: r.input.reference ?? null,
        createdAt: r.createdAt,
        cashier: r.cashierName,
        terminal: null,
        customer: r.customer?.name ?? null,
        itemCount: r.itemCount,
        totalCents: r.totalCents,
        lines: r.lines,
        note: r.error ? `Couldn’t share: ${r.error}` : 'On this register — not shared yet',
      })),
      ...shared.map((s) => ({
        key: s.id,
        item: { kind: 'shared' as const, sale: s },
        reference: s.reference,
        createdAt: s.createdAt,
        cashier: s.parkedBy.name,
        terminal: s.terminalId,
        customer: s.customer?.name ?? null,
        itemCount: s.itemCount,
        totalCents: s.totalCents,
        lines: s.lines,
      })),
    ];
    const q = search.trim().toLowerCase();
    return q ? all.filter((r) => [r.reference, r.cashier, r.customer, r.terminal].some((v) => v?.toLowerCase().includes(q))) : all;
  }, [local, shared, search]);

  if (!open) return null;

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label="Held sales">
      <button className="absolute inset-0 bg-ink/60 backdrop-blur-[2px]" aria-label="Close held sales" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-md flex-col border-l border-line bg-ink-2 shadow-lift animate-rise">
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <p className="eyebrow text-amber">Held sales</p>
            <h2 className="display text-3xl">
              {rows.length} waiting{search && ' (filtered)'}
            </h2>
          </div>
          <button onClick={onClose} className="grid h-10 w-10 place-items-center rounded-sm text-dust hover:bg-ink-3 hover:text-bone" aria-label="Close">
            <Icon name="x" size={20} />
          </button>
        </header>
        <div className="border-b border-line px-5 py-3">
          <input
            className="field"
            placeholder="Search note, cashier, customer, register"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search held sales"
            autoFocus
          />
          {offline && <p className="mt-2 text-xs text-amber">Can’t reach the Main Register — only sales held on this register can be resumed.</p>}
        </div>

        <ul className="flex-1 space-y-2 overflow-y-auto px-5 py-4">
          {loading && !rows.length && <li className="eyebrow animate-blink">Loading…</li>}
          {!loading && !rows.length && (
            <li className="py-10 text-center text-dust">
              <Icon name="pause" size={30} className="mx-auto mb-2" />
              No held sales{search ? ' match' : ''}.
            </li>
          )}
          {rows.map((r) => {
            const old = minutesAgo(r.createdAt) >= remind;
            const lockedOut = r.item.kind === 'shared' && offline;
            return (
              <li key={r.key} className={clsx('rounded-sm border bg-ink p-3', old ? 'border-amber/50' : 'border-line')}>
                <button className="w-full text-left" onClick={() => setExpanded(expanded === r.key ? null : r.key)} aria-expanded={expanded === r.key}>
                  <div className="flex items-start justify-between gap-3">
                    <span className={clsx('min-w-0 font-medium', r.reference ? 'text-bone' : 'italic text-dust')}>{r.reference || 'No note'}</span>
                    <span className="num shrink-0 font-medium text-bone">{money(r.totalCents)}</span>
                  </div>
                  <p className="mt-1 text-xs text-dust">
                    <span className={clsx(old && 'text-amber')}>{ago(r.createdAt)}</span> · {r.cashier}
                    {r.terminal && ` on ${r.terminal}`} · {r.itemCount} item{r.itemCount === 1 ? '' : 's'}
                    {r.customer && (
                      <>
                        {' · '}
                        <Icon name="star" size={11} className="inline text-amber" /> {r.customer}
                      </>
                    )}
                  </p>
                  {r.note && (
                    <Badge tone={r.item.kind === 'local' && r.item.row.error ? 'vermilion' : 'sky'} className="mt-2">
                      {r.note}
                    </Badge>
                  )}
                </button>
                {expanded === r.key && (
                  <ul className="mt-2 space-y-0.5 border-t border-dashed border-line pt-2 text-sm text-dust">
                    {r.lines.map((l, i) => (
                      <li key={i} className="flex justify-between gap-3">
                        <span className="min-w-0 truncate">
                          {l.quantity} × {l.name}
                        </span>
                        <span className="num shrink-0">{money(l.unitPriceCents * l.quantity)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {discarding === r.key ? (
                  <div className="mt-3 space-y-2">
                    <input className="field h-9 py-1 text-sm" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason for discarding" autoFocus />
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="quiet" onClick={() => setDiscarding(null)}>
                        Keep
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={reason.trim().length < 2}
                        loading={busy === r.key}
                        onClick={() => void run(r.key, () => onDiscard(r.item, reason.trim()).then(() => setDiscarding(null)))}
                      >
                        Discard sale
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 flex justify-end gap-2">
                    <Button size="sm" variant="quiet" onClick={() => setDiscarding(r.key)} disabled={lockedOut}>
                      Discard
                    </Button>
                    <Button size="sm" variant="primary" iconRight="arrowRight" loading={busy === r.key} disabled={lockedOut} onClick={() => void run(r.key, () => onResume(r.item))}>
                      {lockedOut ? 'Reconnect to resume' : 'Resume'}
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </aside>
    </div>
  );
}
