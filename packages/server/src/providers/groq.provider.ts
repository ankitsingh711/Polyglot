import { registerProvider } from '../core/registry.js';
import { OpenAICompatibleProvider } from './_shared/openai-compatible.js';
import type { ProviderInit } from '../core/types.js';

/**
 * Groq. OpenAI-compatible surface, different models and much tighter rate limits.
 *
 * Groq-only behaviour worth encoding:
 *  - no `/embeddings` endpoint;
 *  - final usage may arrive as `x_groq.usage` rather than `usage` (handled in the
 *    shared base, which reads both);
 *  - the free tier 429s frequently and sends a `retry-after` we must honour —
 *    that is why `retry.respectRetryAfter` exists in config/app.json.
 *
 * This adapter used to rename `max_tokens` to `max_completion_tokens` for model
 * ids starting with `openai/gpt-oss`. That branch is gone: it was the only place
 * in the codebase that read a vendor model id as a string, and re-checking it
 * against the live API showed every Groq chat model now accepts `max_tokens`.
 * A capability that varies per model belongs in config/models.json, not in a
 * prefix match that silently stops matching when a vendor renames something.
 */
class GroqProvider extends OpenAICompatibleProvider {
  constructor(init: ProviderInit) {
    super(init, { supportsEmbeddings: false, reasoningField: 'reasoning' });
  }
}

registerProvider('groq', (init) => new GroqProvider(init));
