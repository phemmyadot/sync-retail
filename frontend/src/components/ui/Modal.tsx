import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { IconButton } from './primitives';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  eyebrow?: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: 'sm' | 'md' | 'lg' | 'xl';
  tone?: 'ink' | 'danger';
  /** Disable Esc/backdrop close (e.g. while a payment is processing). */
  locked?: boolean;
}

const widths = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-3xl', xl: 'max-w-5xl' };

export function Modal({ open, onClose, title, eyebrow, children, footer, width = 'md', tone = 'ink', locked }: ModalProps) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !locked) onClose();
      // Basic focus trap
      if (e.key === 'Tab' && panel.current) {
        const f = panel.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>('[autofocus], input, button')?.focus());
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open, locked, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-[2px] animate-[rise_.2s_ease-out_both]" onClick={() => !locked && onClose()} />
      <div
        ref={panel}
        className={clsx(
          'relative flex max-h-[94vh] w-full flex-col overflow-hidden rounded-t-md border bg-ink-2 shadow-lift animate-pop sm:rounded-md',
          widths[width],
          tone === 'danger' ? 'border-vermilion/50' : 'border-line-strong',
        )}
      >
        {tone === 'danger' && <div className="hatch h-2 shrink-0 border-b border-vermilion/40" />}
        {(title || eyebrow) && (
          <div className="flex items-start justify-between gap-4 px-6 pb-3 pt-5">
            <div>
              {eyebrow && <p className={clsx('eyebrow mb-1', tone === 'danger' && '!text-vermilion')}>{eyebrow}</p>}
              {title && <h2 className="display text-3xl leading-tight text-bone">{title}</h2>}
            </div>
            {!locked && <IconButton icon="x" label="Close" onClick={onClose} className="-mr-2 -mt-1" />}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-ink px-6 py-4">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
