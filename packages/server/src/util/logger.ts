import { maybeTenant } from '../tenancy/context.js';

/**
 * Structured JSON logging with two rules:
 *  1. every line carries the tenant and request id when there is one, so a leak
 *     investigation is a single query rather than an archaeology project;
 *  2. values are redacted on the way out. Provider error bodies and request
 *     payloads routinely contain the very things you must not log.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? LEVELS.info;

const SECRET_KEY = /(api[-_]?key|authorization|x-api-key|x-goog-api-key|token|secret|password|cookie|bearer)/i;
/** Key prefixes used by the vendors we talk to. */
const KEY_SHAPES = /\b(sk-[A-Za-z0-9_\-]{12,}|sk-ant-[A-Za-z0-9_\-]{12,}|AIza[A-Za-z0-9_\-]{20,}|gsk_[A-Za-z0-9]{20,}|pk_[A-Za-z0-9]{12,})\b/g;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (typeof value === 'string') return value.replace(KEY_SHAPES, '[redacted-key]').slice(0, 4000);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function emit(level: Level, event: string, data?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const ctx = maybeTenant();
  const line = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(ctx ? { tenantId: ctx.tenantId, requestId: ctx.requestId } : {}),
    ...(data ? (redact(data) as Record<string, unknown>) : {}),
  };
  const target = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  target.write(`${JSON.stringify(line)}\n`);
}

export const logger = {
  debug: (event: string, data?: Record<string, unknown>) => emit('debug', event, data),
  info: (event: string, data?: Record<string, unknown>) => emit('info', event, data),
  warn: (event: string, data?: Record<string, unknown>) => emit('warn', event, data),
  error: (event: string, data?: Record<string, unknown>) => emit('error', event, data),
};
