import { useState } from 'react';
import clsx from 'clsx';

/**
 * Hand-built SVG/HTML charts in the Thermal Noir system.
 * Single-series marks use amber; the one categorical chart (payments) uses a
 * palette validated for the dark surface (see PAYMENT_COLORS).
 */

/** Validated with dataviz/validate_palette.js on #171510 (dark): all checks PASS. Fixed order. */
export const PAYMENT_COLORS = { CASH: '#C2760E', CARD: '#3584CF', LOYALTY: '#848F26' } as const;

/** Round an axis max up to 1/2/2.5/5 × 10ⁿ so tick labels are clean numbers. */
function niceCeil(v: number) {
  const exp = 10 ** Math.floor(Math.log10(v));
  const f = v / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * exp;
}

interface SeriesPoint {
  label: string;
  sublabel?: string;
  value: number;
  meta?: string;
}

/** Vertical bars with a hover tooltip; rounded data-ends, 2px gaps, recessive grid. */
export function BarSeries({ data, format, height = 240 }: { data: SeriesPoint[]; format: (n: number) => string; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = niceCeil(Math.max(1, ...data.map((d) => d.value)));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  const h = height;
  const labelEvery = Math.max(1, Math.ceil(data.length / 10));

  if (!data.length) return <p className="py-16 text-center text-sm text-dust">No sales in this range.</p>;

  return (
    <div className="relative" onMouseLeave={() => setHover(null)}>
      <div className="flex">
        {/* y-axis */}
        <div className="relative mr-3 w-16 shrink-0" style={{ height: h }}>
          {ticks.map((t) => (
            <span key={t} className="num absolute right-0 -translate-y-1/2 text-2xs text-dust" style={{ top: h - (t / max) * h }}>
              {format(t)}
            </span>
          ))}
        </div>
        <div className="relative flex-1" style={{ height: h }}>
          {ticks.map((t) => (
            <span key={t} className="absolute inset-x-0 border-t border-line/70" style={{ top: h - (t / max) * h }} />
          ))}
          <div className="absolute inset-0 flex items-end gap-[2px]">
            {data.map((d, i) => (
              <button
                key={i}
                className="group relative flex h-full flex-1 items-end focus:outline-none"
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                aria-label={`${d.label}: ${format(d.value)}`}
              >
                <span
                  className={clsx(
                    'block w-full rounded-t-[4px] transition-[height,background-color] duration-500 ease-out',
                    hover === null || hover === i ? 'bg-amber' : 'bg-amber/35',
                  )}
                  style={{ height: `${Math.max(d.value > 0 ? 2 : 0, (d.value / max) * 100)}%` }}
                />
              </button>
            ))}
          </div>
          {hover !== null && (
            <div
              className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-sm border border-line-strong bg-ink-3 px-3 py-2 text-sm shadow-lift"
              style={{
                left: `${((hover + 0.5) / data.length) * 100}%`,
                top: h - (data[hover].value / max) * h - 8,
              }}
            >
              <p className="eyebrow whitespace-nowrap">{data[hover].label}</p>
              <p className="num whitespace-nowrap text-bone">{format(data[hover].value)}</p>
              {data[hover].meta && <p className="whitespace-nowrap text-xs text-dust">{data[hover].meta}</p>}
            </div>
          )}
        </div>
      </div>
      <div className="ml-[4.75rem] mt-2 flex gap-[2px]">
        {data.map((d, i) => (
          <span key={i} className="flex-1 truncate text-center font-mono text-[0.625rem] text-dust">
            {i % labelEvery === 0 ? d.sublabel ?? d.label : ''}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Ranked horizontal bars with direct labels (name left, value right). */
export function RankBars({ rows, format }: { rows: { name: string; value: number; note?: string }[]; format: (n: number) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <p className="py-6 text-sm text-dust">No data.</p>;
  return (
    <ol className="space-y-3">
      {rows.map((r, i) => (
        <li key={r.name} className="group">
          <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate text-bone">
              <span className="num mr-2 text-dust">{String(i + 1).padStart(2, '0')}</span>
              {r.name}
            </span>
            <span className="num shrink-0 text-bone">
              {format(r.value)}
              {r.note && <span className="ml-2 text-xs text-dust">{r.note}</span>}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-ink-3">
            <div
              className="h-full rounded-full bg-amber transition-[width] duration-700 ease-out group-hover:brightness-110"
              style={{ width: `${(r.value / max) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ol>
  );
}

/** 100% stacked bar with a legend that carries labels + values (identity never color-alone). */
export function ShareBar({
  parts,
  format,
}: {
  parts: { key: string; label: string; value: number; color: string; count?: number }[];
  format: (n: number) => string;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const total = parts.reduce((a, p) => a + p.value, 0);
  if (!total) return <p className="py-6 text-sm text-dust">No payments in this range.</p>;
  return (
    <div>
      <div className="flex h-10 gap-[2px] overflow-hidden rounded-[4px]" onMouseLeave={() => setHover(null)}>
        {parts.map((p) => (
          <div
            key={p.key}
            onMouseEnter={() => setHover(p.key)}
            title={`${p.label}: ${format(p.value)} (${((p.value / total) * 100).toFixed(1)}%)`}
            className="h-full transition-opacity duration-200"
            style={{ width: `${(p.value / total) * 100}%`, background: p.color, opacity: hover && hover !== p.key ? 0.4 : 1 }}
          />
        ))}
      </div>
      <ul className="mt-4 space-y-2">
        {parts.map((p) => (
          <li key={p.key} className="flex items-center justify-between gap-3 text-sm" onMouseEnter={() => setHover(p.key)} onMouseLeave={() => setHover(null)}>
            <span className="flex items-center gap-2 text-bone">
              <span className="h-3 w-3 rounded-[3px]" style={{ background: p.color }} />
              {p.label}
              {p.count !== undefined && <span className="num text-xs text-dust">{p.count} txns</span>}
            </span>
            <span className="num text-bone">
              {format(p.value)} <span className="text-dust">· {((p.value / total) * 100).toFixed(1)}%</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
