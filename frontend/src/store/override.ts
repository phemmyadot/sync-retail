import { create } from 'zustand';
import type { OverrideAction } from '@sync-retail/shared';

export interface OverridePrompt {
  action: OverrideAction;
  /** Human sentence shown in the modal, e.g. "Remove 2 × Oat Latte". */
  detail?: string;
  saleId?: string;
  context?: Record<string, unknown>;
  requireReason?: boolean;
}

interface OverrideState {
  prompt: (OverridePrompt & { resolve: (token: string) => void; reject: (e: Error) => void }) | null;
  ask: (p: OverridePrompt) => Promise<string>;
  close: () => void;
}

export class OverrideCancelled extends Error {
  constructor() {
    super('Override cancelled');
  }
}

/** Promise-based modal: `await ask(...)` resolves with a single-use override token. */
export const useOverrideStore = create<OverrideState>((set, get) => ({
  prompt: null,
  ask: (p) =>
    new Promise<string>((resolve, reject) => {
      get().prompt?.reject(new OverrideCancelled());
      set({ prompt: { ...p, resolve, reject } });
    }),
  close: () => set({ prompt: null }),
}));
