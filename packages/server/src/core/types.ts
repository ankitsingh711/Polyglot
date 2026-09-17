/**
 * Polyglot's provider-agnostic contract.
 *
 * Everything above the adapter layer speaks ONLY these types. No vendor shape,
 * no vendor error, and no vendor SSE frame is allowed to escape `src/providers/*`.
 * If you find yourself importing a vendor type outside an adapter, that is a bug.
 */

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type Role = 'user' | 'assistant' | 'tool';

export type ContentBlockType = 'text' | 'image' | 'tool_use' | 'tool_result';

export interface ContentBlock {
  type: ContentBlockType;

  /** type: 'text' */
  text?: string;

  /** type: 'image' — base64 payload plus its mime type. No remote URLs: we never
   *  let a provider fetch a URL on our behalf (SSRF surface, and Anthropic/Gemini
   *  disagree about whether it is even allowed). */
  mimeType?: string;
  data?: string;

  /** type: 'tool_use' — the assistant asking us to run a tool. */
  id?: string;
  name?: string;
  input?: Record<string, unknown>;

  /** type: 'tool_result' — our answer going back to the model. */
  toolUseId?: string;
  content?: string;
  isError?: boolean;

  /**
   * Opaque continuity tokens a vendor MINTED and requires back verbatim on the
   * next turn. Namespaced by provider name; only the adapter that wrote an entry
   * ever reads it, and nothing outside an adapter may interpret the contents.
   *
   * This exists because the brief's contract has no home for it and Gemini 3
   * hard-fails without it: a `functionCall` part carries a `thoughtSignature`,
   * and replaying that tool call without it returns
   *   "Function call is missing a thought_signature in functionCall parts."
   * so the second leg of EVERY multi-turn tool loop 400s. Dropping the field on
   * the way in is invisible until the model asks for a tool.
   *
   * It is namespaced rather than a bare blob because a conversation can switch
   * provider between turns (Module B) -- Anthropic must not be handed Gemini's
   * signature, and the adapter reading `providerMetadata.google` simply finds
   * nothing when the block came from somewhere else.
   */
  providerMetadata?: Record<string, Record<string, unknown>>;
}

export interface Message {
  role: Role;
  /** Always an array, even for plain text. Uniformity here is what keeps the
   *  adapters from growing `typeof x === 'string'` branches. */
  content: ContentBlock[];
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema (draft-2020-12 subset). Each adapter narrows this to whatever
   *  dialect its vendor actually accepts — see `toolSchemaForGemini`. */
  parameters: Record<string, unknown>;
}

export type ToolChoice =
  | { type: 'auto' }
  | { type: 'none' }
  | { type: 'required' }
  | { type: 'tool'; name: string };

/**
 * Structured output request. Providers implement this three different ways
 * (native json_schema, responseSchema, tool-forcing); the adapter picks the best
 * mechanism it has and reports which one it used via `structuredMode`.
 */
export interface ResponseFormat {
  type: 'json_schema';
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
}

export interface CompletionRequest {
  /** Polyglot model id, e.g. "anthropic:claude-sonnet-4-5". Never a vendor id. */
  model: string;
  messages: Message[];
  /** Top-level on purpose: Anthropic wants it there, OpenAI-compatibles want it
   *  as a leading message, Gemini wants it as `systemInstruction`. Adapter's job. */
  system?: string;
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  responseFormat?: ResponseFormat;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  /** Cancellation must reach the upstream socket, not just stop rendering. */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// What comes back
// ---------------------------------------------------------------------------

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Where the provider reports it (Anthropic cache_read, OpenAI cached_tokens,
   *  Gemini cachedContentTokenCount, DeepSeek prompt_cache_hit_tokens). */
  cachedInputTokens?: number;
  /** Tokens written into a provider-side prompt cache (Anthropic only, today). */
  cacheWriteTokens?: number;
  /** Where the provider reports it (OpenAI reasoning_tokens, Gemini thoughtsTokenCount). */
  reasoningTokens?: number;
}

export type FinishReason =
  | 'stop'
  | 'max_tokens'
  | 'tool_use'
  | 'content_filter'
  | 'error';

/**
 * `reasoning_delta` is an addition to the contract in the brief. DeepSeek's
 * reasoner and Gemini's thinking models emit chain-of-thought on a separate
 * channel; folding it into `text_delta` would corrupt the assistant turn we
 * persist and replay. See docs/DESIGN.md → "Contract deltas".
 */
export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; id: string; partialJson: string }
  | {
      type: 'tool_use_complete';
      id: string;
      name: string;
      input: Record<string, unknown>;
      /** Vendor continuity tokens to replay on the next turn. See ContentBlock. */
      providerMetadata?: Record<string, Record<string, unknown>>;
    }
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; finishReason: FinishReason }
  | { type: 'error'; error: NormalizedProviderError };

