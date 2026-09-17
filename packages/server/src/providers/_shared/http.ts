import { ProviderError, normalizeTransportError, parseRetryAfter, kindFromStatus } from '../../core/errors.js';
import type { ErrorKind } from '../../core/types.js';

/**
 * The one place adapters talk to the network.
 *
 * Responsibilities:
 *  - merge the caller's AbortSignal with a per-request timeout, so cancellation
 *    genuinely tears down the upstream socket;
 *  - never let a non-2xx body escape as a raw object;
 *  - hand each adapter the parsed error body so it can apply vendor-specific
 *    classification on top of the generic status mapping.
 */

export interface UpstreamErrorContext {
  status: number;
  headers: Headers;
  /** Parsed JSON body when the upstream sent JSON, else the raw text. */
  body: unknown;
  text: string;
}

export interface PostJsonOptions {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal?: AbortSignal;
  timeoutMs: number;
  provider: string;
  fetchImpl: typeof fetch;
  /** Vendor-specific refinement of the generic status→kind mapping. */
  classify?: (ctx: UpstreamErrorContext) => { kind: ErrorKind; message: string } | undefined;
  method?: 'POST' | 'GET';
}

function mergeSignals(caller: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!caller) return { signal: timeout, dispose: () => {} };
  // AbortSignal.any propagates the *reason* of whichever fired, which is how we
  // keep "user pressed stop" (AbortError) distinct from "we ran out of time"
  // (TimeoutError) all the way into the normalized error taxonomy.
  const signal = AbortSignal.any([caller, timeout]);
  return { signal, dispose: () => {} };
}

function extractMessage(body: unknown, fallback: string): string {
  if (typeof body === 'string' && body.trim()) return body.slice(0, 500);
  if (body && typeof body === 'object') {
    const b = body as Record<string, any>;
    const candidates = [
      b.error?.message,
      b.error?.msg,
      b.message,
      b.detail,
      Array.isArray(b.error) ? b.error[0]?.message : undefined,
      b.error?.status,
    ];
    for (const c of candidates) if (typeof c === 'string' && c.trim()) return c.slice(0, 500);
  }
  return fallback;
}

export async function requestUpstream(opts: PostJsonOptions): Promise<Response> {
  const { signal, dispose } = mergeSignals(opts.signal, opts.timeoutMs);
  let res: Response;
  try {
    res = await opts.fetchImpl(opts.url, {
      method: opts.method ?? 'POST',
      headers: opts.headers,
      body: opts.method === 'GET' ? undefined : JSON.stringify(opts.body),
      signal,
    });
  } catch (err) {
    dispose();
    throw normalizeTransportError(opts.provider, err);
  }

  if (res.ok) return res;

  // Drain the error body once, defensively: some gateways send HTML on a 502.
  const text = await res.text().catch(() => '');
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : text;
  } catch {
    /* keep the raw text */
  }

  const ctx: UpstreamErrorContext = { status: res.status, headers: res.headers, body: parsed, text };
  const refined = opts.classify?.(ctx);
  const kind = refined?.kind ?? kindFromStatus(res.status);
  const message =
    refined?.message ??
    extractMessage(parsed, `${opts.provider}: upstream returned HTTP ${res.status}`);

  throw new ProviderError({
    kind,
    provider: opts.provider,
    message: `${opts.provider}: ${message}`,
    status: res.status,
    retryAfterMs: parseRetryAfter(res.headers),
    raw: { status: res.status, body: parsed },
  });
}

export async function postJson<T>(opts: PostJsonOptions): Promise<T> {
  const res = await requestUpstream(opts);
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError({
      kind: 'server_error',
      provider: opts.provider,
      message: `${opts.provider}: upstream returned a non-JSON body`,
      raw: text.slice(0, 2000),
    });
  }
}

/** Returns the response body stream for SSE consumption, with the same guarantees. */
export async function postStream(opts: PostJsonOptions): Promise<Response> {
  const res = await requestUpstream(opts);
  if (!res.body) {
    throw new ProviderError({
      kind: 'server_error',
      provider: opts.provider,
      message: `${opts.provider}: upstream returned an empty stream`,
    });
  }
  return res;
}
