import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import type { CustomerDTO } from '@sync-retail/shared';
import { api, errorMessage } from '@/lib/api';
import { fmtDate, fmtDay, useMoney } from '@/lib/format';
import { useCan } from '@/hooks/useOverride';
import { toast } from '@/store/toast';
import { Avatar, Badge, Button, Empty, Input, PageHeader } from '@/components/ui/primitives';
import { Modal } from '@/components/ui/Modal';
import { Icon } from '@/components/ui/Icon';

interface CustomerDetail extends CustomerDTO {
  notes: string | null;
  sales: { id: string; receiptNo: string; totalCents: number; status: string; createdAt: string; pointsEarned: number; pointsRedeemed: number }[];
  loyaltyLedger: { id: string; points: number; reason: string; createdAt: string }[];
}

export function CustomersPage() {
  const money = useMoney();
  const can = useCan();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState<null | { id?: string; name: string; phone: string; email: string; notes: string }>(null);

  const list = useQuery({
    queryKey: ['customers', search],
    queryFn: () => api<CustomerDTO[]>('/customers', { query: { search, take: 100 } }),
  });
  const detail = useQuery({
    queryKey: ['customer', selected],
    queryFn: () => api<CustomerDetail>(`/customers/${selected}`),
    enabled: !!selected,
  });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    try {
      const body = { name: form.name, phone: form.phone || null, email: form.email || null, notes: form.notes || null };
      const c = form.id
        ? await api<CustomerDTO>(`/customers/${form.id}`, { method: 'PATCH', body })
        : await api<CustomerDTO>('/customers', { method: 'POST', body });
      toast.success(form.id ? 'Customer updated' : 'Member enrolled', c.name);
      setForm(null);
      setSelected(c.id);
      void qc.invalidateQueries({ queryKey: ['customers'] });
      void qc.invalidateQueries({ queryKey: ['customer', c.id] });
    } catch (err) {
      toast.error('Could not save', errorMessage(err));
    }
  };

  const [pointsForm, setPointsForm] = useState<null | { points: string; reason: string }>(null);
  const adjustPoints = async (e: FormEvent) => {
    e.preventDefault();
    const points = Math.trunc(Number(pointsForm?.points));
    if (!points || !selected || !pointsForm) return;
    try {
      await api(`/customers/${selected}/points`, { method: 'POST', body: { points, reason: pointsForm.reason } });
      toast.success('Points adjusted', `${points > 0 ? '+' : ''}${points} pts`);
      setPointsForm(null);
      void qc.invalidateQueries({ queryKey: ['customer', selected] });
      void qc.invalidateQueries({ queryKey: ['customers'] });
    } catch (err) {
      toast.error('Adjustment failed', errorMessage(err));
    }
  };

  const d = detail.data;

  return (
    <div className="flex h-full flex-col">
      <PageHeader eyebrow="Loyalty club" title={<>Customers</>}>
        <Button variant="primary" icon="plus" onClick={() => setForm({ name: '', phone: '', email: '', notes: '' })}>
          Enrol member
        </Button>
      </PageHeader>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(20rem,26rem)_1fr]">
        {/* Directory */}
        <div className="flex min-h-0 flex-col border-r border-line">
          <div className="border-b border-line p-4">
            <div className="relative">
              <Icon name="search" size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dust" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, phone, email" className="field pl-10" aria-label="Search customers" />
            </div>
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {list.data?.map((c) => (
              <li key={c.id}>
                <button
                  onClick={() => setSelected(c.id)}
                  className={clsx(
                    'flex w-full items-center gap-3 border-b border-line/60 px-4 py-3 text-left transition-colors',
                    selected === c.id ? 'bg-ink-3' : 'hover:bg-ink-2',
                  )}
                >
                  <Avatar name={c.name} size={36} color={selected === c.id ? '#FFB547' : '#D9D1BF'} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{c.name}</span>
                    <span className="block truncate text-xs text-dust">{c.phone ?? c.email ?? '—'}</span>
                  </span>
                  <span className="num text-sm text-amber">{c.pointsBalance.toLocaleString()}</span>
                </button>
              </li>
            ))}
            {list.data && !list.data.length && <li className="p-6 text-center text-sm text-dust">No customers match.</li>}
          </ul>
        </div>

        {/* Profile */}
        <div className="min-h-0 overflow-y-auto">
          {!d ? (
            <Empty icon="users" title="Pick a member">
              Lifetime spend, points history and recent receipts appear here.
            </Empty>
          ) : (
            <div className="animate-rise p-6 lg:p-10" key={d.id}>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="eyebrow">Member since {fmtDay(d.createdAt)}</p>
                  <h2 className="display mt-1 text-5xl">{d.name}</h2>
                  <p className="mt-2 text-dust">{[d.phone, d.email].filter(Boolean).join(' · ') || 'No contact details'}</p>
                </div>
                <div className="flex gap-2">
                  {can('customers:write') && (
                    <>
                      <Button size="sm" icon="star" onClick={() => setPointsForm({ points: '', reason: '' })}>
                        Adjust points
                      </Button>
                      <Button
                        size="sm"
                        icon="edit"
                        onClick={() => setForm({ id: d.id, name: d.name, phone: d.phone ?? '', email: d.email ?? '', notes: d.notes ?? '' })}
                      >
                        Edit
                      </Button>
                    </>
                  )}
                </div>
              </div>

              {/* Loyalty card */}
              <div className="mt-8 grid gap-4 md:grid-cols-[1.1fr_1fr]">
                <div className="relative overflow-hidden rounded-md bg-amber p-6 text-amber-ink shadow-lift">
                  <div className="hatch absolute inset-0 opacity-30 mix-blend-multiply" />
                  <p className="relative font-mono text-xs uppercase tracking-[0.25em]">Points balance</p>
                  <p className="display relative mt-2 text-7xl leading-none">{d.pointsBalance.toLocaleString()}</p>
                  <p className="relative mt-4 font-mono text-sm">#{d.id.slice(-8).toUpperCase()}</p>
                </div>
                <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line">
                  <Fact label="Lifetime spend" value={money(d.lifetimeSpendCents)} />
                  <Fact label="Visits (recent)" value={String(d.sales.length)} />
                  <Fact label="Avg ticket" value={money(d.sales.length ? Math.round(d.sales.reduce((a, s) => a + s.totalCents, 0) / d.sales.length) : 0)} />
                  <Fact label="Redeemed" value={`${d.sales.reduce((a, s) => a + s.pointsRedeemed, 0)} pts`} />
                </div>
              </div>
              {d.notes && <p className="mt-6 border-l-2 border-amber pl-4 text-dust">{d.notes}</p>}

              <div className="mt-10 grid gap-10 xl:grid-cols-2">
                <section>
                  <p className="eyebrow mb-3">Recent receipts</p>
                  <ul className="divide-y divide-line border-y border-line text-sm">
                    {d.sales.map((s) => (
                      <li key={s.id} className="flex items-center justify-between py-2.5">
                        <span>
                          <span className="num">{s.receiptNo}</span>
                          <span className="ml-2 text-xs text-dust">{fmtDate(s.createdAt)}</span>
                          {s.status !== 'COMPLETED' && (
                            <Badge tone="vermilion" className="ml-2">
                              {s.status.replace('_', ' ')}
                            </Badge>
                          )}
                        </span>
                        <span className="num">{money(s.totalCents)}</span>
                      </li>
                    ))}
                    {!d.sales.length && <li className="py-3 text-dust">No purchases yet.</li>}
                  </ul>
                </section>
                <section>
                  <p className="eyebrow mb-3">Points ledger</p>
                  <ul className="divide-y divide-line border-y border-line text-sm">
                    {d.loyaltyLedger.map((l) => (
                      <li key={l.id} className="flex items-center justify-between gap-3 py-2.5">
                        <span className="min-w-0 truncate text-dust">
                          {l.reason} · {fmtDay(l.createdAt)}
                        </span>
                        <span className={clsx('num shrink-0', l.points >= 0 ? 'text-mint' : 'text-vermilion')}>
                          {l.points >= 0 ? '+' : ''}
                          {l.points}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              </div>
            </div>
          )}
        </div>
      </div>

      <Modal open={!!form} onClose={() => setForm(null)} eyebrow="Customer" title={form?.id ? 'Edit member' : 'Enrol member'}>
        {form && (
          <form onSubmit={save} className="space-y-4">
            <Input label="Full name" required autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Input label="Phone" inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              <Input label="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <Input label="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" onClick={() => setForm(null)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" icon="check">
                Save
              </Button>
            </div>
          </form>
        )}
      </Modal>
      <Modal open={!!pointsForm} onClose={() => setPointsForm(null)} eyebrow="Loyalty" title="Adjust points" width="sm">
        {pointsForm && (
          <form onSubmit={adjustPoints} className="space-y-4">
            <Input
              label="Points (negative to deduct)"
              inputMode="numeric"
              autoFocus
              required
              value={pointsForm.points}
              onChange={(e) => setPointsForm({ ...pointsForm, points: e.target.value.replace(/[^\d-]/g, '') })}
            />
            <Input label="Reason" required minLength={3} value={pointsForm.reason} onChange={(e) => setPointsForm({ ...pointsForm, reason: e.target.value })} />
            <div className="flex justify-end gap-2">
              <Button type="button" onClick={() => setPointsForm(null)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" icon="check">
                Apply
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}

const Fact = ({ label, value }: { label: string; value: string }) => (
  <div className="bg-ink-2 p-4">
    <p className="eyebrow">{label}</p>
    <p className="num mt-1 text-xl text-bone">{value}</p>
  </div>
);
