import { useQuery } from '@tanstack/react-query';
import { DEFAULT_SETTINGS, type StoreSettings } from '@sync-retail/shared';
import { api, NetworkError } from '@/lib/api';
import { cachedSettings } from '@/lib/db';
import { useAuth } from '@/store/auth';

const LAST_KEY = 'sr-settings';

/** Last settings this device saw — read synchronously so the very first paint uses the right currency. */
function lastKnown(): StoreSettings | undefined {
  try {
    const raw = localStorage.getItem(LAST_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<StoreSettings>) } : undefined;
  } catch {
    return undefined;
  }
}

function remember(s: StoreSettings) {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(s));
  } catch {
    /* storage blocked — we'll just refetch */
  }
  return s;
}

/**
 * Store settings (currency, locale, branding, loyalty).
 * Signed in → full settings; signed out (lock screen, customer display on
 * another device) → the public subset. Offline → IndexedDB / last-known copy.
 */
export function useSettings() {
  const token = useAuth((s) => s.token);
  return useQuery({
    queryKey: ['settings', !!token],
    queryFn: async (): Promise<StoreSettings> => {
      try {
        if (token) return remember(await api<StoreSettings>('/settings'));
        const pub = await api<Partial<StoreSettings>>('/settings/public', { token: null });
        return remember({ ...DEFAULT_SETTINGS, ...lastKnown(), ...pub });
      } catch (err) {
        if (err instanceof NetworkError) return (await cachedSettings()) ?? lastKnown() ?? DEFAULT_SETTINGS;
        throw err;
      }
    },
    staleTime: 60_000,
    placeholderData: () => lastKnown() ?? DEFAULT_SETTINGS,
  });
}
