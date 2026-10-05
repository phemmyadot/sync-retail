import { useEffect, useMemo, useState } from 'react';
import type { CategoryDTO, ProductDTO } from '@sync-retail/shared';
import { localDb } from '@/lib/db';

/**
 * The register reads its catalog from IndexedDB (kept fresh by the sync loop),
 * so search, scanning and the grid all work with no network at all.
 */
export function useCatalog() {
  const [products, setProducts] = useState<ProductDTO[]>([]);
  const [categories, setCategories] = useState<CategoryDTO[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const [p, c] = await Promise.all([localDb.products.toArray(), localDb.categories.orderBy('sortOrder').toArray()]);
      if (!alive) return;
      setProducts(p.filter((x) => x.active).sort((a, b) => a.name.localeCompare(b.name)));
      setCategories(c);
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

  const lookup = (code: string) => index.get(code.trim()) ?? index.get(code.trim().toUpperCase()) ?? null;

  return { products, categories, ready, lookup };
}
