import { useEffect, useMemo } from 'react';
import clsx from 'clsx';
import { useQuery } from '@tanstack/react-query';
import { can, ROLE_LABEL, type Permission, type StaffTile } from '@sync-retail/shared';
import { api } from '@/lib/api';
import { Avatar } from './ui/primitives';
import { Icon } from './ui/Icon';

const STAFF_CACHE = 'sr-staff';

/** Active staff (same list and cache as the lock screen). */
export function useStaffTiles() {
  return useQuery({
    queryKey: ['staff'],
    queryFn: async () => {
      const s = await api<StaffTile[]>('/auth/staff', { token: null });
      localStorage.setItem(STAFF_CACHE, JSON.stringify(s));
      return s;
    },
    initialData: () => {
      try {
        return (JSON.parse(localStorage.getItem(STAFF_CACHE) ?? 'null') as StaffTile[] | null) ?? undefined;
      } catch {
        return undefined;
      }
    },
    staleTime: 60_000,
  });
}

interface Props {
  /** Only people whose role grants this can be chosen. */
  permission: Permission;
  value: StaffTile | null;
  onChange: (s: StaffTile | null) => void;
  tone?: 'amber' | 'vermilion';
}

/**
 * "Who is approving?" — managers and admins may share a PIN, so the approver
 * is picked first and only their PIN is checked. The log then names them.
 */
export function ApproverPicker({ permission, value, onChange, tone = 'amber' }: Props) {
  const staff = useStaffTiles();
  const eligible = useMemo(() => (staff.data ?? []).filter((s) => can(s.role, permission)), [staff.data, permission]);

  // Only one person can approve: skip the choice.
  useEffect(() => {
    if (!value && eligible.length === 1) onChange(eligible[0]);
  }, [eligible, value, onChange]);

  if (value) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-sm border border-line bg-ink p-2.5">
        <span className="flex min-w-0 items-center gap-3">
          <Avatar name={value.name} color={value.color} size={34} />
          <span className="min-w-0">
            <span className="block truncate font-medium text-bone">{value.name}</span>
            <span className="eyebrow">{ROLE_LABEL[value.role]}</span>
          </span>
        </span>
        {eligible.length > 1 && (
          <button type="button" onClick={() => onChange(null)} className="shrink-0 text-sm text-dust underline-offset-4 hover:text-bone hover:underline">
            Change
          </button>
        )}
      </div>
    );
  }

  if (staff.isLoading && !eligible.length) return <p className="eyebrow animate-blink text-center">Loading managers…</p>;
  if (!eligible.length) {
    return (
      <p className="flex items-center gap-2 text-sm text-vermilion" role="alert">
        <Icon name="alert" size={16} /> No manager or admin can approve this{staff.isError ? ' — can’t reach the server' : ''}.
      </p>
    );
  }
  return (
    <ul className="grid grid-cols-2 gap-2" aria-label="Choose the approving manager">
      {eligible.map((s) => (
        <li key={s.id}>
          <button
            type="button"
            onClick={() => onChange(s)}
            className={clsx(
              'flex w-full items-center gap-2.5 rounded-sm border border-line bg-ink-2 p-2.5 text-left transition-colors hover:bg-ink-3',
              tone === 'vermilion' ? 'hover:border-vermilion/60' : 'hover:border-amber/60',
            )}
          >
            <Avatar name={s.name} color={s.color} size={34} />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-bone">{s.name}</span>
              <span className="eyebrow">{ROLE_LABEL[s.role]}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
