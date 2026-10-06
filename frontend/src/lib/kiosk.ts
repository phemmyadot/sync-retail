import { create } from 'zustand';
import { IS_TAURI } from './config';

/** Mirrors `KioskStatus` in src-tauri/src/kiosk.rs. */
export interface KioskStatus {
  available: boolean;
  active: boolean;
  locked: boolean;
  unlockedForSecs: number | null;
  level: 'standard' | 'strict';
  enabled: boolean;
  autostart: boolean;
  customerDisplayMonitor: string;
  hasOfflinePin: boolean;
  envOverride: string | null;
  updatedAt: number | null;
  updatedBy: string | null;
}

export interface MonitorInfo {
  name: string;
  primary: boolean;
  width: number;
  height: number;
}

export interface KioskSettingsInput {
  enabled: boolean;
  level: KioskStatus['level'];
  autostart: boolean;
  customerDisplayMonitor: string;
  updatedBy?: string;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

/** Kiosk lives in the desktop shell; in a browser every call is a no-op. */
export const kiosk = {
  status: () => (IS_TAURI ? invoke<KioskStatus>('kiosk_status') : Promise.resolve(null)),
  markReady: () => (IS_TAURI ? invoke<KioskStatus>('kiosk_mark_ready') : Promise.resolve(null)),
  save: (input: KioskSettingsInput) => invoke<KioskStatus>('kiosk_save_settings', { input }),
  unlock: (minutes = 10) => invoke<KioskStatus>('kiosk_unlock', { minutes }),
  relock: () => invoke<KioskStatus>('kiosk_relock'),
  enforce: () => (IS_TAURI ? invoke<void>('kiosk_enforce') : Promise.resolve()),
  exitApp: () => invoke<void>('kiosk_exit_app'),
  hashPin: (pin: string) => invoke<string>('kiosk_hash_pin', { pin }),
  setOfflineHash: (hash: string | null) => invoke<void>('kiosk_set_offline_hash', { hash }),
  verifyOfflinePin: (pin: string) => invoke<boolean>('kiosk_verify_offline_pin', { pin }),
  monitors: () => invoke<MonitorInfo[]>('kiosk_monitors'),
};

interface KioskStore {
  status: KioskStatus | null;
  exitOpen: boolean;
  set: (s: KioskStatus | null) => void;
  openExit: () => void;
  closeExit: () => void;
}

export const useKiosk = create<KioskStore>((set) => ({
  status: null,
  exitOpen: false,
  set: (status) => set({ status }),
  openExit: () => set({ exitOpen: true }),
  closeExit: () => set({ exitOpen: false }),
}));

// ─── Offline audit queue ────────────────────────────────────────────────────
// Unlocks done with the offline PIN are recorded here and sent to the Main
// Register the next time someone is signed in and it is reachable.

const QUEUE_KEY = 'sr-kiosk-events';
export interface KioskEvent {
  event: 'settings' | 'maintenance_end' | 'exit' | 'offline_unlock' | 'offline_unlock_failed';
  register?: string;
  at: string;
  details?: Record<string, unknown>;
}

export function queueKioskEvent(e: Omit<KioskEvent, 'at'>) {
  try {
    const q = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]') as KioskEvent[];
    q.push({ ...e, at: new Date().toISOString() });
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-50)));
  } catch {
    /* storage blocked — the local Rust log still has nothing to lose */
  }
}

export function takeKioskEvents(): KioskEvent[] {
  try {
    const q = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]') as KioskEvent[];
    localStorage.removeItem(QUEUE_KEY);
    return q;
  } catch {
    return [];
  }
}
