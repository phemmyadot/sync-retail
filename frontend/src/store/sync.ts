import { create } from 'zustand';

interface SyncState {
  online: boolean;
  pending: number;
  failed: number;
  syncing: boolean;
  lastSyncAt: string | null;
  set: (p: Partial<Omit<SyncState, 'set'>>) => void;
}

export const useSyncStatus = create<SyncState>((set) => ({
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  pending: 0,
  failed: 0,
  syncing: false,
  lastSyncAt: null,
  set: (p) => set(p),
}));
