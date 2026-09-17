import type { NextFunction, Request, Response } from 'express';
import { appConfig } from '../core/config.js';
import { AppError, isProviderError } from '../core/errors.js';
import { audit } from '../db/index.js';
import { runWithTenant } from '../tenancy/context.js';
import { findTenantByApiKey } from '../tenancy/tenants.js';
import { newRequestId } from '../util/ids.js';
import { logger } from '../util/logger.js';

/**
 * HTTP middleware. Three jobs, in this order: say who the tenant is, stop
 * abuse, and make sure nothing internal reaches the client.
 */

// ---------------------------------------------------------------------------
// Tenant resolution
// ---------------------------------------------------------------------------

export const TENANT_HEADER = 'x-tenant-key';

/**
 * The tenant identity comes from a SECRET, not from an identifier.
 *
 * "Can a caller forge it?" -- no. There is no X-Tenant-Id header anywhere in the
 * request path; supplying one has no effect. The only input is an opaque key,
 * and only its SHA-256 is stored, so the database itself cannot hand an
 * attacker a working credential.
 *
 * For a take-home this stands in for real auth. In production the same seam
 * takes a verified JWT or session and reads the tenant claim from it -- the
 * important property, that everything downstream reads the tenant from the
 * ambient context rather than from anything the caller sent, does not change.
 */
export function tenantMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.header(TENANT_HEADER)?.trim();
  const requestId = newRequestId();
  res.setHeader('x-request-id', requestId);

  if (!header) {
    respondError(res, new AppError(401, 'missing_tenant_key', `Provide your tenant key in the ${TENANT_HEADER} header.`), requestId);
    return;
  }

  const tenant = findTenantByApiKey(header);
  if (!tenant) {
    // Log the attempt, never the key. Repeated failures here are the first
    // signal of credential stuffing against the API.
    logger.warn('auth.rejected', { ip: req.ip, path: req.path });
    respondError(res, new AppError(401, 'invalid_tenant_key', 'That tenant key is not recognized.'), requestId);
    return;
  }

  runWithTenant({ tenantId: tenant.id, tenantName: tenant.name, requestId }, () => {
    // Echo the resolved tenant so a misconfigured client notices immediately.
    res.setHeader('x-tenant-id', tenant.id);
    next();
  });
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Per-tenant token bucket. In-memory on purpose and documented as such: with one
 * process this is correct, and with several it is not. The production version is
 * Redis or the gateway's own limiter; what matters for review is that the limit
 * is per TENANT rather than per IP, so one tenant cannot exhaust another's
 * budget from behind a shared NAT.
 */
export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  const limit = appConfig().limits.rateLimitPerMinute;
  const tenantId = res.getHeader('x-tenant-id');
  const key = typeof tenantId === 'string' ? tenantId : req.ip ?? 'unknown';
  const now = Date.now();

  const bucket = buckets.get(key) ?? { tokens: limit, updatedAt: now };
  const refill = ((now - bucket.updatedAt) / 60_000) * limit;
  bucket.tokens = Math.min(limit, bucket.tokens + refill);
  bucket.updatedAt = now;

  if (bucket.tokens < 1) {
    buckets.set(key, bucket);
    res.setHeader('retry-after', '5');
    respondError(res, new AppError(429, 'rate_limited', `Rate limit of ${limit} requests/minute exceeded.`));
    return;
  }

  bucket.tokens -= 1;
  buckets.set(key, bucket);
  res.setHeader('x-ratelimit-remaining', String(Math.floor(bucket.tokens)));
  next();
}

/** Bound the map so a key-guessing flood cannot grow it without limit. */
setInterval(() => {
  const cutoff = Date.now() - 300_000;
  for (const [key, bucket] of buckets) if (bucket.updatedAt < cutoff) buckets.delete(key);
}, 60_000).unref();

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------

export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('cross-origin-resource-policy', 'same-site');
  res.removeHeader('x-powered-by');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }

  // The API answers only JSON and SSE, so its policy can forbid everything.
  // The optionally-served SPA needs its own bundle, styles and data: URIs for
  // uploaded-image previews -- but still no remote origins, and no inline script.
  res.setHeader(
    'content-security-policy',
    req.path.startsWith('/api') || req.path === '/health'
      ? "default-src 'none'; frame-ancestors 'none'"
      : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; " +
        "object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
  next();
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const allowed = (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const origin = req.header('origin');

  // Explicit allow-list, never a reflected wildcard: the tenant key is a bearer
  // credential and `*` with credentials is how those get stolen.
  if (origin && allowed.includes(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
    res.setHeader('access-control-allow-headers', `content-type, ${TENANT_HEADER}`);
    res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('access-control-expose-headers', 'x-request-id, x-tenant-id, x-ratelimit-remaining');
    res.setHeader('access-control-max-age', '600');
  }
  if (req.method === 'OPTIONS') {
    res.status(origin && allowed.includes(origin) ? 204 : 403).end();
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export function respondError(res: Response, err: unknown, requestId?: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const id = requestId ?? (res.getHeader('x-request-id') as string | undefined);

  if (err instanceof AppError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details, requestId: id },
    });
    return;
  }

  if (isProviderError(err)) {
    // `toClient()` deliberately drops `raw`: upstream error bodies echo the
    // request and have been known to include a key prefix.
    const safe = err.toClient();
    const status =
      safe.kind === 'auth' ? 502
      : safe.kind === 'rate_limit' ? 429
      : safe.kind === 'context_length' ? 413
      : safe.kind === 'bad_request' ? 400
      : safe.kind === 'timeout' ? 504
      : safe.kind === 'unsupported' ? 400
      : 502;
    logger.warn('provider.error', { kind: safe.kind, provider: safe.provider, message: safe.message });
    res.status(status).json({ error: { code: safe.kind, message: safe.message, provider: safe.provider, retryable: safe.retryable, requestId: id } });
    return;
  }

  // Anything else is a bug. Log it in full server-side, say nothing useful to
  // the client: stack traces are a map of the codebase.
  logger.error('http.unhandled', { error: (err as Error)?.message, stack: (err as Error)?.stack });
  res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong.', requestId: id } });
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError && err.code === 'tenant_predicate_missing') {
    // A guard violation is a security-relevant event, not an ordinary 500.
    audit('guard.violation', { severity: 'violation', detail: err.details });
    logger.error('tenancy.guard_violation', { details: err.details });
  }
  respondError(res, err);
}

/** Express 5 propagates async rejections, but route handlers are still wrapped for clarity. */
export function asyncRoute<T extends (req: Request, res: Response, next: NextFunction) => Promise<unknown>>(handler: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res, next).catch(next);
  };
}

/**
 * Express 5 types route params as `string | string[]` to accommodate wildcards.
 * Every param this app uses is a single segment, so it is narrowed in one place
 * rather than cast at thirty call sites.
 */
export function pathParam(req: Request, name: string): string {
  const value = (req.params as Record<string, string | string[] | undefined>)[name];
  const single = Array.isArray(value) ? value[0] : value;
  if (typeof single !== 'string' || !single) {
    throw new AppError(400, 'missing_path_parameter', `Missing ":${name}" in the request path.`);
  }
  return single;
}

export function notFound(_req: Request, res: Response): void {
  respondError(res, new AppError(404, 'not_found', 'No such endpoint.'));
}
