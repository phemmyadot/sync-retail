import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { BANNER_TOKENS, fillBannerText, formatBps, ROLE_LABEL, ROLES, type Role, type StoreSettings } from '@sync-retail/shared';
import { api, download, errorMessage } from '@/lib/api';
import { IS_TAURI } from '@/lib/config';
import { centsToInput, fmtDay, inputToCents, useCurrencySymbol, useMoney } from '@/lib/format';
import { useAuth } from '@/store/auth';
import { toast } from '@/store/toast';
import { Avatar, Badge, Button, Input, Label, PageHeader, Segmented } from '@/components/ui/primitives';
import { Modal } from '@/components/ui/Modal';
import { DevicesTab } from './DevicesTab';
import { TaxManagement } from './TaxManagement';
import { useCan } from '@/hooks/useOverride';

interface StaffUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  color: string | null;
  active: boolean;
  createdAt: string;
}

const SWATCHES = ['#FFB547', '#8BE28B', '#6FC9F2', '#E7A6F0', '#F28C6B', '#D9D1BF'];

type AdminTab = 'staff' | 'store' | 'tax' | 'registers' | 'system';

export function AdminPage() {
  const can = useCan();
  // Each tab is shown only to roles allowed to use it (managers: Tax, Registers).
  const tabs = (
    [
      { value: 'staff', label: 'Staff & PINs', show: can('users:manage') },
      { value: 'store', label: 'Store & loyalty', show: can('settings:write') },
      { value: 'tax', label: 'Tax', show: can('tax:manage') },
      { value: 'registers', label: 'Registers', show: IS_TAURI && can('devices:manage') },
      { value: 'system', label: 'System', show: can('users:manage') },
    ] as { value: AdminTab; label: string; show: boolean }[]
  ).filter((t) => t.show);
  const [chosen, setTab] = useState<AdminTab | null>(null);
  const tab = chosen && tabs.some((t) => t.value === chosen) ? chosen : (tabs[0]?.value ?? 'tax');
  return (
    <div className="pb-16">
      <PageHeader eyebrow="Administration" title={<>Back <span className="italic text-dust">office</span></>}>
        <Segmented
          value={tab}
          onChange={setTab}
          options={tabs.map(({ value, label }) => ({ value, label }))}
        />
      </PageHeader>
      {tab === 'staff' ? (
        <StaffTab />
      ) : tab === 'store' ? (
        <StoreTab />
      ) : tab === 'tax' ? (
        <TaxManagement />
      ) : tab === 'registers' ? (
        <DevicesTab />
      ) : (
        <SystemTab />
      )}
    </div>
  );
}

