import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { assetUrl } from '@/lib/api';
import { useSettings } from '@/hooks/useSettings';

const SLOTS = {
  /** Desktop navigation rail, top-left. */
  rail: { box: 'h-10 w-[72px]', mark: 'text-3xl' },
  /** Mobile top bar. */
  bar: { box: 'h-7 w-28 justify-start', mark: 'text-2xl' },
} as const;

/** The store's logo, or the default "Sr" mark when there is none (or it can't load). */
export function StoreLogo({ variant, src }: { variant: keyof typeof SLOTS; /** Preview override. */ src?: string | null }) {
  const { data: settings } = useSettings();
  const url = src !== undefined ? src : settings?.logoUrl ? assetUrl(settings.logoUrl) : null;
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  const slot = SLOTS[variant];

  if (!url || failed) {
    return (
      <span className={clsx('display italic text-amber', slot.mark)}>
        S<span className="text-bone">r</span>
      </span>
    );
  }
  return (
    <span className={clsx('flex items-center justify-center', slot.box)}>
      <img src={url} alt={settings?.storeName ?? 'Store logo'} className="max-h-full max-w-full object-contain" draggable={false} onError={() => setFailed(true)} />
    </span>
  );
}
