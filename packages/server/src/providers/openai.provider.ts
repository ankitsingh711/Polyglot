import { registerProvider } from '../core/registry.js';
import { OpenAICompatibleProvider } from './_shared/openai-compatible.js';
import type { CompletionRequest, ProviderInit } from '../core/types.js';

/**
 * OpenAI `/v1/chat/completions`.
 *
 * Everything structural is in `_shared/openai-compatible.ts`. What remains here
 * is genuinely OpenAI-only: the reasoning-model parameter rename.
 */
class OpenAIProvider extends OpenAICompatibleProvider {
  constructor(init: ProviderInit) {
    super(init, {
      supportsStreamOptions: true,
      supportsJsonSchema: true,
      supportsParallelToolCalls: true,
      supportsEmbeddings: true,
      // OpenAI puts reasoning token COUNTS in usage but does not stream reasoning
      // text, so there is no reasoning field to read off the delta.
      reasoningField: undefined,
    });
  }

  protected override buildBody(req: CompletionRequest, stream: boolean): Record<string, unknown> {
    const body = super.buildBody(req, stream);
    const entry = this.init.lookup(req.model);

    // o-series / GPT-5 reasoning models renamed `max_tokens` and reject a
    // non-default `temperature` outright (400, not a warning).
    if (entry.capabilities.reasoning) {
      if ('max_tokens' in body) {
        body.max_completion_tokens = body.max_tokens;
        delete body.max_tokens;
      }
      delete body.temperature;
      delete body.top_p;
    }
    return body;
  }
}

registerProvider('openai', (init) => new OpenAIProvider(init));
