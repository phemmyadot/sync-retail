import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import clsx from 'clsx';
import { formatMoney, type AuthResponse } from '@sync-retail/shared';
import { api, errorMessage } from '@/lib/api';
import { Button, Input } from '@/components/ui/primitives';
import { Icon } from '@/components/ui/Icon';

/** Common currencies first; any ISO 4217 code can be typed in Admin later. */
const CURRENCIES: { code: string; name: string; locale: string }[] = [
  { code: 'NGN', name: 'Nigerian naira', locale: 'en-NG' },
  { code: 'GHS', name: 'Ghanaian cedi', locale: 'en-GH' },
  { code: 'KES', name: 'Kenyan shilling', locale: 'en-KE' },
  { code: 'ZAR', name: 'South African rand', locale: 'en-ZA' },
  { code: 'XOF', name: 'West African CFA franc', locale: 'fr-SN' },
  { code: 'EGP', name: 'Egyptian pound', locale: 'en-EG' },
  { code: 'USD', name: 'US dollar', locale: 'en-US' },
  { code: 'GBP', name: 'Pound sterling', locale: 'en-GB' },
  { code: 'EUR', name: 'Euro', locale: 'en-IE' },
  { code: 'CAD', name: 'Canadian dollar', locale: 'en-CA' },
  { code: 'INR', name: 'Indian rupee', locale: 'en-IN' },
  { code: 'AED', name: 'UAE dirham', locale: 'en-AE' },
];

interface SetupResult extends AuthResponse {
  recoveryKey: string;
  keyId: string;
  passphraseSet: boolean;
}

const STEPS = ['Store', 'Owner', 'Security', 'Recovery key'];

/**
 * First-run store setup (desktop Main Register, or a fresh server install).
 * Creates the owner account and store profile and hands back the recovery key.
 */
