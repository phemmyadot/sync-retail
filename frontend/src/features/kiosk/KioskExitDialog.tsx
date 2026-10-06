import { useState } from 'react';
import type { StaffTile } from '@sync-retail/shared';
import { ApproverPicker } from '@/components/ApproverPicker';
import { api, errorMessage, NetworkError } from '@/lib/api';
import { getTerminalId } from '@/lib/config';
import { kiosk, queueKioskEvent, useKiosk } from '@/lib/kiosk';
import { toast } from '@/store/toast';
import { Modal } from '@/components/ui/Modal';
import { PinPad } from '@/components/ui/PinPad';

const MAINTENANCE_MINUTES = 10;

/**
 * Manager unlock for kiosk mode. Online: the Main Register checks the PIN and
 * logs it. Main Register unreachable: the store's offline exit PIN is checked
 * on this PC and the unlock is reported once it reconnects.
 */
export function KioskExitDialog() {
  const open = useKiosk((s) => s.exitOpen);
  const close = useKiosk((s) => s.closeExit);
  const status = useKiosk((s) => s.status);
  const setStatus = useKiosk((s) => s.set);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [approver, setApprover] = useState<StaffTile | null>(null);

  if (!open) return null;

  const done = async (by: string) => {
    setStatus(await kiosk.unlock(MAINTENANCE_MINUTES));
    toast.success(`Unlocked for ${MAINTENANCE_MINUTES} minutes`, `Approved by ${by}. Kiosk mode comes back on by itself.`);
    finish();
  };
  const finish = () => {
    setOffline(false);
    setError(null);
    setBusy(false);
    setApprover(null);
    close();
  };
  const fail = (msg: string) => {
    setError(msg);
    setErrorKey((k) => k + 1);
    setBusy(false);
  };

  const checkOffline = async (pin: string) => {
    if (!status?.hasOfflinePin) {
      return fail('The Main Register can’t be reached and no offline exit PIN is set for this store.');
    }
    try {
      if (await kiosk.verifyOfflinePin(pin)) {
        queueKioskEvent({ event: 'offline_unlock', register: getTerminalId() });
        await done('offline exit PIN');
      } else {
        queueKioskEvent({ event: 'offline_unlock_failed', register: getTerminalId() });
        fail('That isn’t the offline exit PIN.');
      }
    } catch (err) {
      fail(String(err));
    }
  };

  const submit = async (pin: string) => {
    setBusy(true);
    setError(null);
    if (offline) return checkOffline(pin);
    if (!approver) return fail('Choose who is approving first.');
    try {
      const r = await api<{ approvedBy: { name: string } }>('/kiosk/unlock', { method: 'POST', body: { approverId: approver.id, pin, register: getTerminalId() } });
      await done(r.approvedBy.name);
    } catch (err) {
      if (err instanceof NetworkError) {
        setOffline(true);
        return checkOffline(pin);
      }
      fail(errorMessage(err));
    }
  };

  return (
    <Modal open onClose={finish} tone="danger" eyebrow="Kiosk mode" title="Unlock for maintenance" width="sm">
      <div className="space-y-5">
        <p className="text-sm text-dust">
          {offline
            ? 'The Main Register can’t be reached. Enter the store’s offline exit PIN.'
            : `A manager or admin PIN unlocks this register for ${MAINTENANCE_MINUTES} minutes: windowed, and the app can be closed.`}
        </p>
        {!offline && (
          <div>
            <p className="eyebrow mb-2">{approver ? 'Approved by' : 'Who is unlocking?'}</p>
            <ApproverPicker permission="devices:manage" value={approver} onChange={setApprover} tone="vermilion" />
          </div>
        )}
        {(offline || approver) && <PinPad key={offline ? 'offline' : approver!.id} onComplete={submit} errorKey={errorKey} busy={busy} tone="vermilion" />}
        <p className="min-h-5 text-center text-sm text-vermilion" role="alert">
          {error}
        </p>
        <div className="flex items-center justify-between text-xs text-dust">
          <span>Every attempt is written to the audit log.</span>
          {!offline && status?.hasOfflinePin && (
            <button className="underline-offset-4 hover:text-bone hover:underline" onClick={() => setOffline(true)}>
              Use offline PIN
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