export interface CompletionResponse {
  /** Provider's own response id where it gives one, else a generated one. */
  id: string;
  /** Polyglot model id that was actually used. */
  model: string;
  provider: string;
  content: ContentBlock[];
  usage: Usage;
  finishReason: FinishReason;
  /** Which structured-output mechanism the adapter used, if any. */
  structuredMode?: 'native_json_schema' | 'response_schema' | 'tool_forcing' | 'prompt_fallback';
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'context_length'
  | 'content_filter'
  | 'timeout'
  | 'server_error'
  | 'bad_request'
  | 'cancelled'
  | 'unsupported';

export interface NormalizedProviderError extends Error {
  kind: ErrorKind;
  provider: string;
  retryable: boolean;
  retryAfterMs?: number;
  /** Kept for server-side logs. NEVER serialized to a client. */
  raw?: unknown;
  status?: number;
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

export interface EmbeddingRequest {
  texts: string[];
  /** Polyglot model id of an embedding model, e.g. "openai:text-embedding-3-small". */
  model: string;
  /** Some providers (Gemini) score query vs document differently. */
  taskType?: 'query' | 'document';
  signal?: AbortSignal;
}

export interface EmbeddingResponse {
  vectors: number[][];
  usage: Usage;
  model: string;
  provider: string;
}

// ---------------------------------------------------------------------------
// The interface every adapter implements
// ---------------------------------------------------------------------------

export interface Provider {
  readonly name: string;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
  stream(req: CompletionRequest): AsyncIterable<StreamEvent>;
  embed?(req: EmbeddingRequest): Promise<EmbeddingResponse>;
}

// ---------------------------------------------------------------------------
// Model catalog (loaded from config/models.json — never hardcoded)
// ---------------------------------------------------------------------------

export interface ModelCapabilities {
  tools: boolean;
  vision: boolean;
  jsonSchema: boolean;
  streaming: boolean;
  /** Model emits separate reasoning/thinking content. */
  reasoning?: boolean;
  /** Provider-side prompt caching is available for this model. */
  promptCaching?: boolean;
  /**
   * Whether the model accepts a `temperature` (and other sampling knobs).
   * Absent means yes -- only models that REJECT it need to say so.
   *
   * This is a capability, not a vendor quirk, which is why it lives in config
   * next to `contextWindow` rather than in an adapter: Anthropic's Sonnet 5 and
   * Opus 5 hard-400 on `temperature` ("`temperature` is deprecated for this
   * model") while Haiku 4.5, Sonnet 4.5 and Opus 4.5 on the SAME adapter accept
   * it, and OpenAI's reasoning models behave the same way. Encoding it per model
   * is the only thing that stays correct as vendors ship new generations.
   */
  temperature?: boolean;
}

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cachedInputPerMTok?: number;
  cacheWritePerMTok?: number;
  reasoningPerMTok?: number;
}

export interface ModelEntry {
  /** Registered provider name — must match a `registerProvider()` call. */
  provider: string;
  /** The id the vendor's API actually expects. */
  providerModelId: string;
  kind?: 'chat' | 'embedding';
  contextWindow: number;
  maxOutputTokens?: number;
  /** Embedding models only. */
  dimensions?: number;
  /**
   * Embedding models only. A cosine score means nothing in the absolute: a
   * relevant query/passage pair scores around 0.35 on text-embedding-3-small,
   * around 0.7 on gemini-embedding-001, and around 0.05 on the local hashed
   * embedder. The retrieval threshold therefore belongs to the MODEL, with
   * app.json's value as the fallback for models that do not declare one.
   */
  retrieval?: { defaultSimilarityThreshold: number };
  capabilities: ModelCapabilities;
  pricing: ModelPricing;
  displayName?: string;
}

export type ModelCatalog = Record<string, ModelEntry>;

/** Everything an adapter is given at construction time. */
export interface ProviderInit {
  /** Registered provider name. */
  name: string;
  apiKey: string;
  baseUrl: string;
  /** Per-request wall-clock budget, enforced by the adapter's HTTP layer. */
  timeoutMs: number;
  /** Resolve a Polyglot model id to its catalog entry. */
  lookup(modelId: string): ModelEntry;
  /** Injected so tests can drive adapters with fixtures instead of the network. */
  fetchImpl: typeof fetch;
  /** Free-form per-provider settings from config/providers.json. */
  options: Record<string, unknown>;
}

export type ProviderFactory = (init: ProviderInit) => Provider;
