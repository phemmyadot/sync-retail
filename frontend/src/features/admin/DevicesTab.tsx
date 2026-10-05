import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { api, errorMessage } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { toast } from '@/store/toast';
import { Badge, Button, Empty } from '@/components/ui/primitives';
import { Modal } from '@/components/ui/Modal';
import { Icon } from '@/components/ui/Icon';

interface DeviceRow {
  id: string;
  code: string;
  name: string;
  kind: 'HOST' | 'REGISTER' | 'DISPLAY';
  appVersion: string | null;
  pairedAt: string;
  lastSeenAt: string | null;
  lastIp: string | null;
  revokedAt: string | null;
  pairedBy: { name: string } | null;
}
interface DevicesResponse {
  host: { code: string; appVersion: string; hostMode: boolean };
  devices: DeviceRow[];
}
interface PairCode {
  code: string;
  expiresAt: string;
  ttlSeconds: number;
  addresses: string[];
  port: number;
}

const ago = (iso: string | null) => {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return fmtDate(iso);
};

/** Admin → Registers: pair new registers with a code, see them, remove them. */
export function DevicesTab() {
  const qc = useQueryClient();
  const [pairing, setPairing] = useState(false);
  const [removing, setRemoving] = useState<DeviceRow | null>(null);
  const list = useQuery({
    queryKey: ['devices'],
    queryFn: () => api<DevicesResponse>('/devices'),
    refetchInterval: pairing ? 2000 : 15000,
  });

  const active = list.data?.devices.filter((d) => !d.revokedAt) ?? [];
  const removed = list.data?.devices.filter((d) => d.revokedAt) ?? [];

  const remove = async () => {
    if (!removing) return;
    try {
      await api(`/devices/${removing.id}`, { method: 'DELETE' });
      toast.success(`${removing.name} removed`, 'It can no longer sell or see store data.');
      setRemoving(null);
      void qc.invalidateQueries({ queryKey: ['devices'] });
    } catch (err) {
      toast.error('Could not remove register', errorMessage(err));
    }
  };

  return (
    <div className="px-6 py-8 lg:px-10">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <p className="max-w-xl text-dust">Registers on this network connect to the Main Register. Each pairs once with a 6-digit code and can be removed at any time.</p>
        <Button variant="primary" icon="plus" onClick={() => setPairing(true)} disabled={list.data && !list.data.host.hostMode}>
          Add register
        </Button>
      </div>

      <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <li className="panel flex items-center gap-4 border-amber/40 p-4">
          <Code code="R1" tone="amber" />
          <span className="min-w-0 flex-1">
            <span className="block font-medium">Main Register</span>
            <span className="block text-sm text-dust">This store’s database · v{list.data?.host.appVersion ?? '…'}</span>
          </span>
          <Badge tone="amber">Host</Badge>
        </li>
        {active.map((d) => {
          const online = d.lastSeenAt && Date.now() - new Date(d.lastSeenAt).getTime() < 3 * 60_000;
          return (
            <li key={d.id} className="panel group flex items-center gap-4 p-4">
              <Code code={d.code} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{d.name}</span>
                <span className="block truncate text-sm text-dust">
                  {online ? <span className="text-mint">● online</span> : `seen ${ago(d.lastSeenAt)}`} · {d.lastIp ?? '—'} · v{d.appVersion ?? '?'}
                </span>
              </span>
              <button
                onClick={() => setRemoving(d)}
                className="rounded-sm p-2 text-dust opacity-60 transition hover:bg-vermilion/10 hover:text-vermilion group-hover:opacity-100"
                aria-label={`Remove ${d.name} (${d.code})`}
                title="Remove register"
              >
                <Icon name="trash" size={16} />
              </button>
            </li>
          );
        })}
      </ul>
      {list.data && !active.length && (
        <Empty icon="register" title="No other registers yet">
          Install Sync Retail on another PC, choose <b>Connect to Main Register</b>, then press <b>Add register</b> here.
        </Empty>
      )}

      {!!removed.length && (
        <details className="mt-10">
          <summary className="eyebrow cursor-pointer">Removed registers ({removed.length})</summary>
          <ul className="mt-3 divide-y divide-line border-y border-line text-sm">
            {removed.map((d) => (
              <li key={d.id} className="flex justify-between gap-3 py-2 text-dust">
                <span>
                  <span className="num mr-2">{d.code}</span>
                  {d.name}
                </span>
                <span>removed {fmtDate(d.revokedAt!)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {pairing && (
        <PairModal
          knownIds={new Set(list.data?.devices.map((d) => d.id) ?? [])}
          devices={list.data?.devices ?? []}
          onClose={() => {
            setPairing(false);
            void qc.invalidateQueries({ queryKey: ['devices'] });
          }}
        />
      )}

      <Modal
        open={!!removing}
        onClose={() => setRemoving(null)}
        tone="danger"
        eyebrow="Remove register"
        title={removing?.name ?? ''}
        width="sm"
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>Cancel</Button>
            <Button variant="danger" icon="trash" onClick={() => void remove()}>
              Remove {removing?.code}
            </Button>
          </>
        }
      >
        <p className="text-dust">
          It stops working immediately: it can’t sell, sync or see store data. Sales it already synced stay in your reports. To use that PC again, pair it with a new
          code.
        </p>
      </Modal>
    </div>
  );
}

function PairModal({ knownIds, devices, onClose }: { knownIds: Set<string>; devices: DeviceRow[]; onClose: () => void }) {
  const [code, setCode] = useState<PairCode | null>(null);
  const [left, setLeft] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const initial = useRef(knownIds);
  const paired = devices.find((d) => !initial.current.has(d.id));

  const issue = async () => {
    setError(null);
    try {
      setCode(await api<PairCode>('/devices/codes', { method: 'POST' }));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  useEffect(() => {
    void issue();
  }, []);

  useEffect(() => {
    if (!code) return;
    const tick = () => setLeft(Math.max(0, Math.round((new Date(code.expiresAt).getTime() - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [code]);

  useEffect(() => {
    if (paired) toast.success(`${paired.name} paired`, `Registered as ${paired.code}.`);
  }, [paired]);

  const close = () => {
    if (code && !paired) void api(`/devices/codes/${code.code}`, { method: 'DELETE' }).catch(() => {});
    onClose();
  };

  return (
    <Modal open onClose={close} eyebrow="Add register" title={paired ? 'Paired' : 'Enter this code on the new register'} width="md">
      {paired ? (
        <div className="py-6 text-center animate-pop">
          <span className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-mint/15 text-mint">
            <Icon name="check" size={30} />
          </span>
          <p className="display mt-4 text-4xl">{paired.name}</p>
          <p className="mt-1 text-dust">
            is now register <span className="num text-bone">{paired.code}</span>. Staff can sign in on it with their PIN.
          </p>
          <Button variant="primary" className="mt-6" onClick={onClose}>
            Done
          </Button>
        </div>
      ) : code ? (
        <div className="space-y-6">
          <div className="text-center">
            <p className={clsx('num text-[4.5rem] font-bold leading-none tracking-[0.15em] transition-opacity', left === 0 ? 'text-dust line-through opacity-50' : 'text-amber')}>
              {code.code.slice(0, 3)} {code.code.slice(3)}
            </p>
            <div className="mx-auto mt-4 h-1 w-64 overflow-hidden rounded-full bg-ink-3">
              <div className="h-full bg-amber transition-[width] duration-500 ease-linear" style={{ width: `${(left / code.ttlSeconds) * 100}%` }} />
            </div>
            <p className="mt-2 text-sm text-dust">
              {left > 0 ? (
                <>
                  Expires in <span className="num text-bone">{Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</span> · single use
                </>
              ) : (
                'Code expired'
              )}
            </p>
            {left === 0 && (
              <Button className="mt-3" icon="refresh" onClick={() => void issue()}>
                New code
              </Button>
            )}
          </div>
          <ol className="space-y-2 rounded-sm border border-line bg-ink p-4 text-sm text-dust">
            <li>1. On the new PC, open Sync Retail and choose <span className="text-bone">Connect to Main Register</span>.</li>
            <li>2. Pick this store from the list — or type its address:</li>
            <li className="num pl-4 text-bone">{code.addresses.map((a) => `${a}${code.port !== 47800 ? `:${code.port}` : ''}`).join('   ·   ') || 'no network address found'}</li>
            <li>3. Enter the code above and name the register.</li>
          </ol>
          <p className="flex items-center gap-2 text-xs text-dust">
            <span className="h-2 w-2 rounded-full bg-amber animate-blink" /> Waiting for the register…
          </p>
        </div>
      ) : (
        <p className="text-sm text-vermilion">{error ?? 'Creating code…'}</p>
      )}
    </Modal>
  );
}

const Code = ({ code, tone }: { code: string; tone?: 'amber' }) => (
  <span className={clsx('grid h-11 w-11 shrink-0 place-items-center rounded-sm font-mono text-sm font-bold', tone === 'amber' ? 'bg-amber text-amber-ink' : 'bg-ink-3 text-bone')}>
    {code}
  </span>
);
