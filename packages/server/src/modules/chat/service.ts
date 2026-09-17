import { appConfig } from '../../core/config.js';
import { AppError, ProviderError, isProviderError } from '../../core/errors.js';
import { streamCompletion, type GatewayEvent } from '../../core/gateway.js';
import { computeCost } from '../../core/pricing.js';
import { getModelEntry, isProviderConfigured } from '../../core/registry.js';
import type { ContentBlock, FinishReason, Message, ToolDefinition, Usage } from '../../core/types.js';
import { audit } from '../../db/index.js';
import { logger } from '../../util/logger.js';
import { getTool, toolDefinitions, type ToolExecutionContext } from '../tools/registry.js';
import { buildGroundedPrompt, extractCitedNumbers, IDK_ANSWER } from '../rag/prompt.js';
import { retrieve, type RetrievalParams, type RetrievedChunk } from '../rag/retrieve.js';
import { fitToContext } from './context-window.js';
import {
  appendMessage,
  countMessages,
  listMessages,
  requireConversation,
  toProviderMessages,
  updateConversation,
  type StoredMessage,
} from './store.js';
import { lookupSemanticCache, storeSemanticCache } from '../cache/semantic.js';

/**
 * The chat turn.
 *
 * One function owns the whole shape of a turn -- retrieval, context fitting, the
 * multi-turn tool loop, persistence and the event stream -- because these are
 * genuinely coupled: what gets retrieved changes what fits, tools change how
 * many model calls happen, and persistence must record the turn as the model
 * actually saw it or the next turn replays a fiction.
 *
 * Everything vendor-specific is already gone by the time we get here. This file
 * never learns which provider answered.
 */

export type ChatEvent =
  | { type: 'start'; conversationId: string; userMessageId: string; model: string; provider: string }
  | { type: 'meta'; model: string; provider: string; attempt: number; fallbackFrom?: string }
  | { type: 'notice'; level: 'info' | 'warn'; code: string; message: string }
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_args_delta'; id: string; partialJson: string }
  | { type: 'tool_result'; id: string; name: string; ok: boolean; preview: string; durationMs: number }
  | { type: 'citations'; citations: CitationPayload[] }
  | { type: 'retry'; attempt: number; delayMs: number; kind: string; message: string }
  | { type: 'fallback'; from: string; to: string; kind: string; message: string }
  | {
      type: 'usage';
      usage: Usage;
      costUsd: number;
      ttftMs: number | null;
      latencyMs: number;
      model: string;
      provider: string;
      cacheHit?: boolean;
    }
  | { type: 'done'; assistantMessageId: string; finishReason: FinishReason }
  | { type: 'error'; kind: string; message: string; provider: string; retryable: boolean };

export interface CitationPayload {
  number: number;
  chunkId: string;
  documentId: string;
  filename: string;
  page: number | null;
  heading: string | null;
  score: number;
  text: string;
}

export interface SendMessageInput {
  conversationId: string;
  text: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  /** Turn tool calling on for this turn. */
  useTools?: boolean;
  /** Retrieve before answering (RAG mode) rather than exposing search as a tool. */
  useRag?: boolean;
  retrieval?: Partial<RetrievalParams>;
  signal?: AbortSignal;
}

const CITATION_LIMIT = 12;

function toCitationPayload(chunks: RetrievedChunk[]): CitationPayload[] {
  return chunks.slice(0, CITATION_LIMIT).map((c, i) => ({
    number: i + 1,
    chunkId: c.chunkId,
    documentId: c.documentId,
    filename: c.filename,
    page: c.page,
    heading: c.heading,
    score: Number(c.score.toFixed(4)),
    text: c.text,
  }));
}

function textOf(blocks: ContentBlock[]): string {
  return blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
}

/**
 * Tool support is a per-MODEL capability, not a per-provider one
 * (deepseek-reasoner has no function calling while deepseek-chat does). When the
 * selected model cannot do tools we degrade to a plain turn and say why, rather
 * than sending a request the provider will reject.
 */
function resolveTools(
  model: string,
  wantTools: boolean,
  ctx: ToolExecutionContext,
): { tools: ToolDefinition[]; notice?: ChatEvent } {
  if (!wantTools) return { tools: [] };
  const entry = getModelEntry(model);
  if (!entry.capabilities.tools) {
    return {
      tools: [],
      notice: {
        type: 'notice',
        level: 'warn',
        code: 'tools_unsupported',
        message:
          `${entry.displayName ?? model} does not support tool calling, so this turn was answered without tools. ` +
          'Switch to a tool-capable model to use the calculator, weather or document search.',
      },
    };
  }
  const tools = toolDefinitions(ctx, appConfig().tools.enabled);
  return { tools };
}

