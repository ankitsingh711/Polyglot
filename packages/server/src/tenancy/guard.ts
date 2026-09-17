import { AppError } from '../core/errors.js';

/**
 * The structural half of tenant isolation.
 *
 * SQLite has no row-level security, so Polyglot puts the equivalent in the only
 * place every query must pass through: statement preparation. Before a statement
 * that touches a tenant-scoped table is allowed to compile, it must prove it
 * carries a tenant predicate, and that predicate is bound by the framework from
 * the ambient context — never by the caller.
 *
 * Concretely, this is what stops the new engineer's `SELECT * FROM documents
 * WHERE id = ?`: it throws `tenant_predicate_missing` the first time it runs,
 * in dev, with a message telling them what to write instead.
 *
 * What this is NOT: a SQL parser. It is an intentionally conservative lexical
 * check that fails CLOSED — anything it cannot understand is rejected rather
 * than allowed. False positives cost a developer thirty seconds; a false
 * negative costs a customer their data. The production answer is Postgres RLS,
 * and docs/DESIGN.md spells out that migration.
 */

/** Every table whose rows belong to exactly one tenant. */
export const TENANT_SCOPED_TABLES: ReadonlySet<string> = new Set([
  'conversations',
  'messages',
  'collections',
  'documents',
  'chunks',
  'chunk_vectors',
  'chunks_fts',
  'usage_records',
  'semantic_cache',
  'audit_log',
]);

/**
 * Names that are global by design and therefore exempt: the two real global
 * tables, SQLite's own catalogue, and the table-valued functions we use for
 * array binding (`json_each` is how a list of ids is passed to a single
 * prepared statement, since SQLite has no array parameter type).
 */
export const GLOBAL_TABLES: ReadonlySet<string> = new Set([
  'tenants',
  'schema_migrations',
  'sqlite_master',
  'sqlite_sequence',
  'json_each',
  'json_tree',
]);

/** The bound parameter the framework injects. Callers may not supply it. */
export const TENANT_PARAM = 'tenant_id';

const SQL_COMMENTS = /--[^\n]*|\/\*[\s\S]*?\*\//g;
const STRING_LITERALS = /'(?:[^']|'')*'/g;

function normalize(sql: string): string {
  return sql.replace(SQL_COMMENTS, ' ').replace(STRING_LITERALS, "''").replace(/\s+/g, ' ').trim();
}

/** Table names appearing after FROM / JOIN / INTO / UPDATE / DELETE FROM. */
export function referencedTables(sql: string): string[] {
  const normalized = normalize(sql).toLowerCase();
  const tables = new Set<string>();
  const re = /(?:\bfrom\b|\bjoin\b|\binto\b|\bupdate\b)\s+["'`\[]?([a-z_][a-z0-9_]*)["'`\]]?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(normalized))) tables.add(m[1]!);
  return [...tables];
}

function statementKind(sql: string): 'select' | 'insert' | 'update' | 'delete' | 'other' {
  const head = normalize(sql).toLowerCase();
  if (head.startsWith('select') || head.startsWith('with')) return 'select';
  if (head.startsWith('insert') || head.startsWith('replace')) return 'insert';
  if (head.startsWith('update')) return 'update';
  if (head.startsWith('delete')) return 'delete';
  return 'other';
}

export interface GuardResult {
  /** Tenant-scoped tables this statement touches. */
  tables: string[];
  requiresTenant: boolean;
}

/**
 * Throws unless the statement is safe to run under a tenant context.
 * Returns the tenant-scoped tables it touched so the caller can audit them.
 */
export function assertTenantScoped(sql: string): GuardResult {
  const tables = referencedTables(sql);
  const scoped = tables.filter((t) => TENANT_SCOPED_TABLES.has(t));
  const unknown = tables.filter((t) => !TENANT_SCOPED_TABLES.has(t) && !GLOBAL_TABLES.has(t));

  if (unknown.length) {
    // Fail closed: a table the guard has never heard of is assumed to hold
    // tenant data until someone explicitly classifies it in one of the two sets.
    throw new AppError(
      500,
      'unclassified_table',
      `Statement references table(s) [${unknown.join(', ')}] that are classified neither tenant-scoped nor global. ` +
        'Add them to TENANT_SCOPED_TABLES or GLOBAL_TABLES in src/tenancy/guard.ts.',
    );
  }

  if (!scoped.length) return { tables: scoped, requiresTenant: false };

  const normalized = normalize(sql).toLowerCase();
  const kind = statementKind(sql);

  if (kind === 'insert') {
    // The inserted row must carry a tenant_id column, and it must be bound to
    // the framework's parameter rather than an arbitrary value.
    const columnList = /insert\s+(?:or\s+\w+\s+)?into\s+[^(]+\(([^)]*)\)/.exec(normalized)?.[1] ?? '';
    if (!/\btenant_id\b/.test(columnList)) {
      throw fail(scoped, 'INSERT must include a tenant_id column', sql);
    }
    if (!normalized.includes(`:${TENANT_PARAM}`) && !normalized.includes(`@${TENANT_PARAM}`)) {
      throw fail(scoped, `INSERT must bind tenant_id to the framework parameter :${TENANT_PARAM}`, sql);
    }
    return { tables: scoped, requiresTenant: true };
  }

  // SELECT / UPDATE / DELETE must filter on tenant_id, bound to :tenant_id.
  const hasPredicate = new RegExp(`\\btenant_id\\s*=\\s*[:@]${TENANT_PARAM}\\b`).test(normalized);
  if (!hasPredicate) {
    throw fail(
      scoped,
      `statement must filter on "tenant_id = :${TENANT_PARAM}" (one predicate per tenant-scoped table)`,
      sql,
    );
  }

  // Every joined tenant-scoped table needs its own predicate, otherwise a join
  // can fan out across tenants even though the outer table was filtered.
  const predicateCount = (normalized.match(new RegExp(`tenant_id\\s*=\\s*[:@]${TENANT_PARAM}`, 'g')) ?? []).length;
  // A join between two tenant tables may instead be correlated (a.tenant_id = b.tenant_id),
  // which is equally safe because one side is already pinned.
  const correlations = (normalized.match(/\b\w+\.tenant_id\s*=\s*\w+\.tenant_id\b/g) ?? []).length;
  if (predicateCount + correlations < scoped.length) {
    throw fail(
      scoped,
      `joins ${scoped.length} tenant-scoped tables but only pins ${predicateCount + correlations} of them; ` +
        'add "tenant_id = :tenant_id" or correlate "a.tenant_id = b.tenant_id" for each',
      sql,
    );
  }

  return { tables: scoped, requiresTenant: true };
}

function fail(tables: string[], why: string, sql: string): AppError {
  return new AppError(500, 'tenant_predicate_missing', `Refusing to run a query over tenant data: ${why}.`, {
    tables,
    sql: sql.replace(/\s+/g, ' ').trim().slice(0, 300),
    help: 'docs/DESIGN.md → "Tenant isolation". Use db.forTenant().prepare(...) and reference :tenant_id.',
  });
}
