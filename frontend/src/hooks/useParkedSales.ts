import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ParkedSaleDTO } from '@sync-retail/shared';
import { api } from '@/lib/api';
import type { LocalParkedSale } from '@/lib/db';
import { localParked } from '@/lib/parked';
import { useAuth } from '@/store/auth';

/**
 * Held sales for the register: the live count (store WebSocket, with a 30 s
 * poll as fallback), the shared list when the drawer is open, and sales held
 * on this register while offline.
 */
export function useParkedSales(listOpen: boolean) {
  const qc = useQueryClient();
  const token = useAuth((s) => s.token);
  const [local, setLocal] = useState<LocalParkedSale[]>([]);

  const count = useQuery({
    queryKey: ['parked-count'],
    queryFn: () => api<{ count: number }>('/parked-sales/count').then((r) => r.count),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    enabled: !!token,
  });
  const list = useQuery({
    queryKey: ['parked-list'],
    queryFn: () => api<ParkedSaleDTO[]>('/parked-sales'),
    enabled: !!token && listOpen,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    const reloadLocal = () => void localParked().then(setLocal);
    const refresh = () => {
      reloadLocal();
      void qc.invalidateQueries({ queryKey: ['parked-count'] });
      void qc.invalidateQueries({ queryKey: ['parked-list'] });
    };
    reloadLocal();
    window.addEventListener('sr:parked', refresh);
    // Live count from the store channel (AppShell owns the socket).
    const onStore = (ev: Event) => {
      const e = (ev as CustomEvent<{ type: string; count?: number }>).detail;
      if (e.type !== 'parked:changed') return;
      if (typeof e.count === 'number') qc.setQueryData(['parked-count'], e.count);
      void qc.invalidateQueries({ queryKey: ['parked-list'] });
    };
    window.addEventListener('sr:store', onStore);
    return () => {
      window.removeEventListener('sr:parked', refresh);
      window.removeEventListener('sr:store', onStore);
    };
  }, [qc, token]);

  return {
    count: (count.data ?? 0) + local.length,
    shared: list.data ?? [],
    local,
    loading: list.isLoading,
    offline: count.isError && !count.data,
  };
}
