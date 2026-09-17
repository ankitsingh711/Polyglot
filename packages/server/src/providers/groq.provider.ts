import { registerProvider } from '../core/registry.js';
import { OpenAICompatibleProvider } from './_shared/openai-compatible.js';
import type { CompletionRequest, ProviderInit } from '../core/types.js';

/**
 * Groq. OpenAI-compatible surface, different models and much tighter rate limits.
 *
 * Groq-only behaviour worth encoding:
 *  - no `/embeddings` endpoint;
 *  - final usage may arrive as `x_groq.usage` rather than `usage` (handled in the
 *    shared base, which reads both);
 *  - the free tier 429s frequently and sends a `retry-after` we must honour —
 *    that is why `retry.respectRetryAfter` exists in config/app.json;
 *  - `gpt-oss` models reject `max_tokens` and require `max_completion_tokens`.
 */
class GroqProvider extends OpenAICompatibleProvider {
  constructor(init: ProviderInit) {
    super(init, { supportsEmbeddings: false, reasoningField: 'reasoning' });
  }

  protected override buildBody(req: CompletionRequest, stream: boolean): Record<string, unknown> {
    const body = super.buildBody(req, stream);
    const entry = this.init.lookup(req.model);
    if (entry.providerModelId.startsWith('openai/gpt-oss') && 'max_tokens' in body) {
      body.max_completion_tokens = body.max_tokens;
      delete body.max_tokens;
    }
    return body;
  }
}

registerProvider('groq', (init) => new GroqProvider(init));
