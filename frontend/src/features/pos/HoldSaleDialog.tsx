import { useEffect, useState, type FormEvent } from 'react';
import { PARKED_REFERENCE_MAX } from '@sync-retail/shared';
import { useMoney } from '@/lib/format';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/primitives';

interface Props {
  open: boolean;
  /** Pre-fill: the attached customer's name, if any. */
  suggestion: string;
  itemCount: number;
  totalCents: number;
  onClose: () => void;
  onHold: (reference: string) => Promise<void>;
}

/** "Who is this for?" — a note so the cashier can find the sale again. Enter saves. */
export function HoldSaleDialog({ open, suggestion, itemCount, totalCents, onClose, onHold }: Props) {
  const money = useMoney();
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setReference(suggestion);
  }, [open, suggestion]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onHold(reference);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} eyebrow="Hold sale" title="Who is this for?" width="sm">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-dust">
          <span className="num text-bone">{itemCount}</span> item{itemCount === 1 ? '' : 's'} · <span className="num text-bone">{money(totalCents)}</span>. The
          register clears for the next customer; resume it from <span className="text-bone">Held</span> on any register.
        </p>
        <div>
          <label htmlFor="hold-ref" className="eyebrow mb-1.5 block">
            Note (optional)
          </label>
          <input
            id="hold-ref"
            className="field"
            autoFocus
            maxLength={PARKED_REFERENCE_MAX}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="e.g. Lady in green jacket · Mr Bello, gone for cash"
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" icon="pause" loading={busy}>
            Hold sale
          </Button>
        </div>
      </form>
    </Modal>
  );
}
