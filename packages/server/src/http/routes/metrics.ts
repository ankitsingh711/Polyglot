import { Router } from 'express';
import { formatUsd } from '../../core/pricing.js';
import { aggregateByProvider, listUsage, spendToday, totals } from '../../modules/metrics/store.js';
import { cacheStats, clearSemanticCache } from '../../modules/cache/semantic.js';
import { appConfig } from '../../core/config.js';
import { asyncRoute } from '../middleware.js';
import { forTenant } from '../../db/index.js';

export const metricsRouter: Router = Router();

function sinceParam(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const windows: Record<string, number> = { '1h': 3_600_000, '24h': 86_400_000, '7d': 604_800_000, '30d': 2_592_000_000 };
  const ms = windows[value];
  if (ms) return new Date(Date.now() - ms).toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

metricsRouter.get(
  '/metrics/requests',
  asyncRoute(async (req, res) => {
    const records = listUsage({
      limit: Number(req.query.limit ?? 100),
      offset: Number(req.query.offset ?? 0),
      provider: typeof req.query.provider === 'string' ? req.query.provider : undefined,
      conversationId: typeof req.query.conversationId === 'string' ? req.query.conversationId : undefined,
      since: sinceParam(req.query.since),
    });
    res.json({
      requests: records.map((r) => ({ ...r, cost_display: formatUsd(r.cost_usd) })),
    });
  }),
);

metricsRouter.get(
  '/metrics/summary',
  asyncRoute(async (req, res) => {
    const since = sinceParam(req.query.since);
    const limits = appConfig().limits;
    const spent = spendToday();
    res.json({
      totals: totals(since),
      byProvider: aggregateByProvider(since),
      cache: cacheStats(),
      budget: {
        spentTodayUsd: spent,
        dailyBudgetUsd: limits.tenantDailyBudgetUsd,
        remainingUsd: Math.max(0, limits.tenantDailyBudgetUsd - spent),
        maxCostPerRequestUsd: limits.maxCostPerRequestUsd,
      },
    });
  }),
);

/**
 * The audit trail. Exposed per tenant because it answers "would I know if it had
 * leaked?" for the tenant as well as for the operator: every tenant-scoped
 * action is recorded, and a guard violation is recorded with severity=violation.
 */
metricsRouter.get(
  '/metrics/audit',
  asyncRoute(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 100), 1), 500);
    const entries = forTenant()
      .prepare<{ id: string; request_id: string; severity: string; action: string; resource: string | null; detail: string | null; created_at: string }>(
        `SELECT id, request_id, severity, action, resource, detail, created_at
           FROM audit_log
          WHERE tenant_id = :tenant_id
          ORDER BY created_at DESC
          LIMIT :limit`,
      )
      .all({ limit });
    res.json({ entries });
  }),
);

metricsRouter.delete(
  '/metrics/cache',
  asyncRoute(async (_req, res) => {
    clearSemanticCache();
    res.status(204).end();
  }),
);
