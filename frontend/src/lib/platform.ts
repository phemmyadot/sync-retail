import { IS_TAURI } from './config';

/**
 * Opens the customer-facing display. In Tauri it's a native window you drag to
 * the second monitor; in a browser it falls back to a popup window.
 */
export async function openCustomerDisplay() {
  if (IS_TAURI) {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const existing = await WebviewWindow.getByLabel('customer-display');
    if (existing) {
      await existing.setFocus();
      return;
    }
    new WebviewWindow('customer-display', { url: '/display', title: 'Customer Display', width: 1280, height: 800 });
    return;
  }
  window.open('/display', 'sync-retail-display', 'popup,width=1280,height=800');
}

const SEQ_KEY = 'sr-receipt-seq';

/** Receipt numbers are generated on the terminal so offline sales get one too. */
export function nextReceiptNo(terminalId: string) {
  const now = new Date();
  const ymd = [now.getFullYear() % 100, now.getMonth() + 1, now.getDate()].map((n) => String(n).padStart(2, '0')).join('');
  let state = { day: ymd, seq: 0 };
  try {
    state = JSON.parse(localStorage.getItem(SEQ_KEY) ?? '') as typeof state;
  } catch {
    /* first run */
  }
  const seq = state.day === ymd ? state.seq + 1 : 1;
  try {
    localStorage.setItem(SEQ_KEY, JSON.stringify({ day: ymd, seq }));
  } catch {
    /* storage blocked — the server de-duplicates anyway */
  }
  return `${terminalId}-${ymd}-${String(seq).padStart(4, '0')}`;
}
