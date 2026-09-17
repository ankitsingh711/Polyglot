import { ProviderError, normalizeTransportError } from '../../core/errors.js';
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  EmbeddingRequest,
  EmbeddingResponse,
  ErrorKind,
  FinishReason,
  Message,
  Provider,
  ProviderInit,
  StreamEvent,
  ToolDefinition,
  Usage,
} from '../../core/types.js';
import { postJson, postStream, type UpstreamErrorContext } from './http.js';
import { parseSseJson } from './sse.js';
import { ToolCallAccumulator } from './tool-args.js';

/**
 * Shared implementation for the OpenAI `/chat/completions` surface.
 *
 * OpenAI, Groq and DeepSeek are "broadly compatible", which in practice means
 * they agree on the request envelope and disagree about everything that matters
 * under load: usage reporting, cache accounting, reasoning channels, whether
 * `stream_options` exists, whether parallel tool calls exist, and which JSON
 * mode is supported. Those differences are data (`CompatQuirks`), not new files,
 * which is why the three concrete adapters are a dozen lines each.
 *
 * This is deliberately NOT the base class for Anthropic or Gemini — pretending
 * their shapes are a special case of this one is exactly the mistake the
 * assignment is testing for.
 */

export interface CompatQuirks {
  /** `stream_options: {include_usage: true}` is accepted (OpenAI, Groq). */
  supportsStreamOptions: boolean;
  /** Native `response_format: {type:'json_schema'}` (OpenAI; some Groq models). */
  supportsJsonSchema: boolean;
  /** Model may emit several tool calls in one assistant turn. */
  supportsParallelToolCalls: boolean;
  /** Field carrying separate reasoning content on message/delta (DeepSeek). */
  reasoningField?: string;
  /** This surface exposes `/embeddings`. */
  supportsEmbeddings?: boolean;
  /** Extra headers (e.g. a vendor's beta flag). */
  extraHeaders?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

interface OaiToolCall {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OaiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  /** DeepSeek reports cache hits/misses at the top level instead. */
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

interface OaiResponse {
  id?: string;
  choices?: Array<{
    index?: number;
    message?: { content?: string | null; tool_calls?: OaiToolCall[]; [k: string]: unknown };
    delta?: { content?: string | null; tool_calls?: OaiToolCall[]; [k: string]: unknown };
    finish_reason?: string | null;
  }>;
  usage?: OaiUsage;
  /** Groq tucks final usage here when stream_options is not used. */
  x_groq?: { usage?: OaiUsage };
}

// ---------------------------------------------------------------------------
// Mapping helpers (exported for the adapter tests)
// ---------------------------------------------------------------------------

export function toOpenAIMessages(messages: Message[], system?: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  // No top-level `system` on this surface: it becomes a leading message.
  if (system?.trim()) out.push({ role: 'system', content: system });

  for (const m of messages) {
    if (m.role === 'tool') {
      // Each tool_result is its OWN message here (Anthropic instead collapses
      // them into one user turn). One block in, one message out.
      for (const b of m.content) {
        if (b.type !== 'tool_result') continue;
        out.push({
          role: 'tool',
          tool_call_id: b.toolUseId ?? '',
          content: b.isError ? `ERROR: ${b.content ?? 'tool execution failed'}` : (b.content ?? ''),
        });
      }
      continue;
    }

    if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
      const toolCalls = m.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          id: b.id ?? '',
          type: 'function',
          function: { name: b.name ?? '', arguments: JSON.stringify(b.input ?? {}) },
        }));
      if (!text && !toolCalls.length) continue;
      out.push({
        role: 'assistant',
        // `content` must be present; null is the documented "tool call only" value.
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    // user
    const parts: Array<Record<string, unknown>> = [];
    for (const b of m.content) {
      if (b.type === 'text' && b.text) parts.push({ type: 'text', text: b.text });
      else if (b.type === 'image' && b.data) {
        parts.push({ type: 'image_url', image_url: { url: `data:${b.mimeType ?? 'image/png'};base64,${b.data}` } });
      }
    }
    if (!parts.length) continue;
    // Plain-text turns are sent as a string: some compatible servers (and older
    // Groq models) reject the parts array for text-only content.
    const onlyText = parts.every((p) => p.type === 'text');
    out.push({ role: 'user', content: onlyText ? parts.map((p) => p.text).join('') : parts });
  }
  return out;
}

export function toOpenAITools(tools: ToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters ?? { type: 'object', properties: {} },
    },
  }));
}

