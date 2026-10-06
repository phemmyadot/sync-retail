import { formatRate, type ParkedChange } from '@sync-retail/shared';
import { useMoney } from '@/lib/format';
import { Icon } from '@/components/ui/Icon';

/** What changed while a resumed sale was on hold (prices, tax rates, removed items, stock). */
export function ResumeChanges({ changes, onDismiss }: { changes: ParkedChange[]; onDismiss: () => void }) {
  const money = useMoney();
  if (!changes.length) return null;
  const text = (c: ParkedChange) => {
    switch (c.kind) {
      case 'price':
        return `${c.name}: ${money(c.from!)} → ${money(c.to!)}`;
      case 'tax':
        return `${c.name}: tax ${formatRate(c.from!)} → ${formatRate(c.to!)}`;
      case 'removed':
        return `${c.name} is no longer sold — removed`;
      case 'stock':
        return `${c.name}: ${c.from} in this sale, ${c.to} in stock`;
    }
  };
  return (
    <div className="mb-3 rounded-sm border border-amber/50 bg-ink p-3 text-sm" role="status">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-medium text-amber">
          <Icon name="alert" size={15} /> Changed while on hold
        </span>
        <button onClick={onDismiss} className="text-dust hover:text-bone" aria-label="Dismiss changes">
          <Icon name="x" size={15} />
        </button>
      </div>
      <ul className="space-y-0.5 text-dust">
        {changes.map((c, i) => (
          <li key={i}>{text(c)}</li>
        ))}
      </ul>
      <p className="mt-1 text-xs text-dust">The cart uses today’s prices.</p>
    </div>
  );
}
