import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { REPO_ROOT } from '../core/config.js';
import { AppError } from '../core/errors.js';
import { assertTenantScoped, GLOBAL_TABLES, referencedTables, TENANT_PARAM } from '../tenancy/guard.js';
import { currentTenant, maybeTenant } from '../tenancy/context.js';
import { logger } from '../util/logger.js';

/**
 * Data access.
 *
 * There are exactly two doors into the database and both are guarded:
 *
 *   globalDb()    — may touch ONLY tables classified global (tenants, migrations).
 *   forTenant()   — may touch tenant-scoped tables, and every statement must
 *                   carry `tenant_id = :tenant_id`, which this layer binds from
 *                   the ambient context. The caller cannot supply it.
 *
 * The raw better-sqlite3 handle is module-private. Nothing outside this file can
 * reach it, so "I'll just use the raw connection for this one query" is not a
 * shortcut that exists.
 */

type Params = Record<string, unknown>;

let db: Database.Database | null = null;

/** SQLite's in-memory sentinel. NOT a path, and must never be resolved as one. */
const IN_MEMORY = ':memory:';

export function databasePath(): string {
  const configured = process.env.DATABASE_PATH?.trim();
  if (!configured) return join(REPO_ROOT, 'data', 'polyglot.sqlite');
  // `resolve(':memory:')` yields `<cwd>/:memory:`, which SQLite happily creates
  // as a real file -- so the tests were silently writing to disk instead of RAM.
  return configured === IN_MEMORY ? IN_MEMORY : resolve(configured);
}

function connect(): Database.Database {
  const path = databasePath();
  if (path !== IN_MEMORY) mkdirSync(dirname(path), { recursive: true });

  const handle = new Database(path);
  // WAL so a long ingestion does not block chat reads.
  handle.pragma('journal_mode = WAL');
  handle.pragma('synchronous = NORMAL');
  // Non-negotiable: the composite foreign keys ARE the tenant boundary.
  handle.pragma('foreign_keys = ON');
  handle.pragma('busy_timeout = 5000');

  const enforced = handle.pragma('foreign_keys', { simple: true });
  if (enforced !== 1) {
    throw new Error('SQLite refused to enable foreign_keys; tenant isolation cannot be enforced. Aborting.');
  }
  return handle;
}

function raw(): Database.Database {
  if (!db) {
    db = connect();
    migrate(db);
  }
  return db;
}

function migrate(handle: Database.Database): void {
  const schemaPath = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');
  const sql = readFileSync(schemaPath, 'utf8');
  handle.exec(sql);
  handle
    .prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)')
    .run(1, new Date().toISOString());
}

export function initDatabase(): void {
  raw();
  logger.info('database.ready', { path: databasePath() });
}

/** Test helper: point at a fresh in-memory database. */
export function resetDatabaseForTests(): void {
  db?.close();
  db = null;
  process.env.DATABASE_PATH = IN_MEMORY;
  raw();
}

export function closeDatabase(): void {
  db?.close();
  db = null;
}

// ---------------------------------------------------------------------------
// Global door
// ---------------------------------------------------------------------------

export interface Statement<T = unknown> {
  all(params?: Params): T[];
  get(params?: Params): T | undefined;
  run(params?: Params): Database.RunResult;
}

/** Statements here may only reference tables classified as global. */
export function globalDb() {
  return {
    prepare<T = unknown>(sql: string): Statement<T> {
      const tables = referencedTables(sql);
      const notGlobal = tables.filter((t) => !GLOBAL_TABLES.has(t));
      if (notGlobal.length) {
        throw new AppError(
          500,
          'tenant_table_via_global_db',
          `globalDb() may not touch tenant-scoped table(s) [${notGlobal.join(', ')}]. Use forTenant().`,
        );
      }
      const stmt = raw().prepare(sql);
      return {
        all: (params?: Params) => (params ? stmt.all(params) : stmt.all()) as T[],
        get: (params?: Params) => (params ? stmt.get(params) : stmt.get()) as T | undefined,
        run: (params?: Params) => (params ? stmt.run(params) : stmt.run()),
      };
    },
    transaction<T>(fn: () => T): T {
      return raw().transaction(fn)();
    },
  };
}

