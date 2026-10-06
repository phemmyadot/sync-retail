import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/store/auth';
import { useCart } from '@/store/cart';
import { useIdleHold } from '@/store/idle';
import { useOverrideStore } from '@/store/override';
import { useSettings } from '@/hooks/useSettings';
import { toast } from '@/store/toast';
import { Button } from '@/components/ui/primitives';

const WARN_SECS = 30;
const ACTIVITY = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;

/**
 * Returns an unattended register to the PIN lock screen after the store's idle
 * time. Locking only ends the session: the open sale (cart, customer,
 * approvals) is kept and is waiting when someone signs back in.
 */
export function IdleLock() {
  const token = useAuth((s) => s.token);
  const lock = useAuth((s) => s.lock);
  const minutes = useSettings().data?.idleLockMinutes ?? 5;
  const lastActive = useRef(Date.now());
  const [secsLeft, setSecsLeft] = useState<number | null>(null);

  useEffect(() => {
    setSecsLeft(null);
    if (!token || !minutes) return;
    lastActive.current = Date.now();
    const mark = () => {
      lastActive.current = Date.now();
    };
    for (const ev of ACTIVITY) window.addEventListener(ev, mark, { capture: true, passive: true });
    const tick = setInterval(() => {
      // Never lock in the middle of a submission or while a manager is approving something.
      if (useIdleHold.getState().holds > 0 || useOverrideStore.getState().prompt) {
        lastActive.current = Date.now();
      }
      const left = Math.ceil((lastActive.current + minutes * 60_000 - Date.now()) / 1000);
      if (left <= 0) {
        const items = useCart.getState().lines.length;
        setSecsLeft(null);
        lock();
        if (items) toast.info('Register locked — sale kept', `${items} line(s) are waiting for the next sign-in.`);
      } else {
        setSecsLeft(left <= WARN_SECS ? left : null);
      }
    }, 1000);
    return () => {
      for (const ev of ACTIVITY) window.removeEventListener(ev, mark, { capture: true });
      clearInterval(tick);
    };
  }, [token, minutes, lock]);

  if (secsLeft === null || !token) return null;
  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-ink/80 backdrop-blur-sm" role="alertdialog" aria-label="Locking soon">
      <div className="mx-4 max-w-sm rounded-sm border border-amber/40 bg-ink-2 p-6 text-center shadow-lift">
        <p className="eyebrow text-amber">Still there?</p>
        <p className="num mt-3 text-6xl text-bone">{secsLeft}</p>
        <p className="mt-3 text-sm text-dust">This register locks in {secsLeft} s. The current sale is kept.</p>
        <Button variant="primary" className="mt-5 w-full" onClick={() => (lastActive.current = Date.now())}>
          I’m here
        </Button>
      </div>
    </div>
  );
}
