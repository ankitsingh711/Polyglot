import type { ErrorKind, NormalizedProviderError } from './types.js';

/**
 * Which kinds are worth a retry. This is the single source of truth — the retry
 * policy reads it, the fallback chain reads it, and nothing else decides.
 *
 * Deliberately NOT retryable:
 *  - auth          retrying a bad key just burns the rate limit
 *  - bad_request   the request is wrong; it will be wrong again
 *  - context_length the payload is too big; only truncation fixes it
 *  - content_filter the model refused; retrying is a policy violation, not a fix
 *  - cancelled     the caller asked us to stop
 */
const RETRYABLE: ReadonlySet<ErrorKind> = new Set<ErrorKind>([
  'rate_limit',
  'server_error',
  'timeout',
]);

export function isRetryableKind(kind: ErrorKind): boolean {
  return RETRYABLE.has(kind);
}

export class ProviderError extends Error implements NormalizedProviderError {
  readonly kind: ErrorKind;
  readonly provider: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly status?: number;
  /** Raw upstream body/exception. Server-side logs only — see `toClient()`. */
  readonly raw?: unknown;

  constructor(opts: {
    kind: ErrorKind;
    provider: string;
    message: string;
    retryAfterMs?: number;
    status?: number;
    raw?: unknown;
    retryable?: boolean;
  }) {
    super(opts.message);
    this.name = 'ProviderError';
    this.kind = opts.kind;
    this.provider = opts.provider;
    this.retryable = opts.retryable ?? isRetryableKind(opts.kind);
    this.retryAfterMs = opts.retryAfterMs;
    this.status = opts.status;
    this.raw = opts.raw;
  }

  /**
   * The ONLY representation that may cross the network to a browser.
   * `raw` is dropped here on purpose: upstream bodies routinely echo the request,
   * and Anthropic/OpenAI error bodies have been known to include a key prefix.
   */
  toClient(): { kind: ErrorKind; provider: string; message: string; retryable: boolean } {
    return {
      kind: this.kind,
      provider: this.provider,
      message: this.message,
      retryable: this.retryable,
    };
  }
}

export function isProviderError(e: unknown): e is ProviderError {
  return e instanceof ProviderError;
}

/**
 * HTTP status → error kind, for the ~80% of cases where every vendor agrees.
 * Adapters override this when their vendor is more specific (e.g. Anthropic's
 * `invalid_request_error` with a "prompt is too long" message is context_length,
 * not bad_request).
 */
export function kindFromStatus(status: number): ErrorKind {
  if (status === 400 || status === 404 || status === 422) return 'bad_request';
  if (status === 401 || status === 403) return 'auth';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server_error';
  return 'server_error';
}

/**
 * `Retry-After` is either delta-seconds or an HTTP-date (RFC 9110 §10.2.3).
 * Anthropic and OpenAI send seconds; some CDN-fronted 429s send a date.
 * Groq additionally sends `retry-after` as a float ("1.5").
 */
export function parseRetryAfter(headers: Headers, now = Date.now()): number | undefined {
  const raw = headers.get('retry-after') ?? headers.get('x-ratelimit-reset-requests');
  if (!raw) return undefined;
  const trimmed = raw.trim();

  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber) && asNumber >= 0) return Math.round(asNumber * 1000);

  // OpenAI/Groq also use durations like "6m0s" or "1.5s" on reset headers.
  const duration = /^(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(trimmed);
  if (duration && (duration[1] || duration[2])) {
    const minutes = Number(duration[1] ?? 0);
    const seconds = Number(duration[2] ?? 0);
    return Math.round((minutes * 60 + seconds) * 1000);
  }

  const asDate = Date.parse(trimmed);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - now);

  return undefined;
}

/** Normalize anything thrown by `fetch` or by our own timeout/abort plumbing. */
export function normalizeTransportError(provider: string, err: unknown): ProviderError {
  if (isProviderError(err)) return err;

  const e = err as { name?: string; message?: string; cause?: { code?: string } };
  const name = e?.name ?? '';
  const code = e?.cause?.code ?? '';

  if (name === 'TimeoutError' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') {
    return new ProviderError({
      kind: 'timeout',
      provider,
      message: `${provider}: upstream request timed out`,
      raw: err,
    });
  }
  if (name === 'AbortError') {
    return new ProviderError({
      kind: 'cancelled',
      provider,
      message: `${provider}: request cancelled`,
      retryable: false,
      raw: err,
    });
  }
  if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EAI_AGAIN') {
    return new ProviderError({
      kind: 'server_error',
      provider,
      message: `${provider}: network error (${code})`,
      raw: err,
    });
  }
  return new ProviderError({
    kind: 'server_error',
    provider,
    message: `${provider}: ${e?.message ?? 'unknown transport failure'}`,
    raw: err,
  });
}

/** Application-level (non-provider) failures that still need a clean HTTP shape. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
