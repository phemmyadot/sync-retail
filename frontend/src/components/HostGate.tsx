import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { setApiBase, setDeviceToken, setTerminalId } from '@/lib/config';
import { localDb } from '@/lib/db';
import { pullCatalog } from '@/lib/sync';
import { useAuth } from '@/store/auth';
import { useCart } from '@/store/cart';
import { useDeviceStatus } from '@/store/device';
import { useSyncStatus } from '@/store/sync';
import { RoleChooser } from '@/features/setup/RoleChooser';
import { ClientPairing } from '@/features/setup/ClientPairing';
import { Button } from './ui/primitives';
import { Icon } from './ui/Icon';

type HostStatus =
  | { state: 'notConfigured' }
  | { state: 'starting' }
  | { state: 'ready'; apiBase: string; storeId: string; firstLaunch: boolean; needsSetup: boolean }
  | { state: 'failed'; message: string; logDir: string };

interface ClientConnection {
  reachable: boolean;
  healed: boolean;
  apiBase: string;
  deviceToken: string;
  deviceCode: string;
  storeId: string;
  storeName: string;
}

type Mode = 'host' | 'client' | null;

/**
 * Desktop only. Routes by this PC's role:
 *   not configured → role chooser (→ host setup, or pairing with a Main Register)
 *   host           → wait for the bundled API + database, then the app
 *   client         → find the Main Register (self-heals IP changes), then the app
 */
export function HostGate({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<Mode | 'loading' | 'pairing'>('loading');

  useEffect(() => {
    void invoke<Mode>('app_mode').then((m) => setMode(m));
  }, []);

  if (mode === 'loading') return null;
  if (mode === 'pairing') return <ClientPairing onCancel={() => setMode(null)} onPaired={() => setMode('client')} />;
  if (mode === 'client') return <ClientGate onForget={() => setMode(null)}>{children}</ClientGate>;
  if (mode === null)
    return (
      <RoleChooser
        onHost={async () => {
          await invoke('configure_host');
          setMode('host');
        }}
        onClient={() => setMode('pairing')}
      />
    );
  return <HostModeGate>{children}</HostModeGate>;
}

// ─── Main Register ──────────────────────────────────────────────────────────

function HostModeGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<HostStatus>({ state: 'starting' });
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    let alive = true;
    const apply = (s: HostStatus) => {
      if (!alive) return;
      if (s.state === 'ready') {
        setApiBase(s.apiBase);
        setTerminalId('R1');
      }
      setStatus(s);
    };
    const unlisten = listen<HostStatus>('host-status', (e) => apply(e.payload));
    const poll = setInterval(() => void invoke<HostStatus>('host_status').then(apply), 500);
    void invoke<HostStatus>('host_status').then(apply);
    const tick = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => {
      alive = false;
      clearInterval(poll);
      clearInterval(tick);
      void unlisten.then((f) => f());
    };
  }, []);

  if (status.state === 'ready') return <>{children}</>;
  if (status.state === 'failed') return <Failure title="The local database didn’t come up." message={status.message} logDir={status.logDir} />;
  return (
    <Splash
      eyebrow="Main register"
      title={
        <>
          Opening the <span className="italic text-amber">register</span>…
        </>
      }
      sub={seconds < 4 ? 'Starting the local database.' : seconds < 15 ? 'Preparing your store data — first launch takes a little longer.' : 'Still working…'}
    />
  );
}

// ─── Paired register ────────────────────────────────────────────────────────

