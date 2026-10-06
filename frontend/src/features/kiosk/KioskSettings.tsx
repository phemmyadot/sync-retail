import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, errorMessage } from '@/lib/api';
import { getTerminalId } from '@/lib/config';
import { kiosk, useKiosk, type KioskSettingsInput } from '@/lib/kiosk';
import { useAuth } from '@/store/auth';
import { toast } from '@/store/toast';
import { Badge, Button, Input, Label, Segmented } from '@/components/ui/primitives';

/** Admin → Kiosk: settings for *this* PC, plus the store-wide offline exit PIN. */
export function KioskSettings() {
  const status = useKiosk((s) => s.status);
  const setStatus = useKiosk((s) => s.set);
  const openExit = useKiosk((s) => s.openExit);
  const user = useAuth((s) => s.user);
  const monitors = useQuery({ queryKey: ['kiosk-monitors'], queryFn: kiosk.monitors });
  const [form, setForm] = useState<KioskSettingsInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');

  useEffect(() => {
    void kiosk.status().then(setStatus);
  }, [setStatus]);
  useEffect(() => {
    if (status && !form) {
      setForm({ enabled: status.enabled, level: status.level, autostart: status.autostart, customerDisplayMonitor: status.customerDisplayMonitor });
    }
  }, [status, form]);

  if (!status || !form) return null;

  const save = async () => {
    setBusy(true);
    try {
      const next = await kiosk.save({ ...form, updatedBy: user?.name });
      setStatus(next);
      await api('/kiosk/events', { method: 'POST', body: [{ event: 'settings', register: getTerminalId(), details: { ...form } }] }).catch(() => undefined);
      toast.success('Kiosk settings saved', `Register ${getTerminalId()}`);
    } catch (err) {
      toast.error('Couldn’t save kiosk settings', String(err));
    } finally {
      setBusy(false);
    }
  };

  const savePin = async (clear = false) => {
    try {
      if (!clear && (!/^\d{4}$/.test(pin) || pin !== pin2)) {
        toast.error('Offline exit PIN not set', 'Enter the same 4 digits twice.');
        return;
      }
      const hash = clear ? null : await kiosk.hashPin(pin);
      await api('/kiosk/offline-pin', { method: 'PUT', body: { hash } });
      await kiosk.setOfflineHash(hash);
      setStatus(await kiosk.status());
      setPin('');
      setPin2('');
      toast.success(clear ? 'Offline exit PIN removed' : 'Offline exit PIN set', 'Registers pick it up the next time someone signs in.');
    } catch (err) {
      toast.error('Couldn’t update the offline exit PIN', errorMessage(err));
    }
  };

  const state = !status.active ? 'Off' : status.locked ? 'Locked' : 'Maintenance';
  const devBuild = import.meta.env.DEV && status.envOverride !== '1';

  return (
    <div className="grid gap-10 px-6 py-8 lg:grid-cols-2 lg:px-10">
      <section className="space-y-5">
        <div className="flex items-center gap-3">
          <h2 className="display text-3xl">Kiosk mode</h2>
          <Badge tone={state === 'Locked' ? 'mint' : state === 'Maintenance' ? 'amber' : 'neutral'}>{state}</Badge>
        </div>
        <p className="text-sm text-dust">
          Applies to <span className="text-bone">this register ({getTerminalId()})</span> only. The till opens full screen, can’t be closed or minimised by
          accident, and a manager PIN unlocks it for 10 minutes. Shortcut: press and hold the Sr logo for 3 seconds.
        </p>
        {devBuild && <p className="rounded-sm border border-line bg-ink p-3 text-xs text-dust">Development build: kiosk mode stays off unless started with SR_KIOSK=1.</p>}
        {status.envOverride === '0' && <p className="rounded-sm border border-amber/40 bg-ink p-3 text-xs text-amber">Started with SR_KIOSK=0: kiosk is off for this launch only.</p>}

        <label className="flex items-center gap-3 text-sm">
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} className="h-4 w-4 accent-[rgb(var(--amber))]" />
          Kiosk mode on this register
        </label>
        <div>
          <Label>Level</Label>
          <Segmented
            value={form.level}
            onChange={(level) => setForm({ ...form, level })}
            options={[
              { value: 'standard', label: 'Standard' },
              { value: 'strict', label: 'Strict' },
            ]}
          />
          <p className="mt-2 text-xs text-dust">
            {form.level === 'standard'
              ? 'Full screen, close-protected, browser shortcuts blocked. Right for most shops.'
              : 'Adds always-on-top, blocks the Windows key and Alt+Tab while the till is in front, and relaunches the app if it is closed from Task Manager.'}
          </p>
        </div>
        <label className="flex items-center gap-3 text-sm">
          <input type="checkbox" checked={form.autostart} onChange={(e) => setForm({ ...form, autostart: e.target.checked })} className="h-4 w-4 accent-[rgb(var(--amber))]" />
          Start Sync Retail when Windows signs in
        </label>
        <div>
          <Label htmlFor="display-monitor">Customer display</Label>
          <select id="display-monitor" className="field" value={form.customerDisplayMonitor} onChange={(e) => setForm({ ...form, customerDisplayMonitor: e.target.value })}>
            <option value="auto">Second monitor, if connected (automatic)</option>
            <option value="off">Don’t open automatically</option>
            {monitors.data
              ?.filter((m) => !m.primary)
              .map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name} · {m.width}×{m.height}
                </option>
              ))}
          </select>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            Save for this register
          </Button>
          {status.locked ? (
            <Button onClick={openExit}>Unlock for maintenance…</Button>
          ) : status.active ? (
            <Button onClick={async () => setStatus(await kiosk.relock())}>Restore kiosk now</Button>
          ) : null}
        </div>
        {status.updatedBy && (
          <p className="text-xs text-dust">
            Last changed by {status.updatedBy}
            {status.updatedAt ? ` · ${new Date(status.updatedAt * 1000).toLocaleString()}` : ''}
          </p>
        )}
      </section>

      <section className="space-y-5">
        <div className="flex items-center gap-3">
          <h2 className="display text-3xl">Offline exit PIN</h2>
          <Badge tone={status.hasOfflinePin ? 'mint' : 'neutral'}>{status.hasOfflinePin ? 'Set' : 'Not set'}</Badge>
        </div>
        <p className="text-sm text-dust">
          Store-wide. Used only when a register can’t reach the Main Register to check a manager PIN. It is stored hashed and checked on the register;
          offline unlocks are reported to the audit log once the register reconnects.
        </p>
        <div className="grid max-w-sm grid-cols-2 gap-4">
          <Input label="New PIN" type="password" inputMode="numeric" maxLength={4} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
          <Input label="Repeat" type="password" inputMode="numeric" maxLength={4} value={pin2} onChange={(e) => setPin2(e.target.value.replace(/\D/g, ''))} />
        </div>
        <div className="flex gap-2">
          <Button variant="primary" disabled={pin.length !== 4} onClick={() => void savePin()}>
            {status.hasOfflinePin ? 'Change PIN' : 'Set PIN'}
          </Button>
          {status.hasOfflinePin && (
            <Button variant="quiet" onClick={() => void savePin(true)}>
              Remove
            </Button>
          )}
        </div>
      </section>
    </div>
  );
}
