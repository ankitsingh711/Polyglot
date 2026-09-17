import { appConfig } from './config.js';
import { AppError, ProviderError, isProviderError, scrubSecrets } from './errors.js';
import { computeCost, estimateMaxCost } from './pricing.js';
import { getModelEntry, isProviderConfigured, providerForModel } from './registry.js';
import { computeBackoff, defaultRetryPolicy, shouldRetry, type RetryPolicy } from './retry.js';
import { estimateConversationTokens } from './tokens.js';
import type {
  CompletionRequest,
  CompletionResponse,
  ErrorKind,
  FinishReason,
  StreamEvent,
  Usage,
} from './types.js';
import { recordUsage, spendToday, type UsageKind } from '../modules/metrics/store.js';
import { currentTenant } from '../tenancy/context.js';
import { logger } from '../util/logger.js';

/**
 * The gateway is the only thing in Polyglot that calls a Provider.
 *
 * Everything that is true of EVERY model call lives here exactly once:
 * retry with jittered backoff, the fallback chain, per-request cost caps,
 * cancellation, timing (including time-to-first-token), and writing the usage row.
 *
 * Routes and feature modules describe WHAT they want; they never learn which
 * vendor answered, how many times we retried, or what it cost.
 */

export type GatewayEvent =
  | StreamEvent
  | { type: 'meta'; model: string; provider: string; attempt: number; fallbackFrom?: string }
  | { type: 'retry'; attempt: number; delayMs: number; kind: ErrorKind; provider: string; message: string }
  | { type: 'fallback'; from: string; to: string; kind: ErrorKind; message: string };

export interface GatewayCallOptions {
  kind: UsageKind;
  requestId?: string;
  conversationId?: string | null;
  /** Skip the fallback chain (comparison mode wants the model it asked for). */
  disableFallback?: boolean;
  policy?: RetryPolicy;
  /** Extra tool-call count to attribute to this usage row. */
  toolCallCount?: number;
}

/** Errors that justify trying the NEXT provider rather than failing the request. */
const FALLBACK_KINDS: ReadonlySet<ErrorKind> = new Set<ErrorKind>([
  'rate_limit',
  'server_error',
  'timeout',
  // A provider with no key (or a revoked one) should not take the request down
  // when another provider in the chain is configured and healthy.
  'auth',
]);

function shouldFallback(err: unknown): err is ProviderError {
  return isProviderError(err) && FALLBACK_KINDS.has(err.kind);
}

/** Primary model first, then its configured chain, filtered to the possible. */
export function resolveCandidates(modelId: string, disableFallback = false): string[] {
  const cfg = appConfig().fallback;
  const chain = [modelId];
  if (!disableFallback && cfg.enabled) {
    for (const next of cfg.chains[modelId] ?? []) {
      if (chain.length > cfg.maxHops) break;
      if (!chain.includes(next)) chain.push(next);
    }
  }
  // Keep the primary even if unconfigured so the user gets a truthful error when
  // nothing in the chain is usable; drop unconfigured FALLBACK targets, because
  // hopping to a provider we have no key for only wastes the user's time.
  return chain.filter((id, i) => i === 0 || isProviderConfigured(getModelEntry(id).provider));
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });

function assertBudget(modelId: string, req: CompletionRequest): void {
  const limits = appConfig().limits;
  const entry = getModelEntry(modelId);
  const promptTokens = estimateConversationTokens(req.messages, req.system);
  const worstCase = estimateMaxCost(modelId, promptTokens, req.maxTokens ?? entry.maxOutputTokens ?? 2048);

  if (worstCase > limits.maxCostPerRequestUsd) {
    throw new AppError(
      402,
      'request_cost_cap',
      `This request could cost up to $${worstCase.toFixed(4)}, above the per-request cap of $${limits.maxCostPerRequestUsd.toFixed(2)}. ` +
        'Shorten the conversation, reduce maxTokens, or choose a cheaper model.',
      { estimatedUsd: worstCase, cap: limits.maxCostPerRequestUsd, promptTokens },
    );
  }

  const spent = spendToday();
  if (spent + worstCase > limits.tenantDailyBudgetUsd) {
    throw new AppError(
      402,
      'tenant_budget_exceeded',
      `Tenant daily budget of $${limits.tenantDailyBudgetUsd.toFixed(2)} would be exceeded (spent $${spent.toFixed(4)} today).`,
      { spentTodayUsd: spent, cap: limits.tenantDailyBudgetUsd },
    );
  }
}