function ClientGate({ children, onForget }: { children: ReactNode; onForget: () => void }) {
  const [conn, setConn] = useState<ClientConnection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const problem = useDeviceStatus((s) => s.problem);

  const connect = useCallback(async () => {
    const c = await invoke<ClientConnection>('client_connect');
    setApiBase(c.apiBase);
    setDeviceToken(c.deviceToken);
    setTerminalId(c.deviceCode);
    return c;
  }, []);

  useEffect(() => {
    connect().then(setConn, (e) => setError(String(e)));
  }, [connect]);

  // While offline, keep looking for the Main Register (it may have a new IP).
  useEffect(() => {
    if (!conn) return;
    const id = setInterval(async () => {
      if (useSyncStatus.getState().online) return;
      try {
        const c = await connect();
        if (c.reachable) {
          setConn(c);
          void pullCatalog();
        }
      } catch {
        /* keep trying */
      }
    }, 20_000);
    return () => clearInterval(id);
  }, [conn, connect]);

  if (problem) return <Removed storeName={conn?.storeName} onForget={onForget} />;
  if (error) return <Failure title="This register can’t start." message={error} action={<ForgetButton onDone={onForget} label="Pair again" />} />;
  if (!conn)
    return (
      <Splash
        eyebrow="Register"
        title={
          <>
            Finding the <span className="italic text-amber">Main Register</span>…
          </>
        }
        sub="Looking for your store on this network."
      />
    );
  return (
    <>
      {!conn.reachable && (
        <div className="fixed inset-x-0 top-0 z-40 bg-vermilion/90 px-4 py-1.5 text-center text-sm text-ink">
          Can’t reach the Main Register for {conn.storeName} — selling offline. Sales will sync when it’s back.
        </div>
      )}
      {children}
    </>
  );
}

function Removed({ storeName, onForget }: { storeName?: string; onForget: () => void }) {
  const [pending, setPending] = useState<number | null>(null);
  useEffect(() => {
    void localDb.outbox.count().then(setPending);
  }, []);
  return (
    <Failure
      eyebrow="Register removed"
      title="This register was removed from the store."
      message={`An admin removed it on the Main Register${storeName ? ` of ${storeName}` : ''}. It can no longer sell or see store data.`}
      extra={
        pending ? (
          <p className="mt-4 rounded-sm border border-amber/40 bg-amber/10 p-3 text-sm text-amber">
            {pending} offline sale(s) on this PC haven’t reached the store. Ask an admin before pairing again — they will be discarded.
          </p>
        ) : null
      }
      action={<ForgetButton onDone={onForget} label="Pair with a Main Register" />}
    />
  );
}

function ForgetButton({ onDone, label }: { onDone: () => void; label: string }) {
  return (
    <Button
      variant="primary"
      icon="refresh"
      onClick={async () => {
        await invoke('forget_pairing');
        await localDb.delete();
        useAuth.getState().signOut();
        useCart.getState().clear();
        useDeviceStatus.getState().setProblem(null);
        setDeviceToken(null);
        window.location.reload();
        onDone();
      }}
    >
      {label}
    </Button>
  );
}

// ─── Shared screens ─────────────────────────────────────────────────────────

function Splash({ eyebrow, title, sub }: { eyebrow: string; title: ReactNode; sub: string }) {
  return (
    <div className="grid min-h-full place-items-center p-8">
      <div className="text-center animate-rise">
        <span className="mx-auto mb-8 grid h-16 w-16 place-items-center rounded-full border border-amber/40 text-amber">
          <Icon name="register" size={28} />
        </span>
        <p className="eyebrow mb-3">{eyebrow}</p>
        <h1 className="display text-5xl">{title}</h1>
        <p className="mt-4 text-dust">{sub}</p>
        <div className="mx-auto mt-8 h-1 w-56 overflow-hidden rounded-full bg-ink-3">
          <div className="h-full w-1/3 animate-[marquee_1.2s_linear_infinite] rounded-full bg-amber" style={{ animationDirection: 'reverse' }} />
        </div>
      </div>
    </div>
  );
}

function Failure({
  eyebrow = 'Register could not start',
  title,
  message,
  logDir,
  extra,
  action,
}: {
  eyebrow?: string;
  title: string;
  message: string;
  logDir?: string;
  extra?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="grid min-h-full place-items-center p-8">
      <div className="w-full max-w-xl rounded-md border border-vermilion/50 bg-ink-2 shadow-lift">
        <div className="hatch h-2 border-b border-vermilion/40" />
        <div className="p-8">
          <p className="eyebrow !text-vermilion">{eyebrow}</p>
          <h1 className="display mt-2 text-4xl">{title}</h1>
          <pre className="mt-5 max-h-48 overflow-auto whitespace-pre-wrap rounded-sm border border-line bg-ink p-3 font-mono text-xs text-dust">{message}</pre>
          {logDir && (
            <p className="mt-4 text-sm text-dust">
              Logs: <span className="num text-bone">{logDir}</span>
            </p>
          )}
          {extra}
          <div className="mt-6">{action ?? <p className="text-sm text-dust">Close and reopen Sync Retail. If it keeps happening, send the log folder to support.</p>}</div>
        </div>
      </div>
    </div>
  );
}
