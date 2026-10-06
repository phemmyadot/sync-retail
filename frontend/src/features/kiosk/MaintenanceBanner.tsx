import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { getTerminalId } from '@/lib/config';
import { kiosk, queueKioskEvent, useKiosk } from '@/lib/kiosk';
import { useAuth } from '@/store/auth';
import { Button } from '@/components/ui/primitives';
import { Icon } from '@/components/ui/Icon';

/** Shown while a manager has unlocked kiosk mode; counts down to the automatic re-lock. */
export function MaintenanceBanner({ secs }: { secs: number }) {
  const setStatus = useKiosk((s) => s.set);
  const token = useAuth((s) => s.token);
  const [left, setLeft] = useState(secs);
  useEffect(() => setLeft(secs), [secs]);
  useEffect(() => {
    const t = setInterval(() => setLeft((l) => Math.max(0, l - 1)), 1000);
    return () => clearInterval(t);
  }, []);

  const report = async (event: 'maintenance_end' | 'exit') => {
    const register = getTerminalId();
    try {
      if (!token) throw new Error('signed out');
      await api('/kiosk/events', { method: 'POST', body: [{ event, register, at: new Date().toISOString() }] });
    } catch {
      queueKioskEvent({ event, register });
    }
  };

  return (
    <div className="fixed bottom-4 left-1/2 z-[80] flex -translate-x-1/2 items-center gap-3 rounded-sm border border-amber/50 bg-ink-2 px-4 py-2.5 shadow-lift">
      <Icon name="settings" size={16} className="text-amber" />
      <span className="whitespace-nowrap text-sm text-bone">
        Maintenance mode · kiosk returns in{' '}
        <span className="num text-amber">
          {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
        </span>
      </span>
      <Button
        size="sm"
        variant="primary"
        onClick={async () => {
          setStatus(await kiosk.relock());
          void report('maintenance_end');
        }}
      >
        Restore kiosk now
      </Button>
      <Button
        size="sm"
        variant="danger"
        onClick={async () => {
          await report('exit');
          await kiosk.exitApp();
        }}
      >
        Exit app
      </Button>
    </div>
  );
}
