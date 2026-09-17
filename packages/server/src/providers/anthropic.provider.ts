import { registerProvider } from '../core/registry.js';
import { ProviderError, normalizeTransportError } from '../core/errors.js';
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
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
import { ToolCallAccumulator } from './_shared/tool-args.js';

/**
 * Anthropic Messages API adapter.  https://docs.anthropic.com/en/api/messages
 *
 * The three things this adapter absorbs so nothing above it has to care:
 *
 *  1. `system` is a TOP-LEVEL parameter, not a message with role "system".
 *  2. There is no `tool` role. A tool result is a `tool_result` content block
 *     inside a USER message — which also means several parallel tool results
 *     collapse into one user turn.
 *  3. `usage.input_tokens` EXCLUDES cache reads and cache writes. Billed input is
 *     `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`.
 *     Getting this wrong under-reports cost by up to 90% on cached workloads.
 */

// ---------------------------------------------------------------------------
// Wire types (kept local — nothing outside this file may import them)
// ---------------------------------------------------------------------------

interface AnthropicTextBlock { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
interface AnthropicImageBlock { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
interface AnthropicToolUseBlock { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Array<{ type: 'text'; text: string }>;
  is_error?: boolean;
}
type AnthropicBlock = AnthropicTextBlock | AnthropicImageBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

interface AnthropicMessage { role: 'user' | 'assistant'; content: AnthropicBlock[] }

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface AnthropicResponse {
  id: string;
  model: string;
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
  stop_reason: string | null;
  usage: AnthropicUsage;
}

const MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// ---------------------------------------------------------------------------
// Request mapping
// ---------------------------------------------------------------------------

function toAnthropicBlocks(blocks: ContentBlock[], role: 'user' | 'assistant'): AnthropicBlock[] {
  const out: AnthropicBlock[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'text': {
        const text = b.text ?? '';
        // Anthropic rejects empty text blocks, and rejects trailing whitespace on
        // a final assistant turn (it reads as a prefill continuation).
        if (!text.trim()) continue;
        out.push({ type: 'text', text: role === 'assistant' ? text.replace(/\s+$/, '') : text });
        break;
      }
      case 'image': {
        if (!b.data) continue;
        const media = b.mimeType && MEDIA_TYPES.has(b.mimeType) ? b.mimeType : 'image/png';
        out.push({ type: 'image', source: { type: 'base64', media_type: media, data: b.data } });
        break;
      }
      case 'tool_use':
        out.push({ type: 'tool_use', id: b.id ?? '', name: b.name ?? '', input: b.input ?? {} });
        break;
      case 'tool_result':
        out.push({
          type: 'tool_result',
          tool_use_id: b.toolUseId ?? '',
          content: b.content ?? '',
          ...(b.isError ? { is_error: true } : {}),
        });
        break;
    }
  }
  return out;
}

/**
 * Polyglot messages → Anthropic messages.
 * Our `tool` role becomes a user turn; consecutive same-role turns are merged
 * because Anthropic bills and behaves better with strict alternation.
 */
export function toAnthropicMessages(messages: Message[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const m of messages) {
    const role: 'user' | 'assistant' = m.role === 'assistant' ? 'assistant' : 'user';
    const blocks = toAnthropicBlocks(m.content, role);
    if (!blocks.length) continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  }
  // A conversation must open with a user turn.
  if (out.length && out[0]!.role === 'assistant') {
    out.unshift({ role: 'user', content: [{ type: 'text', text: '(continue)' }] });
  }
  return out;
}

export function toAnthropicTools(tools: ToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    // Anthropic calls it `input_schema`, not `parameters`.
    input_schema: t.parameters ?? { type: 'object', properties: {} },
  }));
}

function toAnthropicToolChoice(req: CompletionRequest): Record<string, unknown> | undefined {
  if (!req.toolChoice) return undefined;
  switch (req.toolChoice.type) {
    case 'auto': return { type: 'auto' };
    case 'none': return { type: 'none' };
    // Anthropic spells "you must call some tool" as `any`, not `required`.
    case 'required': return { type: 'any' };
    case 'tool': return { type: 'tool', name: req.toolChoice.name };
  }
}

/** Anthropic has no `stop_reason` for tool errors; the set below is complete. */
export function mapStopReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'max_tokens';
    case 'tool_use':
    case 'pause_turn':
      return 'tool_use';
    case 'refusal':
      return 'content_filter';
    case null:
    case undefined:
      return 'stop';
    default:
      return 'stop';
  }
}

