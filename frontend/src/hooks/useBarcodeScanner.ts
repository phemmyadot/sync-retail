import { useEffect, useRef } from 'react';

/**
 * USB/Bluetooth scanners act as keyboards that "type" a code very fast and
 * press Enter. We capture bursts globally (even when no input is focused) and
 * distinguish them from humans by inter-key timing.
 */
export function useBarcodeScanner(onScan: (code: string) => void, { enabled = true, minLength = 4, maxGapMs = 35 } = {}) {
  const buffer = useRef('');
  const last = useRef(0);
  const cb = useRef(onScan);
  cb.current = onScan;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      // Inputs marked data-scanner="own" handle their own Enter (e.g. the search box).
      if (target?.closest('[data-scanner="own"]')) return;
      const now = performance.now();
      const gap = now - last.current;
      last.current = now;

      if (e.key === 'Enter') {
        if (buffer.current.length >= minLength) {
          const isEditable = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
          if (!isEditable) e.preventDefault();
          cb.current(buffer.current);
        }
        buffer.current = '';
        return;
      }
      if (e.key.length !== 1) return;
      buffer.current = gap > maxGapMs ? e.key : buffer.current + e.key;
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [enabled, minLength, maxGapMs]);
}
