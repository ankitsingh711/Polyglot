import { appConfig } from './config.js';
import { ProviderError, isProviderError } from './errors.js';
import type { ErrorKind } from './types.js';

/**
 * Retry with exponential backoff and jitter.
 *
 * Two rules, both from config/app.json so they can be tuned without a deploy:
 *  - only the kinds in `retry.retryOn` are ever retried (rate_limit, server_error,
 *    timeout). `auth` and `bad_request` are permanent by definition, and retrying
 *    a `content_filter` is a policy violation rather than a fix.
 *  - when the provider tells us how long to wait, we believe it, but we cap it
 *    (`maxRetryAfterMs`) so one provider's "try again in 6 minutes" cannot pin a
 *    request open past its own timeout budget.
 *
 * Jitter is FULL jitter (`random(0, backoff)`) rather than a fixed ±10%: with a
 * fallback chain and several tenants, correlated retries are the failure mode
 * that turns one provider blip into a self-inflicted thundering herd.
 */

export interface RetryAttemptInfo {
  attempt: number;
  delayMs: number;
  error: ProviderError;
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: 'none' | 'full' | 'equal';
  retryOn: ErrorKind[];
  respectRetryAfter: boolean;
  maxRetryAfterMs: number;
}

export function defaultRetryPolicy(): RetryPolicy {
  const r = appConfig().retry;
  return {
    maxAttempts: r.maxAttempts,
    baseDelayMs: r.baseDelayMs,
    maxDelayMs: r.maxDelayMs,
    jitter: r.jitter,
    retryOn: r.retryOn as ErrorKind[],
    respectRetryAfter: r.respectRetryAfter,
    maxRetryAfterMs: r.maxRetryAfterMs,
  };
}

export function computeBackoff(
  attempt: number,
  policy: RetryPolicy,
  retryAfterMs: number | undefined,
  random: () => number = Math.random,
): number {
  if (policy.respectRetryAfter && retryAfterMs !== undefined && retryAfterMs >= 0) {
    return Math.min(retryAfterMs, policy.maxRetryAfterMs);
  }
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  switch (policy.jitter) {
    case 'none': return exponential;
    case 'equal': return exponential / 2 + random() * (exponential / 2);
    case 'full':
    default: return random() * exponential;
  }
}

export function shouldRetry(err: unknown, policy: RetryPolicy): err is ProviderError {
  if (!isProviderError(err)) return false;
  if (!err.retryable) return false;
  return policy.retryOn.includes(err.kind);
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });

export interface WithRetryOptions {
  policy?: RetryPolicy;
  signal?: AbortSignal;
  onRetry?: (info: RetryAttemptInfo) => void;
  random?: () => number;
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: WithRetryOptions = {}): Promise<T> {
  const policy = opts.policy ?? defaultRetryPolicy();
  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt >= policy.maxAttempts || !shouldRetry(err, policy)) throw err;
      const delayMs = computeBackoff(attempt, policy, err.retryAfterMs, opts.random);
      opts.onRetry?.({ attempt, delayMs, error: err });
      await sleep(delayMs, opts.signal);
    }
  }
  throw lastError;
}
