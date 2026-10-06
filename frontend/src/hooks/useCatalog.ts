import { useEffect, useMemo, useState } from 'react';
import type { CategoryDTO, ProductDTO, TaxClassDTO } from '@sync-retail/shared';
import { localDb } from '@/lib/db';

export interface ProductTax {
  taxClassId: string | null;
  taxClassName: string | null;
  taxRateBps: number;
}

/**
 * The register reads its catalog from IndexedDB (kept fresh by the sync loop),
 * so search, scanning and the grid all work with no network at all.
 *
 * Tax rates are resolved from the synced tax classes rather than the rate
 * cached on each product: changing a class rate doesn't touch product rows,
 * so this is how the change reaches every register on the next sync.
 */
export function useCatalog() {
  const [products, setProducts] = useState<ProductDTO[]>([]);
  const [categories, setCategories] = useState<CategoryDTO[]>([]);
  const [taxClasses, setTaxClasses] = useState<TaxClassDTO[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const [p, c, t] = await Promise.all([
        localDb.products.toArray(),
        localDb.categories.orderBy('sortOrder').toArray(),
        localDb.taxClasses.toArray(),
      ]);
      if (!alive) return;
      const byId = new Map(t.map((x) => [x.id, x]));
      // Re-resolve every product's rate from its class.
      const resolved = p.map((x) => {
        const cls = x.taxClassId ? byId.get(x.taxClassId) : undefined;
        return cls ? { ...x, taxRateBps: cls.rateBps, taxClassName: cls.name } : x;
      });
      setProducts(resolved.filter((x) => x.active).sort((a, b) => a.name.localeCompare(b.name)));
      setCategories(c);
      setTaxClasses(t);
      setReady(true);
    };
    void load();
    window.addEventListener('sr:catalog', load);
    return () => {
      alive = false;
      window.removeEventListener('sr:catalog', load);
    };
  }, []);

  const index = useMemo(() => {
    const byCode = new Map<string, ProductDTO>();
    for (const p of products) {
      byCode.set(p.sku.toUpperCase(), p);
      if (p.barcode) byCode.set(p.barcode, p);
    }
    return byCode;
  }, [products]);

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  const lookup = (code: string) => index.get(code.trim()) ?? index.get(code.trim().toUpperCase()) ?? null;

  /** Current tax for a product (null when the product isn't in the local catalog). */
  const taxFor = (productId: string): ProductTax | null => {
    const p = byId.get(productId);
    return p ? { taxClassId: p.taxClassId ?? null, taxClassName: p.taxClassName ?? null, taxRateBps: p.taxRateBps } : null;
  };

  return { products, categories, taxClasses, ready, lookup, taxFor };
}
