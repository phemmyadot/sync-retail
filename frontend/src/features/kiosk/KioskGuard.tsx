import { useEffect } from 'react';

// The app's own shortcuts (F2 search, F4 customer, F9 pay) stay available.
const BLOCKED_F_KEYS = new Set(['F1', 'F3', 'F5', 'F6', 'F7', 'F10', 'F11', 'F12']);
// Ctrl/⌘ + key: reload, print, find, new/close window, save, open, view source, downloads, history, zoom.
const BLOCKED_CTRL_KEYS = new Set(['r', 'p', 'f', 'g', 'n', 'w', 't', 's', 'o', 'u', 'j', 'h', 'l', '+', '-', '=', '0']);

function shouldBlock(e: KeyboardEvent) {
  if (BLOCKED_F_KEYS.has(e.key)) return true;
  if (e.key === 'BrowserBack' || e.key === 'BrowserForward' || e.key === 'BrowserRefresh') return true;
  if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return true;
  if (e.ctrlKey || e.metaKey) {
    if (e.shiftKey && /^[a-z]$/i.test(e.key) && !'zZ'.includes(e.key)) return true; // devtools, reopen tab…
    if (BLOCKED_CTRL_KEYS.has(e.key.toLowerCase())) return true;
  }
  return false;
}

/**
 * Kiosk-only browser hardening: blocks the webview's reload, print, find, zoom,
 * back-navigation and context menu so an accidental key can't break the till.
 * Mounted only while kiosk mode is locked.
 */
export function KioskGuard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (shouldBlock(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const prevent = (e: Event) => e.preventDefault();
    const onDrag = (e: DragEvent) => {
      // File drops are allowed only on real drop zones (the import page).
      if (!(e.target instanceof Element && e.target.closest('[data-allow-drop]'))) {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
      }
    };
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) e.preventDefault();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('contextmenu', prevent, true);
    window.addEventListener('dragover', onDrag, true);
    window.addEventListener('drop', onDrag, true);
    window.addEventListener('wheel', onWheel, { capture: true, passive: false });
    window.addEventListener('gesturestart', prevent, true);
    document.documentElement.classList.add('kiosk');
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('contextmenu', prevent, true);
      window.removeEventListener('dragover', onDrag, true);
      window.removeEventListener('drop', onDrag, true);
      window.removeEventListener('wheel', onWheel, true);
      window.removeEventListener('gesturestart', prevent, true);
      document.documentElement.classList.remove('kiosk');
    };
  }, []);
  return null;
}