export async function* sendMessage(input: SendMessageInput): AsyncGenerator<ChatEvent> {
  const cfg = appConfig();
  const conversation = requireConversation(input.conversationId);
  const text = input.text.trim();

  if (!text) throw new AppError(400, 'empty_message', 'Message text is required.');
  if (text.length > cfg.limits.maxPromptChars) {
    throw new AppError(413, 'message_too_long', `Messages must be under ${cfg.limits.maxPromptChars} characters.`);
  }
  if (countMessages(conversation.id) >= cfg.limits.maxMessagesPerConversation) {
    throw new AppError(
      429,
      'conversation_full',
      `This conversation has reached ${cfg.limits.maxMessagesPerConversation} messages. Start a new one.`,
    );
  }

  const entry = getModelEntry(input.model);
  if (!isProviderConfigured(entry.provider)) {
    throw new AppError(
      400,
      'provider_not_configured',
      `No API key is configured for ${entry.provider}. Add it to .env and restart, or pick another model.`,
    );
  }
  if (entry.kind === 'embedding') {
    throw new AppError(400, 'not_a_chat_model', `${input.model} is an embedding model and cannot be used for chat.`);
  }

  const userMessage = appendMessage(conversation.id, { role: 'user', content: [{ type: 'text', text }] });

  // First user message doubles as the conversation title until renamed.
  if (userMessage.seq === 0) {
    updateConversation(conversation.id, { title: text.slice(0, 80) });
  }

  yield { type: 'start', conversationId: conversation.id, userMessageId: userMessage.id, model: input.model, provider: entry.provider };

  const toolCtx: ToolExecutionContext = {
    signal: input.signal,
    conversationId: conversation.id,
    collectionId: conversation.collection_id,
  };

  // -------------------------------------------------------------------------
  // Retrieval (RAG mode)
  // -------------------------------------------------------------------------
  let systemPrompt = conversation.system_prompt ?? undefined;
  let citations: CitationPayload[] = [];
  let retrievedChunks: RetrievedChunk[] = [];

  if (input.useRag) {
    if (!conversation.collection_id) {
      throw new AppError(400, 'no_collection', 'Attach a document collection to this conversation before using RAG mode.');
    }
    const result = await retrieve(conversation.collection_id, text, input.retrieval ?? {}, {
      signal: input.signal,
      conversationId: conversation.id,
    });
    retrievedChunks = result.chunks;
    citations = toCitationPayload(result.chunks);

    if (result.empty) {
      // Short-circuit. Grounding beats fluency: with nothing above the
      // threshold there is nothing to ground an answer in, so we answer
      // deterministically instead of paying a provider to improvise.
      const answer =
        `${IDK_ANSWER}` +
        (result.rejected
          ? ` (${result.rejected} passage${result.rejected === 1 ? '' : 's'} were found but none cleared the similarity threshold of ${result.params.similarityThreshold}.)`
          : '');
      yield { type: 'notice', level: 'info', code: 'retrieval_empty', message: 'Retrieval returned nothing above the similarity threshold.' };
      yield { type: 'delta', text: answer };
      const stored = appendMessage(conversation.id, {
        role: 'assistant',
        content: [{ type: 'text', text: answer }],
        modelId: input.model,
        provider: entry.provider,
      });
      yield { type: 'citations', citations: [] };
      yield { type: 'done', assistantMessageId: stored.id, finishReason: 'stop' };
      return;
    }

    const grounded = buildGroundedPrompt(text, result.chunks);
    systemPrompt = systemPrompt ? `${grounded.system}\n\n--- OPERATOR INSTRUCTIONS ---\n${systemPrompt}` : grounded.system;

    if (grounded.injectionFlagged) {
      yield {
        type: 'notice',
        level: 'warn',
        code: 'injection_flagged',
        message:
          'A retrieved excerpt contains instruction-shaped text. It was neutralized and passed to the model as quoted content.',
      };
      audit('rag.injection_flagged', {
        severity: 'violation',
        resource: conversation.collection_id,
        detail: { chunkIds: result.chunks.map((c) => c.chunkId) },
      });
    }
    yield { type: 'citations', citations };
  }

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------
  const { tools, notice } = resolveTools(input.model, Boolean(input.useTools), toolCtx);
  if (notice) yield notice;

  // -------------------------------------------------------------------------
  // Semantic cache (optional extra) -- only for plain single-shot turns, since
  // a cached answer cannot honour tools or fresh retrieval.
  // -------------------------------------------------------------------------
  const cacheEligible =
    cfg.cache.semantic.enabled && !tools.length && !input.useRag && countMessages(conversation.id) <= 1;

  if (cacheEligible) {
    const hit = await lookupSemanticCache(text, input.model, { signal: input.signal, conversationId: conversation.id });
    if (hit) {
      yield { type: 'notice', level: 'info', code: 'cache_hit', message: `Served from the semantic cache (similarity ${hit.similarity.toFixed(3)}), saving $${hit.savedUsd.toFixed(6)}.` };
      yield { type: 'delta', text: hit.text };
      const stored = appendMessage(conversation.id, {
        role: 'assistant',
        content: [{ type: 'text', text: hit.text }],
        modelId: input.model,
        provider: entry.provider,
      });
      yield {
        type: 'usage',
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: 0,
        ttftMs: 0,
        latencyMs: hit.latencyMs,
        model: input.model,
        provider: entry.provider,
        cacheHit: true,
      };
      yield { type: 'done', assistantMessageId: stored.id, finishReason: 'stop' };
      return;
    }
  }

  // -------------------------------------------------------------------------
  // The tool loop
  // -------------------------------------------------------------------------
  const history: StoredMessage[] = listMessages(conversation.id);
  let working: Message[] = toProviderMessages(history);

  let finalText = '';
  let finalReasoning = '';
  let finishReason: FinishReason = 'stop';
  let lastModel = input.model;
  let lastProvider = entry.provider;
  let totalCost = 0;
  const aggregate: Usage = { inputTokens: 0, outputTokens: 0 };
  let toolIterations = 0;
  let sawError = false;

  for (let iteration = 0; iteration <= cfg.limits.maxToolIterations; iteration++) {
    // Fit BEFORE each model call: tool results grow the conversation inside the
    // loop, and the fifth iteration can overflow a window the first one fitted.
    const fitted = await fitToContext(working, systemPrompt, lastModel, {
      signal: input.signal,
      conversationId: conversation.id,
      reservedOutputTokens: input.maxTokens ?? cfg.defaults.maxTokens,
    });
    if (fitted.notice) {
      yield { type: 'notice', level: 'warn', code: 'context_compacted', message: fitted.notice };
    }
    working = fitted.messages;

    const assistantBlocks: ContentBlock[] = [];
    const pendingToolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
    let iterationText = '';
    let iterationReasoning = '';
    let ttftMs: number | null = null;
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    const t0 = performance.now();

    const stream = streamCompletion(
      {
        model: lastModel,
        system: systemPrompt,
        messages: working,
        tools: tools.length ? tools : undefined,
        maxTokens: input.maxTokens ?? cfg.defaults.maxTokens,
        temperature: input.temperature ?? cfg.defaults.temperature,
        signal: input.signal,
      },
      { kind: 'chat', conversationId: conversation.id },
    );

    for await (const event of stream as AsyncGenerator<GatewayEvent>) {
      switch (event.type) {
        case 'meta':
          lastModel = event.model;
          lastProvider = event.provider;
          yield { type: 'meta', model: event.model, provider: event.provider, attempt: event.attempt, ...(event.fallbackFrom ? { fallbackFrom: event.fallbackFrom } : {}) };
          break;
        case 'retry':
          yield { type: 'retry', attempt: event.attempt, delayMs: event.delayMs, kind: event.kind, message: event.message };
          break;
        case 'fallback':
          yield { type: 'fallback', from: event.from, to: event.to, kind: event.kind, message: event.message };
          break;
        case 'text_delta':
          if (ttftMs === null) ttftMs = Math.round(performance.now() - t0);
          iterationText += event.text;
          yield { type: 'delta', text: event.text };
          break;
        case 'reasoning_delta':
          if (ttftMs === null) ttftMs = Math.round(performance.now() - t0);
          iterationReasoning += event.text;
          yield { type: 'reasoning', text: event.text };
          break;
        case 'tool_use_start':
          if (ttftMs === null) ttftMs = Math.round(performance.now() - t0);
          break;
        case 'tool_use_delta':
          // Surfaced so the UI can show arguments assembling live, which is the
          // visible proof that tool arguments really do stream in fragments.
          yield { type: 'tool_args_delta', id: event.id, partialJson: event.partialJson };
          break;
        case 'tool_use_complete':
          pendingToolUses.push({ id: event.id, name: event.name, input: event.input });
          yield { type: 'tool_call', id: event.id, name: event.name, input: event.input };
          break;
        case 'usage':
          usage = event.usage;
          break;
        case 'done':
          finishReason = event.finishReason;
          break;
        case 'error': {
          const err = event.error as ProviderError;
          sawError = true;
          yield {
            type: 'error',
            kind: err.kind,
            message: err.message,
            provider: err.provider,
            retryable: err.retryable,
          };
          break;
        }
        default:
          break;
      }
      if (sawError) break;
    }

    const latencyMs = performance.now() - t0;
    const cost = computeCost(lastModel, usage).totalUsd;
    totalCost += cost;
    aggregate.inputTokens += usage.inputTokens;
    aggregate.outputTokens += usage.outputTokens;
    if (usage.cachedInputTokens) aggregate.cachedInputTokens = (aggregate.cachedInputTokens ?? 0) + usage.cachedInputTokens;
    if (usage.cacheWriteTokens) aggregate.cacheWriteTokens = (aggregate.cacheWriteTokens ?? 0) + usage.cacheWriteTokens;
    if (usage.reasoningTokens) aggregate.reasoningTokens = (aggregate.reasoningTokens ?? 0) + usage.reasoningTokens;

    yield {
      type: 'usage',
      usage,
      costUsd: cost,
      ttftMs,
      latencyMs: Math.round(latencyMs),
      model: lastModel,
      provider: lastProvider,
    };

    if (sawError) break;

    if (iterationText) assistantBlocks.push({ type: 'text', text: iterationText });
    for (const use of pendingToolUses) {
      assistantBlocks.push({ type: 'tool_use', id: use.id, name: use.name, input: use.input });
    }

    finalText += iterationText;
    finalReasoning += iterationReasoning;

    // No tool calls: the model is done talking.
    if (!pendingToolUses.length) {
      if (assistantBlocks.length) working = [...working, { role: 'assistant', content: assistantBlocks }];
      break;
    }

    if (iteration >= cfg.limits.maxToolIterations) {
      yield {
        type: 'notice',
        level: 'warn',
        code: 'tool_iteration_limit',
        message: `Stopped after ${cfg.limits.maxToolIterations} tool rounds to avoid a loop. The answer may be incomplete.`,
      };
      finishReason = 'max_tokens';
      if (assistantBlocks.length) working = [...working, { role: 'assistant', content: assistantBlocks }];
      break;
    }

    // Execute. Parallel because providers may request several tools at once and
    // serializing them would triple the latency of a two-tool turn; order is
    // preserved so tool_result blocks line up with their tool_use blocks.
    toolIterations++;
    const results = await Promise.all(
      pendingToolUses.map(async (use) => {
        const started = performance.now();
        const tool = getTool(use.name);
        if (!tool) {
          return {
            use,
            ok: false,
            content: `Unknown tool "${use.name}". Available tools: ${tools.map((t) => t.name).join(', ') || 'none'}.`,
            durationMs: Math.round(performance.now() - started),
            meta: undefined as Record<string, unknown> | undefined,
          };
        }
        if (use.input._parse_error) {
          // The accumulator could not parse the streamed arguments. Telling the
          // model exactly that is far more useful than a generic failure.
          return {
            use,
            ok: false,
            content: 'The arguments you sent were not valid JSON. Call the tool again with a well-formed arguments object.',
            durationMs: Math.round(performance.now() - started),
            meta: undefined,
          };
        }
        try {
          const result = await tool.execute(use.input, toolCtx);
          return {
            use,
            ok: !result.isError,
            content: result.content,
            durationMs: Math.round(performance.now() - started),
            meta: result.meta,
          };
        } catch (err) {
          logger.warn('tool.failed', { tool: use.name, error: (err as Error).message });
          return {
            use,
            ok: false,
            content: `The tool failed: ${(err as Error).message}`,
            durationMs: Math.round(performance.now() - started),
            meta: undefined,
          };
        }
      }),
    );

    const toolResultBlocks: ContentBlock[] = [];
    for (const result of results) {
      yield {
        type: 'tool_result',
        id: result.use.id,
        name: result.use.name,
        ok: result.ok,
        preview: result.content.slice(0, 600),
        durationMs: result.durationMs,
      };
      toolResultBlocks.push({
        type: 'tool_result',
        toolUseId: result.use.id,
        name: result.use.name,
        content: result.content,
        ...(result.ok ? {} : { isError: true }),
      });

      // search_documents produces citations the UI should render alongside the
      // answer, exactly as RAG mode does.
      const meta = result.meta as { citations?: RetrievedChunk[] } | undefined;
      if (meta?.citations?.length) {
        retrievedChunks = meta.citations;
        citations = toCitationPayload(meta.citations);
        yield { type: 'citations', citations };
      }
    }

    working = [
      ...working,
      { role: 'assistant', content: assistantBlocks },
      { role: 'tool', content: toolResultBlocks },
    ];
  }

  // -------------------------------------------------------------------------
  // Persist the turn
  // -------------------------------------------------------------------------
  // Everything the model produced in this turn, including intermediate tool
  // rounds, so the next turn replays what actually happened.
  const newMessages = working.slice(history.length);
  let assistantMessageId = '';

  for (const message of newMessages) {
    if (message.role === 'user') continue; // already persisted
    const isFinalAssistant = message === newMessages[newMessages.length - 1] && message.role === 'assistant';
    const cited = isFinalAssistant && citations.length
      ? filterCitations(citations, textOf(message.content))
      : undefined;
    const stored = appendMessage(conversation.id, {
      role: message.role,
      content: message.content,
      modelId: message.role === 'assistant' ? lastModel : null,
      provider: message.role === 'assistant' ? lastProvider : null,
      reasoning: isFinalAssistant && finalReasoning ? finalReasoning : null,
      citations: cited ?? null,
    });
    if (message.role === 'assistant') assistantMessageId = stored.id;
  }

  if (!assistantMessageId) {
    // The turn produced nothing storable (an error, or an empty response).
    const stored = appendMessage(conversation.id, {
      role: 'assistant',
      content: [{ type: 'text', text: finalText || '(no response)' }],
      modelId: lastModel,
      provider: lastProvider,
    });
    assistantMessageId = stored.id;
  }

  if (cacheEligible && !sawError && finalText.trim()) {
    await storeSemanticCache(text, input.model, finalText, aggregate, totalCost, { signal: input.signal }).catch((err) =>
      logger.warn('cache.store_failed', { error: (err as Error).message }),
    );
  }

  if (retrievedChunks.length) {
    const used = extractCitedNumbers(finalText, citations.length);
    if (!used.length && finalText && !finalText.includes(IDK_ANSWER)) {
      // Grounding check: an answer built from excerpts that cites none of them
      // is the failure mode this module exists to prevent, so it is surfaced
      // rather than hidden.
      yield {
        type: 'notice',
        level: 'warn',
        code: 'uncited_answer',
        message: 'The model answered without citing any retrieved excerpt. Treat this answer as ungrounded.',
      };
    }
  }

  if (!sawError) {
    yield { type: 'done', assistantMessageId, finishReason };
  }

  logger.info('chat.turn_complete', {
    conversationId: conversation.id,
    model: lastModel,
    toolIterations,
    costUsd: totalCost,
    citations: citations.length,
  });
}

/** Keep only the citations the answer actually referenced, renumbered. */
function filterCitations(citations: CitationPayload[], answer: string): CitationPayload[] {
  const used = extractCitedNumbers(answer, citations.length);
  if (!used.length) return citations;
  return used.map((n) => citations[n - 1]).filter((c): c is CitationPayload => Boolean(c));
}

/** Turn any thrown error into the one serializable error event the UI knows. */
export function toChatErrorEvent(err: unknown): ChatEvent {
  if (isProviderError(err)) {
    const safe = err.toClient();
    return { type: 'error', kind: safe.kind, message: safe.message, provider: safe.provider, retryable: safe.retryable };
  }
  if (err instanceof AppError) {
    return { type: 'error', kind: err.code, message: err.message, provider: 'polyglot', retryable: false };
  }
  logger.error('chat.unexpected_error', { error: (err as Error).message, stack: (err as Error).stack });
  return { type: 'error', kind: 'server_error', message: 'Something went wrong handling this message.', provider: 'polyglot', retryable: false };
}
