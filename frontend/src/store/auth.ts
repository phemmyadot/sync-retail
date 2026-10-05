import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AuthResponse, SessionUser } from '@sync-retail/shared';

interface AuthState {
  token: string | null;
  user: SessionUser | null;
  /** Locked = session cleared but the terminal stays on the PIN quick-switch screen. */
  locked: boolean;
  signIn: (r: AuthResponse) => void;
  lock: () => void;
  signOut: () => void;
}

export const useAuth = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      locked: false,
      signIn: ({ token, user }) => set({ token, user, locked: false }),
      lock: () => set({ token: null, user: null, locked: true }),
      signOut: () => set({ token: null, user: null, locked: false }),
    }),
    { name: 'sr-auth' },
  ),
);
