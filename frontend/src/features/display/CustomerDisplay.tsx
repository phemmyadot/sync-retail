import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { fillBannerText, type DisplayMessage } from '@sync-retail/shared';
import { subscribeDisplay } from '@/lib/display';
import { useCurrencySymbol, useMoney } from '@/lib/format';
import { fitClass } from '@/components/ui/Price';
import { useSettings } from '@/hooks/useSettings';

type CartMsg = Extract<DisplayMessage, { type: 'cart' }>;
type CompleteMsg = Extract<DisplayMessage, { type: 'complete' }>;
type CheckoutMsg = Extract<DisplayMessage, { type: 'checkout' }>;

/**
 * Customer-facing screen. Same-machine windows get updates over
 * BroadcastChannel; add `?relay=1` when it runs on a separate device.
 */
export function CustomerDisplay() {
  const money = useMoney();
  const symbol = useCurrencySymbol();
  const { data: settings } = useSettings();
  const [cart, setCart] = useState<CartMsg | null>(null);
  const [checkout, setCheckout] = useState<CheckoutMsg | null>(null);
  const [complete, setComplete] = useState<CompleteMsg | null>(null);
  const [bannerIdx, setBannerIdx] = useState(0);
  const listEnd = useRef<HTMLLIElement>(null);
  const resetTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const relay = new URLSearchParams(location.search).has('relay');
    return subscribeDisplay(
      (m) => {
        if (m.type === 'cart') {
          setCart(m);
          setComplete(null);
          setCheckout(null);
        } else if (m.type === 'checkout') setCheckout(m);
        else if (m.type === 'complete') {
          setComplete(m);
          setCart(null);
          setCheckout(null);
          window.clearTimeout(resetTimer.current);
          resetTimer.current = window.setTimeout(() => setComplete(null), 12_000);
        } else if (m.type === 'idle') {
          setCart(null);
          setCheckout(null);
        }
      },
      { relay },
    );
  }, []);

  useEffect(() => {
    listEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [cart?.lines.length]);

  const banners = settings
    ? settings.promoBanners.map((b) => ({ title: fillBannerText(b.title, settings), subtitle: fillBannerText(b.subtitle, settings) }))
    : [];
  useEffect(() => {
    if (banners.length < 2) return;
    const id = setInterval(() => setBannerIdx((i) => (i + 1) % banners.length), 7000);
    return () => clearInterval(id);
  }, [banners.length]);

  const ticker = banners.map((b) => `${b.title} — ${b.subtitle}`).join('   ✦   ');

  // ── Thank-you state ──────────────────────────────────────────────────────
  if (complete) {
    return (
      <Frame storeName={settings?.storeName} ticker={ticker}>
        <div className="flex flex-1 flex-col items-center justify-center px-8 text-center animate-rise">
          <p className="eyebrow mb-4 text-mint">Payment received · #{complete.receiptNo}</p>
          <h1 className="display text-[clamp(4rem,12vw,11rem)] leading-[0.85]">
            Thank <span className="italic text-amber">you.</span>
          </h1>
          <div className="mt-12 flex flex-wrap items-stretch justify-center gap-4">
            {complete.changeCents > 0 && <BigStat label="Your change" value={money(complete.changeCents)} tone="amber" />}
            <BigStat label="Total paid" value={money(complete.totalCents)} />
            {complete.pointsEarned > 0 && (
              <BigStat
                label="Points earned"
                value={`+${complete.pointsEarned}`}
                sub={complete.pointsBalance !== null ? `Balance ${complete.pointsBalance.toLocaleString()}` : undefined}
                tone="mint"
              />
            )}
          </div>
        </div>
      </Frame>
    );
  }

  // ── Idle / promo state ───────────────────────────────────────────────────
  if (!cart || !cart.lines.length) {
    const b = banners[bannerIdx];
    return (
      <Frame storeName={settings?.storeName} ticker={ticker}>
        <div className="relative flex flex-1 items-center overflow-hidden px-[6vw]">
          <div className="pointer-events-none absolute -right-[10vw] top-1/2 h-[70vh] w-[70vh] -translate-y-1/2 rounded-full border border-line" />
          <div className="pointer-events-none absolute -right-[4vw] top-1/2 h-[46vh] w-[46vh] -translate-y-1/2 rounded-full border border-amber/40" />
          <div className="relative max-w-4xl">
            <p className="eyebrow mb-6">Welcome to {settings?.storeName}</p>
            {b && (
              <div key={bannerIdx} className="animate-rise">
                <h1 className="display text-[clamp(3.5rem,9vw,9rem)] leading-[0.88] text-bone">{b.title}</h1>
                <p className="mt-6 max-w-xl text-2xl text-dust">{b.subtitle}</p>
              </div>
            )}
          </div>
        </div>
      </Frame>
    );
  }

  // ── Live cart ────────────────────────────────────────────────────────────
  const due = checkout?.remainingCents ?? cart.totalCents;
  return (
    <Frame storeName={settings?.storeName} ticker={ticker}>
      <div className="grid min-h-0 flex-1 lg:grid-cols-[1.35fr_1fr]">
        <ul className="scroll-fade min-h-0 overflow-y-auto px-[4vw] py-8">
          {cart.lines.map((l, i) => (
            <li key={`${l.name}-${i}`} className="flex items-baseline gap-6 border-b border-line py-5 animate-rise">
              <span className="num w-14 shrink-0 text-2xl text-dust">{l.quantity}×</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-3xl text-bone">{l.name}</span>
                {l.discountCents > 0 && <span className="num mt-1 block text-lg text-amber">You save {money(l.discountCents)}</span>}
              </span>
              <span className="num shrink-0 text-3xl text-bone">{money(l.totalCents)}</span>
            </li>
          ))}
          <li ref={listEnd} />
        </ul>

        <aside className="flex flex-col justify-between gap-8 border-t border-line bg-ink-2 px-[4vw] py-10 lg:border-l lg:border-t-0">
          <dl className="space-y-3 text-2xl">
            <Row k="Subtotal" v={money(cart.subtotalCents)} />
            {cart.discountCents > 0 && <Row k="Savings" v={`−${money(cart.discountCents)}`} accent />}
            <Row k="Tax" v={money(cart.taxCents)} />
            {checkout && checkout.paidCents > 0 && <Row k="Paid" v={`−${money(checkout.paidCents)}`} accent />}
          </dl>

          <div>
            <p className="eyebrow mb-2">{checkout ? 'Remaining' : 'Total'}</p>
            <p
              className={clsx(
                'display whitespace-nowrap leading-none transition-colors',
                fitClass(money(due), [[9, 'text-[clamp(4rem,8vw,8rem)]'], [13, 'text-[clamp(3rem,5.5vw,6rem)]']], 'text-[clamp(2.5rem,4.2vw,4.5rem)]'),
                checkout ? 'text-amber' : 'text-bone',
              )}
              aria-live="polite"
            >
              {money(due)}
            </p>
          </div>

          {cart.customer ? (
            <div className="relative overflow-hidden rounded-md bg-amber p-6 text-amber-ink">
              <div className="hatch absolute inset-0 opacity-40 mix-blend-multiply" />
              <p className="relative font-mono text-sm uppercase tracking-[0.2em]">Rewards member</p>
              <p className="display relative mt-1 text-4xl">{cart.customer.name}</p>
              <p className="num relative mt-3 text-3xl font-bold">
                {cart.customer.pointsBalance.toLocaleString()} <span className="text-lg font-medium">points</span>
              </p>
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-line-strong p-6 text-xl text-dust">
              Not a member? Ask us to join — earn <span className="text-amber">{settings?.loyalty.pointsPerDollar} pt</span> per {symbol}1 spent.
            </div>
          )}
        </aside>
      </div>
    </Frame>
  );
}

