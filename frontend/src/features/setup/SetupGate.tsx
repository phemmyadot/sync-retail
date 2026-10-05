import type { ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/store/auth';
import { SetupWizard } from './SetupWizard';

interface SetupStatus {
  needsSetup: boolean;
  canSetupHere: boolean;
  hostMode: boolean;
}

/**
 * Shows the first-run store setup while the database has no users.
 * Works for the desktop Main Register and for a fresh server install.
 */
export function SetupGate({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const signIn = useAuth((s) => s.signIn);
  const status = useQuery({
    queryKey: ['setup-status'],
    queryFn: () => api<SetupStatus>('/setup/status', { token: null }),
    staleTime: Infinity,
    retry: 1,
  });

  // The customer display never runs setup.
  if (window.location.pathname.startsWith('/display')) return <>{children}</>;
  if (status.isLoading) return null;
  // Unreachable API: let the app's normal offline handling take over.
  if (status.isError || !status.data?.needsSetup) return <>{children}</>;

  if (!status.data.canSetupHere) {
    return (
      <div className="grid min-h-full place-items-center p-8 text-center">
        <div className="max-w-md">
          <p className="eyebrow text-amber">Store not set up yet</p>
          <h1 className="display mt-3 text-5xl">Finish setup on the {status.data.hostMode ? 'Main Register' : 'server'}.</h1>
          <p className="mt-4 text-dust">For security, the owner account can only be created on the machine that holds the store’s database.</p>
        </div>
      </div>
    );
  }

  return (
    <SetupWizard
      onFinished={(auth) => {
        signIn(auth);
        qc.setQueryData<SetupStatus>(['setup-status'], { ...status.data!, needsSetup: false });
        void qc.invalidateQueries({ queryKey: ['settings'] });
        void qc.invalidateQueries({ queryKey: ['staff'] });
      }}
    />
  );
}
