import { registerProvider } from '../core/registry.js';
import { ProviderError, normalizeTransportError } from '../core/errors.js';
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
} from '../core/types.js';
import { postJson, postStream, type UpstreamErrorContext } from './_shared/http.js';
import { parseSseJson } from './_shared/sse.js';

/**
 * Google Gemini adapter.  https://ai.google.dev/api/generate-content
 *
 * Gemini disagrees with everyone else about nearly every noun. What this adapter
 * absorbs:
 *
 *  1. Roles are `user` / `model` — there is no `assistant` and no `tool` role.
 *  2. Content is `contents[].parts[]`, not `content[]`; text is `{text}`, images
 *     are `{inlineData}`, tool calls are `{functionCall}`, results `{functionResponse}`.
 *  3. System prompt is `systemInstruction`, a Content object, not a string.
 *  4. Tool schemas are an OpenAPI 3.0 dialect, NOT JSON Schema. `additionalProperties`,
 *     `$schema`, `$defs`, `const` and friends are hard errors. See `toGeminiSchema`.
 *  5. `functionResponse` correlates by NAME, not by call id — so we have to look the
 *     name back up from the originating `tool_use` block.
 *  6. Function-call arguments are NOT streamed incrementally; the whole `args`
 *     object lands in one chunk. We synthesize start/delta/complete so callers
 *     never learn the difference.
 *  7. Usage lives in `usageMetadata` and `candidatesTokenCount` is cumulative
 *     across stream chunks, not per-chunk.
 */

interface GeminiPart {
  text?: string;
  thought?: boolean;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
}
interface GeminiContent { role?: 'user' | 'model'; parts: GeminiPart[] }

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
}

interface GeminiResponse {
  candidates?: Array<{ content?: GeminiContent; finishReason?: string; index?: number }>;
  usageMetadata?: GeminiUsageMetadata;
  promptFeedback?: { blockReason?: string };
  responseId?: string;
}

// ---------------------------------------------------------------------------
// Schema translation: JSON Schema → Gemini's OpenAPI 3.0 `Schema`
// ---------------------------------------------------------------------------

const GEMINI_TYPES: Record<string, string> = {
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
  array: 'ARRAY',
  object: 'OBJECT',
};

/**
 * Keys Gemini rejects outright (or silently mis-handles) rather than ignoring.
 * `toGeminiSchema` is an allow-list, so these are dropped by construction; the
 * set is kept as executable documentation and is asserted in the adapter tests.
 */
export const GEMINI_UNSUPPORTED_SCHEMA_KEYS = new Set([
  '$schema', '$id', '$ref', '$defs', 'definitions', 'additionalProperties',
  'const', 'examples', 'default', 'patternProperties', 'allOf', 'not',
  'if', 'then', 'else', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'uniqueItems', 'contentEncoding', 'contentMediaType', 'title',
]);

/**
 * Recursively translate a JSON Schema into the subset Gemini accepts.
 * Silently dropping unknown keywords is the right call here: the alternative is
 * a 400 that the caller cannot act on, because the caller wrote valid JSON Schema.
 */
export function toGeminiSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  const src = schema as Record<string, any>;
  const out: Record<string, unknown> = {};

  // `type` may be a union like ["string","null"]; Gemini wants one type + nullable.
  let type = src.type;
  if (Array.isArray(type)) {
    const nonNull = type.filter((t) => t !== 'null');
    if (type.includes('null')) out.nullable = true;
    type = nonNull[0];
  }
  if (typeof type === 'string' && GEMINI_TYPES[type]) out.type = GEMINI_TYPES[type];

  if (typeof src.description === 'string') out.description = src.description;
  if (Array.isArray(src.enum) && src.enum.length) {
    out.enum = src.enum.map(String);
    out.type = out.type ?? 'STRING';
  }
  // Gemini supports only `enum` and `date-time` for `format` on STRING.
  if (typeof src.format === 'string' && (src.format === 'date-time' || src.format === 'enum')) {
    out.format = src.format;
  }
  if (out.type === 'INTEGER' || out.type === 'NUMBER') {
    if (typeof src.minimum === 'number') out.minimum = src.minimum;
    if (typeof src.maximum === 'number') out.maximum = src.maximum;
  }
  if (typeof src.minItems === 'number') out.minItems = String(src.minItems);
  if (typeof src.maxItems === 'number') out.maxItems = String(src.maxItems);

  if (src.properties && typeof src.properties === 'object') {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src.properties)) {
      const child = toGeminiSchema(v);
      if (child) props[k] = child;
    }
    if (Object.keys(props).length) {
      out.properties = props;
      out.type = out.type ?? 'OBJECT';
      // Order matters to Gemini for reproducibility; declare it explicitly.
      out.propertyOrdering = Object.keys(props);
    }
  }
  if (Array.isArray(src.required) && src.required.length) out.required = src.required.map(String);

  if (src.items) {
    const items = toGeminiSchema(src.items);
    if (items) {
      out.items = items;
      out.type = out.type ?? 'ARRAY';
    }
  }
  if (Array.isArray(src.anyOf)) {
    const variants = src.anyOf.map((v: unknown) => toGeminiSchema(v)).filter(Boolean);
    if (variants.length) out.anyOf = variants;
  }
  // `oneOf` has no Gemini equivalent; anyOf is the closest honest mapping.
  if (Array.isArray(src.oneOf) && !out.anyOf) {
    const variants = src.oneOf.map((v: unknown) => toGeminiSchema(v)).filter(Boolean);
    if (variants.length) out.anyOf = variants;
  }

  if (!out.type && !out.anyOf) return undefined;
  return out;
}

