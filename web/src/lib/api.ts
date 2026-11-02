/**
 * Thin fetch wrapper. The API speaks { data, nextCursor } / { data } / { error: { code, message, details } }.
 * The bearer token lives in memory and is mirrored to sessionStorage so a reload keeps the session
 * but closing the tab ends it.
 */

const STORE_KEY = 'gw.token';

let memoryToken: string | null = null;
try {
  memoryToken = sessionStorage.getItem(STORE_KEY);
} catch {
  memoryToken = null;
}

export const tokenStore = {
  get: () => memoryToken,
  set(t: string | null) {
    memoryToken = t;
    try {
      if (t) sessionStorage.setItem(STORE_KEY, t);
      else sessionStorage.removeItem(STORE_KEY);
    } catch {
      /* storage can be blocked; the in-memory copy still works */
    }
  },
};

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** A validation problem found in the browser before anything is sent. Its message is already written for the user. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

/** Anything thrown becomes a sentence a person can read. Never a stack, never "[object Object]". */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError || e instanceof UserError) return e.message;
  return 'Something went wrong. Try again, and if it keeps happening tell an administrator.';
}

let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: (() => void) | null) => {
  onUnauthorized = fn;
};

export type Query = Record<string, string | number | boolean | null | undefined>;

function qs(params?: Query): string {
  if (!params) return '';
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    u.set(k, String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : '';
}

export interface Reply<T> {
  status: number;
  body: T;
}

async function send<T>(method: string, path: string, opts: { query?: Query; body?: unknown } = {}): Promise<Reply<T>> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = tokenStore.get();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(`/api/v1${path}${qs(opts.query)}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch {
    throw new ApiError(0, 'network', 'Cannot reach the server. Check your connection and try again.');
  }

  let parsed: any = null;
  const text = await res.text();
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!res.ok) {
    const err = parsed?.error;
    if (res.status === 401 && path !== '/auth/login') onUnauthorized?.();
    throw new ApiError(
      res.status,
      err?.code ?? `http_${res.status}`,
      err?.message ??
        (res.status >= 500
          ? 'The server could not complete that. Try again in a moment.'
          : `The request was refused (${res.status}).`),
      err?.details,
    );
  }
  return { status: res.status, body: parsed as T };
}

export const api = {
  get: async <T>(path: string, query?: Query) => (await send<T>('GET', path, { query })).body,
  post: async <T>(path: string, body?: unknown) => (await send<T>('POST', path, { body: body ?? {} })).body,
  postFull: <T>(path: string, body?: unknown) => send<T>('POST', path, { body: body ?? {} }),
  patch: async <T>(path: string, body: unknown) => (await send<T>('PATCH', path, { body })).body,
  put: async <T>(path: string, body: unknown) => (await send<T>('PUT', path, { body })).body,
  del: async <T>(path: string, query?: Query) => (await send<T>('DELETE', path, { query })).body,
};

/** Fetches a binary document with the bearer token and hands it to the browser. */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const token = tokenStore.get();
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  } catch {
    throw new ApiError(0, 'network', 'Cannot reach the server. Check your connection and try again.');
  }
  if (!res.ok) {
    let msg = `The document could not be produced (${res.status}).`;
    let code = `http_${res.status}`;
    try {
      const j = await res.json();
      if (j?.error?.message) msg = j.error.message;
      if (j?.error?.code) code = j.error.code;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, code, msg);
  }
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') ?? '';
  const name = /filename="?([^";]+)"?/.exec(cd)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * Fetches a document the server renders as HTML and shows it in a new tab. The tab is opened
 * synchronously, before the request, so the browser does not treat it as a pop-up.
 */
export async function openDocument(path: string): Promise<void> {
  const tab = window.open('', '_blank');
  const token = tokenStore.get();
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  } catch {
    tab?.close();
    throw new ApiError(0, 'network', 'Cannot reach the server. Check your connection and try again.');
  }
  if (!res.ok) {
    tab?.close();
    let msg = `The document could not be produced (${res.status}).`;
    let code = `http_${res.status}`;
    try {
      const j = await res.json();
      if (j?.error?.message) msg = j.error.message;
      if (j?.error?.code) code = j.error.code;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, code, msg);
  }
  const url = URL.createObjectURL(await res.blob());
  if (tab) tab.location.href = url;
  else window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}
export interface One<T> {
  data: T;
}