/** A stream event that means "the model has started answering". */
function isContentEvent(e: StreamEvent): boolean {
  return e.type === 'text_delta' || e.type === 'reasoning_delta' || e.type === 'tool_use_start';
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/**
 * Stream a completion, transparently retrying and falling back.
 *
 * The important subtlety: a stream can only be retried while it is COLD, i.e.
 * before a single token has reached the caller. Once we have emitted content,
 * replaying the call would duplicate output, so from that point on errors are
 * surfaced rather than papered over. This is why the loop buffers nothing and
 * flips `committed` on the first content event.
 */
/**
 * Bind a provider-agnostic request to ONE concrete model.
 *
 * This is the only place a request is specialised, and it runs on every hop --
 * which matters, because a fallback can land on a model whose capabilities
 * differ from the one the caller asked for. Sending `temperature` to a model
 * that has deprecated it is a hard 400 on Anthropic, so the chain would turn a
 * recoverable outage into a dead end if the parameter were carried over blindly.
 *
 * Capabilities are read from config, never inferred from the model id.
 */
function bindToModel(req: CompletionRequest, modelId: string): CompletionRequest {
  const caps = getModelEntry(modelId).capabilities;
  const bound: CompletionRequest = { ...req, model: modelId };
  if (caps.temperature === false) delete bound.temperature;
  return bound;
}

export async function* streamCompletion(
  req: CompletionRequest,
  opts: GatewayCallOptions,
): AsyncGenerator<GatewayEvent> {
  const policy = opts.policy ?? defaultRetryPolicy();
  const requestId = opts.requestId ?? currentTenant().requestId;
  const candidates = resolveCandidates(req.model, opts.disableFallback);
  const requested = req.model;

  assertBudget(requested, req);

  let lastError: ProviderError | undefined;
  let retryCount = 0;

  for (let hop = 0; hop < candidates.length; hop++) {
    const modelId = candidates[hop]!;
    const entry = getModelEntry(modelId);

    for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
      const startedAt = new Date();
      const t0 = performance.now();
      let ttftMs: number | null = null;
      let usage: Usage = { inputTokens: 0, outputTokens: 0 };
      let finishReason: FinishReason = 'stop';
      let committed = false;
      let toolCalls = 0;
      let streamError: ProviderError | undefined;

      /*
       * Exactly one usage row per attempt, whatever happens to this generator.
       *
       * A cancelled turn used to land in the metrics panel as a clean `stop`
       * with no error kind -- indistinguishable from a turn that ran to
       * completion, which is the one thing an observability panel must never do.
       * Two things make that easy to get wrong: the caller abandoning the
       * generator (`break` out of `for await`) unwinds through `return()`, which
       * runs `finally` but NOT the code after the loop; and a provider that
       * simply stops yielding when its socket dies looks, from here, exactly
       * like a provider that finished.
       */
      let recorded = false;
      const record = (over: { finishReason?: FinishReason; errorKind?: ErrorKind | null }) => {
        if (recorded) return;
        recorded = true;
        recordUsage({
          requestId,
          conversationId: opts.conversationId ?? null,
          kind: opts.kind,
          provider: entry.provider,
          modelId,
          startedAt,
          ttftMs,
          latencyMs: performance.now() - t0,
          usage,
          finishReason: over.finishReason ?? finishReason,
          retryCount,
          fallbackFrom: hop > 0 ? requested : null,
          errorKind: over.errorKind ?? null,
          toolCallCount: toolCalls + (opts.toolCallCount ?? 0),
        });
      };

      try {
        const { provider } = providerForModel(modelId);
        yield {
          type: 'meta',
          model: modelId,
          provider: entry.provider,
          attempt,
          ...(hop > 0 ? { fallbackFrom: requested } : {}),
        };

        const iterable = provider.stream(bindToModel(req, modelId));

        for await (const event of iterable) {
          if (event.type === 'error') {
            // In-band error. Cold → retry/fallback; hot → surface to the caller.
            streamError = event.error as ProviderError;
            if (!committed) break;
            yield event;
            break;
          }
          if (!committed && isContentEvent(event)) {
            committed = true;
            ttftMs = Math.round(performance.now() - t0);
          }
          if (event.type === 'tool_use_complete') toolCalls++;
          if (event.type === 'usage') usage = event.usage;
          if (event.type === 'done') finishReason = event.finishReason;
          yield event;
        }

        if (streamError && !committed) throw streamError;

        // The caller's signal firing mid-stream is a cancellation even when the
        // adapter returned quietly rather than throwing.
        const cancelled = !streamError && req.signal?.aborted === true;
        record({
          finishReason: streamError || cancelled ? 'error' : finishReason,
          errorKind: streamError?.kind ?? (cancelled ? 'cancelled' : null),
        });

        if (streamError) return; // hot failure already surfaced
        return;
      } catch (err) {
        const perr = isProviderError(err) ? err : new ProviderError({
          kind: 'server_error',
          provider: entry.provider,
          message: (err as Error).message,
          raw: err,
        });
        lastError = perr;

        record({ finishReason: 'error', errorKind: perr.kind });

        if (perr.kind === 'cancelled') return;

        const canRetry = attempt < policy.maxAttempts && shouldRetry(perr, policy);
        if (canRetry) {
          const delayMs = computeBackoff(attempt, policy, perr.retryAfterMs);
          retryCount++;
          logger.warn('gateway.retry', { modelId, attempt, delayMs, kind: perr.kind });
          yield { type: 'retry', attempt, delayMs, kind: perr.kind, provider: entry.provider, message: scrubSecrets(perr.message) };
          try {
            await sleep(delayMs, req.signal);
          } catch {
            return; // aborted while backing off
          }
          continue;
        }

        const nextModel = candidates[hop + 1];
        if (nextModel && shouldFallback(perr)) {
          logger.warn('gateway.fallback', { from: modelId, to: nextModel, kind: perr.kind });
          yield { type: 'fallback', from: modelId, to: nextModel, kind: perr.kind, message: scrubSecrets(perr.message) };
        }
        break; // exit attempt loop → next candidate (or out of candidates)
      } finally {
        // Reached when the CALLER abandons this generator: `break` inside their
        // `for await` unwinds through `return()`, so neither branch above ran.
        // The turn still happened and still cost money, so it still gets a row.
        record({ finishReason: 'error', errorKind: 'cancelled' });
      }
    }

    if (lastError && !shouldFallback(lastError)) break; // permanent failure: stop walking the chain
  }

  yield {
    type: 'error',
    error:
      lastError ??
      new ProviderError({ kind: 'server_error', provider: 'polyglot', message: 'No provider was able to serve this request.' }),
  };
}

