let apiBase = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

/** Base URL of the API. Empty = same origin (web build behind nginx / Vite proxy). */
export const getApiBase = () => apiBase;

/** Set at runtime by the desktop shell once it knows where the host API lives. */
export function setApiBase(url: string) {
  apiBase = url.replace(/\/$/, '');
}

let terminalId: string = import.meta.env.VITE_TERMINAL_ID || 'T1';
/** Register code: receipt prefix + display channel. Desktop: R1 = Main Register, R2… = paired registers. */
export const getTerminalId = () => terminalId;
export const setTerminalId = (id: string) => {
  terminalId = id;
};

let deviceToken: string | null = null;
/** Desktop client registers send this on every API call (issued at pairing). */
export const getDeviceToken = () => deviceToken;
export const setDeviceToken = (t: string | null) => {
  deviceToken = t;
};
export const IS_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export function wsUrl(path: string): string {
  const base = apiBase || window.location.origin;
  return base.replace(/^http/, 'ws') + path;
}
