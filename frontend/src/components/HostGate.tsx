import { useEffect, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { setApiBase } from '@/lib/config';
import { Icon } from './ui/Icon';

type HostStatus =
  | { state: 'starting' }
  | { state: 'ready'; apiBase: string; storeId: string; firstLaunch: boolean }
  | { state: 'failed'; message: string; logDir: string };

/**
 * Desktop only: holds the UI until the bundled host (API + local database)
 * reports ready, then points the API client at it.
 */
export function HostGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<HostStatus>({ state: 'starting' });
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    let alive = true;
    const apply = (s: HostStatus) => {
      if (!alive) return;
      if (s.state === 'ready') setApiBase(s.apiBase);
      setStatus(s);
    };
    const unlisten = listen<HostStatus>('host-status', (e) => apply(e.payload));
    // The host may have become ready before this window subscribed.
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

  if (status.state === 'failed') {
    return (
      <div className="grid min-h-full place-items-center p-8">
        <div className="w-full max-w-xl rounded-md border border-vermilion/50 bg-ink-2 shadow-lift">
          <div className="hatch h-2 border-b border-vermilion/40" />
          <div className="p-8">
            <p className="eyebrow !text-vermilion">Register could not start</p>
            <h1 className="display mt-2 text-4xl">The local database didn’t come up.</h1>
            <pre className="mt-5 max-h-48 overflow-auto whitespace-pre-wrap rounded-sm border border-line bg-ink p-3 font-mono text-xs text-dust">
              {status.message}
            </pre>
            <p className="mt-4 text-sm text-dust">
              Logs: <span className="num text-bone">{status.logDir}</span>
            </p>
            <p className="mt-2 text-sm text-dust">Close and reopen Sync Retail. If it keeps happening, send the log folder to support.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="grid min-h-full place-items-center p-8">
      <div className="text-center animate-rise">
        <span className="mx-auto mb-8 grid h-16 w-16 place-items-center rounded-full border border-amber/40 text-amber">
          <Icon name="register" size={28} />
        </span>
        <p className="eyebrow mb-3">Main register</p>
        <h1 className="display text-5xl">
          Opening the <span className="italic text-amber">register</span>…
        </h1>
        <p className="mt-4 text-dust">
          {seconds < 4 ? 'Starting the local database.' : seconds < 15 ? 'Preparing your store data — first launch takes a little longer.' : 'Still working…'}
        </p>
        <div className="mx-auto mt-8 h-1 w-56 overflow-hidden rounded-full bg-ink-3">
          <div className="h-full w-1/3 animate-[marquee_1.2s_linear_infinite] rounded-full bg-amber" style={{ animationDirection: 'reverse' }} />
        </div>
      </div>
    </div>
  );
}
