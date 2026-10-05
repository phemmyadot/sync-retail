export const API_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');
export const TERMINAL_ID: string = import.meta.env.VITE_TERMINAL_ID || 'T1';
export const IS_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export function wsUrl(path: string): string {
  const base = API_URL || window.location.origin;
  return base.replace(/^http/, 'ws') + path;
}
