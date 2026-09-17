import { AsyncLocalStorage } from 'node:async_hooks';
import { AppError } from '../core/errors.js';

/**
 * Ambient tenant context.
 *
 * Why AsyncLocalStorage and not "pass tenantId down as an argument":
 * an argument is something a developer can forget, default, or shadow. Six
 * months in, some helper grows an optional `tenantId?: string` parameter and the
 * boundary quietly becomes conventional. Here there is no parameter to forget —
 * the data layer reads the tenant from the ambient context and REFUSES to run if
 * there is not one. Forgetting produces a loud 500 on the first request in dev,
 * not a silent leak in production.
 *
 * This is the application-side half of the model. The other half is
 * `tenancy/guard.ts`, which refuses SQL that does not carry a tenant predicate.
 */

export interface TenantContext {
  tenantId: string;
  tenantName: string;
  /** Correlates every log line, usage row and audit entry for one HTTP request. */
  requestId: string;
}

const storage = new AsyncLocalStorage<TenantContext>();

export function runWithTenant<T>(ctx: TenantContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentTenant(): TenantContext {
  const ctx = storage.getStore();
  if (!ctx) {
    // Reaching here means code touched tenant data outside a request scope.
    // That is a programming error, and it is meant to be impossible to ignore.
    throw new AppError(
      500,
      'no_tenant_context',
      'Tenant-scoped work was attempted outside of a tenant context. ' +
        'Wrap it in runWithTenant() — see docs/DESIGN.md → Tenant isolation.',
    );
  }
  return ctx;
}

export function currentTenantId(): string {
  return currentTenant().tenantId;
}

export function maybeTenant(): TenantContext | undefined {
  return storage.getStore();
}
