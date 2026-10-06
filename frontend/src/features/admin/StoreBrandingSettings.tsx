import { useEffect, useRef, useState, type DragEvent } from 'react';
import clsx from 'clsx';
import { useQueryClient } from '@tanstack/react-query';
import { LOGO_RULES } from '@sync-retail/shared';
import { api, assetUrl, errorMessage } from '@/lib/api';
import { useSettings } from '@/hooks/useSettings';
import { toast } from '@/store/toast';
import { validateLogo, type LogoCheck } from '@/utils/validateLogo';
import { StoreLogo } from '@/components/layout/StoreLogo';
import { Button } from '@/components/ui/primitives';
import { Icon } from '@/components/ui/Icon';

/** Admin → Store & loyalty → Branding: upload, preview and remove the store logo. */
export function StoreBrandingSettings() {
  const qc = useQueryClient();
  const { data: settings } = useSettings();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [check, setCheck] = useState<LogoCheck | null>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => () => void (check?.previewUrl && URL.revokeObjectURL(check.previewUrl)), [check]);

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setFile(f);
    setCheck(await validateLogo(f));
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void pick(e.dataTransfer.files[0]);
  };
  const reset = () => {
    setFile(null);
    setCheck(null);
    if (input.current) input.current.value = '';
  };
  const refresh = () => qc.invalidateQueries({ queryKey: ['settings'] });

  const upload = async () => {
    if (!file || !check?.ok) return;
    setBusy(true);
    try {
      await api('/branding/logo', { method: 'PUT', file: new Blob([await file.arrayBuffer()], { type: { png: 'image/png', jpeg: 'image/jpeg', svg: 'image/svg+xml' }[check.type!] }) });
      await refresh();
      reset();
      toast.success('Logo updated', 'Every register shows it now.');
    } catch (err) {
      toast.error('Logo not saved', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api('/branding/logo', { method: 'DELETE' });
      await refresh();
      toast.info('Logo removed', 'Registers show the Sr mark again.');
    } catch (err) {
      toast.error('Couldn’t remove the logo', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // Preview: the candidate if it passed, otherwise what registers show today.
  const previewSrc = check?.ok ? check.previewUrl! : settings?.logoUrl ? assetUrl(settings.logoUrl) : null;
  const R = LOGO_RULES;

  return (
    <section className="space-y-4 lg:col-span-2">
      <h2 className="display text-3xl">Branding</h2>
      <div className="grid gap-6 md:grid-cols-[1.2fr_1fr]">
        <div>
          <div
            data-allow-drop
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={onDrop}
            onClick={() => input.current?.click()}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
            role="button"
            tabIndex={0}
            aria-label="Choose a logo file"
            className={clsx(
              'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-sm border border-dashed px-6 py-8 text-center transition-colors',
              over ? 'border-amber bg-amber/5' : 'border-line-strong hover:border-bone/60',
            )}
          >
            <Icon name="upload" size={26} className="text-dust" />
            <p className="text-bone">{file ? file.name : 'Drop your logo here, or click to choose'}</p>
            <p className="text-xs text-dust">
              PNG, JPEG or SVG · up to {R.maxBytes / 1024} KB · square to 4:1 wide · {R.minPx}–{R.maxPx} px each side (PNG/JPEG)
            </p>
            <input ref={input} type="file" accept="image/png,image/jpeg,image/svg+xml,.png,.jpg,.jpeg,.svg" className="hidden" onChange={(e) => void pick(e.target.files?.[0])} />
          </div>
          {check && (
            <p className={clsx('mt-3 flex items-start gap-2 text-sm', check.ok ? 'text-mint' : 'text-vermilion')} role={check.ok ? 'status' : 'alert'}>
              <Icon name={check.ok ? 'check' : 'alert'} size={16} className="mt-0.5 shrink-0" />
              <span>
                {check.ok
                  ? `Looks good: ${check.type?.toUpperCase()} ${Math.round(check.width!)}×${Math.round(check.height!)}${check.type === 'svg' ? ' (vector)' : ''}.`
                  : check.error}
              </span>
            </p>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="primary" icon="upload" disabled={!check?.ok} loading={busy && !!check?.ok} onClick={() => void upload()}>
              Use this logo
            </Button>
            {file && (
              <Button variant="quiet" onClick={reset}>
                Cancel
              </Button>
            )}
            {settings?.logoUrl && !file && (
              <Button variant="danger" icon="trash" loading={busy} onClick={() => void remove()}>
                Remove logo
              </Button>
            )}
          </div>
        </div>

        <div>
          <p className="eyebrow mb-2">{check?.ok ? 'Preview' : settings?.logoUrl ? 'Current logo' : 'Current: default mark'}</p>
          <div className="flex items-start gap-4">
            {/* Mirrors the navigation rail's top-left corner. */}
            <div className="w-[88px] shrink-0 overflow-hidden rounded-sm border border-line bg-ink" aria-label="Navigation preview">
              <div className="flex h-[72px] items-center justify-center border-b border-line">
                <StoreLogo variant="rail" src={previewSrc} />
              </div>
              <div className="space-y-2 p-3">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="mx-auto h-2 w-8 rounded-full bg-ink-3" />
                ))}
              </div>
            </div>
            {/* Mobile top bar. */}
            <div className="min-w-0 flex-1 rounded-sm border border-line bg-ink px-3 py-2" aria-label="Mobile preview">
              <div className="flex items-center justify-between">
                <StoreLogo variant="bar" src={previewSrc} />
                <span className="h-6 w-6 rounded-full bg-ink-3" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
