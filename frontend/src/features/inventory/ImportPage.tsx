import { useCallback, useMemo, useRef, useState, type DragEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import * as XLSX from 'xlsx';
import {
  IMPORT_FIELDS,
  missingRequiredFields,
  suggestMapping,
  validateImportRows,
  type ColumnMapping,
  type ImportMode,
  type RawRow,
  type ValidatedRow,
  type ValidationSummary,
} from '@sync-retail/shared';
import { api, errorMessage } from '@/lib/api';
import { fmtDate, useMoney } from '@/lib/format';
import { pullCatalog } from '@/lib/sync';
import { toast } from '@/store/toast';
import { Badge, Button, PageHeader, Segmented } from '@/components/ui/primitives';
import { Icon } from '@/components/ui/Icon';

type Step = 1 | 2 | 3 | 4;
interface Parsed {
  fileName: string;
  sheetName: string;
  headers: string[];
  rows: RawRow[];
}
interface CommitResult {
  batchId: string;
  created: number;
  updated: number;
  skipped: number;
  errors: { rowNumber: number; errors: string[] }[];
}

const STEPS = ['Upload', 'Map columns', 'Validate', 'Commit'];
const MAX_BYTES = 15 * 1024 * 1024;

export function ImportPage() {
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>(1);
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [mode, setMode] = useState<ImportMode>('upsert');
  const [validation, setValidation] = useState<{ rows: ValidatedRow[]; summary: ValidationSummary; server: boolean } | null>(null);
  const [result, setResult] = useState<CommitResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const history = useQuery({
    queryKey: ['import-history'],
    queryFn: () => api<{ id: string; fileName: string; created: number; updated: number; skipped: number; createdAt: string; user: { name: string } }[]>('/import/history'),
  });

  const readFile = async (file: File) => {
    setError(null);
    if (!/\.(csv|xlsx|xls)$/i.test(file.name)) return setError('Choose a .csv, .xlsx or .xls file.');
    if (file.size > MAX_BYTES) return setError('Files are limited to 15 MB.');
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { cellDates: true });
      const sheetName = wb.SheetNames[0];
      const sheet = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json<RawRow>(sheet, { defval: '', raw: false });
      const headers = ((XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, blankrows: false })[0] ?? []) as unknown[])
        .map((h) => String(h).trim())
        .filter(Boolean);
      if (!rows.length) return setError('That sheet has a header row but no data.');
      setParsed({ fileName: file.name, sheetName, headers, rows });
      setMapping(suggestMapping(headers));
      setValidation(null);
      setResult(null);
      setStep(2);
    } catch (err) {
      setError(`Couldn’t read that file: ${errorMessage(err)}`);
    }
  };

  /** Only send the mapped columns to the server. */
  const slimRows = useCallback(() => {
    if (!parsed || !mapping) return [];
    const cols = Object.values(mapping).filter((c): c is string => !!c);
    return parsed.rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
  }, [parsed, mapping]);

  const runValidation = async () => {
    if (!parsed || !mapping) return;
    // Instant local pass first (in-file problems), then the authoritative server pass.
    setValidation({ ...validateImportRows(parsed.rows, mapping, undefined, mode), server: false });
    setStep(3);
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ rows: ValidatedRow[]; summary: ValidationSummary }>('/import/validate', {
        method: 'POST',
        body: { rows: slimRows(), mapping, mode },
      });
      setValidation({ ...res, server: true });
    } catch (err) {
      setError(`Server validation failed — ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!parsed || !mapping) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<CommitResult>('/import/commit', {
        method: 'POST',
        body: { fileName: parsed.fileName, rows: slimRows(), mapping, mode },
      });
      setResult(res);
      setStep(4);
      toast.success('Import committed', `${res.created} created · ${res.updated} updated`);
      void qc.invalidateQueries({ queryKey: ['products'] });
      void qc.invalidateQueries({ queryKey: ['import-history'] });
      void pullCatalog();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setStep(1);
    setParsed(null);
    setMapping(null);
    setValidation(null);
    setResult(null);
    setError(null);
  };

  return (
    <div className="pb-16">
      <PageHeader eyebrow="Inventory · bulk import" title={<>Import <span className="italic text-amber">a spreadsheet</span></>}>
        <Button icon="download" onClick={downloadTemplate}>
          Template
        </Button>
      </PageHeader>

      {/* Step rail */}
      <ol className="grid grid-cols-4 border-b border-line">
        {STEPS.map((label, i) => {
          const n = (i + 1) as Step;
          const state = n < step ? 'done' : n === step ? 'current' : 'todo';
          return (
            <li key={label} className={clsx('relative border-r border-line px-4 py-4 last:border-r-0 lg:px-10', state === 'current' && 'bg-ink-2')}>
              <span className={clsx('display text-4xl leading-none md:text-5xl', state === 'todo' ? 'text-line-strong' : state === 'current' ? 'text-amber' : 'text-dust')}>
                {String(n).padStart(2, '0')}
              </span>
              <span className={clsx('mt-1 block text-sm', state === 'todo' ? 'text-dust' : 'text-bone')}>
                {label} {state === 'done' && <Icon name="check" size={14} className="inline text-mint" />}
              </span>
              {state === 'current' && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-amber" />}
            </li>
          );
        })}
      </ol>

      <div className="px-6 pt-8 lg:px-10">
        {error && (
          <div className="mb-6 flex items-start gap-3 rounded-sm border border-vermilion/50 bg-vermilion/10 p-3 text-sm text-vermilion" role="alert">
            <Icon name="alert" size={18} className="mt-0.5 shrink-0" /> {error}
          </div>
        )}

        {step === 1 && <Dropzone onFile={(f) => void readFile(f)} />}

        {step === 2 && parsed && mapping && (
          <MappingStep
            parsed={parsed}
            mapping={mapping}
            onChange={setMapping}
            mode={mode}
            onMode={setMode}
            onBack={reset}
            onNext={() => void runValidation()}
          />
        )}

        {step === 3 && validation && (
          <ValidationStep
            validation={validation}
            busy={busy}
            onBack={() => setStep(2)}
            onCommit={() => void commit()}
          />
        )}

        {step === 4 && result && (
          <div className="grid gap-8 lg:grid-cols-[1fr_1.2fr]">
            <div className="animate-rise">
              <p className="eyebrow mb-2 text-mint">Committed · batch {result.batchId.slice(-6)}</p>
              <h2 className="display text-6xl leading-[0.9]">
                {result.created + result.updated} products <span className="italic text-amber">on the shelf.</span>
              </h2>
              <div className="mt-8 grid grid-cols-3 gap-px overflow-hidden rounded-sm border border-line bg-line">
                <Tally n={result.created} label="Created" tone="text-mint" />
                <Tally n={result.updated} label="Updated" tone="text-sky" />
                <Tally n={result.skipped} label="Skipped" tone={result.skipped ? 'text-vermilion' : 'text-dust'} />
              </div>
              <Button variant="primary" className="mt-8" icon="upload" onClick={reset}>
                Import another file
              </Button>
            </div>
            {!!result.errors.length && (
              <div className="panel max-h-[28rem] overflow-y-auto p-4">
                <p className="eyebrow mb-3">Rows skipped</p>
                <ul className="space-y-2 text-sm">
                  {result.errors.map((e) => (
                    <li key={e.rowNumber}>
                      <span className="num mr-2 text-dust">Row {e.rowNumber}</span>
                      <span className="text-vermilion">{e.errors.join(' · ')}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {step === 1 && !!history.data?.length && (
          <section className="mt-12">
            <p className="eyebrow mb-3">Recent imports</p>
            <ul className="divide-y divide-line border-y border-line text-sm">
              {history.data.map((h) => (
                <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <span className="flex items-center gap-2">
                    <Icon name="file" size={16} className="text-dust" /> {h.fileName}
                  </span>
                  <span className="num text-dust">
                    +{h.created} · ~{h.updated} · ✕{h.skipped} — {h.user.name}, {fmtDate(h.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

// ─── Step 1 ─────────────────────────────────────────────────────────────────

function Dropzone({ onFile }: { onFile: (f: File) => void }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files[0];
    if (f) onFile(f);
  };
  return (
    <div
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
      aria-label="Upload a CSV or Excel file"
      className={clsx(
        'group relative grid min-h-[22rem] cursor-pointer place-items-center overflow-hidden rounded-md border-2 border-dashed transition-all duration-300',
        over ? 'scale-[1.01] border-amber bg-amber/5' : 'border-line-strong hover:border-dust',
      )}
    >
      <div className={clsx('absolute inset-0 transition-opacity', over ? 'hatch-amber opacity-100' : 'opacity-0')} />
      <div className="relative text-center">
        <div className="mx-auto mb-6 flex w-fit -space-x-4">
          {['CSV', 'XLSX', 'XLS'].map((ext, i) => (
            <span
              key={ext}
              className={clsx(
                'paper grid h-24 w-20 place-items-end rounded-sm p-2 font-mono text-xs font-bold shadow-lift transition-transform duration-300 ease-snap',
                i === 0 && '-rotate-6 group-hover:-rotate-12 group-hover:-translate-x-2',
                i === 1 && 'z-10 -translate-y-2 group-hover:-translate-y-5',
                i === 2 && 'rotate-6 group-hover:translate-x-2 group-hover:rotate-12',
              )}
            >
              .{ext.toLowerCase()}
            </span>
          ))}
        </div>
        <p className="display text-4xl">{over ? 'Let go — we’ll take it from here' : 'Drop a spreadsheet here'}</p>
        <p className="mt-2 text-dust">or click to browse · first sheet is used · up to 20,000 rows</p>
      </div>
      <input
        ref={input}
        type="file"
        accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
        className="hidden"
        onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
      />
    </div>
  );
}

// ─── Step 2 ─────────────────────────────────────────────────────────────────

function MappingStep({
  parsed,
  mapping,
  onChange,
  mode,
  onMode,
  onBack,
  onNext,
}: {
  parsed: Parsed;
  mapping: ColumnMapping;
  onChange: (m: ColumnMapping) => void;
  mode: ImportMode;
  onMode: (m: ImportMode) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const missing = missingRequiredFields(mapping);
  const sample = (col: string | null) =>
    col
      ? parsed.rows
          .slice(0, 3)
          .map((r) => String(r[col] ?? ''))
          .filter(Boolean)
          .join(' · ')
      : '';
  const used = new Set(Object.values(mapping).filter(Boolean));
  const unmapped = parsed.headers.filter((h) => !used.has(h));

  return (
    <div className="grid gap-8 xl:grid-cols-[1.4fr_1fr]">
      <div>
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-dust">
            <span className="text-bone">{parsed.fileName}</span> · sheet “{parsed.sheetName}” · <span className="num">{parsed.rows.length.toLocaleString()}</span> rows
          </p>
          <span className="eyebrow">We guessed what we could — check the arrows</span>
        </div>
        <ul className="divide-y divide-line border-y border-line">
          {IMPORT_FIELDS.map((f) => {
            const col = mapping[f.key];
            return (
              <li key={f.key} className="grid grid-cols-[1fr_auto_1.2fr] items-center gap-3 py-3">
                <div>
                  <p className="font-medium">
                    {f.label} {f.required && <span className="text-amber">*</span>}
                  </p>
                  <p className="num truncate text-xs text-dust">{sample(col) || (f.required ? 'Required' : 'Optional — leave unmapped to skip')}</p>
                </div>
                <Icon name="arrowLeft" size={18} className={col ? 'text-amber' : 'text-line-strong'} />
                <select
                  value={col ?? ''}
                  onChange={(e) => onChange({ ...mapping, [f.key]: e.target.value || null })}
                  className={clsx('field', f.required && !col && 'border-vermilion/60')}
                  aria-label={`Column for ${f.label}`}
                >
                  <option value="">— not mapped —</option>
                  {parsed.headers.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="space-y-6">
        <div className="panel p-5">
          <p className="eyebrow mb-3">When a SKU already exists</p>
          <Segmented<ImportMode>
            value={mode}
            onChange={onMode}
            options={[
              { value: 'upsert', label: 'Update it' },
              { value: 'createOnly', label: 'Flag as error' },
            ]}
          />
          <p className="mt-3 text-sm text-dust">
            {mode === 'upsert' ? 'Matching SKUs are updated with the values from the file; blank optional cells keep their current value.' : 'Only brand-new SKUs are imported.'}
          </p>
        </div>
        {!!unmapped.length && (
          <div>
            <p className="eyebrow mb-2">Ignored columns</p>
            <div className="flex flex-wrap gap-1.5">
              {unmapped.map((h) => (
                <Badge key={h}>{h}</Badge>
              ))}
            </div>
          </div>
        )}
        <div className="flex gap-2">
          <Button onClick={onBack} icon="arrowLeft">
            Different file
          </Button>
          <Button variant="primary" className="flex-1" disabled={!!missing.length} onClick={onNext} iconRight="arrowRight">
            {missing.length ? `Map ${missing.length} required field${missing.length > 1 ? 's' : ''}` : 'Validate rows'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Step 3 ─────────────────────────────────────────────────────────────────

function ValidationStep({
  validation,
  busy,
  onBack,
  onCommit,
}: {
  validation: { rows: ValidatedRow[]; summary: ValidationSummary; server: boolean };
  busy: boolean;
  onBack: () => void;
  onCommit: () => void;
}) {
  const money = useMoney();
  const [show, setShow] = useState<'all' | 'errors' | 'warnings'>('errors');
  const { summary } = validation;
  const rows = useMemo(
    () =>
      validation.rows.filter((r) => (show === 'errors' ? r.errors.length : show === 'warnings' ? r.warnings.length && !r.errors.length : true)).slice(0, 400),
    [validation.rows, show],
  );

  return (
    <div>
      <div className="mb-6 grid grid-cols-2 gap-px overflow-hidden rounded-sm border border-line bg-line md:grid-cols-5">
        <Tally n={summary.total} label="Rows" tone="text-bone" />
        <Tally n={summary.creates} label="New" tone="text-mint" />
        <Tally n={summary.updates} label="Updates" tone="text-sky" />
        <Tally n={summary.warnings} label="Warnings" tone="text-amber" />
        <Tally n={summary.invalid} label="Will skip" tone={summary.invalid ? 'text-vermilion' : 'text-dust'} />
      </div>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <Segmented
          size="sm"
          value={show}
          onChange={setShow}
          options={[
            { value: 'errors', label: `Errors (${summary.invalid})` },
            { value: 'warnings', label: 'Warnings' },
            { value: 'all', label: 'All rows' },
          ]}
        />
        <span className="flex items-center gap-2 text-xs text-dust">
          {busy ? (
            <>
              <span className="h-2 w-2 rounded-full bg-amber animate-blink" /> Checking against the live catalog…
            </>
          ) : validation.server ? (
            <>
              <Icon name="check" size={14} className="text-mint" /> Verified against the database
            </>
          ) : (
            'Local check only'
          )}
        </span>
      </div>

      <div className="paper overflow-x-auto rounded-sm">
        <table className="w-full min-w-[48rem] text-sm">
          <thead>
            <tr className="border-b-2 border-paper-ink text-left font-mono text-2xs uppercase tracking-widest text-paper-dim">
              <th className="px-3 py-2">Row</th>
              <th className="px-3 py-2">SKU</th>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2 text-right">Price</th>
              <th className="px-3 py-2 text-right">Stock</th>
              <th className="px-3 py-2">Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.rowNumber} className={clsx('border-b border-paper-rule align-top', r.errors.length && 'bg-vermilion/10')}>
                <td className="num px-3 py-2 text-paper-dim">{r.rowNumber}</td>
                <td className="num px-3 py-2">{r.preview.sku || <span className="text-paper-dim">(blank)</span>}</td>
                <td className="px-3 py-2">{r.preview.name || <span className="text-paper-dim">(blank)</span>}</td>
                <td className="num px-3 py-2 text-right">{r.data ? money(r.data.priceCents) : '—'}</td>
                <td className="num px-3 py-2 text-right">{r.data?.stockQty ?? '—'}</td>
                <td className="px-3 py-2">
                  <span
                    className={clsx(
                      'mr-2 inline-block rounded-xs px-1.5 font-mono text-2xs font-bold uppercase',
                      r.action === 'skip' ? 'bg-[#B3261E] text-white' : r.action === 'update' ? 'bg-paper-ink text-paper' : 'bg-[#1E6B34] text-white',
                    )}
                  >
                    {r.action}
                  </span>
                  {[...r.errors, ...r.warnings.filter((w) => !w.startsWith('Existing SKU'))].join(' · ')}
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-paper-dim">
                  {show === 'errors' ? 'No errors — every row is importable.' : 'Nothing to show.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <Button onClick={onBack} icon="arrowLeft">
          Back to mapping
        </Button>
        <Button variant="primary" size="lg" onClick={onCommit} loading={busy} disabled={!summary.valid || !validation.server} icon="upload">
          Commit {summary.valid.toLocaleString()} row{summary.valid === 1 ? '' : 's'}
          {summary.invalid ? `, skip ${summary.invalid}` : ''}
        </Button>
      </div>
    </div>
  );
}

const Tally = ({ n, label, tone }: { n: number; label: string; tone: string }) => (
  <div className="bg-ink-2 px-5 py-4">
    <p className={clsx('num text-3xl', tone)}>{n.toLocaleString()}</p>
    <p className="eyebrow mt-1">{label}</p>
  </div>
);

function downloadTemplate() {
  const ws = XLSX.utils.aoa_to_sheet([
    ['SKU', 'Barcode', 'Item Name', 'Category', 'Cost Price', 'Retail Price', 'Tax Rate', 'Stock Qty'],
    ['COF-0100', '012345678905', 'House Blend 250g', 'Coffee', '6.20', '12.50', '0%', 40],
    ['BAK-0200', '', 'Almond Croissant', 'Bakery', '1.10', '4.25', '8.25%', 24],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Products');
  XLSX.writeFile(wb, 'sync-retail-import-template.xlsx');
}