function StaffTab() {
  const qc = useQueryClient();
  const me = useAuth((s) => s.user);
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<StaffUser[]>('/users') });
  const [edit, setEdit] = useState<(Partial<StaffUser> & { password?: string; pin?: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!edit) return;
    setError(null);
    try {
      const body = {
        name: edit.name,
        email: edit.email,
        role: edit.role,
        color: edit.color,
        ...(edit.password && { password: edit.password }),
        ...(edit.pin && { pin: edit.pin }),
        ...(edit.id && { active: edit.active }),
      };
      if (edit.id) await api(`/users/${edit.id}`, { method: 'PATCH', body });
      else await api('/users', { method: 'POST', body });
      toast.success(edit.id ? 'Staff updated' : 'Staff added', edit.name);
      setEdit(null);
      void qc.invalidateQueries({ queryKey: ['users'] });
      void qc.invalidateQueries({ queryKey: ['staff'] });
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div className="px-6 py-8 lg:px-10">
      <div className="mb-5 flex items-center justify-between">
        <p className="max-w-xl text-dust">PINs power quick-switch at the till and manager overrides. Only managers and admins can approve overrides.</p>
        <Button variant="primary" icon="plus" onClick={() => setEdit({ role: 'SALES_AGENT', color: SWATCHES[2], active: true })}>
          Add staff
        </Button>
      </div>
      <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {users.data?.map((u, i) => (
          <li key={u.id} className="animate-rise" style={{ animationDelay: `${i * 40}ms` }}>
            <button
              onClick={() => setEdit({ ...u })}
              className={clsx('panel flex w-full items-center gap-4 p-4 text-left transition-colors hover:border-line-strong', !u.active && 'opacity-50')}
            >
              <Avatar name={u.name} color={u.color} size={48} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">
                  {u.name} {u.id === me?.id && <span className="text-dust">(you)</span>}
                </span>
                <span className="block truncate text-sm text-dust">{u.email}</span>
                <span className="mt-1.5 flex gap-1.5">
                  <Badge tone={u.role === 'ADMIN' ? 'amber' : u.role === 'MANAGER' ? 'mint' : 'neutral'}>{ROLE_LABEL[u.role]}</Badge>
                  {!u.active && <Badge tone="vermilion">Disabled</Badge>}
                </span>
              </span>
              <span className="text-xs text-dust">{fmtDay(u.createdAt)}</span>
            </button>
          </li>
        ))}
      </ul>

      <Modal open={!!edit} onClose={() => setEdit(null)} eyebrow="Staff" title={edit?.id ? `Edit ${edit.name}` : 'New staff member'}>
        {edit && (
          <form onSubmit={save} className="space-y-4">
            <Input label="Name" required value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            <Input label="Email" type="email" required value={edit.email ?? ''} onChange={(e) => setEdit({ ...edit, email: e.target.value })} />
            <div>
              <Label>Role</Label>
              <Segmented<Role>
                value={edit.role ?? 'SALES_AGENT'}
                onChange={(role) => setEdit({ ...edit, role })}
                options={[...ROLES].reverse().map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label="Password"
                type="password"
                autoComplete="new-password"
                required={!edit.id}
                minLength={8}
                hint={edit.id ? 'Leave blank to keep' : '8+ chars'}
                value={edit.password ?? ''}
                onChange={(e) => setEdit({ ...edit, password: e.target.value })}
              />
              <Input
                label="PIN"
                inputMode="numeric"
                autoComplete="off"
                required={!edit.id}
                pattern="\d{4,8}"
                hint={edit.id ? 'Leave blank to keep' : '4–8 digits'}
                value={edit.pin ?? ''}
                onChange={(e) => setEdit({ ...edit, pin: e.target.value.replace(/\D/g, '').slice(0, 8) })}
              />
            </div>
            <div>
              <Label>Tile colour</Label>
              <div className="flex gap-2">
                {SWATCHES.map((c) => (
                  <button
                    type="button"
                    key={c}
                    onClick={() => setEdit({ ...edit, color: c })}
                    aria-label={`Colour ${c}`}
                    className={clsx('h-8 w-8 rounded-sm transition-transform', edit.color === c && 'scale-110 ring-2 ring-bone ring-offset-2 ring-offset-ink-2')}
                    style={{ background: c }}
                  />
                ))}
              </div>
            </div>
            {edit.id && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={edit.active ?? true} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} className="h-4 w-4 accent-[rgb(var(--amber))]" />
                Account active
              </label>
            )}
            {error && <p className="text-sm text-vermilion">{error}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" onClick={() => setEdit(null)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" icon="check">
                Save
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}

function StoreTab() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['settings', true], queryFn: () => api<StoreSettings>('/settings') });
  const [form, setForm] = useState<StoreSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const money = useMoney();
  const symbol = useCurrencySymbol();

  useEffect(() => {
    if (settings.data && !form) setForm(settings.data);
  }, [settings.data, form]);

  if (!form) return null;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const next = await api<StoreSettings>('/settings', { method: 'PUT', body: form });
      setForm(next);
      void qc.invalidateQueries({ queryKey: ['settings'] });
      toast.success('Settings saved');
    } catch (err) {
      toast.error('Could not save', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const l = form.loyalty;
  return (
    <form onSubmit={save} className="grid gap-10 px-6 py-8 lg:grid-cols-2 lg:px-10">
      <section className="space-y-4">
        <h2 className="display text-3xl">Store</h2>
        <Input label="Store name" value={form.storeName} onChange={(e) => setForm({ ...form, storeName: e.target.value })} />
        <div className="grid grid-cols-2 gap-4">
          <Input label="Currency (ISO)" maxLength={3} value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} />
          <Input label="Locale" value={form.locale} onChange={(e) => setForm({ ...form, locale: e.target.value })} />
        </div>
        <Input
          label="Agent discount limit %"
          hint={`Currently ${formatBps(form.agentMaxDiscountBps)} — higher needs a manager PIN`}
          inputMode="decimal"
          value={String(form.agentMaxDiscountBps / 100)}
          onChange={(e) => setForm({ ...form, agentMaxDiscountBps: Math.round(Number(e.target.value) * 100) || 0 })}
        />
        <Input label="Receipt footer" value={form.receiptFooter} onChange={(e) => setForm({ ...form, receiptFooter: e.target.value })} />
      </section>

      <section className="space-y-4">
        <h2 className="display text-3xl">Loyalty rewards</h2>
        <div className="grid grid-cols-3 gap-4">
          <Input
            label={`Pts per ${symbol}1`}
            inputMode="numeric"
            value={String(l.pointsPerDollar)}
            onChange={(e) => setForm({ ...form, loyalty: { ...l, pointsPerDollar: Number(e.target.value) || 0 } })}
          />
          <Input
            label="Redeem block"
            inputMode="numeric"
            value={String(l.redeemBlockPoints)}
            onChange={(e) => setForm({ ...form, loyalty: { ...l, redeemBlockPoints: Number(e.target.value) || 1 } })}
          />
          <Input
            label={`Block value ${symbol}`}
            inputMode="decimal"
            value={centsToInput(l.redeemBlockValueCents)}
            onChange={(e) => setForm({ ...form, loyalty: { ...l, redeemBlockValueCents: inputToCents(e.target.value) || 1 } })}
          />
        </div>
        <p className="rounded-sm border border-line bg-ink p-3 text-sm text-dust">
          A {money(5000)} purchase earns <span className="num text-amber">{50 * l.pointsPerDollar}</span> pts. {l.redeemBlockPoints} pts take{' '}
          <span className="num text-amber">{money(l.redeemBlockValueCents)}</span> off — an effective{' '}
          <span className="num text-bone">{((l.redeemBlockValueCents / 100 / (l.redeemBlockPoints / Math.max(1, l.pointsPerDollar))) * 100).toFixed(1)}%</span> back.
        </p>

        <h3 className="eyebrow pt-4">Customer display banners</h3>
        <p className="text-xs text-dust">
          Placeholders fill in from the settings above, so banners follow your currency:{' '}
          {BANNER_TOKENS.map((t) => (
            <code key={t} className="mr-1 rounded-xs bg-ink-3 px-1 font-mono text-bone">
              {t}
            </code>
          ))}
        </p>
        {form.promoBanners.map((b, i) => (
          <div key={i} className="grid grid-cols-[1fr_1.4fr_auto] gap-2">
            <input className="field" value={b.title} aria-label="Banner title" onChange={(e) => setForm({ ...form, promoBanners: form.promoBanners.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })} />
            <input className="field" value={b.subtitle} aria-label="Banner subtitle" onChange={(e) => setForm({ ...form, promoBanners: form.promoBanners.map((x, j) => (j === i ? { ...x, subtitle: e.target.value } : x)) })} />
            <Button type="button" variant="quiet" icon="trash" aria-label="Remove banner" onClick={() => setForm({ ...form, promoBanners: form.promoBanners.filter((_, j) => j !== i) })} />
            <p className="col-span-3 -mt-1 truncate text-xs text-dust">
              Shows as: <span className="text-bone">{fillBannerText(b.title, form)}</span> — {fillBannerText(b.subtitle, form)}
            </p>
          </div>
        ))}
        <Button type="button" size="sm" icon="plus" onClick={() => setForm({ ...form, promoBanners: [...form.promoBanners, { title: '', subtitle: '' }] })} disabled={form.promoBanners.length >= 8}>
          Add banner
        </Button>
      </section>

      <div className="lg:col-span-2">
        <Button type="submit" variant="primary" size="lg" loading={busy} icon="check">
          Save settings
        </Button>
      </div>
    </form>
  );
}

