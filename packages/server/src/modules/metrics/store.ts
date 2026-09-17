import { forTenant } from '../../db/index.js';
import { newId } from '../../util/ids.js';
import { computeCost } from '../../core/pricing.js';
import type { Usage } from '../../core/types.js';

export type UsageKind = 'chat' | 'embedding' | 'tool' | 'summary' | 'compare' | 'structured' | 'judge';

export interface UsageRecordInput {
  requestId: string;
  conversationId?: string | null;
  kind: UsageKind;
  provider: string;
  modelId: string;
  startedAt: Date;
  ttftMs?: number | null;
  latencyMs: number;
  usage?: Usage;
  finishReason?: string | null;
  retryCount?: number;
  /** Set when a fallback served this request: the model originally requested. */
  fallbackFrom?: string | null;
  errorKind?: string | null;
  toolCallCount?: number;
  cacheHit?: boolean;
  /** Pre-computed cost (semantic-cache hits record the cost they SAVED as 0 spent). */
  costUsdOverride?: number;
}

export interface UsageRecord {
  id: string;
  request_id: string;
  conversation_id: string | null;
  kind: UsageKind;
  provider: string;
  model_id: string;
  started_at: string;
  ttft_ms: number | null;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
  finish_reason: string | null;
  retry_count: number;
  fallback_from: string | null;
  error_kind: string | null;
  tool_call_count: number;
  cache_hit: number;
}

export function recordUsage(input: UsageRecordInput): UsageRecord {
  const usage = input.usage ?? { inputTokens: 0, outputTokens: 0 };
  const cost = input.costUsdOverride ?? computeCost(input.modelId, usage).totalUsd;

  const row: UsageRecord = {
    id: newId('use'),
    request_id: input.requestId,
    conversation_id: input.conversationId ?? null,
    kind: input.kind,
    provider: input.provider,
    model_id: input.modelId,
    started_at: input.startedAt.toISOString(),
    ttft_ms: input.ttftMs ?? null,
    latency_ms: Math.round(input.latencyMs),
    input_tokens: usage.inputTokens ?? 0,
    output_tokens: usage.outputTokens ?? 0,
    cached_input_tokens: usage.cachedInputTokens ?? 0,
    cache_write_tokens: usage.cacheWriteTokens ?? 0,
    reasoning_tokens: usage.reasoningTokens ?? 0,
    cost_usd: cost,
    finish_reason: input.finishReason ?? null,
    retry_count: input.retryCount ?? 0,
    fallback_from: input.fallbackFrom ?? null,
    error_kind: input.errorKind ?? null,
    tool_call_count: input.toolCallCount ?? 0,
    cache_hit: input.cacheHit ? 1 : 0,
  };

  forTenant()
    .prepare(
      `INSERT INTO usage_records (
         tenant_id, id, request_id, conversation_id, kind, provider, model_id, started_at,
         ttft_ms, latency_ms, input_tokens, output_tokens, cached_input_tokens, cache_write_tokens,
         reasoning_tokens, cost_usd, finish_reason, retry_count, fallback_from, error_kind,
         tool_call_count, cache_hit
       ) VALUES (
         :tenant_id, :id, :request_id, :conversation_id, :kind, :provider, :model_id, :started_at,
         :ttft_ms, :latency_ms, :input_tokens, :output_tokens, :cached_input_tokens, :cache_write_tokens,
         :reasoning_tokens, :cost_usd, :finish_reason, :retry_count, :fallback_from, :error_kind,
         :tool_call_count, :cache_hit
       )`,
    )
    .run(row as unknown as Record<string, unknown>);

  return row;
}

export interface UsageQuery {
  limit?: number;
  offset?: number;
  provider?: string;
  conversationId?: string;
  since?: string;
}

