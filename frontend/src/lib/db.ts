import Dexie, { type Table } from 'dexie';
import type { CategoryDTO, CreateSaleInput, CustomerDTO, ProductDTO, StoreSettings } from '@sync-retail/shared';

export interface OutboxSale {
  clientId: string;
  payload: CreateSaleInput;
  /** Session token of the cashier who rang the sale, so it's attributed correctly. */
  token: string | null;
  status: 'pending' | 'failed';
  attempts: number;
  error?: string;
  createdAt: string;
  totalCents: number;
}

interface Meta {
  key: string;
  value: unknown;
}

/** Local IndexedDB mirror — lets the register keep selling with no network. */
class LocalDB extends Dexie {
  products!: Table<ProductDTO, string>;
  categories!: Table<CategoryDTO, string>;
  customers!: Table<CustomerDTO, string>;
  outbox!: Table<OutboxSale, string>;
  meta!: Table<Meta, string>;

  constructor() {
    super('sync-retail');
    this.version(1).stores({
      products: 'id, &sku, barcode, name, categoryId, updatedAt',
      categories: 'id, sortOrder',
      customers: 'id, name, phone, email',
      outbox: 'clientId, status, createdAt',
      meta: 'key',
    });
  }
}

export const localDb = new LocalDB();

export const getMeta = async <T,>(key: string) => (await localDb.meta.get(key))?.value as T | undefined;
export const setMeta = (key: string, value: unknown) => localDb.meta.put({ key, value });

export const cachedSettings = () => getMeta<StoreSettings>('settings');
