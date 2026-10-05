import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Icon } from './Icon';

interface PinPadProps {
  length?: number;
  onComplete: (pin: string) => void | Promise<void>;
  /** Bumping this number clears the pad and shakes it (wrong PIN). */
  errorKey?: number;
  busy?: boolean;
  tone?: 'amber' | 'vermilion';
}

/**
 * Large, touch-first PIN entry. Also accepts the physical number row/numpad so
 * a cashier with a keyboard never has to reach for the screen.
 */
export function PinPad({ length = 4, onComplete, errorKey = 0, busy, tone = 'amber' }: PinPadProps) {
  const [pin, setPin] = useState('');
  const [shake, setShake] = useState(false);

  useEffect(() => {
    if (!errorKey) return;
    setPin('');
    setShake(true);
    const t = setTimeout(() => setShake(false), 500);
    return () => clearTimeout(t);
  }, [errorKey]);

  // Fire completion from an effect, never inside a state updater: StrictMode
  // double-invokes updaters, which would submit the PIN twice.
  const completeRef = useRef(onComplete);
  completeRef.current = onComplete;
  useEffect(() => {
    if (pin.length !== length) return;
    const t = setTimeout(() => void completeRef.current(pin), 90);
    return () => clearTimeout(t);
  }, [pin, length]);

  const press = (d: string) => {
    if (busy) return;
    setPin((p) => (p.length >= length ? p : p + d));
  };
  const back = () => !busy && setPin((p) => p.slice(0, -1));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const accent = tone === 'amber' ? 'bg-amber border-amber' : 'bg-vermilion border-vermilion';

  return (
    <div className="mx-auto w-full max-w-[18rem] select-none">
      <div className={clsx('mb-6 flex justify-center gap-3', shake && 'animate-shake')} aria-live="polite" aria-label={`${pin.length} of ${length} digits entered`}>
        {Array.from({ length }, (_, i) => (
          <span
            key={i}
            className={clsx(
              'h-3.5 w-3.5 rounded-full border-2 transition-all duration-200 ease-snap',
              i < pin.length ? `${accent} scale-110` : 'border-line-strong',
              shake && '!border-vermilion',
            )}
          />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2.5">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <Key key={d} onClick={() => press(d)}>
            {d}
          </Key>
        ))}
        <Key onClick={() => setPin('')} aria-label="Clear" muted>
          <span className="font-mono text-xs tracking-widest">CLR</span>
        </Key>
        <Key onClick={() => press('0')}>0</Key>
        <Key onClick={back} aria-label="Delete digit" muted>
          <Icon name="backspace" size={22} />
        </Key>
      </div>
    </div>
  );
}

function Key({ children, muted, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { muted?: boolean }) {
  return (
    <button
      type="button"
      className={clsx(
        'key grid h-16 place-items-center rounded-sm border border-line bg-ink-3 font-mono text-2xl transition-colors hover:border-line-strong hover:bg-ink-4 active:bg-amber active:text-amber-ink',
        muted ? 'text-dust' : 'text-bone',
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
