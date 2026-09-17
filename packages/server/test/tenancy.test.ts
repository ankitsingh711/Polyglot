import { describe, it, expect, beforeAll } from 'vitest';
import { assertTenantScoped, referencedTables } from '../src/tenancy/guard.js';
import { runWithTenant } from '../src/tenancy/context.js';
import { audit, forTenant, globalDb, initDatabase } from '../src/db/index.js';
import { ensureTenant } from '../src/tenancy/tenants.js';
import { createCollection, listCollections, getCollection } from '../src/modules/rag/store.js';
import { createConversation, appendMessage, listMessages, getConversation } from '../src/modules/chat/store.js';
import { newRequestId } from '../src/util/ids.js';
import { AppError } from '../src/core/errors.js';

/**
 * These are the tests that matter most in this repo.
 *
 * "A new engineer joins on Monday and writes a query. What stops them leaking
 * data?" -- the answer has to be executable, not a paragraph. Each mechanism is
 * exercised independently below, because the whole point of layering them is
 * that no single one has to be perfect.
 */

let acme: { id: string; name: string };
let globex: { id: string; name: string };

beforeAll(() => {
  initDatabase();
  const a = ensureTenant('Acme Test', 'key-acme');
  const b = ensureTenant('Globex Test', 'key-globex');
  acme = { id: a.id, name: a.name };
  globex = { id: b.id, name: b.name };
});

const asAcme = <T>(fn: () => T): T =>
  runWithTenant({ tenantId: acme.id, tenantName: acme.name, requestId: newRequestId() }, fn);
const asGlobex = <T>(fn: () => T): T =>
  runWithTenant({ tenantId: globex.id, tenantName: globex.name, requestId: newRequestId() }, fn);

describe('guard — static analysis of statements', () => {
  it('finds tables after FROM, JOIN, INTO and UPDATE', () => {
    expect(referencedTables('SELECT * FROM chunks k JOIN documents d ON 1=1').sort()).toEqual(['chunks', 'documents']);
    expect(referencedTables('UPDATE documents SET x = 1')).toEqual(['documents']);
    expect(referencedTables('INSERT INTO messages (a) VALUES (1)')).toEqual(['messages']);
  });

  it('REFUSES the query the new engineer writes on Monday', () => {
    // The canonical mistake: correct-looking, passes review, leaks everything.
    expect(() => assertTenantScoped('SELECT * FROM documents WHERE id = :id')).toThrowError(
      /tenant_predicate_missing|Refusing to run a query over tenant data/,
    );
  });

  it('accepts the same query once it carries the framework predicate', () => {
    expect(() => assertTenantScoped('SELECT * FROM documents WHERE tenant_id = :tenant_id AND id = :id')).not.toThrow();
  });

  it('refuses a join that pins only one of two tenant tables', () => {
    expect(() =>
      assertTenantScoped(
        'SELECT * FROM chunks k JOIN documents d ON d.id = k.document_id WHERE k.tenant_id = :tenant_id',
      ),
    ).toThrowError(/only pins/);
  });

  it('accepts a join correlated on tenant_id, which is equally safe', () => {
    expect(() =>
      assertTenantScoped(
        'SELECT * FROM chunks k JOIN documents d ON d.tenant_id = k.tenant_id AND d.id = k.document_id WHERE k.tenant_id = :tenant_id',
      ),
    ).not.toThrow();
  });

  it('refuses an INSERT that omits tenant_id', () => {
    expect(() => assertTenantScoped('INSERT INTO messages (id, role) VALUES (:id, :role)')).toThrowError(/tenant_id column/);
  });

  it('refuses an INSERT that hardcodes a tenant instead of binding the parameter', () => {
    expect(() =>
      assertTenantScoped("INSERT INTO messages (tenant_id, id) VALUES ('ten_someone_else', :id)"),
    ).toThrowError(/framework parameter/);
  });

  it('fails CLOSED on a table nobody classified', () => {
    // A new table is assumed to hold tenant data until someone says otherwise.
    // A guard that allowed unknown tables would silently stop covering every
    // table added after it was written, which is the failure mode that matters.
    const error = catchError(() => assertTenantScoped('SELECT * FROM invoices WHERE id = :id'));
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('unclassified_table');
    expect((error as AppError).message).toMatch(/invoices/);
  });

  it('is not fooled by a tenant_id mentioned only inside a string literal or comment', () => {
    expect(() =>
      assertTenantScoped("SELECT * FROM documents WHERE note = 'tenant_id = :tenant_id'"),
    ).toThrow();
    expect(() => assertTenantScoped('SELECT * FROM documents -- tenant_id = :tenant_id\n WHERE id = :id')).toThrow();
  });

  it('leaves statements that touch no tenant table alone', () => {
    expect(assertTenantScoped('SELECT * FROM tenants WHERE id = :id').requiresTenant).toBe(false);
  });
});

