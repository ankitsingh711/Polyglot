import { registerProvider } from '../core/registry.js';
import { OpenAICompatibleProvider } from './_shared/openai-compatible.js';
import type { ProviderInit } from '../core/types.js';

/**
 * DeepSeek. OpenAI-compatible envelope, three real divergences:
 *
 *  1. `reasoning_content` is a SEPARATE channel on the message/delta. It must be
 *     surfaced to the user but must NOT be echoed back in the next request —
 *     DeepSeek 400s if a prior assistant turn contains it. Polyglot's contract
 *     keeps reasoning out of `Message.content` entirely (it rides the
 *     `reasoning_delta` stream event and is persisted in its own column), so the
 *     round-trip is safe by construction.
 *  2. Cache accounting is `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
 *     at the top level of `usage`, not `prompt_tokens_details.cached_tokens`.
 *  3. Only `response_format: {type:'json_object'}` — there is no native JSON
 *     Schema, so structured output degrades to prompt + validate + retry.
 *
 * `deepseek-reasoner` additionally does not support function calling at all;
 * that is declared as `capabilities.tools: false` in config/models.json and the
 * shared base turns it into an `unsupported` ProviderError the UI can explain.
 */
class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(init: ProviderInit) {
    super(init, {
      supportsStreamOptions: false,
      supportsJsonSchema: false,
      supportsParallelToolCalls: false,
      supportsEmbeddings: false,
      reasoningField: 'reasoning_content',
    });
  }
}

registerProvider('deepseek', (init) => new DeepSeekProvider(init));
