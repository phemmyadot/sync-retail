import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { formatRate, starterTaxClasses, type TaxClassDTO } from '@sync-retail/shared';
import { api, errorMessage } from '@/lib/api';
import { useMoney } from '@/lib/format';
import { pullCatalog } from '@/lib/sync';
import { useSettings } from '@/hooks/useSettings';
import { toast } from '@/store/toast';
import { Badge, Button, Empty, Input, Label } from '@/components/ui/primitives';
import { Modal } from '@/components/ui/Modal';
import { Icon } from '@/components/ui/Icon';

type Editing = { mode: 'create' } | { mode: 'edit'; cls: TaxClassDTO };

/** Admin → Tax: tax classes and rates (Admin & Manager). */
export function TaxManagement() {
  const qc = useQueryClient();
  const { data: settings } = useSettings();
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [moving, setMoving] = useState<TaxClassDTO | null>(null);
  const [deleting, setDeleting] = useState<TaxClassDTO | null>(null);

  const list = useQuery({ queryKey: ['tax-classes', 'all'], queryFn: () => api<TaxClassDTO[]>('/tax-classes', { query: { includeArchived: true } }) });
  const classes = (list.data ?? []).filter((c) => showArchived || !c.archived);
  const archivedCount = (list.data ?? []).filter((c) => c.archived).length;

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['tax-classes'] });
    await qc.invalidateQueries({ queryKey: ['products'] });
    void pullCatalog(); // registers pick up new rates on their next sync anyway
  };

  const run = async (fn: () => Promise<unknown>, success: string, detail?: string) => {
    try {
      await fn();
      toast.success(success, detail);
      await refresh();
      return true;
    } catch (err) {
      toast.error('Couldn’t save', errorMessage(err));
      return false;
    }
  };

  const createStarters = async () => {
    for (const c of starterTaxClasses(settings?.currency ?? 'NGN')) {
      await api('/tax-classes', { method: 'POST', body: { name: c.name, code: c.code, percentage: c.rateBps / 100, isDefault: c.isDefault } });
    }
    toast.success('Starter tax classes created');
    await refresh();
  };

  return (
    <div className="px-6 py-8 lg:px-10">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <p className="max-w-2xl text-dust">
          Each product belongs to a tax class. Change a class’s rate and every product in it is taxed at the new rate from the next sale — past receipts never
          change. New products get the <span className="text-bone">default</span> class.
        </p>
        <div className="flex items-center gap-3">
          {archivedCount > 0 && (
            <label className="flex items-center gap-2 text-sm text-dust">
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="h-4 w-4 accent-[rgb(var(--amber))]" />
              Show archived ({archivedCount})
            </label>
          )}
          <Button variant="primary" icon="plus" onClick={() => setEditing({ mode: 'create' })}>
            New tax class
          </Button>
        </div>
      </div>

      {list.data && list.data.length === 0 ? (
        <Empty icon="percent" title="No tax classes yet">
          <p>Start with the usual classes for your currency, then adjust.</p>
          <Button className="mt-4" variant="primary" onClick={() => void createStarters()}>
            Create {starterTaxClasses(settings?.currency ?? 'NGN').map((c) => c.name).join(', ')}
          </Button>
        </Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[44rem] text-sm">
            <thead>
              <tr className="border-y border-line text-left">
                {['Tax class', 'Code', 'Rate', 'Products', ''].map((h, i) => (
                  <th key={i} className={clsx('eyebrow py-2.5 font-normal', (i === 2 || i === 3) && 'text-right')}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {classes.map((c) => (
                <tr key={c.id} className={clsx('group border-b border-line/60', c.archived && 'opacity-55')}>
                  <td className="py-3 pr-3">
                    <span className="font-medium text-bone">{c.name}</span>
                    {c.isDefault && (
                      <Badge tone="amber" className="ml-2">
                        Default
                      </Badge>
                    )}
                    {c.archived && <Badge className="ml-2">Archived</Badge>}
                  </td>
                  <td className="num py-3 pr-3 text-dust">{c.code ?? '—'}</td>
                  <td className="num py-3 pr-3 text-right text-lg text-bone">{formatRate(c.rateBps)}</td>
                  <td className="num py-3 pr-3 text-right text-dust">{c.productCount ?? 0}</td>
                  <td className="py-3 text-right">
                    <span className="inline-flex gap-1">
                      {!c.archived && (
                        <Button size="sm" variant="ghost" icon="edit" onClick={() => setEditing({ mode: 'edit', cls: c })}>
                          Edit
                        </Button>
                      )}
                      {!!c.productCount && (
                        <Button size="sm" variant="ghost" icon="arrowRight" onClick={() => setMoving(c)}>
                          Move products…
                        </Button>
                      )}
                      {!c.isDefault && !c.productCount && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void run(() => api(`/tax-classes/${c.id}/archive`, { method: 'POST', body: { archived: !c.archived } }), c.archived ? 'Class restored' : 'Class archived', c.name)}
                        >
                          {c.archived ? 'Restore' : 'Archive'}
                        </Button>
                      )}
                      <button
                        onClick={() => setDeleting(c)}
                        disabled={c.isDefault || !!c.productCount}
                        title={c.isDefault ? 'Make another class the default first' : c.productCount ? 'Move its products to another class first' : 'Delete'}
                        aria-label={`Delete ${c.name}`}
                        className="rounded-sm p-2 text-dust transition hover:bg-vermilion/10 hover:text-vermilion disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-dust"
                      >
                        <Icon name="trash" size={16} />
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && <ClassEditor editing={editing} onClose={() => setEditing(null)} onSaved={refresh} />}
      {moving && <MoveProducts from={moving} classes={(list.data ?? []).filter((c) => !c.archived && c.id !== moving.id)} onClose={() => setMoving(null)} onSaved={refresh} />}

      <Modal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        tone="danger"
        eyebrow="Delete tax class"
        title={deleting?.name ?? ''}
        width="sm"
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>Cancel</Button>
            <Button
              variant="danger"
              icon="trash"
              onClick={async () => {
                if (deleting && (await run(() => api(`/tax-classes/${deleting.id}`, { method: 'DELETE' }), 'Tax class deleted', deleting.name))) setDeleting(null);
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <p className="text-dust">No products use this class. Past receipts keep the class name they were sold under.</p>
      </Modal>
    </div>
  );
}

function ClassEditor({ editing, onClose, onSaved }: { editing: Editing; onClose: () => void; onSaved: () => Promise<void> }) {
  const money = useMoney();
  const cls = editing.mode === 'edit' ? editing.cls : null;
  const [name, setName] = useState(cls?.name ?? '');
  const [code, setCode] = useState(cls?.code ?? '');
  const [pct, setPct] = useState(cls ? String(cls.percentage) : '');
  const [isDefault, setIsDefault] = useState(cls?.isDefault ?? false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rate = Number(pct);
  const valid = pct !== '' && Number.isFinite(rate) && rate >= 0 && rate <= 100 && /^\d+(\.\d{1,2})?$/.test(pct);
  const rateChanged = !!cls && valid && Math.round(rate * 100) !== cls.rateBps;
  const affected = cls?.productCount ?? 0;

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    setError(null);
    if (!valid) return setError('Enter a rate between 0 and 100, with at most two decimals.');
    if (rateChanged && affected > 0 && !confirming) return setConfirming(true);
    setBusy(true);
    try {
      const body = { name: name.trim(), code: code.trim() || null, percentage: rate, ...(isDefault && !cls?.isDefault ? { isDefault: true } : {}) };
      if (cls) await api(`/tax-classes/${cls.id}`, { method: 'PATCH', body });
      else await api('/tax-classes', { method: 'POST', body: { ...body, isDefault } });
      toast.success(cls ? 'Tax class updated' : 'Tax class created', rateChanged ? `${affected} product(s) now at ${formatRate(Math.round(rate * 100))}` : name);
      await onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} eyebrow="Tax class" title={cls ? `Edit ${cls.name}` : 'New tax class'} width="sm">
      {confirming ? (
        <div className="space-y-5">
          <div className="hatch-amber rounded-sm border border-amber/40 p-4">
            <p className="text-bone">
              This changes the price customers pay on <span className="num text-amber">{affected}</span> product{affected === 1 ? '' : 's'} from the next sale.
            </p>
            <p className="mt-2 text-sm text-dust">
              {formatRate(cls!.rateBps)} → <span className="text-bone">{formatRate(Math.round(rate * 100))}</span>. Past receipts are not affected.
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setConfirming(false)}>Back</Button>
            <Button variant="primary" loading={busy} onClick={() => void save()}>
              Change rate
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={save} className="space-y-4">
          <Input label="Name" required autoFocus maxLength={40} placeholder="VAT 7.5%" value={name} onChange={(e) => setName(e.target.value)} />
          <div className="grid grid-cols-2 gap-4">
            <Input label="Rate %" inputMode="decimal" required placeholder="7.5" value={pct} onChange={(e) => setPct(e.target.value.replace(/[^\d.]/g, ''))} />
            <Input label="Code" hint="optional, for imports" maxLength={10} placeholder="VAT" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
          </div>
          {valid && (
            <p className="rounded-sm border border-line bg-ink p-3 text-sm text-dust">
              A {money(1_000_000)} item → tax <span className="num text-bone">{money(Math.round(1_000_000 * rate) / 100)}</span>
            </p>
          )}
          {!cls?.isDefault && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} className="h-4 w-4 accent-[rgb(var(--amber))]" />
              Make this the default for new products
            </label>
          )}
          {error && <p className="text-sm text-vermilion">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" icon="check" loading={busy} disabled={!name.trim() || !valid}>
              Save
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function MoveProducts({ from, classes, onClose, onSaved }: { from: TaxClassDTO; classes: TaxClassDTO[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const [to, setTo] = useState(classes[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const move = async () => {
    setBusy(true);
    try {
      const r = await api<{ moved: number }>(`/tax-classes/${from.id}/reassign`, { method: 'POST', body: { toClassId: to } });
      toast.success(`Moved ${r.moved} product(s)`, `to ${classes.find((c) => c.id === to)?.name}`);
      await onSaved();
      onClose();
    } catch (err) {
      toast.error('Couldn’t move products', errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Move products"
      title={`${from.productCount} product${from.productCount === 1 ? '' : 's'} in ${from.name}`}
      width="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="arrowRight" loading={busy} disabled={!to} onClick={() => void move()}>
            Move
          </Button>
        </>
      }
    >
      <Label htmlFor="move-to">Move them to</Label>
      <select id="move-to" className="field" value={to} onChange={(e) => setTo(e.target.value)}>
        {classes.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name} · {formatRate(c.rateBps)}
          </option>
        ))}
      </select>
      <p className="mt-3 text-sm text-dust">Their tax changes from the next sale. Afterwards you can archive or delete “{from.name}”.</p>
    </Modal>
  );
}
