import clsx from 'clsx';
import { moneyParts } from '@sync-retail/shared';
import { useSettings } from '@/hooks/useSettings';
import { useMoney } from '@/lib/format';

/** Pick a size class by text length: the first step whose max length fits wins. */
export function fitClass(text: string, steps: [maxLen: number, cls: string][], fallback: string) {
  return steps.find(([max]) => text.length <= max)?.[1] ?? fallback;
}

/**
 * Shelf-tag price: large whole units, small dimmed symbol and minor units.
 * The digits step down in size as the number grows (₦950 → ₦12,500,000.00)
 * so long prices never wrap or clip inside a fixed-width tile.
 */
export function Price({ cents, className }: { cents: number; className?: string }) {
  const { data } = useSettings();
  const money = useMoney();
  const { symbol, whole, fraction, symbolFirst } = moneyParts(cents, data?.currency, data?.locale);

  const size = fitClass(
    whole,
    [
      [5, 'text-2xl'], // 99,999
      [7, 'text-xl'], // 9,999,999 → "999,999"
      [9, 'text-lg'], // 1,000,000
      [11, 'text-base'], // 100,000,000
    ],
    'text-sm',
  );
  const sym = <span className="mx-px align-[0.2em] text-[0.7em] font-medium text-dust">{symbol}</span>;

  return (
    <span className={clsx('num inline-flex max-w-full items-baseline whitespace-nowrap leading-none', size, className)} title={money(cents)}>
      <span className="sr-only">{money(cents)}</span>
      <span aria-hidden="true" className="inline-flex items-baseline">
        {symbolFirst && sym}
        <span className="font-semibold tracking-tight">{whole}</span>
        {fraction && <span className="align-[0.3em] text-[0.6em] text-dust">{fraction}</span>}
        {!symbolFirst && sym}
      </span>
    </span>
  );
}
