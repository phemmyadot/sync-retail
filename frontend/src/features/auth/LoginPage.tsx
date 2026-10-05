import { useEffect, useState, type FormEvent } from 'react';
import clsx from 'clsx';
import { useQuery } from '@tanstack/react-query';
import { ROLE_LABEL, type AuthResponse, type StaffTile } from '@sync-retail/shared';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/store/auth';
import { useSettings } from '@/hooks/useSettings';
import { PinPad } from '@/components/ui/PinPad';
import { Avatar, Button, Input } from '@/components/ui/primitives';
import { Icon } from '@/components/ui/Icon';
import { TERMINAL_ID } from '@/lib/config';

const STAFF_CACHE = 'sr-staff';

function useClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** Sign-in + quick-switch lock screen. Tap a name → PIN; or use email/password. */
export function LoginPage() {
  const signIn = useAuth((s) => s.signIn);
  const locked = useAuth((s) => s.locked);
  const { data: settings } = useSettings();
  const now = useClock();
  const [mode, setMode] = useState<'pin' | 'password'>('pin');
  const [selected, setSelected] = useState<StaffTile | null>(null);
  const [errorKey, setErrorKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const staff = useQuery({
    queryKey: ['staff'],
    queryFn: async () => {
      const s = await api<StaffTile[]>('/auth/staff', { token: null });
      localStorage.setItem(STAFF_CACHE, JSON.stringify(s));
      return s;
    },
    initialData: () => {
      try {
        return JSON.parse(localStorage.getItem(STAFF_CACHE) ?? 'null') ?? undefined;
      } catch {
        return undefined;
      }
    },
  });

  const viaPin = async (pin: string) => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      signIn(await api<AuthResponse>('/auth/pin', { method: 'POST', body: { userId: selected.id, pin }, token: null }));
    } catch (err) {
      setError(errorMessage(err));
      setErrorKey((k) => k + 1);
    } finally {
      setBusy(false);
    }
  };

  const viaPassword = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      signIn(await api<AuthResponse>('/auth/login', { method: 'POST', body: { email, password }, token: null }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-full lg:grid-cols-[1.15fr_1fr]">
      {/* Left: masthead */}
      <section className="relative flex flex-col justify-between overflow-hidden border-b border-line p-8 lg:border-b-0 lg:border-r lg:p-14">
        <div className="pointer-events-none absolute -right-24 top-10 hidden h-[130%] w-72 rotate-[8deg] lg:block">
          <div className="paper tear-both h-full w-full opacity-[0.08]" />
        </div>
        <div className="flex items-center gap-3 animate-rise">
          <span className="h-2.5 w-2.5 rounded-full bg-amber shadow-glow animate-blink" />
          <span className="eyebrow">Register {TERMINAL_ID} · {locked ? 'locked' : 'signed out'}</span>
        </div>

        <div className="my-14 animate-rise [animation-delay:80ms]">
          <p className="eyebrow mb-4 text-amber">Sync Retail POS</p>
          <h1 className="display text-[clamp(3.2rem,8vw,7.5rem)] leading-[0.86] text-bone">
            {settings?.storeName.split(' ').map((w, i) => (
              <span key={i} className={clsx('block', i % 2 === 1 && 'italic text-amber')}>
                {w}
              </span>
            ))}
          </h1>
        </div>

        <div className="flex items-end justify-between gap-6 animate-rise [animation-delay:160ms]">
          <div>
            <p className="num text-5xl font-medium tracking-tight text-bone md:text-6xl">
              {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              <span className="text-dust">:{String(now.getSeconds()).padStart(2, '0')}</span>
            </p>
            <p className="mt-1 text-dust">{now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
          </div>
        </div>
      </section>

      {/* Right: sign-in */}
      <section className="flex flex-col justify-center px-6 py-10 sm:px-12">
        <div className="mx-auto w-full max-w-md">
          <div className="mb-8 flex items-center justify-between">
            <h2 className="display text-3xl">{selected ? `Hi, ${selected.name.split(' ')[0]}` : 'Who’s on the till?'}</h2>
            <button
              className="text-sm text-dust underline-offset-4 hover:text-bone hover:underline"
              onClick={() => {
                setMode(mode === 'pin' ? 'password' : 'pin');
                setSelected(null);
                setError(null);
              }}
            >
              {mode === 'pin' ? 'Use email instead' : 'Use PIN instead'}
            </button>
          </div>

          {mode === 'password' ? (
            <form onSubmit={viaPassword} className="space-y-4 animate-rise">
              <Input label="Email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
              <Input
                label="Password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} iconRight="arrowRight">
                Sign in
              </Button>
            </form>
          ) : selected ? (
            <div className="animate-rise">
              <button onClick={() => setSelected(null)} className="mb-6 flex items-center gap-2 text-sm text-dust hover:text-bone">
                <Icon name="arrowLeft" size={16} /> Not you?
              </button>
              <PinPad onComplete={viaPin} errorKey={errorKey} busy={busy} />
            </div>
          ) : (
            <ul className="grid grid-cols-2 gap-2.5">
              {(staff.data ?? []).map((s: StaffTile, i: number) => (
                <li key={s.id} className="animate-rise" style={{ animationDelay: `${i * 45}ms` }}>
                  <button
                    onClick={() => setSelected(s)}
                    className="group flex w-full items-center gap-3 rounded-sm border border-line bg-ink-2 p-3 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-line-strong hover:bg-ink-3"
                  >
                    <Avatar name={s.name} color={s.color} size={42} />
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-bone">{s.name}</span>
                      <span className="eyebrow">{ROLE_LABEL[s.role]}</span>
                    </span>
                  </button>
                </li>
              ))}
              {staff.isError && !staff.data && (
                <li className="col-span-2 text-sm text-dust">Can’t reach the server to list staff — use email sign-in or check the connection.</li>
              )}
            </ul>
          )}

          <p className="mt-6 min-h-5 text-center text-sm text-vermilion" role="alert">
            {error}
          </p>
        </div>
      </section>
    </div>
  );
}