function SystemTab() {
  const [busy, setBusy] = useState(false);
  const [host, setHost] = useState<{ storeId?: string; apiBase?: string } | null>(null);

  useEffect(() => {
    if (!IS_TAURI) return;
    void import('@tauri-apps/api/core').then(({ invoke }) => invoke<{ storeId?: string; apiBase?: string }>('host_status').then(setHost));
  }, []);

  const exportDiagnostics = async () => {
    setBusy(true);
    try {
      await download('/admin/diagnostics');
      toast.success('Diagnostics saved', 'Send this file to support. It contains no passwords or keys.');
    } catch (err) {
      toast.error('Could not create diagnostics', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-10 px-6 py-8 lg:grid-cols-2 lg:px-10">
      <section className="space-y-4">
        <h2 className="display text-3xl">This installation</h2>
        <dl className="divide-y divide-line border-y border-line text-sm">
          <Row k="Mode" v={IS_TAURI ? 'Main Register (desktop host)' : 'Server (web)'} />
          {host?.storeId && <Row k="Store ID" v={host.storeId} mono />}
          {host?.apiBase && <Row k="Local API" v={host.apiBase} mono />}
        </dl>
      </section>
      <section className="space-y-4">
        <h2 className="display text-3xl">Diagnostics</h2>
        <p className="text-dust">
          A text report for support: versions, record counts, migrations, network addresses and recent logs. Passwords, tokens and the recovery key are never
          included.
        </p>
        <Button variant="primary" icon="download" loading={busy} onClick={() => void exportDiagnostics()}>
          Download diagnostics
        </Button>
      </section>
    </div>
  );
}

const Row = ({ k, v, mono }: { k: string; v: string; mono?: boolean }) => (
  <div className="flex items-center justify-between gap-4 py-2.5">
    <dt className="text-dust">{k}</dt>
    <dd className={clsx('text-right text-bone', mono && 'num text-xs')}>{v}</dd>
  </div>
);
