import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '@/lib/api';
import { IS_TAURI } from '@/lib/config';
import { kiosk, queueKioskEvent, takeKioskEvents, useKiosk, type KioskStatus } from '@/lib/kiosk';
import { useAuth } from '@/store/auth';
import { toast } from '@/store/toast';
import { IdleLock } from './IdleLock';
import { KioskGuard } from './KioskGuard';
import { KioskExitDialog } from './KioskExitDialog';
import { MaintenanceBanner } from './MaintenanceBanner';

/**
 * Register-window chrome for kiosk mode and the idle lock. Rendered once the
 * store is set up (inside the setup/host gates), never on the customer display.
 */
export function KioskRoot() {
  const onDisplay = useLocation().pathname.startsWith('/display');
  const status = useKiosk((s) => s.status);
  const set = useKiosk((s) => s.set);
  const token = useAuth((s) => s.token);

  useEffect(() => {
    if (!IS_TAURI || onDisplay) return;
    void kiosk.markReady().then(set);
    let unlisten: (() => void)[] = [];
    let cancelled = false;
    void import('@tauri-apps/api/event').then(async ({ listen }) => {
      const subs = await Promise.all([
        listen<KioskStatus>('kiosk://changed', (e) => set(e.payload)),
        listen('kiosk://blocked', () => toast.warn('This register is in kiosk mode', 'Ask a manager to unlock it: press and hold the Sr logo for 3 seconds.')),
        listen('kiosk://relocked', () => toast.info('Kiosk mode is back on')),
      ]);
      if (cancelled) subs.forEach((u) => u());
      else unlisten = subs;
    });
    const enforce = () => void kiosk.enforce();
    window.addEventListener('resize', enforce);
    document.addEventListener('visibilitychange', enforce);
    return () => {
      cancelled = true;
      unlisten.forEach((u) => u());
      window.removeEventListener('resize', enforce);
      document.removeEventListener('visibilitychange', enforce);
    };
  }, [onDisplay, set]);

  // Signed in and online: fetch the store's offline exit PIN hash and report
  // anything that happened while the Main Register was unreachable.
  useEffect(() => {
    if (!IS_TAURI || onDisplay || !token || !status?.available) return;
    void api<{ hash: string | null }>('/kiosk/offline-pin')
      .then(async (r) => {
        await kiosk.setOfflineHash(r.hash);
        set(await kiosk.status());
      })
      .catch(() => undefined);
    const pending = takeKioskEvents();
    if (pending.length) {
      void api('/kiosk/events', { method: 'POST', body: pending }).catch(() => pending.forEach(({ at: _at, ...e }) => queueKioskEvent(e)));
    }
  }, [token, onDisplay, status?.available, set]);

  if (onDisplay) return null;
  return (
    <>
      <IdleLock />
      {status?.locked && <KioskGuard />}
      {status?.active && !status.locked && status.unlockedForSecs != null && <MaintenanceBanner secs={status.unlockedForSecs} />}
      <KioskExitDialog />
    </>
  );
}