export function toGeminiTools(tools: ToolDefinition[]): Array<Record<string, unknown>> {
  return [
    {
      functionDeclarations: tools.map((t) => {
        const params = toGeminiSchema(t.parameters);
        const hasProps = params && typeof params === 'object' && Object.keys((params as any).properties ?? {}).length > 0;
        return {
          name: t.name,
          description: t.description,
          // Gemini 400s on `{"type":"OBJECT","properties":{}}` — a zero-argument
          // tool must omit `parameters` entirely.
          ...(hasProps ? { parameters: params } : {}),
        };
      }),
    },
  ];
}

// ---------------------------------------------------------------------------
// Message translation
// ---------------------------------------------------------------------------

/**
 * Gemini's `functionResponse` is keyed by function NAME. Our contract keys tool
 * results by `toolUseId`, so we walk the history to recover the name each id
 * belongs to. Without this, results silently attach to the wrong tool.
 */
function buildToolNameIndex(messages: Message[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'tool_use' && b.id) index.set(b.id, b.name ?? '');
    }
  }
  return index;
}

export function toGeminiContents(messages: Message[]): GeminiContent[] {
  const toolNames = buildToolNameIndex(messages);
  const out: GeminiContent[] = [];

  for (const m of messages) {
    const role: 'user' | 'model' = m.role === 'assistant' ? 'model' : 'user';
    const parts: GeminiPart[] = [];

    for (const b of m.content) {
      switch (b.type) {
        case 'text':
          if (b.text?.trim()) parts.push({ text: b.text });
          break;
        case 'image':
          if (b.data) parts.push({ inlineData: { mimeType: b.mimeType ?? 'image/png', data: b.data } });
          break;
        case 'tool_use':
          parts.push({
            functionCall: {
              ...(b.id ? { id: b.id } : {}),
              name: b.name ?? '',
              args: b.input ?? {},
            },
          });
          break;
        case 'tool_result': {
          const name = (b.toolUseId && toolNames.get(b.toolUseId)) || b.name || 'unknown_tool';
          parts.push({
            functionResponse: {
              ...(b.toolUseId ? { id: b.toolUseId } : {}),
              name,
              // `response` must be an object. Tool output is a string in our
              // contract, so it is wrapped — and errors are flagged in-band
              // because Gemini has no `is_error` equivalent.
              response: b.isError
                ? { error: b.content ?? 'tool execution failed' }
                : { result: b.content ?? '' },
            },
          });
          break;
        }
      }
    }

    if (!parts.length) continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else out.push({ role, parts });
  }
  return out;
}

export function mapGeminiFinishReason(reason: string | undefined): FinishReason {
  switch (reason) {
    case 'STOP': return 'stop';
    case 'MAX_TOKENS': return 'max_tokens';
    case 'SAFETY':
    case 'RECITATION':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'BLOCKLIST':
      return 'content_filter';
    case 'MALFORMED_FUNCTION_CALL':
      return 'error';
    case undefined:
      return 'stop';
    default:
      return 'stop';
  }
}

export function mapGeminiUsage(u: GeminiUsageMetadata | undefined): Usage {
  const cached = u?.cachedContentTokenCount ?? 0;
  const thoughts = u?.thoughtsTokenCount ?? 0;
  return {
    // promptTokenCount already INCLUDES cachedContentTokenCount (unlike Anthropic).
    inputTokens: u?.promptTokenCount ?? 0,
    // candidatesTokenCount excludes thinking tokens, which are billed as output.
    outputTokens: (u?.candidatesTokenCount ?? 0) + thoughts,
    ...(cached ? { cachedInputTokens: cached } : {}),
    ...(thoughts ? { reasoningTokens: thoughts } : {}),
  };
}

