import { create } from 'zustand';

/**
 * Work that must not be interrupted by the idle lock (a sale being submitted,
 * later a card payment waiting on the terminal). `const release = holdIdle()`.
 */
export const useIdleHold = create<{ holds: number }>(() => ({ holds: 0 }));

export function holdIdle() {
  useIdleHold.setState((s) => ({ holds: s.holds + 1 }));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    useIdleHold.setState((s) => ({ holds: Math.max(0, s.holds - 1) }));
  };
}