export function mapUsage(u: AnthropicUsage | undefined): Usage {
  const fresh = u?.input_tokens ?? 0;
  const cacheRead = u?.cache_read_input_tokens ?? 0;
  const cacheWrite = u?.cache_creation_input_tokens ?? 0;
  return {
    // Normalized meaning across Polyglot: inputTokens is the total prompt size.
    // Anthropic reports the three buckets separately and they do NOT overlap.
    inputTokens: fresh + cacheRead + cacheWrite,
    outputTokens: u?.output_tokens ?? 0,
    ...(cacheRead ? { cachedInputTokens: cacheRead } : {}),
    ...(cacheWrite ? { cacheWriteTokens: cacheWrite } : {}),
  };
}

/** Anthropic's error envelope is more specific than its HTTP status. */
function classify(ctx: UpstreamErrorContext): { kind: ErrorKind; message: string } | undefined {
  const body = ctx.body as { error?: { type?: string; message?: string } } | undefined;
  const type = body?.error?.type ?? '';
  const message = body?.error?.message ?? ctx.text.slice(0, 400) ?? `HTTP ${ctx.status}`;

  // A too-long prompt is a 400 `invalid_request_error`, which would otherwise be
  // classified `bad_request` and never trigger our truncation path.
  if (/prompt is too long|exceeds the maximum|input length and `max_tokens`/i.test(message)) {
    return { kind: 'context_length', message };
  }
  const map: Record<string, ErrorKind> = {
    authentication_error: 'auth',
    permission_error: 'auth',
    invalid_request_error: 'bad_request',
    not_found_error: 'bad_request',
    request_too_large: 'context_length',
    rate_limit_error: 'rate_limit',
    api_error: 'server_error',
    overloaded_error: 'rate_limit',
    timeout_error: 'timeout',
  };
  const kind = map[type];
  return kind ? { kind, message } : undefined;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

class AnthropicProvider implements Provider {
  readonly name: string;

  constructor(private readonly init: ProviderInit) {
    this.name = init.name;
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-api-key': this.init.apiKey,
      'anthropic-version': String(this.init.options.apiVersion ?? '2023-06-01'),
    };
  }

  private buildBody(req: CompletionRequest, stream: boolean): Record<string, unknown> {
    const entry = this.init.lookup(req.model);
    const cacheMin = Number(this.init.options.promptCacheMinChars ?? 2000);

    const body: Record<string, unknown> = {
      model: entry.providerModelId,
      // Required by Anthropic, optional everywhere else. Falling back to the
      // model's own ceiling keeps the rest of the app from having to know.
      max_tokens: req.maxTokens ?? entry.maxOutputTokens ?? 4096,
      messages: toAnthropicMessages(req.messages),
    };

    if (req.system) {
      // Prompt caching: a long system prompt (RAG context, tool preamble) is
      // marked cacheable so repeat turns are billed at the cache-read rate.
      body.system =
        entry.capabilities.promptCaching && req.system.length >= cacheMin
          ? [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }]
          : req.system;
    }
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.topP !== undefined) body.top_p = req.topP;
    if (req.stopSequences?.length) body.stop_sequences = req.stopSequences;

    const tools = [...(req.tools ?? [])];
    let toolChoice = toAnthropicToolChoice(req);

    // Anthropic has no native JSON-schema response format. The supported route is
    // tool-forcing: declare the schema as a single tool and require it.
    if (req.responseFormat?.type === 'json_schema') {
      tools.length = 0;
      tools.push({
        name: req.responseFormat.name,
        description: 'Return the extracted data using this schema.',
        parameters: req.responseFormat.schema,
      });
      toolChoice = { type: 'tool', name: req.responseFormat.name };
    }

    if (tools.length) {
      body.tools = toAnthropicTools(tools);
      if (toolChoice) body.tool_choice = toolChoice;
    }
    if (stream) body.stream = true;
    return body;
  }

  private assertToolSupport(req: CompletionRequest): void {
    const entry = this.init.lookup(req.model);
    if ((req.tools?.length || req.responseFormat) && !entry.capabilities.tools) {
      throw new ProviderError({
        kind: 'unsupported',
        provider: this.name,
        message: `Model ${req.model} does not support tool calling.`,
        retryable: false,
      });
    }
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.assertToolSupport(req);
    const json = await postJson<AnthropicResponse>({
      url: `${this.init.baseUrl}/v1/messages`,
      headers: this.headers(),
      body: this.buildBody(req, false),
      signal: req.signal,
      timeoutMs: this.init.timeoutMs,
      provider: this.name,
      fetchImpl: this.init.fetchImpl,
      classify,
    });

    const content: ContentBlock[] = [];
    for (const block of json.content ?? []) {
      if (block.type === 'text' && block.text) content.push({ type: 'text', text: block.text });
      else if (block.type === 'tool_use') {
        content.push({ type: 'tool_use', id: block.id ?? '', name: block.name ?? '', input: block.input ?? {} });
      }
    }

    return {
      id: json.id ?? `anthropic-${Date.now()}`,
      model: req.model,
      provider: this.name,
      content,
      usage: mapUsage(json.usage),
      finishReason: mapStopReason(json.stop_reason),
      ...(req.responseFormat ? { structuredMode: 'tool_forcing' as const } : {}),
    };
  }

  async *stream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    this.assertToolSupport(req);
    let res: Response;
    try {
      res = await postStream({
        url: `${this.init.baseUrl}/v1/messages`,
        headers: { ...this.headers(), accept: 'text/event-stream' },
        body: this.buildBody(req, true),
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

    const acc = new ToolCallAccumulator();
    // Anthropic splits usage across two events: message_start carries the input
    // side, message_delta the output side. We merge and emit once, at the end.
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let finishReason: FinishReason = 'stop';
    // content_block_delta identifies its block by array index, so we keep an
    // index → tool-use-id map for the lifetime of the message.
    const indexToToolId = new Map<number, string>();
    let emittedDone = false;

    try {
      for await (const { event, json } of parseSseJson<any>(res.body!, req.signal)) {
        const type = event ?? json?.type;
        switch (type) {
          case 'message_start': {
            usage = { ...mapUsage(json?.message?.usage), outputTokens: usage.outputTokens };
            break;
          }
          case 'content_block_start': {
            const block = json?.content_block;
            if (block?.type === 'tool_use') {
              const id = String(block.id ?? `tool_${json.index}`);
              indexToToolId.set(Number(json.index), id);
              acc.start(id, String(block.name ?? ''));
              yield { type: 'tool_use_start', id, name: String(block.name ?? '') };
            }
            break;
          }
          case 'content_block_delta': {
            const delta = json?.delta;
            if (delta?.type === 'text_delta' && delta.text) {
              yield { type: 'text_delta', text: String(delta.text) };
            } else if (delta?.type === 'thinking_delta' && delta.thinking) {
              yield { type: 'reasoning_delta', text: String(delta.thinking) };
            } else if (delta?.type === 'input_json_delta') {
              const id = indexToToolId.get(Number(json.index));
              if (id) {
                const partial = String(delta.partial_json ?? '');
                acc.push(id, partial);
                yield { type: 'tool_use_delta', id, partialJson: partial };
              }
            }
            break;
          }
          case 'content_block_stop': {
            const id = indexToToolId.get(Number(json.index));
            if (id) {
              const done = acc.finish(id);
              if (done) yield { type: 'tool_use_complete', ...done };
            }
            break;
          }
          case 'message_delta': {
            if (json?.delta?.stop_reason) finishReason = mapStopReason(json.delta.stop_reason);
            if (json?.usage) {
              const partial = mapUsage(json.usage);
              // message_delta repeats output_tokens cumulatively and may re-state
              // cache counters; take the max so a missing field never zeroes us.
              usage = {
                inputTokens: Math.max(usage.inputTokens, partial.inputTokens),
                outputTokens: Math.max(usage.outputTokens, partial.outputTokens),
                ...(usage.cachedInputTokens || partial.cachedInputTokens
                  ? { cachedInputTokens: Math.max(usage.cachedInputTokens ?? 0, partial.cachedInputTokens ?? 0) }
                  : {}),
                ...(usage.cacheWriteTokens || partial.cacheWriteTokens
                  ? { cacheWriteTokens: Math.max(usage.cacheWriteTokens ?? 0, partial.cacheWriteTokens ?? 0) }
                  : {}),
              };
            }
            break;
          }
          case 'message_stop': {
            yield { type: 'usage', usage };
            yield { type: 'done', finishReason };
            emittedDone = true;
            break;
          }
          case 'error': {
            const err = json?.error ?? {};
            const kindMap: Record<string, ErrorKind> = {
              overloaded_error: 'rate_limit',
              rate_limit_error: 'rate_limit',
              api_error: 'server_error',
              invalid_request_error: 'bad_request',
              authentication_error: 'auth',
            };
            yield {
              type: 'error',
              error: new ProviderError({
                kind: kindMap[String(err.type)] ?? 'server_error',
                provider: this.name,
                message: `${this.name}: ${err.message ?? 'stream error'}`,
                raw: json,
              }),
            };
            return;
          }
          default:
            break; // ping, and anything Anthropic adds later
        }
      }
    } catch (err) {
      yield { type: 'error', error: normalizeTransportError(this.name, err) };
      return;
    }

    // Defensive: a truncated stream still owes the caller usage + done so the
    // metrics row and the UI both close out.
    if (!emittedDone) {
      yield { type: 'usage', usage };
      yield { type: 'done', finishReason };
    }
  }
}

registerProvider('anthropic', (init) => new AnthropicProvider(init));
