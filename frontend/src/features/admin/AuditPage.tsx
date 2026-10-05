import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { OVERRIDE_LABEL, type OverrideAction } from '@sync-retail/shared';
import { api } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { Badge, Empty, PageHeader, Segmented } from '@/components/ui/primitives';
import { Icon } from '@/components/ui/Icon';

interface OverrideRow {
  id: string;
  action: OverrideAction;
  outcome: 'APPROVED' | 'DENIED';
  reason: string | null;
  createdAt: string;
  consumedAt: string | null;
  context: Record<string, unknown> | null;
  requestedBy: { name: string };
  approvedBy: { name: string } | null;
  sale: { receiptNo: string } | null;
}
interface AuditRow {
  id: string;
  action: string;
  entity: string;
  entityId: string | null;
  details: unknown;
  createdAt: string;
  actor: { name: string } | null;
}

export function AuditPage() {
  const [tab, setTab] = useState<'overrides' | 'activity'>('overrides');
  const overrides = useQuery({ queryKey: ['overrides'], queryFn: () => api<OverrideRow[]>('/overrides', { query: { take: 200 } }), enabled: tab === 'overrides' });
  const activity = useQuery({ queryKey: ['audit'], queryFn: () => api<AuditRow[]>('/audit', { query: { take: 200 } }), enabled: tab === 'activity' });

  const denied = overrides.data?.filter((o) => o.outcome === 'DENIED').length ?? 0;

  return (
    <div className="pb-16">
      <PageHeader eyebrow="Compliance" title={<>Audit <span className="italic text-dust">trail</span></>}>
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'overrides', label: 'Manager overrides' },
            { value: 'activity', label: 'All activity' },
          ]}
        />
      </PageHeader>

      {tab === 'overrides' ? (
        <div className="px-6 py-6 lg:px-10">
          {!!denied && (
            <p className="hatch mb-5 flex items-center gap-2 rounded-sm border border-vermilion/40 p-3 text-sm text-vermilion">
              <Icon name="alert" size={16} /> {denied} denied PIN attempt{denied > 1 ? 's' : ''} in this list.
            </p>
          )}
          <ol className="relative border-l border-line pl-6">
            {overrides.data?.map((o) => (
              <li key={o.id} className="relative pb-6 animate-rise">
                <span
                  className={clsx(
                    'absolute -left-[1.85rem] top-1 grid h-4 w-4 place-items-center rounded-full border-2 bg-ink',
                    o.outcome === 'APPROVED' ? 'border-mint' : 'border-vermilion',
                  )}
                />
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-medium text-bone">{OVERRIDE_LABEL[o.action]}</span>
                  <Badge tone={o.outcome === 'APPROVED' ? 'mint' : 'vermilion'}>{o.outcome}</Badge>
                  {o.sale && <span className="num text-sm text-dust">{o.sale.receiptNo}</span>}
                  <span className="text-xs text-dust">{fmtDate(o.createdAt)}</span>
                </div>
                <p className="mt-1 text-sm text-dust">
                  Requested by <span className="text-bone">{o.requestedBy.name}</span>
                  {o.approvedBy && (
                    <>
                      {' '}
                      · approved by <span className="text-bone">{o.approvedBy.name}</span>
                    </>
                  )}
                  {o.reason && <> · “{o.reason}”</>}
                  {o.outcome === 'APPROVED' && !o.consumedAt && <span className="text-dust/80"> · not used on a completed sale</span>}
                </p>
                {o.context && Object.keys(o.context).length > 0 && (
                  <p className="num mt-1 text-xs text-dust/80">
                    {Object.entries(o.context)
                      .map(([k, v]) => `${k}=${String(v)}`)
                      .join('  ')}
                  </p>
                )}
              </li>
            ))}
          </ol>
          {overrides.data && !overrides.data.length && <Empty icon="shield" title="No overrides yet" />}
        </div>
      ) : (
        <div className="overflow-x-auto px-6 py-6 lg:px-10">
          <table className="w-full min-w-[44rem] text-sm">
            <thead>
              <tr className="border-y border-line text-left">
                {['When', 'Who', 'Action', 'Entity', 'Details'].map((h) => (
                  <th key={h} className="eyebrow py-2.5 font-normal">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {activity.data?.map((a) => (
                <tr key={a.id} className="border-b border-line/60 align-top">
                  <td className="whitespace-nowrap py-2.5 pr-4 text-dust">{fmtDate(a.createdAt)}</td>
                  <td className="py-2.5 pr-4">{a.actor?.name ?? 'System'}</td>
                  <td className="num py-2.5 pr-4 text-amber">{a.action}</td>
                  <td className="py-2.5 pr-4 text-dust">{a.entity}</td>
                  <td className="num max-w-md truncate py-2.5 text-xs text-dust" title={JSON.stringify(a.details)}>
                    {a.details ? JSON.stringify(a.details) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
