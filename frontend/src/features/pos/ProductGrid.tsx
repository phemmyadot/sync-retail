import { memo } from 'react';
import clsx from 'clsx';
import type { CategoryDTO, ProductDTO } from '@sync-retail/shared';
import { useMoney } from '@/lib/format';
import { Empty } from '@/components/ui/primitives';

interface Props {
  products: ProductDTO[];
  categories: CategoryDTO[];
  onAdd: (p: ProductDTO) => void;
  flashId: string | null;
}

/** Shelf-tag tiles: category stripe, mono SKU, oversized price. */
export const ProductGrid = memo(function ProductGrid({ products, categories, onAdd, flashId }: Props) {
  const money = useMoney();
  const colorOf = new Map(categories.map((c) => [c.id, c.color ?? '#A89F8C']));

  if (!products.length) {
    return (
      <Empty icon="search" title="Nothing on this shelf">
        Try another search, or scan a barcode — the scanner works from anywhere on this screen.
      </Empty>
    );
  }

  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))] gap-2.5">
      {products.map((p, i) => {
        const low = p.stockQty <= p.lowStockThreshold;
        const out = p.stockQty <= 0;
        return (
          <li key={p.id} className="animate-rise" style={{ animationDelay: `${Math.min(i, 24) * 18}ms` }}>
            <button
              onClick={() => onAdd(p)}
              className={clsx(
                'group relative flex h-[8.5rem] w-full flex-col overflow-hidden rounded-sm border border-line bg-ink-2 p-3 pl-4 text-left',
                'transition-[transform,border-color,background-color] duration-150 ease-out hover:-translate-y-0.5 hover:border-line-strong hover:bg-ink-3 active:translate-y-0 active:scale-[0.98]',
                flashId === p.id && 'animate-flash',
              )}
            >
              <span className="absolute inset-y-0 left-0 w-1.5" style={{ background: p.categoryId ? colorOf.get(p.categoryId) : '#4A4438' }} />
              <span className="font-mono text-[0.625rem] uppercase tracking-wider text-dust">{p.sku}</span>
              <span className="mt-1 line-clamp-2 text-[0.95rem] font-medium leading-snug text-bone">{p.name}</span>
              <span className="mt-auto flex items-end justify-between gap-2">
                <span
                  className={clsx('whitespace-nowrap font-mono text-2xs', out ? 'text-vermilion' : low ? 'text-amber' : 'text-dust')}
                  title={`${p.stockQty} in stock`}
                >
                  {out ? 'OUT' : `${p.stockQty} left`}
                </span>
                <span className="num text-xl font-medium text-bone transition-colors group-hover:text-amber">{money(p.priceCents)}</span>
              </span>
              <span className="pointer-events-none absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-full bg-amber font-mono text-sm font-bold text-amber-ink opacity-0 transition-all duration-200 ease-snap group-hover:opacity-100 group-active:scale-125">
                +
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
});
