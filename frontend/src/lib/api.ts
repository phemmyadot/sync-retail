import { getApiBase, getDeviceToken } from './config';
import { useDeviceStatus } from '@/store/device';
import { useAuth } from '@/store/auth';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
  }
  get overrideAction(): string | undefined {
    return this.code === 'OVERRIDE_REQUIRED' ? (this.details as { action?: string })?.action : undefined;
  }
}

/** Thrown when the API can't be reached at all — the caller may go offline-first. */
export class NetworkError extends Error {}

interface Options {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  overrideToken?: string | null;
  /** Use this bearer token instead of the current session's. */
  token?: string | null;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: Options['query']) {
  const url = `${getApiBase()}/api${path}`;
  if (!query) return url;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const s = qs.toString();
  return s ? `${url}?${s}` : url;
}

async function request(path: string, opts: Options): Promise<Response> {
  const token = opts.token !== undefined ? opts.token : useAuth.getState().token;
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.overrideToken) headers['X-Override-Token'] = opts.overrideToken;
  const device = getDeviceToken();
  if (device) headers['X-Device-Token'] = device;

  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new NetworkError('Cannot reach the server');
  }

  if (!res.ok) {
    let payload: { error?: { message?: string; code?: string; details?: unknown } } = {};
    try {
      payload = await res.json();
    } catch {
      /* non-JSON error */
    }
    if (res.status === 502 || res.status === 503 || res.status === 504) throw new NetworkError('Server unavailable');
    const e = payload.error ?? {};
    // This register was removed (or never paired) on the Main Register.
    if (res.status === 401 && (e.code === 'DEVICE_REVOKED' || e.code === 'DEVICE_REQUIRED')) useDeviceStatus.getState().setProblem(e.code);
    // Expired session on a normal request → bounce to the lock screen.
    if (res.status === 401 && !path.startsWith('/auth') && !path.startsWith('/overrides') && opts.token === undefined) {
      useAuth.getState().lock();
    }
    throw new ApiError(res.status, e.message ?? res.statusText, e.code, e.details);
  }
  return res;
}

export async function api<T>(path: string, opts: Options = {}): Promise<T> {
  const res = await request(path, opts);
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/** Downloads an export endpoint as a file, preserving the server's filename. */
export async function download(path: string, query?: Options['query']) {
  const res = await request(path, { query });
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const filename = /filename="?([^"]+)"?/.exec(disposition)?.[1] ?? 'export';
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const errorMessage = (err: unknown) =>
  err instanceof ApiError || err instanceof NetworkError ? err.message : err instanceof Error ? err.message : 'Something went wrong';
