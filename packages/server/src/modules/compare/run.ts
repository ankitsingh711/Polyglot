import { appConfig } from '../../core/config.js';
import { AppError, isProviderError, scrubSecrets } from '../../core/errors.js';
import { streamCompletion, type GatewayEvent } from '../../core/gateway.js';
import { computeCost } from '../../core/pricing.js';
import { getModelEntry, isProviderConfigured } from '../../core/registry.js';
import type { Usage } from '../../core/types.js';

/**
 * Side-by-side comparison (optional extra).
 *
 * The same prompt goes to several models CONCURRENTLY and their streams are
 * multiplexed onto one SSE channel, tagged with a lane id, so the UI can render
 * parallel columns that fill at their real relative speeds. Running them
 * sequentially would make the latency column meaningless, which is most of what
 * a comparison is for.
 *
 * Fallback is DISABLED here on purpose: a comparison that silently substitutes a
 * different model is not a comparison. A lane that fails reports its failure,
 * which is itself a useful result.
 */

export interface CompareEvent {
  lane: string;
  model: string;
  provider: string;
  event:
    | { type: 'delta'; text: string }
    | { type: 'reasoning'; text: string }
    | { type: 'usage'; usage: Usage; costUsd: number; ttftMs: number | null; latencyMs: number }
    | { type: 'done'; finishReason: string }
    | { type: 'error'; kind: string; message: string };
}

export interface CompareInput {
  prompt: string;
  system?: string;
  models: string[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

const MAX_LANES = 4;

/**
 * Merge N async generators into one, yielding whichever produces next. Written
 * out rather than pulled from a library because the ordering guarantee is the
 * whole feature: we always await the full set of in-flight `next()` promises and
 * yield the first to settle, so a fast lane never waits on a slow one.
 */
async function* merge<T>(sources: Array<AsyncGenerator<T>>): AsyncGenerator<T> {
  type Pending = { index: number; result: IteratorResult<T> };
  const pending = new Map<number, Promise<Pending>>();

  sources.forEach((source, index) => {
    pending.set(index, source.next().then((result) => ({ index, result })));
  });

  while (pending.size) {
    const { index, result } = await Promise.race(pending.values());
    if (result.done) {
      pending.delete(index);
      continue;
    }
    yield result.value;
    pending.set(index, sources[index]!.next().then((r) => ({ index, result: r })));
  }
}

async function* runLane(lane: string, modelId: string, input: CompareInput): AsyncGenerator<CompareEvent> {
  const entry = getModelEntry(modelId);
  const base = { lane, model: modelId, provider: entry.provider };
  const t0 = performance.now();
  let ttftMs: number | null = null;
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };

  try {
    const stream = streamCompletion(
      {
        model: modelId,
        system: input.system,
        messages: [{ role: 'user', content: [{ type: 'text', text: input.prompt }] }],
        maxTokens: input.maxTokens ?? appConfig().defaults.maxTokens,
        temperature: input.temperature ?? appConfig().defaults.temperature,
        signal: input.signal,
      },
      // No fallback: a substituted model would silently invalidate the comparison.
      { kind: 'compare', disableFallback: true },
    );

    for await (const event of stream as AsyncGenerator<GatewayEvent>) {
      switch (event.type) {
        case 'text_delta':
          if (ttftMs === null) ttftMs = Math.round(performance.now() - t0);
          yield { ...base, event: { type: 'delta', text: event.text } };
          break;
        case 'reasoning_delta':
          if (ttftMs === null) ttftMs = Math.round(performance.now() - t0);
          yield { ...base, event: { type: 'reasoning', text: event.text } };
          break;
        case 'usage':
          usage = event.usage;
          break;
        case 'done':
          yield {
            ...base,
            event: {
              type: 'usage',
              usage,
              costUsd: computeCost(modelId, usage).totalUsd,
              ttftMs,
              latencyMs: Math.round(performance.now() - t0),
            },
          };
          yield { ...base, event: { type: 'done', finishReason: event.finishReason } };
          break;
        case 'error':
          yield {
            ...base,
            event: { type: 'error', kind: event.error.kind, message: scrubSecrets(event.error.message) },
          };
          break;
        default:
          break;
      }
    }
  } catch (err) {
    yield {
      ...base,
      event: {
        type: 'error',
        kind: isProviderError(err) ? err.kind : 'server_error',
        message: scrubSecrets((err as Error).message),
      },
    };
  }
}

/**
 * Validation is separate from execution so a bad request can be answered with a
 * real HTTP status. Once the SSE headers are flushed the status line is spent,
 * and a 400 delivered as an event on a 200 response is a worse API.
 */
export function validateCompareModels(models: string[]): string[] {
  const unique = [...new Set(models)].slice(0, MAX_LANES);
  if (unique.length < 2) {
    throw new AppError(400, 'too_few_models', 'Pick at least two models to compare.');
  }
  for (const modelId of unique) {
    const entry = getModelEntry(modelId);
    if (entry.kind === 'embedding') {
      throw new AppError(400, 'not_a_chat_model', `${modelId} is an embedding model.`);
    }
    if (!isProviderConfigured(entry.provider)) {
      throw new AppError(400, 'provider_not_configured', `No API key is configured for ${entry.provider} (${modelId}).`);
    }
  }
  return unique;
}

export function runComparison(input: CompareInput): AsyncGenerator<CompareEvent> {
  const models = validateCompareModels(input.models);
  return merge(models.map((modelId, i) => runLane(`lane${i + 1}`, modelId, input)));
}
