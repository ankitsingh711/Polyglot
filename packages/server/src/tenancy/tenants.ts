import { globalDb } from '../db/index.js';
import { newApiKey, newId, sha256Hex } from '../util/ids.js';

/**
 * Tenant records live in the one global table. Note what is NOT stored: the API
 * key itself. Only its SHA-256 is persisted, so a database dump does not hand an
 * attacker working credentials for every tenant.
 */

export interface TenantRow {
  id: string;
  name: string;
  api_key_hash: string;
  daily_budget_usd: number | null;
  created_at: string;
}

export function findTenantByApiKey(apiKey: string): TenantRow | undefined {
  const hash = sha256Hex(apiKey);
  // Indexed lookup on the hash — a constant-time compare of the key itself is
  // unnecessary because we never compare plaintext, and the hash is unguessable.
  return globalDb()
    .prepare<TenantRow>('SELECT * FROM tenants WHERE api_key_hash = :hash')
    .get({ hash });
}

export function findTenantById(id: string): TenantRow | undefined {
  return globalDb().prepare<TenantRow>('SELECT * FROM tenants WHERE id = :id').get({ id });
}

export function listTenants(): Array<Omit<TenantRow, 'api_key_hash'>> {
  return globalDb()
    .prepare<Omit<TenantRow, 'api_key_hash'>>(
      'SELECT id, name, daily_budget_usd, created_at FROM tenants ORDER BY created_at',
    )
    .all();
}

/** Returns the plaintext key exactly once — it is not recoverable afterwards. */
export function createTenant(name: string, dailyBudgetUsd?: number): { tenant: TenantRow; apiKey: string } {
  const apiKey = newApiKey();
  const row: TenantRow = {
    id: newId('ten'),
    name,
    api_key_hash: sha256Hex(apiKey),
    daily_budget_usd: dailyBudgetUsd ?? null,
    created_at: new Date().toISOString(),
  };
  globalDb()
    .prepare(
      `INSERT INTO tenants (id, name, api_key_hash, daily_budget_usd, created_at)
       VALUES (:id, :name, :api_key_hash, :daily_budget_usd, :created_at)`,
    )
    .run(row as unknown as Record<string, unknown>);
  return { tenant: row, apiKey };
}

/** Idempotent seeding helper: reuses the tenant if the name already exists. */
export function ensureTenant(name: string, apiKey: string, dailyBudgetUsd?: number): TenantRow {
  const existing = globalDb()
    .prepare<TenantRow>('SELECT * FROM tenants WHERE name = :name')
    .get({ name });
  if (existing) return existing;

  const row: TenantRow = {
    id: newId('ten'),
    name,
    api_key_hash: sha256Hex(apiKey),
    daily_budget_usd: dailyBudgetUsd ?? null,
    created_at: new Date().toISOString(),
  };
  globalDb()
    .prepare(
      `INSERT INTO tenants (id, name, api_key_hash, daily_budget_usd, created_at)
       VALUES (:id, :name, :api_key_hash, :daily_budget_usd, :created_at)`,
    )
    .run(row as unknown as Record<string, unknown>);
  return row;
}
