import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CategoryDTO, ProductDTO } from '@sync-retail/shared';
import { api, errorMessage } from '@/lib/api';
import { centsToInput, fmtDate, inputToCents } from '@/lib/format';
import { toast } from '@/store/toast';
import { Modal } from '@/components/ui/Modal';
import { Badge, Button, Input, Label } from '@/components/ui/primitives';

interface Props {
  product: ProductDTO | null;
  categories: CategoryDTO[];
  readOnly: boolean;
  onClose: () => void;
  onSaved: () => void;
}

interface Movement {
  id: string;
  type: string;
  quantity: number;
  reference: string | null;
  createdAt: string;
  user: { name: string } | null;
}

export function ProductEditor({ product, categories, readOnly, onClose, onSaved }: Props) {
  const isNew = !product;
  const [form, setForm] = useState({
    name: product?.name ?? '',
    sku: product?.sku ?? '',
    barcode: product?.barcode ?? '',
    categoryId: product?.categoryId ?? '',
    cost: centsToInput(product?.costCents ?? 0),
    price: centsToInput(product?.priceCents ?? 0),
    tax: String((product?.taxRateBps ?? 0) / 100),
    stock: String(product?.stockQty ?? 0),
    low: String(product?.lowStockThreshold ?? 5),
  });
  const [adjust, setAdjust] = useState('');
  const [adjustReason, setAdjustReason] = useState('Stock count');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ['product', product?.id],
    queryFn: () => api<ProductDTO & { movements: Movement[] }>(`/products/${product!.id}`),
    enabled: !!product,
  });

  useEffect(() => setError(null), [form]);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body = {
        name: form.name,
        sku: form.sku,
        barcode: form.barcode || null,
        categoryId: form.categoryId || null,
        costCents: inputToCents(form.cost),
        priceCents: inputToCents(form.price),
        taxRateBps: Math.round(Number(form.tax) * 100),
        lowStockThreshold: Number(form.low) || 0,
      };
      if (isNew) await api('/products', { method: 'POST', body: { ...body, stockQty: Number(form.stock) || 0 } });
      else await api(`/products/${product.id}`, { method: 'PATCH', body });
      toast.success(isNew ? 'Product created' : 'Product saved', form.name);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const doAdjust = async () => {
    const delta = Math.trunc(Number(adjust));
    if (!delta || !product) return;
    try {
      await api(`/products/${product.id}/adjust-stock`, { method: 'POST', body: { delta, reason: adjustReason } });
      toast.success(`Stock ${delta > 0 ? '+' : ''}${delta}`, product.name);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const archive = async () => {
    if (!product) return;
    if (product.active) await api(`/products/${product.id}`, { method: 'DELETE' });
    else await api(`/products/${product.id}`, { method: 'PATCH', body: { active: true } });
    toast.info(product.active ? 'Product archived' : 'Product restored', product.name);
    onSaved();
  };

  return (
    <Modal open onClose={onClose} eyebrow={isNew ? 'New product' : product.sku} title={isNew ? 'Add to catalog' : product.name} width="lg">
      <form id="product-form" onSubmit={save} className="grid gap-6 md:grid-cols-[1.3fr_1fr]">
        <fieldset disabled={readOnly} className="grid grid-cols-2 gap-4">
          <Input label="Name" className="col-span-2" required value={form.name} onChange={set('name')} />
          <Input label="SKU" required value={form.sku} onChange={set('sku')} className="font-mono" />
          <Input label="Barcode" value={form.barcode} onChange={set('barcode')} />
          <div className="col-span-2">
            <Label htmlFor="cat">Category</Label>
            <select id="cat" className="field" value={form.categoryId} onChange={set('categoryId')}>
              <option value="">Uncategorised</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <Input label="Cost price" inputMode="decimal" value={form.cost} onChange={set('cost')} />
          <Input label="Retail price" inputMode="decimal" required value={form.price} onChange={set('price')} />
          <Input label="Tax rate %" inputMode="decimal" value={form.tax} onChange={set('tax')} />
          <Input label="Low-stock alert at" inputMode="numeric" value={form.low} onChange={set('low')} />
          {isNew && <Input label="Opening stock" inputMode="numeric" value={form.stock} onChange={set('stock')} />}
        </fieldset>

        {!isNew && (
          <div className="space-y-4">
            <div className="rounded-sm border border-line bg-ink p-4">
              <p className="eyebrow">On hand</p>
              <p className="num text-4xl">{product.stockQty}</p>
              {!readOnly && (
                <div className="mt-3 space-y-2">
                  <div className="flex gap-2">
                    <input
                      className="field w-24 font-mono"
                      placeholder="±qty"
                      inputMode="numeric"
                      value={adjust}
                      onChange={(e) => setAdjust(e.target.value.replace(/[^\d-]/g, ''))}
                      aria-label="Stock adjustment"
                    />
                    <input className="field" value={adjustReason} onChange={(e) => setAdjustReason(e.target.value)} aria-label="Adjustment reason" />
                  </div>
                  <Button type="button" size="sm" className="w-full" onClick={() => void doAdjust()} disabled={!Number(adjust)}>
                    Apply adjustment
                  </Button>
                </div>
              )}
            </div>
            <div>
              <p className="eyebrow mb-2">Stock movements</p>
              <ul className="max-h-56 space-y-1 overflow-y-auto text-sm">
                {detail.data?.movements.map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-2 border-b border-line/60 py-1.5">
                    <span className="min-w-0">
                      <Badge tone={m.type === 'SALE' ? 'neutral' : m.type === 'RETURN' || m.type === 'VOID' ? 'sky' : 'amber'}>{m.type}</Badge>
                      <span className="ml-2 text-xs text-dust">{fmtDate(m.createdAt)}</span>
                      <span className="block truncate text-xs text-dust">{m.reference}</span>
                    </span>
                    <span className={m.quantity > 0 ? 'num text-mint' : 'num text-dust'}>{m.quantity > 0 ? `+${m.quantity}` : m.quantity}</span>
                  </li>
                ))}
                {detail.data && !detail.data.movements.length && <li className="text-dust">No movements yet.</li>}
              </ul>
            </div>
          </div>
        )}
      </form>
      {error && (
        <p className="mt-4 text-sm text-vermilion" role="alert">
          {error}
        </p>
      )}
      {!readOnly && (
        <div className="mt-6 flex flex-wrap justify-end gap-2 border-t border-line pt-4">
          {!isNew && (
            <Button type="button" variant={product.active ? 'danger' : 'outline'} className="mr-auto" onClick={() => void archive()}>
              {product.active ? 'Archive' : 'Restore'}
            </Button>
          )}
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="product-form" variant="primary" loading={busy} icon="check">
            Save
          </Button>
        </div>
      )}
    </Modal>
  );
}
