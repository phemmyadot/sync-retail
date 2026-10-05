import { formatMoney } from '@sync-retail/shared';
import { useSettings } from '@/hooks/useSettings';

/** Money formatter bound to the store's currency/locale. */
export function useMoney() {
  const { data } = useSettings();
  const currency = data?.currency ?? 'USD';
  const locale = data?.locale ?? 'en-US';
  return (cents: number) => formatMoney(cents, currency, locale);
}

export const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export const fmtDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

export const fmtInt = (n: number) => n.toLocaleString();

/** Cents ↔ "12.34" for editable inputs. */
export const centsToInput = (c: number) => (c / 100).toFixed(2);
export const inputToCents = (s: string) => {
  const n = Number(s.replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
