import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { PinPad } from '@/components/ui/PinPad';
import { Button, Input, Spinner } from '@/components/ui/primitives';
import { Icon } from '@/components/ui/Icon';

interface DiscoveredHost {
  instance: string;
  storeId: string;
  version: string;
  port: number;
  addresses: string[];
}
interface PairInfo {
  storeId: string;
  storeName: string;
  appVersion: string;
}
interface Target {
  address: string;
  info: PairInfo;
}

const DEFAULT_PORT = 47800;
const newer = (a: string, b: string) => {
  const p = (v: string) => v.split(/[.+-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

async function probe(address: string): Promise<PairInfo | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch(`http://${address}/api/pair/info`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const info = (await r.json()) as PairInfo & { hostMode?: boolean };
    return info.hostMode && info.storeId ? info : null;
  } catch {
    return null;
  }
}

/** Add this PC as a register: find the Main Register, enter its 6-digit code. */
export function ClientPairing({ onPaired, onCancel }: { onPaired: () => void; onCancel: () => void }) {
  const [hosts, setHosts] = useState<DiscoveredHost[] | null>(null);
  const [searching, setSearching] = useState(true);
  const [myVersion, setMyVersion] = useState('0.0.0');
  const [manual, setManual] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [checking, setChecking] = useState<string | null>(null);

  useEffect(() => {
    void getVersion().then(setMyVersion);
    let alive = true;
    const scan = async () => {
      setSearching(true);
      try {
        const found = await invoke<DiscoveredHost[]>('discover_hosts', { timeoutMs: 2500 });
        if (alive) setHosts(found);
      } catch {
        if (alive) setHosts([]);
      } finally {
        if (alive) setSearching(false);
      }
    };
    void scan();
    const id = setInterval(scan, 6000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const choose = async (h: DiscoveredHost) => {
    setChecking(h.storeId);
    for (const address of h.addresses) {
      const info = await probe(address);
      if (info && info.storeId === h.storeId) {
        setChecking(null);
        return setTarget({ address, info });
      }
    }
    setChecking(null);
    setManualError(`Found ${h.instance} but couldn’t connect to it. Check the Main Register’s firewall, or type its address below.`);
  };

  const tryManual = async () => {
    setManualError(null);
    const raw = manual.trim();
    if (!raw) return;
    const address = /:\d+$/.test(raw) ? raw : `${raw}:${DEFAULT_PORT}`;
    setChecking('manual');
    const info = await probe(address);
    setChecking(null);
    if (!info) return setManualError(`No Main Register answered at ${address}.`);
    setTarget({ address, info });
  };

  if (target) return <EnterCode target={target} myVersion={myVersion} onBack={() => setTarget(null)} onPaired={onPaired} />;

  return (
    <Shell onBack={onCancel} step="Find your Main Register">
      <p className="text-dust">Make sure this PC is on the same network as the Main Register. Stores on this network:</p>

      <ul className="mt-6 space-y-2">
        {(hosts ?? []).map((h) => {
          const tooNew = newer(myVersion, h.version);
          return (
            <li key={h.storeId}>
              <button
                disabled={tooNew || !!checking}
                onClick={() => void choose(h)}
                className={clsx(
                  'group flex w-full items-center gap-4 rounded-md border p-4 text-left transition-all',
                  tooNew ? 'cursor-not-allowed border-line opacity-60' : 'border-line-strong bg-ink-2 hover:-translate-y-0.5 hover:border-amber',
                )}
              >
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-amber/50 text-amber">
                  {checking === h.storeId ? <Spinner /> : <Icon name="register" size={20} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="display block truncate text-2xl">{h.instance.split(' · ')[0]}</span>
                  <span className="num block text-xs text-dust">
                    {h.addresses[0] ?? '—'} · v{h.version}
                  </span>
                  {tooNew && <span className="mt-1 block text-xs text-vermilion">This register is newer (v{myVersion}). Update the Main Register first.</span>}
                </span>
                {!tooNew && <Icon name="arrowRight" size={18} className="text-dust transition-transform group-hover:translate-x-1 group-hover:text-amber" />}
              </button>
            </li>
          );
        })}
        {hosts !== null && hosts.length === 0 && !searching && (
          <li className="rounded-md border border-dashed border-line p-5 text-sm text-dust">
            No Main Register found yet. Is it switched on and open? Some routers block discovery — you can type its address instead.
          </li>
        )}
        {searching && (
          <li className="flex items-center gap-2 px-1 text-sm text-dust">
            <Spinner className="text-amber" /> Searching the network…
          </li>
        )}
      </ul>

      <div className="mt-10 border-t border-line pt-6">
        <p className="eyebrow mb-2">Or type the Main Register’s address</p>
        <p className="mb-3 text-sm text-dust">Shown on the Main Register under Admin → Registers → Add register.</p>
        <div className="flex gap-2">
          <input
            className="field font-mono"
            placeholder="e.g. 192.168.1.20"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void tryManual()}
            aria-label="Main Register address"
          />
          <Button onClick={() => void tryManual()} loading={checking === 'manual'}>
            Connect
          </Button>
        </div>
        {manualError && <p className="mt-2 text-sm text-vermilion">{manualError}</p>}
      </div>
    </Shell>
  );
}

function EnterCode({ target, myVersion, onBack, onPaired }: { target: Target; myVersion: string; onBack: () => void; onPaired: () => void }) {
  const [name, setName] = useState('');
  const [errorKey, setErrorKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const claim = async (code: string) => {
    if (!name.trim()) {
      setError('Give this register a name first (e.g. “Front counter”).');
      setErrorKey((k) => k + 1);
      nameRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`http://${target.address}/api/pair/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, deviceName: name.trim(), appVersion: myVersion }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message ?? 'Pairing failed');
      await invoke('save_client_pairing', {
        storeId: data.store.id,
        storeName: data.store.name,
        address: target.address,
        deviceId: data.deviceId,
        deviceCode: data.deviceCode,
        deviceToken: data.deviceToken,
      });
      onPaired();
    } catch (err) {
      setBusy(false);
      setError((err as Error).message);
      setErrorKey((k) => k + 1);
    }
  };

  return (
    <Shell onBack={onBack} step={`Pair with ${target.info.storeName}`}>
      <div className="grid gap-10 md:grid-cols-2">
        <div className="space-y-4">
          <p className="text-dust">
            On the Main Register, an admin opens <span className="text-bone">Admin → Registers → Add register</span>. Enter the 6-digit code it shows.
          </p>
          <Input ref={nameRef} label="Name this register" placeholder="Front counter" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <p className="num text-xs text-dust">Main Register: {target.address}</p>
        </div>
        <div>
          <p className="eyebrow mb-4 text-center">Pairing code</p>
          <PinPad length={6} onComplete={claim} errorKey={errorKey} busy={busy} />
          <p className="mt-4 min-h-5 text-center text-sm text-vermilion" role="alert">
            {error}
          </p>
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children, step, onBack }: { children: React.ReactNode; step: string; onBack: () => void }) {
  return (
    <div className="flex min-h-full flex-col px-6 py-10 sm:px-12">
      <div className="mx-auto w-full max-w-4xl animate-rise">
        <button onClick={onBack} className="mb-8 flex items-center gap-2 text-sm text-dust hover:text-bone">
          <Icon name="arrowLeft" size={16} /> Back
        </button>
        <p className="eyebrow text-amber">Connect to Main Register</p>
        <h1 className="display mt-2 text-6xl leading-none">{step}</h1>
        <div className="mt-10">{children}</div>
      </div>
    </div>
  );
}