export function listUsage(q: UsageQuery = {}): UsageRecord[] {
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
  const offset = Math.max(q.offset ?? 0, 0);
  return forTenant()
    .prepare<UsageRecord>(
      `SELECT id, request_id, conversation_id, kind, provider, model_id, started_at, ttft_ms,
              latency_ms, input_tokens, output_tokens, cached_input_tokens, cache_write_tokens,
              reasoning_tokens, cost_usd, finish_reason, retry_count, fallback_from, error_kind,
              tool_call_count, cache_hit
         FROM usage_records
        WHERE tenant_id = :tenant_id
          AND (:provider IS NULL OR provider = :provider)
          AND (:conversation_id IS NULL OR conversation_id = :conversation_id)
          AND (:since IS NULL OR started_at >= :since)
        ORDER BY started_at DESC
        LIMIT :limit OFFSET :offset`,
    )
    .all({
      provider: q.provider ?? null,
      conversation_id: q.conversationId ?? null,
      since: q.since ?? null,
      limit,
      offset,
    });
}

export interface ProviderAggregate {
  provider: string;
  model_id: string;
  requests: number;
  total_cost_usd: number;
  avg_latency_ms: number;
  avg_ttft_ms: number | null;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  errors: number;
  fallbacks: number;
  retries: number;
  cache_hits: number;
}

export function aggregateByProvider(since?: string): ProviderAggregate[] {
  return forTenant()
    .prepare<ProviderAggregate>(
      `SELECT provider,
              model_id,
              COUNT(*)                         AS requests,
              COALESCE(SUM(cost_usd), 0)       AS total_cost_usd,
              COALESCE(AVG(latency_ms), 0)     AS avg_latency_ms,
              AVG(ttft_ms)                     AS avg_ttft_ms,
              COALESCE(SUM(input_tokens), 0)   AS input_tokens,
              COALESCE(SUM(output_tokens), 0)  AS output_tokens,
              COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
              COALESCE(SUM(CASE WHEN error_kind IS NOT NULL THEN 1 ELSE 0 END), 0) AS errors,
              COALESCE(SUM(CASE WHEN fallback_from IS NOT NULL THEN 1 ELSE 0 END), 0) AS fallbacks,
              COALESCE(SUM(retry_count), 0)    AS retries,
              COALESCE(SUM(cache_hit), 0)      AS cache_hits
         FROM usage_records
        WHERE tenant_id = :tenant_id
          AND (:since IS NULL OR started_at >= :since)
        GROUP BY provider, model_id
        ORDER BY total_cost_usd DESC`,
    )
    .all({ since: since ?? null });
}

export interface UsageTotals {
  requests: number;
  total_cost_usd: number;
  avg_latency_ms: number;
  avg_ttft_ms: number | null;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  reasoning_tokens: number;
  errors: number;
  fallbacks: number;
  cache_hits: number;
}

export function totals(since?: string): UsageTotals {
  return (
    forTenant()
      .prepare<UsageTotals>(
        `SELECT COUNT(*)                        AS requests,
                COALESCE(SUM(cost_usd), 0)      AS total_cost_usd,
                COALESCE(AVG(latency_ms), 0)    AS avg_latency_ms,
                AVG(ttft_ms)                    AS avg_ttft_ms,
                COALESCE(SUM(input_tokens), 0)  AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
                COALESCE(SUM(reasoning_tokens), 0)    AS reasoning_tokens,
                COALESCE(SUM(CASE WHEN error_kind IS NOT NULL THEN 1 ELSE 0 END), 0) AS errors,
                COALESCE(SUM(CASE WHEN fallback_from IS NOT NULL THEN 1 ELSE 0 END), 0) AS fallbacks,
                COALESCE(SUM(cache_hit), 0)     AS cache_hits
           FROM usage_records
          WHERE tenant_id = :tenant_id
            AND (:since IS NULL OR started_at >= :since)`,
      )
      .get({ since: since ?? null }) ?? {
      requests: 0, total_cost_usd: 0, avg_latency_ms: 0, avg_ttft_ms: null,
      input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, reasoning_tokens: 0,
      errors: 0, fallbacks: 0, cache_hits: 0,
    }
  );
}

/** Spend since UTC midnight — the input to the per-tenant daily budget check. */
export function spendToday(): number {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const row = forTenant()
    .prepare<{ spent: number }>(
      `SELECT COALESCE(SUM(cost_usd), 0) AS spent
         FROM usage_records
        WHERE tenant_id = :tenant_id AND started_at >= :since`,
    )
    .get({ since: since.toISOString() });
  return row?.spent ?? 0;
}