// ---------------------------------------------------------------------------
// Tenant door
// ---------------------------------------------------------------------------

export interface TenantDb {
  readonly tenantId: string;
  prepare<T = unknown>(sql: string): Statement<T>;
  transaction<T>(fn: () => T): T;
}

class GuardedTenantDb implements TenantDb {
  constructor(readonly tenantId: string) {}

  prepare<T = unknown>(sql: string): Statement<T> {
    // Throws AppError('tenant_predicate_missing') before the statement compiles.
    const { requiresTenant } = assertTenantScoped(sql);

    if (/[:@]tenant_id\b/.test(sql) === false && requiresTenant) {
      throw new AppError(500, 'tenant_predicate_missing', 'Statement must bind :tenant_id.');
    }
    // Reject any attempt to smuggle in a different tenant by hand.
    const stmt = raw().prepare(sql);
    const needsTenant = /[:@]tenant_id\b/.test(sql);
    const tenantId = this.tenantId;

    const bind = (params?: Params): Params | undefined => {
      if (!needsTenant) return params;
      if (params && TENANT_PARAM in params && params[TENANT_PARAM] !== tenantId) {
        throw new AppError(
          500,
          'tenant_param_override',
          'A caller tried to bind :tenant_id explicitly. It is supplied by the framework from the request context.',
        );
      }
      return { ...(params ?? {}), [TENANT_PARAM]: tenantId };
    };

    return {
      all: (params?: Params) => {
        const p = bind(params);
        return (p ? stmt.all(p) : stmt.all()) as T[];
      },
      get: (params?: Params) => {
        const p = bind(params);
        return (p ? stmt.get(p) : stmt.get()) as T | undefined;
      },
      run: (params?: Params) => {
        const p = bind(params);
        return p ? stmt.run(p) : stmt.run();
      },
    };
  }

  transaction<T>(fn: () => T): T {
    return raw().transaction(fn)();
  }
}

/** The only way to read or write tenant data. Requires an active tenant context. */
export function forTenant(): TenantDb {
  const ctx = currentTenant();
  raw();
  return new GuardedTenantDb(ctx.tenantId);
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export function audit(
  action: string,
  opts: { severity?: 'info' | 'violation'; resource?: string; detail?: unknown } = {},
): void {
  const ctx = maybeTenant();
  if (!ctx) return;
  try {
    forTenant()
      .prepare(
        `INSERT INTO audit_log (tenant_id, id, request_id, severity, action, resource, detail, created_at)
         VALUES (:tenant_id, :id, :request_id, :severity, :action, :resource, :detail, :created_at)`,
      )
      .run({
        id: randomUUID(),
        request_id: ctx.requestId,
        severity: opts.severity ?? 'info',
        action,
        resource: opts.resource ?? null,
        detail: opts.detail === undefined ? null : JSON.stringify(opts.detail).slice(0, 4000),
        created_at: new Date().toISOString(),
      });
  } catch (err) {
    // Auditing must never break the request it is auditing.
    logger.error('audit.failed', { action, error: (err as Error).message });
  }
}

// ---------------------------------------------------------------------------
// Vector blob helpers
// ---------------------------------------------------------------------------

/** L2-normalize once at write time so similarity is a plain dot product. */
export function normalizeVector(values: number[]): Float32Array {
  const out = new Float32Array(values.length);
  let norm = 0;
  for (const v of values) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return out;
  for (let i = 0; i < values.length; i++) out[i] = values[i]! / norm;
  return out;
}

export function vectorToBlob(values: number[]): Buffer {
  const f32 = normalizeVector(values);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

export function blobToVector(blob: Buffer | Uint8Array): Float32Array {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  // Copy: the underlying ArrayBuffer may be a slice of a larger pooled buffer.
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

export function dotProduct(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += a[i]! * b[i]!;
  return sum;
}
