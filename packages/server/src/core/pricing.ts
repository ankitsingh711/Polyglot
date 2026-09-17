import { getModelEntry } from './registry.js';
import type { ModelEntry, Usage } from './types.js';

/**
 * Cost computation.
 *
 * The one invariant that makes this work across vendors: by the time `Usage`
 * leaves an adapter, `inputTokens` is the TOTAL prompt size, and
 * `cachedInputTokens` / `cacheWriteTokens` are subsets of it.
 *
 * Anthropic does not report it that way (its `input_tokens` excludes both cache
 * buckets), so `anthropic.provider.ts` adds them before handing the usage over.
 * Doing that normalization in the adapter rather than here is deliberate: the
 * billing layer should not need a `if (provider === 'anthropic')` branch, and the
 * next adapter someone writes gets the rule from the type, not from tribal memory.
 */

export interface CostBreakdown {
  inputUsd: number;
  outputUsd: number;
  cachedInputUsd: number;
  cacheWriteUsd: number;
  totalUsd: number;
  /** True when the model has no cached-input price but reported cached tokens. */
  approximated: boolean;
}

const ZERO: CostBreakdown = {
  inputUsd: 0, outputUsd: 0, cachedInputUsd: 0, cacheWriteUsd: 0, totalUsd: 0, approximated: false,
};

export function computeCostForEntry(entry: ModelEntry, usage: Usage | undefined): CostBreakdown {
  if (!usage) return { ...ZERO };
  const p = entry.pricing;

  const cached = Math.max(0, usage.cachedInputTokens ?? 0);
  const written = Math.max(0, usage.cacheWriteTokens ?? 0);
  // Fresh (full-price) input is whatever was not served from, or written to, cache.
  const fresh = Math.max(0, usage.inputTokens - cached - written);

  const cachedRate = p.cachedInputPerMTok;
  const writeRate = p.cacheWritePerMTok;
  const approximated = (cached > 0 && cachedRate === undefined) || (written > 0 && writeRate === undefined);

  const inputUsd = (fresh / 1_000_000) * p.inputPerMTok;
  // No cached rate published → bill at the normal input rate rather than free.
  const cachedInputUsd = (cached / 1_000_000) * (cachedRate ?? p.inputPerMTok);
  const cacheWriteUsd = (written / 1_000_000) * (writeRate ?? p.inputPerMTok);
  // Reasoning tokens are billed as output everywhere we support, and every
  // adapter already folds them into outputTokens, so no double count here.
  const outputUsd = (Math.max(0, usage.outputTokens) / 1_000_000) * p.outputPerMTok;

  const totalUsd = inputUsd + cachedInputUsd + cacheWriteUsd + outputUsd;
  return { inputUsd, outputUsd, cachedInputUsd, cacheWriteUsd, totalUsd, approximated };
}

export function computeCost(modelId: string, usage: Usage | undefined): CostBreakdown {
  try {
    return computeCostForEntry(getModelEntry(modelId), usage);
  } catch {
    // An unknown model must not take down metrics recording.
    return { ...ZERO, approximated: true };
  }
}

/** USD, rounded for display without losing sub-cent precision. */
export function formatUsd(value: number): string {
  if (value === 0) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(6)}`;
  return `$${value.toFixed(4)}`;
}

/**
 * Pre-flight estimate used by the per-request cost cap. Deliberately pessimistic:
 * it assumes the full `maxTokens` output budget is spent.
 */
export function estimateMaxCost(modelId: string, promptTokens: number, maxOutputTokens: number): number {
  try {
    const entry = getModelEntry(modelId);
    return (
      (promptTokens / 1_000_000) * entry.pricing.inputPerMTok +
      (maxOutputTokens / 1_000_000) * entry.pricing.outputPerMTok
    );
  } catch {
    return 0;
  }
}
