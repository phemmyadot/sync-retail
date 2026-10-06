import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { NavLink, Outlet } from 'react-router-dom';
import clsx from 'clsx';
import { ROLE_LABEL, type Permission } from '@sync-retail/shared';
import { useAuth } from '@/store/auth';
import { useSyncStatus } from '@/store/sync';
import { useCan } from '@/hooks/useOverride';
import { retryFailed, startSyncLoop } from '@/lib/sync';
import { subscribeStore } from '@/lib/parked';
import { StoreLogo } from './StoreLogo';
import { openCustomerDisplay } from '@/lib/platform';
import { toast } from '@/store/toast';
import { Icon, type IconName } from '../ui/Icon';
import { Avatar } from '../ui/primitives';
import { useKioskHold } from '@/features/kiosk/useKioskHold';

const NAV: { to: string; label: string; icon: IconName; perm?: Permission | Permission[] }[] = [
  { to: '/pos', label: 'Register', icon: 'register' },
  { to: '/sales', label: 'Sales', icon: 'receipt' },
  { to: '/customers', label: 'Customers', icon: 'users' },
  { to: '/inventory', label: 'Inventory', icon: 'box' },
  { to: '/inventory/import', label: 'Import', icon: 'upload', perm: 'inventory:import' },
  { to: '/reports', label: 'Reports', icon: 'chart', perm: 'reports:read' },
  { to: '/audit', label: 'Audit', icon: 'shield', perm: 'audit:read' },
  // Managers see Admin too (Tax, Registers); each tab checks its own permission.
  { to: '/settings', label: 'Admin', icon: 'settings', perm: ['users:manage', 'settings:write', 'tax:manage', 'devices:manage'] },
];

export function AppShell() {
  const user = useAuth((s) => s.user)!;
  const lock = useAuth((s) => s.lock);
  const can = useCan();
  const kioskHold = useKioskHold();
  const qc = useQueryClient();
  const token = useAuth((s) => s.token);

  useEffect(() => startSyncLoop(), []);
  // Store-wide live events (held-sales count, new logo): one socket per register.
  useEffect(() => {
    if (!token) return;
    return subscribeStore((e) => {
      window.dispatchEvent(new CustomEvent('sr:store', { detail: e }));
      if (e.type === 'branding:changed') void qc.invalidateQueries({ queryKey: ['settings'] });
    });
  }, [token, qc]);

  const items = NAV.filter((n) => !n.perm || (Array.isArray(n.perm) ? n.perm.some(can) : can(n.perm)));

  return (
    <div className="flex h-full flex-col md:flex-row">
      {/* Rail */}
      <nav
        aria-label="Primary"
        className="order-last flex shrink-0 border-t border-line bg-ink md:order-first md:w-[88px] md:flex-col md:border-r md:border-t-0"
      >
        <div className="hidden h-[72px] items-center justify-center border-b border-line md:flex">
          <span className="grid h-12 w-[72px] select-none place-items-center" aria-label="Sync Retail" {...kioskHold}>
            <StoreLogo variant="rail" />
          </span>
        </div>
        <ul className="flex flex-1 justify-around overflow-x-auto md:flex-col md:justify-start md:gap-1 md:py-3">
          {items.map((n) => (
            <li key={n.to}>
              <NavLink
                to={n.to}
                end={n.to === '/inventory'}
                className={({ isActive }) =>
                  clsx(
                    'group relative flex flex-col items-center gap-1 px-2 py-2.5 transition-colors md:mx-2 md:rounded-sm md:py-3',
                    isActive ? 'text-amber md:bg-ink-3' : 'text-dust hover:text-bone',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <span
                      className={clsx(
                        'absolute -left-2 top-1/2 hidden h-6 w-[3px] -translate-y-1/2 rounded-r bg-amber transition-transform duration-300 ease-snap md:block',
                        isActive ? 'scale-y-100' : 'scale-y-0',
                      )}
                    />
                    <Icon name={n.icon} size={22} className="transition-transform duration-200 group-hover:-translate-y-0.5" />
                    <span className="font-mono text-[0.625rem] uppercase tracking-[0.12em]">{n.label}</span>
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="hidden flex-col items-center gap-3 border-t border-line py-4 md:flex">
          <SyncLamp />
          <button
            onClick={() => void openCustomerDisplay()}
            className="grid h-10 w-10 place-items-center rounded-sm text-dust transition-colors hover:bg-ink-3 hover:text-bone"
            title="Open customer display"
            aria-label="Open customer display"
          >
            <Icon name="monitor" size={20} />
          </button>
          <button
            onClick={lock}
            title={`${user.name} · ${ROLE_LABEL[user.role]} — lock & switch user`}
            aria-label="Lock terminal and switch user"
            className="group relative"
          >
            <Avatar name={user.name} color={user.color} size={40} className="transition-transform group-hover:scale-105" />
            <span className="absolute -bottom-1 -right-1 grid h-5 w-5 place-items-center rounded-full border border-line bg-ink text-dust group-hover:text-amber">
              <Icon name="lock" size={11} strokeWidth={2} />
            </span>
          </button>
        </div>
      </nav>

      {/* Mobile top bar */}
      <div className="flex items-center justify-between border-b border-line px-4 py-2 md:hidden">
        <StoreLogo variant="bar" />
        <div className="flex items-center gap-3">
          <SyncLamp />
          <button onClick={lock} aria-label="Lock terminal">
            <Avatar name={user.name} color={user.color} size={32} />
          </button>
        </div>
      </div>

      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}

function SyncLamp() {
  const { online, pending, failed, syncing } = useSyncStatus();
  const state = !online ? 'offline' : failed ? 'failed' : pending || syncing ? 'syncing' : 'online';
  const styles = {
    online: { dot: 'bg-mint', label: 'Online', text: 'All sales synced' },
    syncing: { dot: 'bg-amber animate-blink', label: `${pending}`, text: `${pending} sale(s) waiting to sync` },
    offline: { dot: 'bg-vermilion animate-blink', label: pending ? `${pending}` : 'Off', text: `Offline — ${pending} sale(s) queued locally` },
    failed: { dot: 'bg-vermilion', label: `${failed}!`, text: `${failed} sale(s) failed to sync — click to retry` },
  }[state];

  return (
    <button
      onClick={async () => {
        if (state === 'failed' || state === 'syncing') {
          const n = await retryFailed();
          toast.info(n ? `Synced ${n} sale(s)` : 'Nothing synced yet', styles.text);
        }
      }}
      title={styles.text}
      aria-label={styles.text}
      className="flex items-center gap-1.5 rounded-xs border border-line px-2 py-1"
    >
      <span className={clsx('h-2 w-2 rounded-full', styles.dot)} />
      <span className="font-mono text-[0.625rem] uppercase tracking-wider text-dust">{styles.label}</span>
    </button>
  );
}
