import { useEffect, useState, type FormEvent } from 'react';
import type { CustomerDTO } from '@sync-retail/shared';
import { api, errorMessage, NetworkError } from '@/lib/api';
import { localDb } from '@/lib/db';
import { useMoney } from '@/lib/format';
import { Modal } from '@/components/ui/Modal';
import { Avatar, Button, Input, Spinner } from '@/components/ui/primitives';
import { Icon } from '@/components/ui/Icon';

interface Props {
  open: boolean;
  current: CustomerDTO | null;
  onClose: () => void;
  onPick: (c: CustomerDTO | null) => void;
}

/** Search by name / phone / email, or enrol a new member on the spot. */
export function CustomerPicker({ open, current, onClose, onPick }: Props) {
  const money = useMoney();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<CustomerDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [offline, setOffline] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', email: '' });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const rows = await api<CustomerDTO[]>('/customers', { query: { search: q, take: 12 }, signal: ctrl.signal });
        setResults(rows);
        setOffline(false);
        void localDb.customers.bulkPut(rows);
      } catch (err) {
        if (err instanceof NetworkError) {
          setOffline(true);
          const needle = q.toLowerCase();
          const all = await localDb.customers.toArray();
          setResults(all.filter((c) => !needle || c.name.toLowerCase().includes(needle) || c.phone?.includes(needle) || c.email?.includes(needle)).slice(0, 12));
        }
      } finally {
        setLoading(false);
      }
    }, 180);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q, open]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const c = await api<CustomerDTO>('/customers', {
        method: 'POST',
        body: { name: form.name, phone: form.phone || null, email: form.email || null },
      });
      await localDb.customers.put(c);
      onPick(c);
      setCreating(false);
      setForm({ name: '', phone: '', email: '' });
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Modal open={open} onClose={onClose} eyebrow="Loyalty" title={creating ? 'New member' : 'Attach customer'} width="md">
      {creating ? (
        <form onSubmit={create} className="space-y-4">
          <Input label="Full name" autoFocus required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Phone" inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            <Input label="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          {error && <p className="text-sm text-vermilion">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setCreating(false)}>
              Back
            </Button>
            <Button type="submit" variant="primary" icon="plus">
              Enrol & attach
            </Button>
          </div>
        </form>
      ) : (
        <div className="space-y-4">
          <div className="relative">
            <Icon name="search" size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dust" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Name, phone or email"
              className="field h-12 pl-10"
              aria-label="Search customers"
            />
            {loading && <Spinner className="absolute right-3 top-1/2 -translate-y-1/2 text-dust" />}
          </div>
          {offline && <p className="text-xs text-amber">Offline — searching customers cached on this register.</p>}
          <ul className="max-h-80 space-y-1 overflow-y-auto">
            {results.map((c) => (
              <li key={c.id}>
                <button
                  onClick={() => onPick(c)}
                  className="flex w-full items-center gap-3 rounded-sm border border-transparent p-2.5 text-left transition-colors hover:border-line hover:bg-ink-3"
                >
                  <Avatar name={c.name} size={36} color="#D9D1BF" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{c.name}</span>
                    <span className="block truncate text-xs text-dust">{[c.phone, c.email].filter(Boolean).join(' · ') || 'No contact'}</span>
                  </span>
                  <span className="text-right">
                    <span className="num block text-amber">{c.pointsBalance.toLocaleString()} pts</span>
                    <span className="num block text-2xs text-dust">LTV {money(c.lifetimeSpendCents)}</span>
                  </span>
                </button>
              </li>
            ))}
            {!loading && !results.length && <li className="py-6 text-center text-sm text-dust">No matches.</li>}
          </ul>
          <div className="flex justify-between gap-2 border-t border-line pt-4">
            {current ? (
              <Button variant="danger" size="sm" icon="x" onClick={() => onPick(null)}>
                Detach {current.name.split(' ')[0]}
              </Button>
            ) : (
              <span />
            )}
            <Button size="sm" icon="plus" onClick={() => setCreating(true)} disabled={offline}>
              New member
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
