import { useQuery } from '@tanstack/react-query';
import { DEFAULT_SETTINGS, type StoreSettings } from '@sync-retail/shared';
import { api, NetworkError } from '@/lib/api';
import { cachedSettings } from '@/lib/db';
import { useAuth } from '@/store/auth';

/** Store settings, falling back to the IndexedDB copy when offline. */
export function useSettings() {
  const token = useAuth((s) => s.token);
  return useQuery({
    queryKey: ['settings', !!token],
    queryFn: async (): Promise<StoreSettings> => {
      if (!token) return (await cachedSettings()) ?? DEFAULT_SETTINGS;
      try {
        return await api<StoreSettings>('/settings');
      } catch (err) {
        if (err instanceof NetworkError) return (await cachedSettings()) ?? DEFAULT_SETTINGS;
        throw err;
      }
    },
    staleTime: 60_000,
    placeholderData: DEFAULT_SETTINGS,
  });
}
