import { useState } from 'react';
import { OVERRIDE_BYPASS, OVERRIDE_LABEL, type OverrideGrant, type StaffTile } from '@sync-retail/shared';
import { api, errorMessage, NetworkError } from '@/lib/api';
import { useAuth } from '@/store/auth';
import { OverrideCancelled, useOverrideStore } from '@/store/override';
import { toast } from '@/store/toast';
import { Modal } from './ui/Modal';
import { PinPad } from './ui/PinPad';
import { Icon } from './ui/Icon';
import { ApproverPicker } from './ApproverPicker';

/**
 * Global manager-override gate. Any component can `await ask({...})`; this
 * modal collects a manager/admin PIN, has the server verify + log it, and
 * hands back a short-lived single-use token.
 */
export function OverrideModal() {
  const prompt = useOverrideStore((s) => s.prompt);
  const close = useOverrideStore((s) => s.close);
  const requester = useAuth((s) => s.user);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [approver, setApprover] = useState<StaffTile | null>(null);

  if (!prompt) return null;

  const reset = () => {
    setReason('');
    setError(null);
    setBusy(false);
    setApprover(null);
  };

  const cancel = () => {
    prompt.reject(new OverrideCancelled());
    reset();
    close();
  };

  const submit = async (pin: string) => {
    if (!approver) return;
    if (prompt.requireReason && reason.trim().length < 3) {
      setError('Enter a reason before the manager approves.');
      setErrorKey((k) => k + 1);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const grant = await api<OverrideGrant>('/overrides/authorize', {
        method: 'POST',
        body: { approverId: approver.id, pin, action: prompt.action, reason: reason.trim() || undefined, saleId: prompt.saleId, context: prompt.context },
      });
      toast.success(`Approved by ${grant.approvedBy.name}`, OVERRIDE_LABEL[prompt.action]);
      prompt.resolve(grant.overrideToken);
      reset();
      close();
    } catch (err) {
      setBusy(false);
      setError(err instanceof NetworkError ? 'Overrides need a connection to verify the PIN.' : errorMessage(err));
      setErrorKey((k) => k + 1);
    }
  };

  return (
    <Modal open onClose={cancel} tone="danger" eyebrow="Manager override required" title={OVERRIDE_LABEL[prompt.action]} width="sm">
      <div className="space-y-5">
        <div className="rounded-sm border border-line bg-ink p-3 text-sm">
          {prompt.detail && <p className="text-bone">{prompt.detail}</p>}
          <p className="mt-1 flex items-center gap-1.5 text-dust">
            <Icon name="user" size={14} /> Requested by <span className="text-bone">{requester?.name}</span>
          </p>
        </div>

        <div>
          <label htmlFor="override-reason" className="eyebrow mb-1.5 block">
            Reason {prompt.requireReason ? '(required)' : '(optional)'}
          </label>
          <input
            id="override-reason"
            className="field"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Customer changed their mind"
            maxLength={300}
          />
        </div>

        <div>
          <p className="eyebrow mb-2">{approver ? 'Approved by' : 'Who is approving?'}</p>
          <ApproverPicker
            permission={OVERRIDE_BYPASS[prompt.action]}
            value={approver}
            onChange={(a) => {
              setApprover(a);
              setError(null);
            }}
            tone="vermilion"
          />
        </div>

        {approver && (
          <div>
            <p className="eyebrow mb-4 text-center">{approver.name.split(' ')[0]}’s PIN</p>
            <PinPad key={approver.id} onComplete={submit} errorKey={errorKey} busy={busy} tone="vermilion" />
          </div>
        )}
        <p className="min-h-5 text-center text-sm text-vermilion" role="alert">
          {error}
        </p>
        <p className="text-center text-xs text-dust">Every attempt, approved or denied, is written to the audit log.</p>
      </div>
    </Modal>
  );
}
