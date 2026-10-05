import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';
import { Icon, type IconName } from './Icon';
import { initials } from '@/lib/format';

// ─── Button ─────────────────────────────────────────────────────────────────

type Variant = 'primary' | 'ghost' | 'outline' | 'danger' | 'paper' | 'quiet';
type Size = 'sm' | 'md' | 'lg' | 'xl';

const variants: Record<Variant, string> = {
  primary: 'bg-amber text-amber-ink hover:bg-[#ffc46b] key font-semibold',
  ghost: 'text-bone hover:bg-ink-3',
  outline: 'border border-line-strong text-bone hover:border-bone hover:bg-ink-3',
  danger: 'border border-vermilion/60 text-vermilion hover:bg-vermilion hover:text-ink',
  paper: 'bg-paper-ink text-paper hover:bg-black key',
  quiet: 'text-dust hover:text-bone',
};
const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-sm gap-1.5',
  md: 'h-10 px-4 text-[0.95rem] gap-2',
  lg: 'h-12 px-5 text-base gap-2',
  xl: 'h-16 px-6 text-lg gap-3',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: IconName;
  iconRight?: IconName;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'outline', size = 'md', icon, iconRight, loading, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center rounded-sm transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-45',
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner /> : icon && <Icon name={icon} size={size === 'sm' ? 16 : 18} />}
      {children}
      {iconRight && <Icon name={iconRight} size={size === 'sm' ? 16 : 18} />}
    </button>
  );
});

export function IconButton({ icon, label, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={clsx(
        'grid h-9 w-9 place-items-center rounded-sm text-dust transition-colors hover:bg-ink-3 hover:text-bone disabled:opacity-40',
        className,
      )}
      {...rest}
    >
      <Icon name={icon} size={18} />
    </button>
  );
}

export const Spinner = ({ className }: { className?: string }) => (
  <span className={clsx('inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent', className)} />
);

// ─── Fields ─────────────────────────────────────────────────────────────────

export function Label({ children, htmlFor, hint }: { children: ReactNode; htmlFor?: string; hint?: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 flex items-baseline justify-between gap-3">
      <span className="eyebrow">{children}</span>
      {hint && <span className="text-xs text-dust">{hint}</span>}
    </label>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { label?: string; hint?: ReactNode; error?: string }>(
  function Input({ label, hint, error, id, className, ...rest }, ref) {
    const fieldId = id ?? (label ? `f-${label.replace(/\W+/g, '-').toLowerCase()}` : undefined);
    return (
      <div className={className}>
        {label && (
          <Label htmlFor={fieldId} hint={hint}>
            {label}
          </Label>
        )}
        <input ref={ref} id={fieldId} aria-invalid={!!error} className={clsx('field', error && 'border-vermilion')} {...rest} />
        {error && <p className="mt-1 text-xs text-vermilion">{error}</p>}
      </div>
    );
  },
);

// ─── Segmented control ──────────────────────────────────────────────────────

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  size = 'md',
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode }[];
  className?: string;
  size?: 'sm' | 'md';
}) {
  return (
    <div role="tablist" className={clsx('inline-flex rounded-sm border border-line bg-ink p-0.5', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={clsx(
            'rounded-[2px] font-medium transition-all duration-200 ease-out',
            size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-1.5 text-sm',
            o.value === value ? 'bg-bone text-ink shadow-sm' : 'text-dust hover:text-bone',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ─── Badges, avatar, empty state ────────────────────────────────────────────

type Tone = 'neutral' | 'amber' | 'mint' | 'vermilion' | 'sky' | 'orchid';
const tones: Record<Tone, string> = {
  neutral: 'border-line-strong text-dust',
  amber: 'border-amber/50 text-amber bg-amber/10',
  mint: 'border-mint/45 text-mint bg-mint/10',
  vermilion: 'border-vermilion/50 text-vermilion bg-vermilion/10',
  sky: 'border-sky/45 text-sky bg-sky/10',
  orchid: 'border-orchid/45 text-orchid bg-orchid/10',
};

export const Badge = ({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) => (
  <span className={clsx('inline-flex items-center gap-1 rounded-xs border px-1.5 py-0.5 font-mono text-2xs uppercase', tones[tone], className)}>
    {children}
  </span>
);

export function Avatar({ name, color, size = 36, className }: { name: string; color?: string | null; size?: number; className?: string }) {
  return (
    <span
      className={clsx('grid shrink-0 place-items-center rounded-sm font-mono font-bold text-ink', className)}
      style={{ width: size, height: size, background: color ?? 'rgb(var(--dust))', fontSize: size * 0.36 }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

export function Empty({ icon = 'box', title, children }: { icon?: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <span className="grid h-14 w-14 place-items-center rounded-full border border-dashed border-line-strong text-dust">
        <Icon name={icon} size={24} />
      </span>
      <p className="display text-2xl text-bone">{title}</p>
      {children && <div className="max-w-sm text-sm text-dust">{children}</div>}
    </div>
  );
}

/** Page header: serif title with an eyebrow and right-side actions. */
export function PageHeader({ eyebrow, title, children }: { eyebrow: string; title: ReactNode; children?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 border-b border-line px-6 pb-5 pt-7 lg:px-10">
      <div className="animate-rise">
        <p className="eyebrow mb-1">{eyebrow}</p>
        <h1 className="display text-4xl leading-none text-bone md:text-5xl">{title}</h1>
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </header>
  );
}