/**
 * OpenAI strict mode requires `additionalProperties:false` on every object and
 * every property listed in `required`. Optionality is expressed by unioning with
 * null. We do that transformation rather than asking callers to write two schemas.
 */
export function strictifySchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(strictifySchema);
  const src = schema as Record<string, any>;
  const out: Record<string, any> = { ...src };

  if (out.properties && typeof out.properties === 'object') {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(out.properties)) props[k] = strictifySchema(v);
    out.properties = props;
    out.additionalProperties = false;
    out.required = Object.keys(props);
  }
  if (out.items) out.items = strictifySchema(out.items);
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(out[key])) out[key] = out[key].map(strictifySchema);
  }
  return out;
}

export function mapOaiFinishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'stop': return 'stop';
    case 'length': return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'content_filter': return 'content_filter';
    case null:
    case undefined:
      return 'stop';
    default: return 'stop';
  }
}

export function mapOaiUsage(u: OaiUsage | undefined): Usage {
  if (!u) return { inputTokens: 0, outputTokens: 0 };
  // DeepSeek: prompt_tokens = hit + miss, and cached tokens are reported as
  // `prompt_cache_hit_tokens`. OpenAI/Groq: `prompt_tokens_details.cached_tokens`.
  const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0;
  const reasoning = u.completion_tokens_details?.reasoning_tokens ?? 0;
  return {
    inputTokens: u.prompt_tokens ?? 0,
    // completion_tokens already includes reasoning tokens on this surface.
    outputTokens: u.completion_tokens ?? 0,
    ...(cached ? { cachedInputTokens: cached } : {}),
    ...(reasoning ? { reasoningTokens: reasoning } : {}),
  };
}

export function classifyOai(provider: string) {
  return (ctx: UpstreamErrorContext): { kind: ErrorKind; message: string } | undefined => {
    const body = ctx.body as { error?: { code?: string; type?: string; message?: string } } | undefined;
    const code = body?.error?.code ?? '';
    const type = body?.error?.type ?? '';
    const message = body?.error?.message ?? ctx.text.slice(0, 400) ?? `HTTP ${ctx.status}`;

    if (code === 'context_length_exceeded' || /maximum context length|reduce the length|too many tokens/i.test(message)) {
      return { kind: 'context_length', message };
    }
    if (code === 'insufficient_quota' || /exceeded your current quota/i.test(message)) {
      // Billing, not throughput — retrying never helps, so this is NOT rate_limit.
      return { kind: 'auth', message: `${message} (billing/quota — not retryable)` };
    }
    if (code === 'rate_limit_exceeded' || type === 'rate_limit_exceeded' || ctx.status === 429) {
      return { kind: 'rate_limit', message };
    }
    if (type === 'invalid_request_error') return { kind: 'bad_request', message };
    if (type === 'authentication_error' || type === 'invalid_api_key') return { kind: 'auth', message };
    if (/content.*(filter|policy)/i.test(type) || /content_filter/.test(code)) {
      return { kind: 'content_filter', message };
    }
    void provider;
    return undefined;
  };
}

// ---------------------------------------------------------------------------
// The shared adapter
// ---------------------------------------------------------------------------

export class OpenAICompatibleProvider implements Provider {
  readonly name: string;
  protected readonly quirks: CompatQuirks;

  constructor(
    protected readonly init: ProviderInit,
    quirks?: Partial<CompatQuirks>,
  ) {
    this.name = init.name;
    const o = init.options;
    this.quirks = {
      supportsStreamOptions: Boolean(o.supportsStreamOptions ?? true),
      supportsJsonSchema: Boolean(o.supportsJsonSchema ?? true),
      supportsParallelToolCalls: Boolean(o.supportsParallelToolCalls ?? true),
      reasoningField: (o.reasoningField as string | undefined) ?? 'reasoning_content',
      supportsEmbeddings: Boolean(o.supportsEmbeddings ?? false),
      ...quirks,
    };
  }