describe('guard — runtime enforcement', () => {
  it('rejects a query prepared without a tenant predicate', () => {
    asAcme(() => {
      expect(() => forTenant().prepare('SELECT * FROM collections')).toThrowError(AppError);
    });
  });

  it('rejects a caller trying to bind :tenant_id by hand', () => {
    asAcme(() => {
      const stmt = forTenant().prepare('SELECT id FROM collections WHERE tenant_id = :tenant_id');
      expect(() => stmt.all({ tenant_id: globex.id } as any)).toThrowError(/supplied by the framework/);
    });
  });

  it('refuses tenant work with no tenant context at all', () => {
    expect(() => forTenant()).toThrowError(/outside of a tenant context/);
  });

  it('will not let globalDb() touch a tenant table', () => {
    expect(() => globalDb().prepare('SELECT * FROM documents')).toThrowError(/may not touch tenant-scoped/);
  });
});

describe('isolation — data layer', () => {
  it('scopes reads to the acting tenant', () => {
    asAcme(() => createCollection({ name: 'Acme docs', embeddingModel: 'local:hash-embedding-384', chunkSize: 900, chunkOverlap: 100, dimensions: 384 }));
    asGlobex(() => createCollection({ name: 'Globex docs', embeddingModel: 'local:hash-embedding-384', chunkSize: 900, chunkOverlap: 100, dimensions: 384 }));

    const acmeNames = asAcme(() => listCollections().map((c) => c.name));
    const globexNames = asGlobex(() => listCollections().map((c) => c.name));

    expect(acmeNames).toContain('Acme docs');
    expect(acmeNames).not.toContain('Globex docs');
    expect(globexNames).toContain('Globex docs');
    expect(globexNames).not.toContain('Acme docs');
  });

  it('makes another tenant\'s id indistinguishable from a nonexistent one', () => {
    const globexCollectionId = asGlobex(() => listCollections()[0]!.id);
    // Not 403: a different status code would be an existence oracle.
    expect(asAcme(() => getCollection(globexCollectionId))).toBeUndefined();
  });

  it('keeps conversations and their messages separated', () => {
    const acmeConversation = asAcme(() => createConversation({ title: 'Acme chat' }));
    asAcme(() => appendMessage(acmeConversation.id, { role: 'user', content: [{ type: 'text', text: 'acme secret' }] }));

    expect(asGlobex(() => getConversation(acmeConversation.id))).toBeUndefined();
    expect(() => asGlobex(() => listMessages(acmeConversation.id))).toThrowError(/not found/);
    expect(asAcme(() => listMessages(acmeConversation.id))).toHaveLength(1);
  });
});

describe('isolation — the database itself', () => {
  it('rejects a cross-tenant foreign key even when the application is wrong', () => {
    const acmeConversation = asAcme(() => createConversation({ title: 'Acme only' }));

    // Simulate the worst case: application code that has BOTH the right tenant
    // context and the wrong conversation id. The composite foreign key means
    // SQLite refuses the write; no application check is involved.
    asGlobex(() => {
      expect(() =>
        forTenant()
          .prepare(
            `INSERT INTO messages (tenant_id, id, conversation_id, seq, role, content_json, created_at)
             VALUES (:tenant_id, :id, :conversation_id, 0, 'user', '[]', :created_at)`,
          )
          .run({ id: 'msg_forced', conversation_id: acmeConversation.id, created_at: new Date().toISOString() }),
      ).toThrowError(/FOREIGN KEY constraint failed/);
    });
  });

  it('enforces foreign keys at all (the pragma is not silently off)', () => {
    asAcme(() => {
      const row = globalDb().prepare<{ foreign_keys: number }>('PRAGMA foreign_keys').get();
      expect(row?.foreign_keys ?? (row as unknown as number)).toBeTruthy();
    });
  });
});

describe('detection — "would I know if it had ever leaked?"', () => {
  it('writes an audit row that only the owning tenant can read', () => {
    asAcme(() => audit('collection.created', { resource: 'col_x', detail: { note: 'acme only' } }));
    asGlobex(() => audit('collection.created', { resource: 'col_y' }));

    const acmeTrail = asAcme(() =>
      forTenant()
        .prepare<{ action: string; resource: string | null }>(
          'SELECT action, resource FROM audit_log WHERE tenant_id = :tenant_id',
        )
        .all(),
    );
    expect(acmeTrail.map((e) => e.resource)).toContain('col_x');
    expect(acmeTrail.map((e) => e.resource)).not.toContain('col_y');
  });

  it('records a guard violation with severity=violation, so it is greppable', () => {
    asAcme(() => {
      const error = catchError(() => forTenant().prepare('SELECT * FROM documents WHERE id = :id'));
      expect((error as AppError).code).toBe('tenant_predicate_missing');
      // This is what src/http/middleware.ts does when it sees that code.
      audit('guard.violation', { severity: 'violation', detail: (error as AppError).details });
    });

    const violations = asAcme(() =>
      forTenant()
        .prepare<{ severity: string; action: string }>(
          "SELECT severity, action FROM audit_log WHERE tenant_id = :tenant_id AND severity = 'violation'",
        )
        .all(),
    );
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]!.action).toBe('guard.violation');
  });
});

/** `expect(fn).toThrowError(re)` matches the message; we often want the code. */
function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('Expected the call to throw, but it did not.');
}