export function SetupWizard({ onFinished }: { onFinished: (auth: AuthResponse) => void }) {
  const [step, setStep] = useState(0);
  const [store, setStore] = useState({ name: '', currency: 'NGN', locale: 'en-NG' });
  const [owner, setOwner] = useState({ name: '', email: '', password: '', password2: '', pin: '', pin2: '' });
  const [usePassphrase, setUsePassphrase] = useState(false);
  const [passphrase, setPassphrase] = useState({ a: '', b: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SetupResult | null>(null);

  const preview = useMemo(() => {
    try {
      return [125000, 1250000, 125000000].map((c) => formatMoney(c * 100, store.currency, store.locale));
    } catch {
      return [];
    }
  }, [store.currency, store.locale]);

  const next = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (step === 1) {
      if (owner.password !== owner.password2) return setError('Passwords don’t match.');
      if (owner.pin !== owner.pin2) return setError('PINs don’t match.');
    }
    setStep((s) => s + 1);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (usePassphrase && passphrase.a !== passphrase.b) return setError('Passphrases don’t match.');
    setBusy(true);
    try {
      const res = await api<SetupResult>('/setup', {
        method: 'POST',
        token: null,
        body: {
          store,
          owner: { name: owner.name, email: owner.email, password: owner.password, pin: owner.pin },
          passphrase: usePassphrase ? passphrase.a : undefined,
        },
      });
      setResult(res);
      setStep(3);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-full lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      {/* Left: editorial masthead that reflects what's being set up */}
      <aside className="relative hidden flex-col justify-between overflow-hidden border-r border-line p-12 lg:flex">
        <div>
          <p className="eyebrow text-amber">Main register · first launch</p>
          <h1 className="display mt-6 text-7xl leading-[0.88]">
            {store.name ? (
              store.name.split(' ').map((w, i) => (
                <span key={i} className={clsx('block', i % 2 === 1 && 'italic text-amber')}>
                  {w}
                </span>
              ))
            ) : (
              <>
                Let’s open
                <span className="block italic text-amber">your store.</span>
              </>
            )}
          </h1>
        </div>
        <ol className="space-y-3">
          {STEPS.map((label, i) => (
            <li key={label} className={clsx('flex items-baseline gap-4 transition-colors', i === step ? 'text-bone' : i < step ? 'text-dust' : 'text-line-strong')}>
              <span className={clsx('display w-10 text-3xl', i === step && 'text-amber')}>{String(i + 1).padStart(2, '0')}</span>
              <span className="text-lg">{label}</span>
              {i < step && <Icon name="check" size={16} className="text-mint" />}
            </li>
          ))}
        </ol>
      </aside>

      {/* Right: the current step */}
      <section className="flex flex-col justify-center px-6 py-10 sm:px-14">
        <div className="mx-auto w-full max-w-lg animate-rise" key={step}>
          <p className="eyebrow mb-2 lg:hidden">
            Step {step + 1} of {STEPS.length}
          </p>

          {step === 0 && (
            <form onSubmit={next} className="space-y-5">
              <Heading title="Your store" sub="This appears on receipts, the customer display and reports." />
              <Input label="Store name" required autoFocus maxLength={80} value={store.name} onChange={(e) => setStore({ ...store, name: e.target.value })} />
              <div>
                <span className="eyebrow mb-1.5 block">Currency</span>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {CURRENCIES.map((c) => (
                    <button
                      type="button"
                      key={c.code}
                      onClick={() => setStore({ ...store, currency: c.code, locale: c.locale })}
                      className={clsx(
                        'rounded-sm border px-3 py-2 text-left transition-colors',
                        store.currency === c.code ? 'border-amber bg-amber/10' : 'border-line hover:border-line-strong',
                      )}
                    >
                      <span className={clsx('block font-mono text-sm', store.currency === c.code ? 'text-amber' : 'text-bone')}>{c.code}</span>
                      <span className="block truncate text-xs text-dust">{c.name}</span>
                    </button>
                  ))}
                </div>
              </div>
              {preview.length > 0 && (
                <p className="rounded-sm border border-line bg-ink p-3 text-sm text-dust">
                  Prices will look like <span className="num text-bone">{preview.join('  ·  ')}</span>
                </p>
              )}
              <Footer error={error}>
                <Button type="submit" variant="primary" size="lg" iconRight="arrowRight" disabled={!store.name.trim()}>
                  Continue
                </Button>
              </Footer>
            </form>
          )}

          {step === 1 && (
            <form onSubmit={next} className="space-y-4">
              <Heading title="Owner account" sub="You’ll be the store admin: staff, settings, reports, backups and manager overrides." />
              <Input label="Your name" required autoFocus value={owner.name} onChange={(e) => setOwner({ ...owner, name: e.target.value })} />
              <Input label="Email" type="email" required autoComplete="username" value={owner.email} onChange={(e) => setOwner({ ...owner, email: e.target.value })} />
              <div className="grid gap-4 sm:grid-cols-2">
                <Input label="Password" type="password" required minLength={8} autoComplete="new-password" hint="8+ characters" value={owner.password} onChange={(e) => setOwner({ ...owner, password: e.target.value })} />
                <Input label="Confirm password" type="password" required autoComplete="new-password" value={owner.password2} onChange={(e) => setOwner({ ...owner, password2: e.target.value })} />
                <Input
                  label="PIN"
                  inputMode="numeric"
                  required
                  pattern="\d{4,8}"
                  hint="4–8 digits, for quick sign-in"
                  value={owner.pin}
                  onChange={(e) => setOwner({ ...owner, pin: e.target.value.replace(/\D/g, '').slice(0, 8) })}
                />
                <Input label="Confirm PIN" inputMode="numeric" required value={owner.pin2} onChange={(e) => setOwner({ ...owner, pin2: e.target.value.replace(/\D/g, '').slice(0, 8) })} />
              </div>
              <Footer error={error} onBack={() => setStep(0)}>
                <Button type="submit" variant="primary" size="lg" iconRight="arrowRight">
                  Continue
                </Button>
              </Footer>
            </form>
          )}

          {step === 2 && (
            <form onSubmit={submit} className="space-y-5">
              <Heading
                title="Protect your backups"
                sub="Backups are encrypted before they leave this PC. Next you’ll get a recovery key — the only way to restore them if this computer is lost."
              />
              <label className="flex cursor-pointer items-start gap-3 rounded-sm border border-line p-4 transition-colors hover:border-line-strong">
                <input type="checkbox" checked={usePassphrase} onChange={(e) => setUsePassphrase(e.target.checked)} className="mt-1 h-4 w-4 accent-[rgb(var(--amber))]" />
                <span>
                  <span className="block font-medium">Also allow a restore passphrase</span>
                  <span className="block text-sm text-dust">Optional. Handy if the key sheet is misplaced — choose 12+ characters nobody could guess.</span>
                </span>
              </label>
              {usePassphrase && (
                <div className="grid gap-4 sm:grid-cols-2 animate-rise">
                  <Input label="Passphrase" type="password" required minLength={12} autoComplete="new-password" value={passphrase.a} onChange={(e) => setPassphrase({ ...passphrase, a: e.target.value })} />
                  <Input label="Confirm passphrase" type="password" required autoComplete="new-password" value={passphrase.b} onChange={(e) => setPassphrase({ ...passphrase, b: e.target.value })} />
                </div>
              )}
              <Footer error={error} onBack={() => setStep(1)}>
                <Button type="submit" variant="primary" size="lg" loading={busy} icon="shield">
                  Create store
                </Button>
              </Footer>
            </form>
          )}

          {step === 3 && result && <RecoveryKeyStep result={result} storeName={store.name} onDone={() => onFinished(result)} />}
        </div>
      </section>
    </div>
  );
}

function RecoveryKeyStep({ result, storeName, onDone }: { result: SetupResult; storeName: string; onDone: () => void }) {
  const groups = result.recoveryKey.split('-');
  // Ask for two random groups to prove it was written down.
  const [ask] = useState(() => {
    const a = Math.floor(Math.random() * groups.length);
    let b = Math.floor(Math.random() * groups.length);
    while (b === a) b = Math.floor(Math.random() * groups.length);
    return [a, b].sort((x, y) => x - y);
  });
  const [answers, setAnswers] = useState(['', '']);
  const [stored, setStored] = useState(false);
  const confirmed = ask.every((g, i) => answers[i].trim().toUpperCase() === groups[g]);

  const download = () => {
    const text = [
      'SYNC RETAIL — BACKUP RECOVERY KEY',
      '',
      `Store:   ${storeName}`,
      `Key ID:  ${result.keyId}`,
      `Created: ${new Date().toLocaleString()}`,
      '',
      result.recoveryKey,
      '',
      'Keep this somewhere safe and offline (printed, in a safe).',
      'Anyone with this key and access to your Google Drive backups can read your store data.',
      'Without it (or your passphrase), backups cannot be restored.',
    ].join('\r\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    Object.assign(document.createElement('a'), { href: url, download: `SyncRetail-recovery-key-${result.keyId}.txt` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  return (
    <div className="space-y-6">
      <Heading title="Your recovery key" sub="Write it down or print it now. It is shown only once." />

      <div className="print-area paper tear-both rounded-sm px-6 font-mono">
        <div className="flex items-baseline justify-between text-xs uppercase tracking-[0.2em] text-paper-dim">
          <span>Backup recovery key</span>
          <span>ID {result.keyId}</span>
        </div>
        <p className="display mt-1 text-2xl not-italic text-paper-ink">{storeName}</p>
        <ol className="mt-4 grid grid-cols-4 gap-x-3 gap-y-2 sm:grid-cols-5">
          {groups.map((g, i) => (
            <li key={i} className="flex items-baseline gap-1.5">
              <span className="w-4 text-right text-[0.6rem] text-paper-dim">{i + 1}</span>
              <span className="text-lg font-bold tracking-wider text-paper-ink">{g}</span>
            </li>
          ))}
        </ol>
        <p className="mt-4 text-xs leading-relaxed text-paper-dim">
          Keep this offline and private. Without it{result.passphraseSet ? ' or your passphrase' : ''}, encrypted backups can’t be restored.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button icon="receipt" onClick={() => window.print()}>
          Print
        </Button>
        <Button icon="download" onClick={download}>
          Save as text file
        </Button>
      </div>

      <div className="rounded-sm border border-line bg-ink-2 p-4">
        <p className="mb-3 text-sm text-dust">To confirm, type these two groups from your key:</p>
        <div className="grid grid-cols-2 gap-3">
          {ask.map((g, i) => (
            <Input
              key={g}
              label={`Group ${g + 1}`}
              className="font-mono"
              maxLength={4}
              autoComplete="off"
              value={answers[i]}
              onChange={(e) => setAnswers(answers.map((a, j) => (j === i ? e.target.value.toUpperCase() : a)))}
              error={answers[i].length === 4 && answers[i].toUpperCase() !== groups[g] ? 'Doesn’t match' : undefined}
            />
          ))}
        </div>
        <label className="mt-4 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={stored} onChange={(e) => setStored(e.target.checked)} className="h-4 w-4 accent-[rgb(var(--amber))]" />
          I’ve stored the recovery key somewhere safe
        </label>
      </div>

      <Button variant="primary" size="lg" className="w-full" disabled={!confirmed || !stored} onClick={onDone} iconRight="arrowRight">
        Open the register
      </Button>
    </div>
  );
}

function Heading({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="mb-2">
      <h2 className="display text-5xl leading-none">{title}</h2>
      <p className="mt-3 text-dust">{sub}</p>
    </div>
  );
}

function Footer({ children, error, onBack }: { children: ReactNode; error: string | null; onBack?: () => void }) {
  return (
    <div className="pt-2">
      {error && (
        <p className="mb-3 text-sm text-vermilion" role="alert">
          {error}
        </p>
      )}
      <div className="flex items-center justify-between gap-3">
        {onBack ? (
          <Button type="button" variant="quiet" icon="arrowLeft" onClick={onBack}>
            Back
          </Button>
        ) : (
          <span />
        )}
        {children}
      </div>
    </div>
  );
}
