import clsx from 'clsx';
import { useToasts } from '@/store/toast';
import { Icon } from './Icon';

const toneStyles = {
  success: { bar: 'bg-mint', icon: 'check', text: 'text-mint' },
  error: { bar: 'bg-vermilion', icon: 'alert', text: 'text-vermilion' },
  warn: { bar: 'bg-amber', icon: 'alert', text: 'text-amber' },
  info: { bar: 'bg-sky', icon: 'spark', text: 'text-sky' },
} as const;

export function Toaster() {
  const { toasts, dismiss } = useToasts();
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
      {toasts.map((t) => {
        const s = toneStyles[t.tone];
        return (
          <button
            key={t.id}
            onClick={() => dismiss(t.id)}
            className="pointer-events-auto flex overflow-hidden rounded-sm border border-line-strong bg-ink-3 text-left shadow-lift animate-rise"
          >
            <span className={clsx('w-1 shrink-0', s.bar)} />
            <span className="flex gap-3 px-4 py-3">
              <Icon name={s.icon} size={18} className={clsx('mt-0.5 shrink-0', s.text)} />
              <span>
                <span className="block font-medium text-bone">{t.title}</span>
                {t.body && <span className="mt-0.5 block text-sm text-dust">{t.body}</span>}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
