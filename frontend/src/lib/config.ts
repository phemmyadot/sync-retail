let apiBase = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

/** Base URL of the API. Empty = same origin (web build behind nginx / Vite proxy). */
export const getApiBase = () => apiBase;

/** Set at runtime by the desktop shell once it knows where the host API lives. */
export function setApiBase(url: string) {
  apiBase = url.replace(/\/$/, '');
}

export const TERMINAL_ID: string = import.meta.env.VITE_TERMINAL_ID || 'T1';
export const IS_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export function wsUrl(path: string): string {
  const base = apiBase || window.location.origin;
  return base.replace(/^http/, 'ws') + path;
}