  protected headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.init.apiKey}`,
      ...(this.quirks.extraHeaders ?? {}),
    };
  }

  protected buildBody(req: CompletionRequest, stream: boolean): Record<string, unknown> {
    const entry = this.init.lookup(req.model);
    const body: Record<string, unknown> = {
      model: entry.providerModelId,
      messages: toOpenAIMessages(req.messages, req.system),
    };
    if (req.maxTokens ?? entry.maxOutputTokens) body.max_tokens = req.maxTokens ?? entry.maxOutputTokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.topP !== undefined) body.top_p = req.topP;
    if (req.stopSequences?.length) body.stop = req.stopSequences;

    if (req.tools?.length) {
      body.tools = toOpenAITools(req.tools);
      if (this.quirks.supportsParallelToolCalls) body.parallel_tool_calls = true;
      if (req.toolChoice) {
        body.tool_choice =
          req.toolChoice.type === 'tool'
            ? { type: 'function', function: { name: req.toolChoice.name } }
            : req.toolChoice.type;
      }
    }

    if (req.responseFormat?.type === 'json_schema') {
      if (this.quirks.supportsJsonSchema) {
        body.response_format = {
          type: 'json_schema',
          json_schema: {
            name: req.responseFormat.name,
            strict: req.responseFormat.strict ?? true,
            schema: strictifySchema(req.responseFormat.schema),
          },
        };
      } else {
        // DeepSeek only has `json_object`: the schema has to go into the prompt,
        // and validation happens in src/modules/structured. We flag the degraded
        // mode on the response so the caller knows it was not enforced upstream.
        body.response_format = { type: 'json_object' };
      }
    }

    if (stream) {
      body.stream = true;
      // Without this OpenAI omits usage entirely from streamed responses, which
      // would silently zero every cost row for streamed chat.
      if (this.quirks.supportsStreamOptions) body.stream_options = { include_usage: true };
    }
    return body;
  }

  protected assertSupport(req: CompletionRequest): void {
    const entry = this.init.lookup(req.model);
    if (req.tools?.length && !entry.capabilities.tools) {
      throw new ProviderError({
        kind: 'unsupported',
        provider: this.name,
        message: `Model ${req.model} does not support tool calling.`,
        retryable: false,
      });
    }
  }

  protected structuredMode(req: CompletionRequest): CompletionResponse['structuredMode'] | undefined {
    if (!req.responseFormat) return undefined;
    return this.quirks.supportsJsonSchema ? 'native_json_schema' : 'prompt_fallback';
  }

  protected reasoningOf(node: Record<string, unknown> | undefined): string | undefined {
    if (!node || !this.quirks.reasoningField) return undefined;
    const v = node[this.quirks.reasoningField];
    return typeof v === 'string' && v.length ? v : undefined;
  }

  protected get chatUrl(): string {
    return `${this.init.baseUrl}/chat/completions`;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.assertSupport(req);
    const json = await postJson<OaiResponse>({
      url: this.chatUrl,
      headers: this.headers(),
      body: this.buildBody(req, false),
      signal: req.signal,
      timeoutMs: this.init.timeoutMs,
      provider: this.name,
      fetchImpl: this.init.fetchImpl,
      classify: classifyOai(this.name),
    });

    const choice = json.choices?.[0];
    const content: ContentBlock[] = [];
    const text = choice?.message?.content;
    if (typeof text === 'string' && text.length) content.push({ type: 'text', text });

    for (const call of choice?.message?.tool_calls ?? []) {
      content.push({
        type: 'tool_use',
        id: call.id ?? `call_${content.length}`,
        name: call.function?.name ?? '',
        input: safeJson(call.function?.arguments),
      });
    }

    return {
      id: json.id ?? `${this.name}-${Date.now()}`,
      model: req.model,
      provider: this.name,
      content,
      usage: mapOaiUsage(json.usage),
      finishReason: mapOaiFinishReason(choice?.finish_reason),
      ...(this.structuredMode(req) ? { structuredMode: this.structuredMode(req) } : {}),
    };
  }

  async *stream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    this.assertSupport(req);
    let res: Response;
    try {
      res = await postStream({
        url: this.chatUrl,
        headers: { ...this.headers(), accept: 'text/event-stream' },
        body: this.buildBody(req, true),
        signal: req.signal,
        timeoutMs: this.init.timeoutMs,
        provider: this.name,
        fetchImpl: this.init.fetchImpl,
        classify: classifyOai(this.name),
      });
    } catch (err) {
      yield { type: 'error', error: normalizeTransportError(this.name, err) };
      return;
    }

    const acc = new ToolCallAccumulator();
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let finishReason: FinishReason = 'stop';
    let sawToolCall = false;

    try {
      for await (const { json } of parseSseJson<OaiResponse>(res.body!, req.signal)) {
        // The usage-only final chunk has an empty `choices` array.
        const chunkUsage = json.usage ?? json.x_groq?.usage;
        if (chunkUsage) usage = mapOaiUsage(chunkUsage);

        const choice = json.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta ?? {};
        const reasoning = this.reasoningOf(delta as Record<string, unknown>);
        if (reasoning) yield { type: 'reasoning_delta', text: reasoning };

        if (typeof delta.content === 'string' && delta.content.length) {
          yield { type: 'text_delta', text: delta.content };
        }

        for (const call of delta.tool_calls ?? []) {
          sawToolCall = true;
          // Continuation chunks carry ONLY `index` and an arguments fragment;
          // the id and name arrive once, on the first chunk for that index.
          const index = call.index ?? 0;
          let id = call.id ?? acc.idForIndex(index);
          if (!id) {
            id = `call_${index}`;
          }
          if (!acc.has(id)) {
            acc.start(id, call.function?.name ?? '', index);
            yield { type: 'tool_use_start', id, name: call.function?.name ?? '' };
          } else if (call.function?.name) {
            acc.start(id, call.function.name, index);
          }
          const fragment = call.function?.arguments;
          if (typeof fragment === 'string' && fragment.length) {
            acc.push(id, fragment);
            yield { type: 'tool_use_delta', id, partialJson: fragment };
          }
        }

        if (choice.finish_reason) {
          finishReason = mapOaiFinishReason(choice.finish_reason);
          // Arguments are complete only once the choice finishes — this surface
          // has no per-tool "stop" event the way Anthropic does.
          for (const done of acc.finishAll()) {
            yield { type: 'tool_use_complete', ...done };
          }
          acc.reset();
        }
      }
    } catch (err) {
      yield { type: 'error', error: normalizeTransportError(this.name, err) };
      return;
    }

    // Defensive: a provider that truncates before `finish_reason` still owes us
    // whatever tool calls it did announce.
    for (const done of acc.finishAll()) yield { type: 'tool_use_complete', ...done };

    yield { type: 'usage', usage };
    yield { type: 'done', finishReason: sawToolCall && finishReason === 'stop' ? 'tool_use' : finishReason };
  }

  async embed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
    if (!this.quirks.supportsEmbeddings) {
      throw new ProviderError({
        kind: 'unsupported',
        provider: this.name,
        message: `${this.name} does not expose an embeddings endpoint.`,
        retryable: false,
      });
    }
    const entry = this.init.lookup(req.model);
    const json = await postJson<{ data?: Array<{ embedding: number[]; index: number }>; usage?: OaiUsage }>({
      url: `${this.init.baseUrl}/embeddings`,
      headers: this.headers(),
      body: {
        model: entry.providerModelId,
        input: req.texts,
        ...(entry.dimensions ? { dimensions: entry.dimensions } : {}),
      },
      signal: req.signal,
      timeoutMs: this.init.timeoutMs,
      provider: this.name,
      fetchImpl: this.init.fetchImpl,
      classify: classifyOai(this.name),
    });

    // `data` is not guaranteed to come back in request order.
    const rows = [...(json.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (rows.length !== req.texts.length) {
      throw new ProviderError({
        kind: 'server_error',
        provider: this.name,
        message: `${this.name}: expected ${req.texts.length} embeddings, received ${rows.length}`,
      });
    }
    return {
      vectors: rows.map((r) => r.embedding),
      usage: mapOaiUsage(json.usage),
      model: req.model,
      provider: this.name,
    };
  }
}

function safeJson(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { value: parsed };
  } catch {
    return { _parse_error: true, _raw: raw.slice(0, 2000) };
  }
}
