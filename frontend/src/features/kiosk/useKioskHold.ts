import { useRef } from 'react';
import { useKiosk } from '@/lib/kiosk';

/**
 * Hidden manager gesture: press and hold for 3 seconds to open the kiosk
 * unlock dialog. Does nothing unless kiosk mode is locked.
 *
 * Only releasing (or a cancelled touch) stops the hold: WebView2 can fire a
 * spurious `pointerleave` while the button is still down.
 */
export function useKioskHold(ms = 3000) {
  const locked = useKiosk((s) => s.status?.locked ?? false);
  const openExit = useKiosk((s) => s.openExit);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancel = () => clearTimeout(timer.current);
  if (!locked) return {};
  return {
    onPointerDown: () => {
      cancel();
      timer.current = setTimeout(openExit, ms);
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
  };
}
