import { appConfig } from '../../core/config.js';
import { ProviderError, isProviderError } from '../../core/errors.js';
import { computeCost } from '../../core/pricing.js';
import { getModelEntry, isProviderConfigured, providerForModel } from '../../core/registry.js';
import { defaultRetryPolicy, computeBackoff, shouldRetry } from '../../core/retry.js';
import type { EmbeddingResponse } from '../../core/types.js';
import { recordUsage } from '../metrics/store.js';
import { currentTenant } from '../../tenancy/context.js';
import { logger } from '../../util/logger.js';

/**
 * Embeddings go through the same abstraction as chat: `Provider.embed`, the same
 * normalized errors, the same retry policy, the same fallback chain, and the
 * same usage/cost accounting. Swapping OpenAI for Gemini embeddings is a config
 * edit (`config/app.json -> fallback.embeddingChain`), not a code change.
 *
 * One thing that is NOT swappable at will, and the reason `collections` stores
 * `embedding_model` and `dimensions`: vectors from two different models are not
 * comparable. Changing a collection's embedding model requires re-embedding it,
 * so the model is pinned per collection at creation and the mismatch is refused
 * loudly rather than returning quietly meaningless similarity scores.
 */

/** Providers cap how many inputs one embed call may carry. */
const BATCH_SIZE = 64;

export interface EmbedOptions {
  model?: string;
  taskType?: 'query' | 'document';
  signal?: AbortSignal;
  conversationId?: string | null;
}

export interface EmbedResult {
  vectors: number[][];
  model: string;
  provider: string;
  dimensions: number;
  costUsd: number;
  /** Set when the requested model failed and a chain entry answered instead. */
  fallbackFrom?: string;
}

function chain(preferred: string): string[] {
  const cfg = appConfig();
  const ordered = [preferred, ...cfg.fallback.embeddingChain.filter((m) => m !== preferred)];
  return ordered.filter((id, i) => {
    const entry = getModelEntry(id);
    if (entry.kind !== 'embedding') return false;
    // Keep the caller's choice even if unconfigured, so the error names it.
    return i === 0 || isProviderConfigured(entry.provider);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function embedWithModel(
  modelId: string,
  texts: string[],
  opts: EmbedOptions,
): Promise<EmbeddingResponse> {
  const { provider } = providerForModel(modelId);
  if (!provider.embed) {
    throw new ProviderError({
      kind: 'unsupported',
      provider: getModelEntry(modelId).provider,
      message: `${modelId} does not support embeddings.`,
      retryable: false,
    });
  }

  const vectors: number[][] = [];
  let inputTokens = 0;
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const res = await provider.embed({
      texts: batch,
      model: modelId,
      taskType: opts.taskType ?? 'document',
      signal: opts.signal,
    });
    vectors.push(...res.vectors);
    inputTokens += res.usage.inputTokens ?? 0;
  }
  return {
    vectors,
    usage: { inputTokens, outputTokens: 0 },
    model: modelId,
    provider: getModelEntry(modelId).provider,
  };
}

export async function embed(texts: string[], opts: EmbedOptions = {}): Promise<EmbedResult> {
  if (!texts.length) {
    const model = opts.model ?? appConfig().defaults.embeddingModel;
    const entry = getModelEntry(model);
    return { vectors: [], model, provider: entry.provider, dimensions: entry.dimensions ?? 0, costUsd: 0 };
  }

  const requested = opts.model ?? appConfig().defaults.embeddingModel;
  const candidates = chain(requested);
  const policy = defaultRetryPolicy();
  const requestId = currentTenant().requestId;
  let lastError: unknown;

  for (let hop = 0; hop < candidates.length; hop++) {
    const modelId = candidates[hop]!;
    const entry = getModelEntry(modelId);

    for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
      const startedAt = new Date();
      const t0 = performance.now();
      try {
        const res = await embedWithModel(modelId, texts, opts);
        const latencyMs = performance.now() - t0;

        recordUsage({
          requestId,
          conversationId: opts.conversationId ?? null,
          kind: 'embedding',
          provider: entry.provider,
          modelId,
          startedAt,
          latencyMs,
          usage: res.usage,
          finishReason: 'stop',
          retryCount: attempt - 1,
          fallbackFrom: hop > 0 ? requested : null,
        });

        const dimensions = res.vectors[0]?.length ?? entry.dimensions ?? 0;
        return {
          vectors: res.vectors,
          model: modelId,
          provider: entry.provider,
          dimensions,
          costUsd: computeCost(modelId, res.usage).totalUsd,
          ...(hop > 0 ? { fallbackFrom: requested } : {}),
        };
      } catch (err) {
        lastError = err;
        recordUsage({
          requestId,
          conversationId: opts.conversationId ?? null,
          kind: 'embedding',
          provider: entry.provider,
          modelId,
          startedAt,
          latencyMs: performance.now() - t0,
          finishReason: 'error',
          retryCount: attempt - 1,
          fallbackFrom: hop > 0 ? requested : null,
          errorKind: isProviderError(err) ? err.kind : 'server_error',
        });

        if (isProviderError(err) && err.kind === 'cancelled') throw err;
        if (attempt < policy.maxAttempts && shouldRetry(err, policy)) {
          await sleep(computeBackoff(attempt, policy, (err as ProviderError).retryAfterMs));
          continue;
        }
        logger.warn('embeddings.model_failed', { modelId, error: (err as Error).message });
        break;
      }
    }
  }

  throw lastError ?? new ProviderError({ kind: 'server_error', provider: 'polyglot', message: 'No embedding provider available.' });
}

/**
 * The embedding model a new collection should use: the caller's choice if
 * usable, otherwise the first configured entry in the chain. This is what makes
 * "clone the repo, add no keys, upload a document" work end to end.
 */
export function resolveEmbeddingModel(requested?: string): string {
  const cfg = appConfig();
  const preferred = requested ?? cfg.defaults.embeddingModel;
  const entry = getModelEntry(preferred);
  if (entry.kind !== 'embedding') {
    throw new ProviderError({
      kind: 'bad_request',
      provider: entry.provider,
      message: `${preferred} is not an embedding model.`,
      retryable: false,
    });
  }
  if (isProviderConfigured(entry.provider)) return preferred;

  const usable = chain(preferred).find((id) => isProviderConfigured(getModelEntry(id).provider));
  if (!usable) {
    throw new ProviderError({
      kind: 'auth',
      provider: entry.provider,
      message: 'No embedding provider is configured. Set OPENAI_API_KEY or GEMINI_API_KEY, or use local:hash-embedding-384.',
      retryable: false,
    });
  }
  logger.warn('embeddings.substituted', { requested: preferred, using: usable });
  return usable;
}
