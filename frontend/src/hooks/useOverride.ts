import { useCallback } from 'react';
import { can, OVERRIDE_BYPASS } from '@sync-retail/shared';
import { useAuth } from '@/store/auth';
import { useOverrideStore, type OverridePrompt } from '@/store/override';

export const useCan = () => {
  const role = useAuth((s) => s.user?.role);
  return useCallback((p: Parameters<typeof can>[1]) => can(role, p), [role]);
};

/**
 * `const token = await authorize({ action: 'REMOVE_ITEM', detail: '…' })`
 *  → resolves `null` immediately for managers/admins (their role is enough),
 *  → otherwise opens the PIN modal and resolves with a single-use override token,
 *  → rejects with OverrideCancelled if the cashier backs out.
 */
export function useOverride() {
  const role = useAuth((s) => s.user?.role);
  const ask = useOverrideStore((s) => s.ask);
  return useCallback(
    async (p: OverridePrompt): Promise<string | null> => {
      if (can(role, OVERRIDE_BYPASS[p.action])) return null;
      return ask(p);
    },
    [role, ask],
  );
}
