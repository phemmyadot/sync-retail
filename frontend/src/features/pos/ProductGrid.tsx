import { memo } from 'react';
import clsx from 'clsx';
import type { CategoryDTO, ProductDTO } from '@sync-retail/shared';
import { Empty } from '@/components/ui/primitives';
import { Price } from '@/components/ui/Price';

interface Props {
  products: ProductDTO[];
  categories: CategoryDTO[];
  onAdd: (p: ProductDTO) => void;
  flashId: string | null;
}

/** Shelf-tag tiles: category stripe, mono SKU, oversized price. */
export const ProductGrid = memo(function ProductGrid({ products, categories, onAdd, flashId }: Props) {
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
              {/* Top row: SKU · stock (swaps to "+ Add" on hover) */}
              <span className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate font-mono text-[0.625rem] uppercase tracking-wider text-dust">{p.sku}</span>
                <span className="relative shrink-0">
                  <span
                    className={clsx(
                      'block whitespace-nowrap font-mono text-[0.625rem] uppercase tracking-wider transition-opacity duration-150 group-hover:opacity-0',
                      out ? 'text-vermilion' : low ? 'text-amber' : 'text-dust',
                    )}
                    title={`${p.stockQty} in stock`}
                  >
                    {out ? 'Out' : `${p.stockQty} left`}
                  </span>
                  <span className="absolute right-0 top-1/2 -translate-y-1/2 whitespace-nowrap rounded-full bg-amber px-2 py-0.5 font-mono text-[0.625rem] font-bold uppercase text-amber-ink opacity-0 transition-all duration-200 ease-snap group-hover:opacity-100 group-active:scale-110">
                    + Add
                  </span>
                </span>
              </span>
              <span className="mt-1.5 line-clamp-2 text-[0.95rem] font-medium leading-snug text-bone">{p.name}</span>
              {/* Price gets the full width of the tile and scales with its length */}
              <span className="mt-auto block border-t border-dashed border-line pt-2">
                <Price cents={p.priceCents} className="text-bone transition-colors group-hover:text-amber" />
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
});
