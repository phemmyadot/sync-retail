import { useEffect, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import type { CustomerDTO, SaleDTO, SaleStatus } from '@sync-retail/shared';
import { api, errorMessage } from '@/lib/api';
import { localDb, type OutboxSale } from '@/lib/db';
import { fmtDate, useMoney } from '@/lib/format';
import { retryFailed } from '@/lib/sync';
import { useOverride } from '@/hooks/useOverride';
import { useSyncStatus } from '@/store/sync';
import { OverrideCancelled } from '@/store/override';
import { toast } from '@/store/toast';
import { Badge, Button, Empty, PageHeader, Segmented } from '@/components/ui/primitives';
import { Modal } from '@/components/ui/Modal';
import { Icon } from '@/components/ui/Icon';
import { Receipt, saleToReceipt } from '../pos/Receipt';
import { CustomerPicker } from '../pos/CustomerPicker';

const STATUS_TONE: Record<SaleStatus, 'mint' | 'vermilion' | 'amber' | 'sky'> = {
  COMPLETED: 'mint',
  VOIDED: 'vermilion',
  PARTIALLY_REFUNDED: 'amber',
  REFUNDED: 'sky',
};

export function SalesHistoryPage() {
  const money = useMoney();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'' | SaleStatus>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { pending, failed } = useSyncStatus();

  const sales = useInfiniteQuery({
    queryKey: ['sales', search, status],
    queryFn: ({ pageParam }) =>
      api<{ items: SaleDTO[]; nextCursor: string | null }>('/sales', { query: { search, status, cursor: pageParam, take: 40 } }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const outbox = useQuery({
    queryKey: ['outbox', pending, failed],
    queryFn: () => localDb.outbox.orderBy('createdAt').reverse().toArray(),
  });

  const all = sales.data?.pages.flatMap((p) => p.items) ?? [];
  const selected = all.find((s) => s.id === selectedId) ?? null;

  return (
    <div>
      <PageHeader eyebrow="Transactions" title={<>Sales <span className="italic text-dust">history</span></>} />

      {!!outbox.data?.length && <OutboxPanel entries={outbox.data} />}

      <div className="flex flex-wrap items-center gap-3 px-6 py-4 lg:px-10">
        <div className="relative min-w-[14rem] flex-1">
          <Icon name="search" size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dust" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Receipt # or customer" className="field pl-10" aria-label="Search sales" />
        </div>
        <Segmented<'' | SaleStatus>
          value={status}
          onChange={setStatus}
          options={[
            { value: '', label: 'All' },
            { value: 'COMPLETED', label: 'Completed' },
            { value: 'PARTIALLY_REFUNDED', label: 'Part-refunded' },
            { value: 'VOIDED', label: 'Voided' },
          ]}
        />
      </div>

      <ul className="px-6 lg:px-10">
        {all.map((s, i) => (
          <li key={s.id} className="animate-rise" style={{ animationDelay: `${Math.min(i, 15) * 20}ms` }}>
            <button
              onClick={() => setSelectedId(s.id)}
              className="group grid w-full grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 border-b border-line py-3.5 text-left transition-colors hover:bg-ink-2 md:grid-cols-[10rem_1fr_9rem_8rem_8rem] md:px-2"
            >
              <span className="num text-bone group-hover:text-amber">{s.receiptNo}</span>
              <span className="truncate text-sm text-dust md:order-none">
                {s.items.length} item{s.items.length === 1 ? '' : 's'} · {s.cashier.name}
                {s.customer && <span className="text-bone"> · {s.customer.name}</span>}
                {s.offline && (
                  <Badge tone="sky" className="ml-2">
                    synced
                  </Badge>
                )}
              </span>
              <span className="text-sm text-dust">{fmtDate(s.createdAt)}</span>
              <span>
                <Badge tone={STATUS_TONE[s.status]}>{s.status.replace('_', ' ')}</Badge>
              </span>
              <span className={clsx('num text-right', s.status === 'VOIDED' ? 'text-dust line-through' : 'text-bone')}>{money(s.totalCents)}</span>
            </button>
          </li>
        ))}
      </ul>
      {!sales.isLoading && !all.length && <Empty icon="receipt" title="No sales found" />}
      {sales.hasNextPage && (
        <div className="flex justify-center py-6">
          <Button onClick={() => void sales.fetchNextPage()} loading={sales.isFetchingNextPage}>
            Load more
          </Button>
        </div>
      )}

      {selected && (
        <SaleDetail
          sale={selected}
          onClose={() => setSelectedId(null)}
          onChanged={() => {
            void qc.invalidateQueries({ queryKey: ['sales'] });
          }}
        />
      )}
    </div>
  );
}

function OutboxPanel({ entries }: { entries: OutboxSale[] }) {
  const money = useMoney();
  return (
    <div className="hatch-amber mx-6 mt-6 rounded-sm border border-amber/40 p-4 lg:mx-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 font-medium text-amber">
          <Icon name="wifiOff" size={18} /> {entries.length} sale(s) on this register haven’t reached the cloud yet
        </p>
        <Button size="sm" icon="refresh" onClick={() => void retryFailed().then((n) => toast.info(`Synced ${n} sale(s)`))}>
          Sync now
        </Button>
      </div>
      <ul className="mt-3 space-y-1 text-sm">
        {entries.slice(0, 8).map((e) => (
          <li key={e.clientId} className="flex justify-between gap-3">
            <span className="num text-bone">
              {e.payload.receiptNo} <span className="text-dust">· {fmtDate(e.createdAt)}</span>
            </span>
            <span className={e.status === 'failed' ? 'text-vermilion' : 'text-dust'}>
              {e.status === 'failed' ? `Failed: ${e.error}` : 'Pending'} · <span className="num">{money(e.totalCents)}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SaleDetail({ sale, onClose, onChanged }: { sale: SaleDTO; onClose: () => void; onChanged: () => void }) {
  const money = useMoney();
  const authorize = useOverride();
  const [mode, setMode] = useState<'view' | 'void' | 'return'>('view');
  const [reason, setReason] = useState('');
  const [qty, setQty] = useState<Record<string, number>>({});
  const [restock, setRestock] = useState(true);
  const [busy, setBusy] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [current, setCurrent] = useState(sale);

  useEffect(() => setCurrent(sale), [sale]);

  const run = async (action: 'VOID_SALE' | 'RETURN_ITEM' | 'EDIT_SALE', detail: string, fn: (token: string | null) => Promise<SaleDTO>) => {
    setBusy(true);
    try {
      const token = await authorize({ action, detail, saleId: sale.id, requireReason: action === 'VOID_SALE' });
      const updated = await fn(token);
      setCurrent(updated);
      setMode('view');
      onChanged();
      toast.success(action === 'VOID_SALE' ? 'Sale voided' : action === 'RETURN_ITEM' ? 'Return processed' : 'Sale updated', updated.receiptNo);
    } catch (err) {
      if (!(err instanceof OverrideCancelled)) toast.error('Action failed', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const doVoid = () =>
    run('VOID_SALE', `Void ${sale.receiptNo} — ${money(sale.totalCents)}`, (token) =>
      api<SaleDTO>(`/sales/${sale.id}/void`, { method: 'POST', body: { reason }, overrideToken: token }),
    );

  const returnItems = Object.entries(qty).filter(([, q]) => q > 0);
  const returnValue = returnItems.reduce((a, [id, q]) => {
    const it = current.items.find((i) => i.id === id)!;
    return a + Math.round((it.totalCents * q) / it.quantity);
  }, 0);
  const doReturn = () =>
    run('RETURN_ITEM', `Refund ${money(returnValue)} on ${sale.receiptNo}`, (token) =>
      api<SaleDTO>(`/sales/${sale.id}/returns`, {
        method: 'POST',
        body: { items: returnItems.map(([saleItemId, quantity]) => ({ saleItemId, quantity, restock })), reason: reason || undefined },
        overrideToken: token,
      }),
    );

  const attach = (c: CustomerDTO | null) => {
    setAttaching(false);
    if (!c) return;
    void run('EDIT_SALE', `Attach ${c.name} to ${sale.receiptNo}`, (token) =>
      api<SaleDTO>(`/sales/${sale.id}`, { method: 'PATCH', body: { customerId: c.id }, overrideToken: token }),
    );
  };

  const editable = current.status === 'COMPLETED' || current.status === 'PARTIALLY_REFUNDED';

  return (
    <Modal open onClose={onClose} eyebrow={`Receipt · ${current.status.replace('_', ' ')}`} title={current.receiptNo} width="lg" tone={mode === 'void' ? 'danger' : 'ink'}>
      <div className="grid gap-6 md:grid-cols-[22rem_1fr]">
        <Receipt data={saleToReceipt(current)} />

        <div className="space-y-4">
          {mode === 'view' && (
            <>
              <p className="text-sm text-dust">
                Agents need a manager PIN for any change to a completed sale. Every change is logged with who approved it.
              </p>
              <div className="grid gap-2">
                <Button icon="undo" disabled={!editable} onClick={() => setMode('return')}>
                  Return / refund items
                </Button>
                <Button icon="user" disabled={current.status !== 'COMPLETED' || !!current.customer} onClick={() => setAttaching(true)}>
                  Attach loyalty member
                </Button>
                <Button variant="danger" icon="x" disabled={current.status !== 'COMPLETED'} onClick={() => setMode('void')}>
                  Void entire sale
                </Button>
              </div>
            </>
          )}

          {mode === 'void' && (
            <div className="space-y-4 animate-rise">
              <p className="text-bone">
                Voiding reverses <span className="num text-vermilion">{money(current.totalCents)}</span>, puts every item back in stock and reverses loyalty points.
              </p>
              <label className="block">
                <span className="eyebrow mb-1.5 block">Reason</span>
                <input className="field" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Rung up on wrong register" autoFocus />
              </label>
              <div className="flex gap-2">
                <Button onClick={() => setMode('view')}>Back</Button>
                <Button variant="danger" className="flex-1" disabled={reason.trim().length < 3} loading={busy} onClick={() => void doVoid()}>
                  Void sale
                </Button>
              </div>
            </div>
          )}

          {mode === 'return' && (
            <div className="space-y-4 animate-rise">
              <ul className="divide-y divide-line border-y border-line">
                {current.items.map((it) => {
                  const left = it.quantity - it.returnedQty;
                  return (
                    <li key={it.id} className="flex items-center justify-between gap-3 py-2.5">
                      <span className="min-w-0">
                        <span className="block truncate">{it.name}</span>
                        <span className="num text-xs text-dust">
                          {left} of {it.quantity} returnable · {money(it.totalCents)}
                        </span>
                      </span>
                      <span className="flex items-center gap-1">
                        <Button size="sm" icon="minus" aria-label="Fewer" disabled={!qty[it.id]} onClick={() => setQty({ ...qty, [it.id]: (qty[it.id] ?? 0) - 1 })} />
                        <span className="num w-6 text-center">{qty[it.id] ?? 0}</span>
                        <Button size="sm" icon="plus" aria-label="More" disabled={(qty[it.id] ?? 0) >= left} onClick={() => setQty({ ...qty, [it.id]: (qty[it.id] ?? 0) + 1 })} />
                      </span>
                    </li>
                  );
                })}
              </ul>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} className="h-4 w-4 accent-[rgb(var(--amber))]" />
                Put returned items back in stock
              </label>
              <input className="field" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" aria-label="Return reason" />
              <div className="flex gap-2">
                <Button onClick={() => setMode('view')}>Back</Button>
                <Button variant="primary" className="flex-1" disabled={!returnItems.length} loading={busy} onClick={() => void doReturn()}>
                  Refund {money(returnValue)}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
      <CustomerPicker open={attaching} current={null} onClose={() => setAttaching(false)} onPick={attach} />
    </Modal>
  );
}
