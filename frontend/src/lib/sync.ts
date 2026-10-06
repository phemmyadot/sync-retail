import type { CategoryDTO, CreateSaleInput, ProductDTO, SaleDTO, StoreSettings, TaxClassDTO } from '@sync-retail/shared';
import { api, ApiError, NetworkError } from './api';
import { getMeta, localDb, setMeta, type OutboxSale } from './db';
import { useAuth } from '@/store/auth';
import { useSyncStatus } from '@/store/sync';
import { flushParked } from './parked';

const status = () => useSyncStatus.getState();

type SyncResult = { clientId: string; ok: boolean; sale?: SaleDTO; error?: { code?: string; message: string } };

export async function refreshOutboxCounts() {
  const [pending, failed] = await Promise.all([
    localDb.outbox.where('status').equals('pending').count(),
    localDb.outbox.where('status').equals('failed').count(),
  ]);
  status().set({ pending, failed });
}

/** Delta-pull products/categories/settings into IndexedDB. */
export async function pullCatalog(): Promise<boolean> {
  if (!useAuth.getState().token) return false;
  const since = await getMeta<string>('catalogSyncedAt');
  try {
    const res = await api<{ serverTime: string; full: boolean; products: ProductDTO[]; categories: CategoryDTO[]; settings: StoreSettings; taxClasses?: TaxClassDTO[] }>(
      '/sync/catalog',
      { query: { since } },
    );
    await localDb.transaction('rw', [localDb.products, localDb.categories, localDb.taxClasses, localDb.meta], async () => {
      if (res.full) await localDb.products.clear();
      await localDb.products.bulkPut(res.products);
      await localDb.categories.clear();
      await localDb.categories.bulkPut(res.categories);
      if (res.taxClasses) {
        await localDb.taxClasses.clear();
        await localDb.taxClasses.bulkPut(res.taxClasses);
      }
      await setMeta('settings', res.settings);
      await setMeta('catalogSyncedAt', res.serverTime);
    });
    status().set({ online: true, lastSyncAt: res.serverTime });
    window.dispatchEvent(new CustomEvent('sr:catalog'));
    return true;
  } catch (err) {
    if (err instanceof NetworkError) status().set({ online: false });
    return false;
  }
}

export async function queueSale(payload: CreateSaleInput, totalCents: number) {
  const entry: OutboxSale = {
    clientId: payload.clientId,
    payload,
    token: useAuth.getState().token,
    status: 'pending',
    attempts: 0,
    createdAt: payload.createdAt ?? new Date().toISOString(),
    totalCents,
  };
  await localDb.outbox.put(entry);
  // Optimistically decrement local stock so the grid stays honest offline.
  await localDb.transaction('rw', localDb.products, async () => {
    for (const l of payload.lines) {
      const p = await localDb.products.get(l.productId);
      if (p) await localDb.products.put({ ...p, stockQty: p.stockQty - l.quantity });
    }
  });
  await refreshOutboxCounts();
  window.dispatchEvent(new CustomEvent('sr:catalog'));
}

let flushing = false;

async function postBatch(entries: OutboxSale[], token: string): Promise<SyncResult[]> {
  const res = await api<{ results: SyncResult[] }>('/sync/sales', {
    method: 'POST',
    body: { sales: entries.map((e) => e.payload) },
    token,
  });
  return res.results;
}

/** Replays queued offline sales, grouped by the cashier session that captured them. */
export async function flushOutbox(): Promise<number> {
  if (flushing) return 0;
  const current = useAuth.getState().token;
  if (!current) return 0;
  const pending = await localDb.outbox.where('status').equals('pending').sortBy('createdAt');
  if (!pending.length) return 0;

  flushing = true;
  status().set({ syncing: true });
  let synced = 0;
  try {
    const groups = new Map<string, OutboxSale[]>();
    for (const e of pending) {
      const k = e.token ?? current;
      groups.set(k, [...(groups.get(k) ?? []), e]);
    }
    for (const [token, entries] of groups) {
      let results: SyncResult[];
      try {
        results = await postBatch(entries, token);
      } catch (err) {
        // Original cashier's session expired → attribute to whoever is signed in now.
        if (err instanceof ApiError && err.status === 401 && token !== current) results = await postBatch(entries, current);
        else throw err;
      }
      for (const r of results) {
        if (r.ok) {
          await localDb.outbox.delete(r.clientId);
          synced++;
        } else {
          const e = entries.find((x) => x.clientId === r.clientId);
          if (e) await localDb.outbox.put({ ...e, status: 'failed', attempts: e.attempts + 1, error: r.error?.message });
        }
      }
    }
    status().set({ online: true });
  } catch (err) {
    if (err instanceof NetworkError) status().set({ online: false });
  } finally {
    flushing = false;
    status().set({ syncing: false });
    await refreshOutboxCounts();
  }
  return synced;
}

export async function retryFailed() {
  await localDb.outbox.where('status').equals('failed').modify({ status: 'pending' });
  await refreshOutboxCounts();
  return flushOutbox();
}

/** Background loop: on boot, on reconnect and every 30s. */
export function startSyncLoop() {
  const tick = async () => {
    await flushOutbox();
    await flushParked();
    await pullCatalog();
  };
  const onOnline = () => {
    status().set({ online: true });
    void tick();
  };
  const onOffline = () => status().set({ online: false });
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  void refreshOutboxCounts();
  void tick();
  const id = window.setInterval(tick, 30_000);
  return () => {
    window.clearInterval(id);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
  };
}
