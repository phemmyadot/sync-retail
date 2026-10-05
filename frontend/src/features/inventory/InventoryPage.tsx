import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatBps, type CategoryDTO, type ProductDTO } from '@sync-retail/shared';
import { api } from '@/lib/api';
import { useMoney } from '@/lib/format';
import { useCan } from '@/hooks/useOverride';
import { pullCatalog } from '@/lib/sync';
import { Badge, Button, Empty, PageHeader, Segmented } from '@/components/ui/primitives';
import { Icon } from '@/components/ui/Icon';
import { ProductEditor } from './ProductEditor';

type Filter = 'all' | 'low' | 'archived';

export function InventoryPage() {
  const money = useMoney();
  const can = useCan();
  const qc = useQueryClient();
  const canWrite = can('products:write');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [categoryId, setCategoryId] = useState('');
  const [editing, setEditing] = useState<ProductDTO | 'new' | null>(null);

  const products = useQuery({
    queryKey: ['products', filter === 'archived'],
    queryFn: () => api<ProductDTO[]>('/products', { query: { includeInactive: filter === 'archived', take: 5000 } }),
  });
  const categories = useQuery({ queryKey: ['categories'], queryFn: () => api<CategoryDTO[]>('/categories') });

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (products.data ?? []).filter(
      (p) =>
        (filter !== 'low' || p.stockQty <= p.lowStockThreshold) &&
        (filter !== 'archived' || !p.active) &&
        (!categoryId || p.categoryId === categoryId) &&
        (!q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q) || p.barcode?.includes(q)),
    );
  }, [products.data, search, filter, categoryId]);

  const stockValue = rows.reduce((a, p) => a + Math.max(0, p.stockQty) * p.costCents, 0);
  const lowCount = (products.data ?? []).filter((p) => p.active && p.stockQty <= p.lowStockThreshold).length;

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['products'] });
    void pullCatalog();
  };

  return (
    <div>
      <PageHeader eyebrow="Catalog" title={<>Inventory <span className="italic text-dust">& stock</span></>}>
        {can('inventory:import') && (
          <Link to="/inventory/import">
            <Button icon="upload">Import CSV / Excel</Button>
          </Link>
        )}
        {canWrite && (
          <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
            New product
          </Button>
        )}
      </PageHeader>

      {/* Ledger strip */}
      <div className="grid grid-cols-2 border-b border-line md:grid-cols-4">
        <Stat label="Products shown" value={rows.length.toLocaleString()} />
        <Stat label="Units on hand" value={rows.reduce((a, p) => a + Math.max(0, p.stockQty), 0).toLocaleString()} />
        <Stat label="Stock at cost" value={money(stockValue)} />
        <Stat label="Low / out of stock" value={String(lowCount)} tone={lowCount ? 'vermilion' : undefined} />
      </div>

      <div className="flex flex-wrap items-center gap-3 px-6 py-4 lg:px-10">
        <div className="relative min-w-[14rem] flex-1">
          <Icon name="search" size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dust" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, SKU or barcode" className="field pl-10" aria-label="Filter products" />
        </div>
        <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="field w-auto" aria-label="Category">
          <option value="">All categories</option>
          {categories.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <Segmented<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'Active' },
            { value: 'low', label: 'Low stock' },
            { value: 'archived', label: 'Archived' },
          ]}
        />
      </div>

      <div className="overflow-x-auto px-6 pb-10 lg:px-10">
        <table className="w-full min-w-[52rem] border-collapse text-sm">
          <thead>
            <tr className="border-y border-line text-left">
              {['Product', 'SKU / Barcode', 'Category', 'Cost', 'Price', 'Margin', 'Tax', 'Stock'].map((h, i) => (
                <th key={h} className={clsx('eyebrow py-2.5 font-normal', i >= 3 && 'text-right', i === 0 && 'pl-2')}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const margin = p.priceCents ? (p.priceCents - p.costCents) / p.priceCents : 0;
              const low = p.stockQty <= p.lowStockThreshold;
              return (
                <tr
                  key={p.id}
                  onClick={() => setEditing(p)}
                  className="group cursor-pointer border-b border-line/70 transition-colors hover:bg-ink-2"
                >
                  <td className="py-3 pl-2 pr-3">
                    <span className="font-medium text-bone group-hover:text-amber">{p.name}</span>
                    {!p.active && <Badge className="ml-2">Archived</Badge>}
                  </td>
                  <td className="num py-3 pr-3 text-xs text-dust">
                    {p.sku}
                    <br />
                    {p.barcode ?? '—'}
                  </td>
                  <td className="py-3 pr-3 text-dust">{p.categoryName ?? '—'}</td>
                  <td className="num py-3 pr-3 text-right text-dust">{money(p.costCents)}</td>
                  <td className="num py-3 pr-3 text-right text-bone">{money(p.priceCents)}</td>
                  <td className={clsx('num py-3 pr-3 text-right', margin < 0.2 ? 'text-vermilion' : 'text-dust')}>{(margin * 100).toFixed(0)}%</td>
                  <td className="num py-3 pr-3 text-right text-dust">{formatBps(p.taxRateBps)}</td>
                  <td className="py-3 text-right">
                    <span className={clsx('num inline-flex min-w-[3.5rem] justify-end font-medium', p.stockQty <= 0 ? 'text-vermilion' : low ? 'text-amber' : 'text-bone')}>
                      {p.stockQty}
                    </span>
                    <span className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-ink-3">
                      <span
                        className={clsx('block h-full', p.stockQty <= 0 ? 'bg-vermilion' : low ? 'bg-amber' : 'bg-mint/70')}
                        style={{ width: `${Math.min(100, (Math.max(0, p.stockQty) / Math.max(1, p.lowStockThreshold * 4)) * 100)}%` }}
                      />
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!products.isLoading && !rows.length && <Empty title="No products match">Adjust the filters, or import a spreadsheet to fill the shelves.</Empty>}
      </div>

      {editing && (
        <ProductEditor
          product={editing === 'new' ? null : editing}
          categories={categories.data ?? []}
          readOnly={!canWrite}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'vermilion' }) {
  return (
    <div className="border-r border-line px-6 py-4 last:border-r-0 lg:px-10">
      <p className="eyebrow">{label}</p>
      <p className={clsx('num mt-1 text-2xl', tone === 'vermilion' ? 'text-vermilion' : 'text-bone')}>{value}</p>
    </div>
  );
}
