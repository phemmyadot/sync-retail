import { create } from 'zustand';

/** Set when the Main Register rejects this register's device token. */
export const useDeviceStatus = create<{
  problem: 'DEVICE_REVOKED' | 'DEVICE_REQUIRED' | null;
  setProblem: (p: 'DEVICE_REVOKED' | 'DEVICE_REQUIRED' | null) => void;
}>((set) => ({ problem: null, setProblem: (problem) => set({ problem }) }));
