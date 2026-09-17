import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';

/** Short, URL-safe, collision-resistant ids. Prefixed so logs are readable. */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('base64url')}`;
}

export function newRequestId(): string {
  return `req_${randomUUID()}`;
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Constant-time comparison for anything that behaves like a credential. */
export function safeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function newApiKey(): string {
  return `pk_${randomBytes(24).toString('base64url')}`;
}
