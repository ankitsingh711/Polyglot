/**
 * API client.
 *
 * Two things worth noting:
 *
 *  1. The tenant key travels in a header, never in a URL. That is why the
 *     streaming endpoints are POST + fetch rather than EventSource — EventSource
 *     cannot set headers, so using it would put a bearer credential into access
 *     logs and browser history.
 *  2. The key lives in localStorage for this take-home so the tenant switcher can
 *     demonstrate isolation. In production this would be a session cookie the
 *     page never reads.
 */

const TENANT_STORAGE_KEY = 'polyglot.tenantKey';

export function getTenantKey(): string {
  return localStorage.getItem(TENANT_STORAGE_KEY) ?? '';
}

export function setTenantKey(key: string): void {
  localStorage.setItem(TENANT_STORAGE_KEY, key.trim());
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

async function parseError(res: Response): Promise<ApiError> {
  let body: any;
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  const error = body?.error ?? {};
  return new ApiError(res.status, error.code ?? 'error', error.message ?? `Request failed (${res.status})`, error.details);
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init.body && !(init.body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
      'x-tenant-key': getTenantKey(),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * Read a POST-initiated SSE response.
 *
 * Hand-rolled for the same reason the server's parser is: frames arrive split
 * across network chunks, and the caller needs each event the moment it lands,
 * not when the response finishes.
 */
export async function streamSse(
  path: string,
  body: unknown,
  onEvent: (event: any) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-key': getTenantKey() },
    body: JSON.stringify(body),
    signal,
  });

  // Validation failures still come back as a normal status: the server checks
  // before flushing SSE headers precisely so this branch can exist.
  if (!res.ok) throw await parseError(res);
  if (!res.body) throw new ApiError(500, 'no_stream', 'The server did not return a stream.');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let index: number;
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        for (const line of raw.split('\n')) {
          if (!line.startsWith('data:')) continue; // skip ": ping" heartbeats
          const data = line.slice(5).trimStart();
          if (!data) continue;
          try {
            onEvent(JSON.parse(data));
          } catch {
            /* a malformed frame must not kill the stream */
          }
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value === 0) return '$0';
  if (value < 0.01) return `$${value.toFixed(6)}`;
  return `$${value.toFixed(4)}`;
}

export function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(2)}s`;
}

export function formatTokens(value: number | null | undefined): string {
  if (!value) return '0';
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}