// ---------------------------------------------------------------------------
// Non-streaming
// ---------------------------------------------------------------------------

export interface GatewayCompletion extends CompletionResponse {
  /** The model originally requested, when a fallback answered instead. */
  fallbackFrom?: string;
  retryCount: number;
  latencyMs: number;
  costUsd: number;
}

export async function complete(req: CompletionRequest, opts: GatewayCallOptions): Promise<GatewayCompletion> {
  const policy = opts.policy ?? defaultRetryPolicy();
  const requestId = opts.requestId ?? currentTenant().requestId;
  const candidates = resolveCandidates(req.model, opts.disableFallback);
  const requested = req.model;

  assertBudget(requested, req);

  let lastError: ProviderError | undefined;
  let retryCount = 0;

  for (let hop = 0; hop < candidates.length; hop++) {
    const modelId = candidates[hop]!;
    const entry = getModelEntry(modelId);

    for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
      const startedAt = new Date();
      const t0 = performance.now();
      try {
        const { provider } = providerForModel(modelId);
        const res = await provider.complete(bindToModel(req, modelId));
        const latencyMs = performance.now() - t0;

        recordUsage({
          requestId,
          conversationId: opts.conversationId ?? null,
          kind: opts.kind,
          provider: entry.provider,
          modelId,
          startedAt,
          ttftMs: null,
          latencyMs,
          usage: res.usage,
          finishReason: res.finishReason,
          retryCount,
          fallbackFrom: hop > 0 ? requested : null,
          toolCallCount: res.content.filter((c) => c.type === 'tool_use').length + (opts.toolCallCount ?? 0),
        });

        return {
          ...res,
          retryCount,
          latencyMs,
          costUsd: computeCost(modelId, res.usage).totalUsd,
          ...(hop > 0 ? { fallbackFrom: requested } : {}),
        };
      } catch (err) {
        const perr = isProviderError(err)
          ? err
          : new ProviderError({ kind: 'server_error', provider: entry.provider, message: (err as Error).message, raw: err });
        lastError = perr;

        recordUsage({
          requestId,
          conversationId: opts.conversationId ?? null,
          kind: opts.kind,
          provider: entry.provider,
          modelId,
          startedAt,
          ttftMs: null,
          latencyMs: performance.now() - t0,
          finishReason: 'error',
          retryCount,
          fallbackFrom: hop > 0 ? requested : null,
          errorKind: perr.kind,
        });

        if (perr.kind === 'cancelled') throw perr;

        if (attempt < policy.maxAttempts && shouldRetry(perr, policy)) {
          const delayMs = computeBackoff(attempt, policy, perr.retryAfterMs);
          retryCount++;
          logger.warn('gateway.retry', { modelId, attempt, delayMs, kind: perr.kind });
          await sleep(delayMs, req.signal);
          continue;
        }
        break;
      }
    }

    if (lastError && !shouldFallback(lastError)) break;
  }

  throw lastError ?? new ProviderError({ kind: 'server_error', provider: 'polyglot', message: 'No provider available.' });
}
