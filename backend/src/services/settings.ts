import { DEFAULT_SETTINGS, type StoreSettings } from '@sync-retail/shared';
import { prisma } from '../lib/db';

const KEY = 'store';
let cache: { value: StoreSettings; at: number } | null = null;

export async function getSettings(): Promise<StoreSettings> {
  if (cache && Date.now() - cache.at < 30_000) return cache.value;
  const row = await prisma.setting.findUnique({ where: { key: KEY } });
  const stored = (row?.value ?? {}) as Partial<StoreSettings>;
  const value: StoreSettings = {
    ...DEFAULT_SETTINGS,
    ...stored,
    loyalty: { ...DEFAULT_SETTINGS.loyalty, ...(stored.loyalty ?? {}) },
  };
  cache = { value, at: Date.now() };
  return value;
}

export async function saveSettings(patch: Partial<StoreSettings>): Promise<StoreSettings> {
  const current = await getSettings();
  const next: StoreSettings = { ...current, ...patch, loyalty: { ...current.loyalty, ...(patch.loyalty ?? {}) } };
  await prisma.setting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: next as object },
    update: { value: next as object },
  });
  cache = { value: next, at: Date.now() };
  return next;
}