function classify(ctx: UpstreamErrorContext): { kind: ErrorKind; message: string } | undefined {
  const body = ctx.body as { error?: { status?: string; message?: string } } | undefined;
  const status = body?.error?.status ?? '';
  const message = body?.error?.message ?? ctx.text.slice(0, 400) ?? `HTTP ${ctx.status}`;

  if (/token count|exceeds the maximum number of tokens|input token count/i.test(message)) {
    return { kind: 'context_length', message };
  }
  const map: Record<string, ErrorKind> = {
    UNAUTHENTICATED: 'auth',
    PERMISSION_DENIED: 'auth',
    INVALID_ARGUMENT: 'bad_request',
    NOT_FOUND: 'bad_request',
    FAILED_PRECONDITION: 'bad_request',
    RESOURCE_EXHAUSTED: 'rate_limit',
    UNAVAILABLE: 'server_error',
    INTERNAL: 'server_error',
    DEADLINE_EXCEEDED: 'timeout',
  };
  const kind = map[status];
  return kind ? { kind, message } : undefined;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

class GoogleProvider implements Provider {
  readonly name: string;

  constructor(private readonly init: ProviderInit) {
    this.name = init.name;
  }

  private get apiVersion(): string {
    return String(this.init.options.apiVersion ?? 'v1beta');
  }

  private headers(): Record<string, string> {
    // Header auth, never `?key=` — query strings end up in proxy and CDN logs.
    return { 'content-type': 'application/json', 'x-goog-api-key': this.init.apiKey };
  }

  private buildBody(req: CompletionRequest): Record<string, unknown> {
    const entry = this.init.lookup(req.model);
    const generationConfig: Record<string, unknown> = {};
    if (req.maxTokens ?? entry.maxOutputTokens) {
      generationConfig.maxOutputTokens = req.maxTokens ?? entry.maxOutputTokens;
    }
    if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
    if (req.topP !== undefined) generationConfig.topP = req.topP;
    if (req.stopSequences?.length) generationConfig.stopSequences = req.stopSequences;

    const body: Record<string, unknown> = { contents: toGeminiContents(req.messages) };
    if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };

    if (req.responseFormat?.type === 'json_schema') {
      // Gemini's native structured output. Note it cannot be combined with tools.
      generationConfig.responseMimeType = 'application/json';
      generationConfig.responseSchema = toGeminiSchema(req.responseFormat.schema);
    } else if (req.tools?.length) {
      body.tools = toGeminiTools(req.tools);
      const mode =
        req.toolChoice?.type === 'none' ? 'NONE'
        : req.toolChoice?.type === 'required' ? 'ANY'
        : req.toolChoice?.type === 'tool' ? 'ANY'
        : 'AUTO';
      body.toolConfig = {
        functionCallingConfig: {
          mode,
          ...(req.toolChoice?.type === 'tool' ? { allowedFunctionNames: [req.toolChoice.name] } : {}),
        },
      };
    }

    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
    return body;
  }

  private assertToolSupport(req: CompletionRequest): void {
    const entry = this.init.lookup(req.model);
    if (req.tools?.length && !entry.capabilities.tools) {
      throw new ProviderError({
        kind: 'unsupported',
        provider: this.name,
        message: `Model ${req.model} does not support tool calling.`,
        retryable: false,
      });
    }
    if (req.tools?.length && req.responseFormat) {
      throw new ProviderError({
        kind: 'unsupported',
        provider: this.name,
        message: 'Gemini cannot combine responseSchema with function declarations in one call.',
        retryable: false,
      });
    }
  }

  private url(req: CompletionRequest, streaming: boolean): string {
    const entry = this.init.lookup(req.model);
    const method = streaming ? 'streamGenerateContent' : 'generateContent';
    // `alt=sse` turns the default streamed-JSON-array into real SSE frames.
    const qs = streaming ? '?alt=sse' : '';
    return `${this.init.baseUrl}/${this.apiVersion}/models/${encodeURIComponent(entry.providerModelId)}:${method}${qs}`;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.assertToolSupport(req);
    const json = await postJson<GeminiResponse>({
      url: this.url(req, false),
      headers: this.headers(),
      body: this.buildBody(req),
      signal: req.signal,
      timeoutMs: this.init.timeoutMs,
      provider: this.name,
      fetchImpl: this.init.fetchImpl,
      classify,
    });

    const candidate = json.candidates?.[0];
    const content: ContentBlock[] = [];
    let seq = 0;
    for (const part of candidate?.content?.parts ?? []) {
      if (part.functionCall) {
        content.push({
          type: 'tool_use',
          // Gemini often omits an id; synthesize a stable one so the rest of the
          // system (and the other providers on replay) can correlate results.
          id: part.functionCall.id ?? `gemini_call_${seq++}`,
          name: part.functionCall.name,
          input: part.functionCall.args ?? {},
        });
      } else if (typeof part.text === 'string' && part.text.length && !part.thought) {
        content.push({ type: 'text', text: part.text });
      }
    }

    // A prompt blocked before generation returns no candidate at all.
    if (!candidate && json.promptFeedback?.blockReason) {
      throw new ProviderError({
        kind: 'content_filter',
        provider: this.name,
        message: `${this.name}: prompt blocked (${json.promptFeedback.blockReason})`,
        retryable: false,
        raw: json.promptFeedback,
      });
    }

    return {
      id: json.responseId ?? `google-${Date.now()}`,
      model: req.model,
      provider: this.name,
      content,
      usage: mapGeminiUsage(json.usageMetadata),
      finishReason: content.some((c) => c.type === 'tool_use')
        ? 'tool_use'
        : mapGeminiFinishReason(candidate?.finishReason),
      ...(req.responseFormat ? { structuredMode: 'response_schema' as const } : {}),
    };
  }

  async *stream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    this.assertToolSupport(req);
    let res: Response;
    try {
      res = await postStream({
        url: this.url(req, true),
        headers: { ...this.headers(), accept: 'text/event-stream' },
        body: this.buildBody(req),
        signal: req.signal,
        timeoutMs: this.init.timeoutMs,
        provider: this.name,
        fetchImpl: this.init.fetchImpl,
        classify,
      });
    } catch (err) {
      yield { type: 'error', error: normalizeTransportError(this.name, err) };
      return;
    }

    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let finishReason: FinishReason = 'stop';
    let sawToolCall = false;
    let seq = 0;

    try {
      for await (const { json } of parseSseJson<GeminiResponse>(res.body!, req.signal)) {
        if (json.promptFeedback?.blockReason) {
          yield {
            type: 'error',
            error: new ProviderError({
              kind: 'content_filter',
              provider: this.name,
              message: `${this.name}: prompt blocked (${json.promptFeedback.blockReason})`,
              retryable: false,
              raw: json.promptFeedback,
            }),
          };
          return;
        }

        const candidate = json.candidates?.[0];
        for (const part of candidate?.content?.parts ?? []) {
          if (part.functionCall) {
            sawToolCall = true;
            const id = part.functionCall.id ?? `gemini_call_${seq++}`;
            const name = part.functionCall.name;
            const args = part.functionCall.args ?? {};
            // Gemini delivers the whole args object at once. We still emit the
            // three-event sequence so downstream consumers have exactly one
            // code path for tool streaming regardless of vendor.
            yield { type: 'tool_use_start', id, name };
            yield { type: 'tool_use_delta', id, partialJson: JSON.stringify(args) };
            yield { type: 'tool_use_complete', id, name, input: args };
          } else if (typeof part.text === 'string' && part.text.length) {
            if (part.thought) yield { type: 'reasoning_delta', text: part.text };
            else yield { type: 'text_delta', text: part.text };
          }
        }

        // usageMetadata is cumulative and repeats on every chunk; last one wins.
        if (json.usageMetadata) usage = mapGeminiUsage(json.usageMetadata);
        if (candidate?.finishReason) finishReason = mapGeminiFinishReason(candidate.finishReason);
      }
    } catch (err) {
      yield { type: 'error', error: normalizeTransportError(this.name, err) };
      return;
    }

    yield { type: 'usage', usage };
    yield { type: 'done', finishReason: sawToolCall ? 'tool_use' : finishReason };
  }

  async embed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
    const entry = this.init.lookup(req.model);
    const taskType = req.taskType === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT';
    const json = await postJson<{ embeddings?: Array<{ values: number[] }> }>({
      url: `${this.init.baseUrl}/${this.apiVersion}/models/${encodeURIComponent(entry.providerModelId)}:batchEmbedContents`,
      headers: this.headers(),
      body: {
        requests: req.texts.map((text) => ({
          model: `models/${entry.providerModelId}`,
          content: { parts: [{ text }] },
          taskType,
          ...(entry.dimensions ? { outputDimensionality: entry.dimensions } : {}),
        })),
      },
      signal: req.signal,
      timeoutMs: this.init.timeoutMs,
      provider: this.name,
      fetchImpl: this.init.fetchImpl,
      classify,
    });

    const vectors = (json.embeddings ?? []).map((e) => e.values);
    if (vectors.length !== req.texts.length) {
      throw new ProviderError({
        kind: 'server_error',
        provider: this.name,
        message: `${this.name}: expected ${req.texts.length} embeddings, received ${vectors.length}`,
      });
    }
    return {
      vectors,
      // Gemini's batch embed endpoint does not report token usage; we estimate
      // from characters so the cost column is not silently zero.
      usage: { inputTokens: Math.ceil(req.texts.join(' ').length / 4), outputTokens: 0 },
      model: req.model,
      provider: this.name,
    };
  }
}

registerProvider('google', (init) => new GoogleProvider(init));