function Frame({ children, storeName, ticker }: { children: React.ReactNode; storeName?: string; ticker: string }) {
  return (
    <div className="flex h-full flex-col bg-ink">
      <header className="flex items-center justify-between border-b border-line px-[4vw] py-5">
        <span className="display text-3xl">
          {storeName?.split(' ')[0]} <span className="italic text-amber">{storeName?.split(' ').slice(1).join(' ')}</span>
        </span>
        <span className="flex items-center gap-2 font-mono text-sm text-dust">
          <span className="h-2 w-2 rounded-full bg-mint animate-blink" /> Live
        </span>
      </header>
      {children}
      {ticker && (
        <footer className="overflow-hidden border-t border-line bg-amber py-3 text-amber-ink">
          <div className="flex w-max animate-marquee whitespace-nowrap font-mono text-lg uppercase tracking-wider">
            <span className="pr-16">{ticker}   ✦   </span>
            <span className="pr-16">{ticker}   ✦   </span>
          </div>
        </footer>
      )}
    </div>
  );
}

const Row = ({ k, v, accent }: { k: string; v: string; accent?: boolean }) => (
  <div className={clsx('flex justify-between', accent ? 'text-amber' : 'text-dust')}>
    <dt>{k}</dt>
    <dd className="num">{v}</dd>
  </div>
);

function BigStat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'amber' | 'mint' }) {
  return (
    <div
      className={clsx(
        'min-w-[14rem] rounded-md border p-6 text-left',
        tone === 'amber' ? 'border-amber bg-amber text-amber-ink' : tone === 'mint' ? 'border-mint/50 text-mint' : 'border-line text-bone',
      )}
    >
      <p className={clsx('font-mono text-sm uppercase tracking-[0.18em]', tone === 'amber' ? 'text-amber-ink/80' : 'text-dust')}>{label}</p>
      <p className="num mt-2 text-5xl font-bold">{value}</p>
      {sub && <p className="mt-1 text-dust">{sub}</p>}
    </div>
  );
}
