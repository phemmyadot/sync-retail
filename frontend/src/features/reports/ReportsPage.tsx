import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { formatMoneyCompact, formatRate, PAYMENT_LABEL, type ReportGranularity, type ReportSummary } from '@sync-retail/shared';
import { useSettings } from '@/hooks/useSettings';
import { api, download, errorMessage } from '@/lib/api';
import { useMoney } from '@/lib/format';
import { toast } from '@/store/toast';
import { Button, PageHeader, Segmented } from '@/components/ui/primitives';
import { fitClass } from '@/components/ui/Price';
import { BarSeries, PAYMENT_COLORS, RankBars, ShareBar } from './charts';

type Preset = 'today' | 'week' | 'month' | 'quarter' | 'year' | 'custom';

export function ReportsPage() {
  const money = useMoney();
  const [preset, setPreset] = useState<Preset>('month');
  const [granularity, setGranularity] = useState<ReportGranularity | ''>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [exporting, setExporting] = useState<string | null>(null);

  const params = {
    preset,
    granularity: granularity || undefined,
    ...(preset === 'custom' && { from: from || undefined, to: to || undefined }),
  };

  const report = useQuery({
    queryKey: ['report', params],
    queryFn: () => api<ReportSummary>('/reports/summary', { query: params }),
    placeholderData: (prev) => prev,
  });
  const r = report.data;

  const exportAs = async (format: 'csv' | 'pdf', dataset: 'summary' | 'ledger' = 'summary') => {
    setExporting(`${format}-${dataset}`);
    try {
      await download('/reports/export', { ...params, format, dataset });
    } catch (err) {
      toast.error('Export failed', errorMessage(err));
    } finally {
      setExporting(null);
    }
  };

  const bucketLabel = (iso: string) => {
    const d = new Date(iso);
    if (r?.range.granularity === 'month') return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };
  const { data: settings } = useSettings();
  const compact = (c: number) => formatMoneyCompact(c, settings?.currency, settings?.locale);

  return (
    <div className="pb-16">
      <PageHeader eyebrow="Analytics" title={<>The <span className="italic text-amber">numbers</span></>}>
        <Button size="sm" icon="download" loading={exporting === 'csv-summary'} onClick={() => void exportAs('csv')}>
          Summary CSV
        </Button>
        <Button size="sm" icon="download" loading={exporting === 'csv-ledger'} onClick={() => void exportAs('csv', 'ledger')}>
          Sales ledger CSV
        </Button>
        <Button size="sm" variant="primary" icon="file" loading={exporting === 'pdf-summary'} onClick={() => void exportAs('pdf')}>
          PDF report
        </Button>
      </PageHeader>

      {/* Filters: one row above all charts */}
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-6 py-4 lg:px-10">
        <Segmented<Preset>
          value={preset}
          onChange={setPreset}
          options={[
            { value: 'today', label: 'Today' },
            { value: 'week', label: '7 days' },
            { value: 'month', label: '30 days' },
            { value: 'quarter', label: '90 days' },
            { value: 'year', label: '12 mo' },
            { value: 'custom', label: 'Custom' },
          ]}
        />
        {preset === 'custom' && (
          <div className="flex items-center gap-2">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="field h-9 w-auto py-1" aria-label="From date" />
            <span className="text-dust">→</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="field h-9 w-auto py-1" aria-label="To date" />
          </div>
        )}
        <span className="ml-auto flex items-center gap-2">
          <span className="eyebrow">Group by</span>
          <Segmented<ReportGranularity | ''>
            size="sm"
            value={granularity}
            onChange={setGranularity}
            options={[
              { value: '', label: 'Auto' },
              { value: 'day', label: 'Day' },
              { value: 'week', label: 'Week' },
              { value: 'month', label: 'Month' },
            ]}
          />
        </span>
      </div>

      {report.isError && <p className="px-10 py-6 text-vermilion">{errorMessage(report.error)}</p>}

      {r && (
        <div className={clsx('transition-opacity', report.isFetching && 'opacity-60')}>
          {/* Hero + KPI ledger */}
          <section className="grid border-b border-line lg:grid-cols-[1.2fr_2fr]">
            <div className="border-b border-line px-6 py-8 lg:border-b-0 lg:border-r lg:px-10">
              <p className="eyebrow">Net sales</p>
              <p
                className={clsx(
                  'display mt-2 whitespace-nowrap leading-[0.9] text-bone',
                  fitClass(money(r.totals.netCents), [[10, 'text-[clamp(3.5rem,7vw,6.5rem)]'], [14, 'text-[clamp(2.75rem,5vw,4.75rem)]']], 'text-[clamp(2.25rem,3.8vw,3.5rem)]'),
                )}
              >
                {money(r.totals.netCents)}
              </p>
              <p className="mt-3 text-sm text-dust">
                {new Date(r.range.from).toLocaleDateString()} — {new Date(r.range.to).toLocaleDateString()} · after{' '}
                <span className="num text-bone">{money(r.totals.refundedCents)}</span> in refunds
              </p>
            </div>
            <dl className="grid grid-cols-2 md:grid-cols-3">
              <Kpi label="Transactions" value={r.totals.transactions.toLocaleString()} />
              <Kpi label="Average ticket" value={money(r.totals.averageTicketCents)} />
              <Kpi label="Items sold" value={r.totals.itemsSold.toLocaleString()} />
              <Kpi label="Gross margin" value={money(r.totals.grossMarginCents)} />
              <Kpi label="Tax collected" value={money(r.totals.taxCents)} />
              <Kpi label="Discounts given" value={money(r.totals.discountCents)} />
            </dl>
          </section>

          <section className="border-b border-line px-6 py-8 lg:px-10">
            <div className="mb-6 flex items-baseline justify-between">
              <h2 className="display text-3xl">Net sales by {r.range.granularity}</h2>
              <span className="eyebrow">{r.series.length} periods</span>
            </div>
            <BarSeries
              data={r.series.map((s) => ({
                label: bucketLabel(s.bucket),
                value: s.totalCents,
                meta: `${s.transactions} transaction${s.transactions === 1 ? '' : 's'}`,
              }))}
              format={compact}
            />
          </section>

          <section className="grid border-b border-line xl:grid-cols-3">
            <Panel title="Top sellers" eyebrow="Revenue ex tax">
              <RankBars rows={r.topProducts.map((p) => ({ name: p.name, value: p.revenueCents, note: `×${p.quantity}` }))} format={money} />
            </Panel>
            <Panel title="Categories" eyebrow="Revenue ex tax">
              <RankBars rows={r.categories.map((c) => ({ name: c.name, value: c.revenueCents, note: `×${c.quantity}` }))} format={money} />
            </Panel>
            <Panel title="Payment mix" eyebrow="By amount">
              <ShareBar
                format={money}
                parts={(['CASH', 'CARD', 'LOYALTY'] as const).map((m) => {
                  const p = r.payments.find((x) => x.method === m);
                  return { key: m, label: PAYMENT_LABEL[m], value: p?.amountCents ?? 0, count: p?.count ?? 0, color: PAYMENT_COLORS[m] };
                })}
              />
            </Panel>
          </section>

          <section className="border-b border-line px-6 py-8 lg:px-10">
            <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="display text-3xl">Tax by class</h2>
              <span className="eyebrow">For VAT returns · net of returns</span>
            </div>
            {r.taxes.length ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[34rem] text-sm">
                  <thead>
                    <tr className="border-y border-line text-left">
                      {['Tax class', 'Rate', 'Taxable sales', 'Tax collected'].map((h, i) => (
                        <th key={h} className={clsx('eyebrow py-2.5 font-normal', i > 0 && 'text-right')}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {r.taxes.map((t) => (
                      <tr key={`${t.name}-${t.rateBps}`} className="border-b border-line/60">
                        <td className="py-2.5 text-bone">{t.name}</td>
                        <td className="num py-2.5 text-right text-dust">{formatRate(t.rateBps)}</td>
                        <td className="num py-2.5 text-right">{money(t.taxableCents)}</td>
                        <td className="num py-2.5 text-right text-bone">{money(t.taxCents)}</td>
                      </tr>
                    ))}
                    <tr className="font-medium">
                      <td className="py-2.5 text-bone">Total</td>
                      <td />
                      <td className="num py-2.5 text-right">{money(r.taxes.reduce((a, t) => a + t.taxableCents, 0))}</td>
                      <td className="num py-2.5 text-right text-amber">{money(r.taxes.reduce((a, t) => a + t.taxCents, 0))}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-dust">No sales in this period.</p>
            )}
          </section>

          <section className="border-b border-line px-6 py-8 lg:px-10">
            <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="display text-3xl">Held sales</h2>
              <span className="eyebrow">Started in this period</span>
            </div>
            <div className="grid grid-cols-2 gap-px overflow-hidden rounded-sm border border-line bg-line sm:grid-cols-3 lg:grid-cols-6">
              {[
                ['Held', String(r.held.held)],
                ['Resumed', String(r.held.resumed)],
                ['Discarded', String(r.held.discarded)],
                ['Expired', String(r.held.expired)],
                ['Still held', String(r.held.open)],
                ['Abandoned value', money(r.held.abandonedCents)],
              ].map(([label, value]) => (
                <div key={label} className="bg-ink px-4 py-3">
                  <p className="eyebrow">{label}</p>
                  <p className={clsx('num mt-1 text-xl', label === 'Abandoned value' && r.held.abandonedCents ? 'text-vermilion' : 'text-bone')}>{value}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="px-6 py-8 lg:px-10">
            <h2 className="display mb-6 text-3xl">Staff performance</h2>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[44rem] text-sm">
                <thead>
                  <tr className="border-y border-line text-left">
                    {['Name', 'Sales', 'Net revenue', '', 'Avg ticket', 'Voids', 'Overrides'].map((h, i) => (
                      <th key={i} className={clsx('eyebrow py-2.5 font-normal', i > 0 && i !== 3 && 'text-right')}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {r.workers.map((w) => {
                    const top = r.workers[0]?.revenueCents || 1;
                    return (
                      <tr key={w.userId} className="border-b border-line/60">
                        <td className="py-3 text-bone">{w.name}</td>
                        <td className="num py-3 text-right">{w.transactions}</td>
                        <td className="num py-3 text-right text-bone">{money(w.revenueCents)}</td>
                        <td className="w-1/4 py-3 pl-4">
                          <div className="h-1.5 rounded-full bg-ink-3">
                            <div className="h-full rounded-full bg-amber" style={{ width: `${(w.revenueCents / top) * 100}%` }} />
                          </div>
                        </td>
                        <td className="num py-3 text-right">{money(w.averageTicketCents)}</td>
                        <td className={clsx('num py-3 text-right', w.voids ? 'text-vermilion' : 'text-dust')}>{w.voids}</td>
                        <td className={clsx('num py-3 text-right', w.overrides ? 'text-amber' : 'text-dust')}>{w.overrides}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
      {report.isLoading && <p className="eyebrow animate-blink px-10 py-10">Crunching numbers…</p>}
    </div>
  );
}

const Kpi = ({ label, value }: { label: string; value: string }) => (
  <div className="border-b border-r border-line px-6 py-5 [&:nth-child(3n)]:md:border-r-0">
    <dt className="eyebrow">{label}</dt>
    <dd className="num mt-1 text-2xl text-bone">{value}</dd>
  </div>
);

function Panel({ title, eyebrow, children }: { title: string; eyebrow: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-line px-6 py-8 last:border-b-0 lg:px-10 xl:border-b-0 xl:border-r xl:last:border-r-0">
      <p className="eyebrow">{eyebrow}</p>
      <h2 className="display mb-5 text-3xl">{title}</h2>
      {children}
    </div>
  );
}
