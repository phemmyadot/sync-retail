import { useState } from 'react';
import clsx from 'clsx';
import { Icon, type IconName } from '@/components/ui/Icon';
import { Spinner } from '@/components/ui/primitives';

const ROLES: { id: 'host' | 'client' | 'restore'; icon: IconName; title: string; body: string; available: boolean; note?: string }[] = [
  {
    id: 'host',
    icon: 'register',
    title: 'Main Register',
    body: 'This PC keeps the store’s database. Other registers on your network will connect to it. Choose this for your first PC.',
    available: true,
  },
  {
    id: 'client',
    icon: 'wifi',
    title: 'Connect to Main Register',
    body: 'Add this PC as another register. It finds the Main Register on your network and pairs with a 6-digit code.',
    available: true,
  },
  {
    id: 'restore',
    icon: 'refresh',
    title: 'Restore from backup',
    body: 'Replacing a Main Register? Bring the store back from its encrypted Google Drive backup.',
    available: false,
    note: 'Arrives with Drive backups',
  },
];

/** First launch on a new PC: what role does it play? (desktop only) */
export function RoleChooser({ onHost, onClient }: { onHost: () => Promise<void>; onClient: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex min-h-full flex-col justify-center px-6 py-12 sm:px-12">
      <div className="mx-auto w-full max-w-5xl">
        <p className="eyebrow text-amber animate-rise">Welcome to Sync Retail</p>
        <h1 className="display mt-3 text-[clamp(3rem,6vw,5.5rem)] leading-[0.9] animate-rise [animation-delay:60ms]">
          How will this PC <span className="italic text-amber">be used?</span>
        </h1>

        <div className="mt-12 grid gap-4 md:grid-cols-3">
          {ROLES.map((r, i) => (
            <button
              key={r.id}
              disabled={!r.available || busy}
              onClick={async () => {
                if (r.id === 'client') return onClient();
                setBusy(true);
                setError(null);
                try {
                  await onHost();
                } catch (err) {
                  setError(String(err));
                  setBusy(false);
                }
              }}
              style={{ animationDelay: `${120 + i * 60}ms` }}
              className={clsx(
                'group relative flex min-h-[15rem] flex-col rounded-md border p-6 text-left transition-all duration-200 animate-rise',
                r.available
                  ? 'border-line-strong bg-ink-2 hover:-translate-y-1 hover:border-amber hover:shadow-glow'
                  : 'cursor-not-allowed border-dashed border-line opacity-60',
              )}
            >
              <span className={clsx('grid h-12 w-12 place-items-center rounded-full border', r.available ? 'border-amber/50 text-amber' : 'border-line text-dust')}>
                {busy && r.id === 'host' ? <Spinner /> : <Icon name={r.icon} size={22} />}
              </span>
              <span className="display mt-6 text-3xl">{r.title}</span>
              <span className="mt-2 text-sm leading-relaxed text-dust">{r.body}</span>
              {r.note && <span className="eyebrow mt-auto pt-4">{r.note}</span>}
              {r.available && (
                <span className="mt-auto flex items-center gap-2 pt-4 text-sm font-medium text-amber">
                  {r.id === 'host' ? 'Set up as Main Register' : 'Find the Main Register'} <Icon name="arrowRight" size={16} className="transition-transform group-hover:translate-x-1" />
                </span>
              )}
            </button>
          ))}
        </div>
        {error && <p className="mt-6 text-sm text-vermilion">{error}</p>}
      </div>
    </div>
  );
}
