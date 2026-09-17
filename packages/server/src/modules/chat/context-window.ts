import { appConfig } from '../../core/config.js';
import { AppError } from '../../core/errors.js';
import { complete } from '../../core/gateway.js';
import { getModelEntry } from '../../core/registry.js';
import { estimateConversationTokens, estimateMessageTokens, estimateTextTokens } from '../../core/tokens.js';
import type { Message } from '../../core/types.js';
import { logger } from '../../util/logger.js';

/**
 * Context-window overflow handling.
 *
 * The brief asks for a deliberate, documented choice. Ours is:
 *
 *   strategy = "summarize" (configurable to "truncate" or "reject")
 *
 * and the non-obvious part is not the strategy, it is the UNIT we drop.
 *
 * Dropping individual messages corrupts tool conversations: an orphaned
 * `tool_result` with no matching `tool_use` is a hard 400 on Anthropic and
 * OpenAI, and Gemini silently mis-attributes it. So we drop whole TURNS — a user
 * message plus every assistant/tool message that followed it — and then run an
 * orphan sweep as a belt-and-braces check.
 *
 * The user is always told: a compaction notice is returned and surfaced in the UI.
 * Silent truncation is how people end up debugging "the model forgot" for a day.
 */

export type ContextStrategy = 'reject' | 'truncate' | 'summarize';

export interface FitResult {
  messages: Message[];
  /** Human-readable note for the UI; undefined when nothing was changed. */
  notice?: string;
  droppedMessages: number;
  droppedTurns: number;
  strategy: ContextStrategy;
  promptTokens: number;
  budgetTokens: number;
}

/** A turn: one genuine user message plus everything that answered it. */
interface Turn {
  messages: Message[];
  tokens: number;
}

/** A `user` message that only carries tool_result blocks is not a new turn. */
function startsTurn(m: Message): boolean {
  if (m.role !== 'user') return false;
  return m.content.some((b) => b.type !== 'tool_result');
}

export function groupIntoTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    if (!turns.length || startsTurn(m)) {
      turns.push({ messages: [m], tokens: estimateMessageTokens(m) });
    } else {
      const turn = turns[turns.length - 1]!;
      turn.messages.push(m);
      turn.tokens += estimateMessageTokens(m);
    }
  }
  return turns;
}

/**
 * Remove `tool_result` blocks with no surviving `tool_use`, and vice versa.
 * Messages left empty are dropped.
 */
export function stripOrphanToolBlocks(messages: Message[]): Message[] {
  const toolUseIds = new Set<string>();
  for (const m of messages) for (const b of m.content) if (b.type === 'tool_use' && b.id) toolUseIds.add(b.id);

  const resultIds = new Set<string>();
  for (const m of messages) for (const b of m.content) if (b.type === 'tool_result' && b.toolUseId) resultIds.add(b.toolUseId);

  const out: Message[] = [];
  for (const m of messages) {
    const content = m.content.filter((b) => {
      if (b.type === 'tool_result') return b.toolUseId ? toolUseIds.has(b.toolUseId) : false;
      if (b.type === 'tool_use') return b.id ? resultIds.has(b.id) : false;
      return true;
    });
    if (content.length) out.push({ ...m, content });
  }
  return out;
}

export interface FitOptions {
  strategy?: ContextStrategy;
  /** Output tokens to leave room for. */
  reservedOutputTokens?: number;
  signal?: AbortSignal;
  conversationId?: string | null;
}

export async function fitToContext(
  messages: Message[],
  system: string | undefined,
  modelId: string,
  opts: FitOptions = {},
): Promise<FitResult> {
  const cfg = appConfig().context;
  const strategy = opts.strategy ?? (cfg.strategy as ContextStrategy);
  const entry = getModelEntry(modelId);

  const reserved = opts.reservedOutputTokens ?? cfg.reservedOutputTokens;
  // headroomRatio absorbs the error in our token estimate (see core/tokens.ts).
  const budget = Math.floor(entry.contextWindow * cfg.headroomRatio) - reserved - estimateTextTokens(system ?? '');
  const promptTokens = estimateConversationTokens(messages, system);

  const base: FitResult = {
    messages,
    droppedMessages: 0,
    droppedTurns: 0,
    strategy,
    promptTokens,
    budgetTokens: budget,
  };

  if (budget <= 0) {
    throw new AppError(
      400,
      'context_budget_exhausted',
      `The system prompt alone does not fit in ${modelId}'s ${entry.contextWindow.toLocaleString()}-token window.`,
    );
  }
  if (promptTokens <= budget) return base;

  if (strategy === 'reject') {
    throw new AppError(
      413,
      'context_length_exceeded',
      `This conversation is about ${promptTokens.toLocaleString()} tokens, over the ${budget.toLocaleString()}-token budget for ${modelId}. ` +
        'Start a new conversation, or switch to a model with a larger context window.',
      { promptTokens, budget, contextWindow: entry.contextWindow },
    );
  }

  const turns = groupIntoTurns(messages);
  const keep = Math.max(1, cfg.keepRecentTurns);
  const kept: Turn[] = [];
  let keptTokens = 0;

  // Walk backwards: the most recent turns are the ones worth keeping verbatim.
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]!;
    const mustKeep = kept.length < keep;
    if (!mustKeep && keptTokens + turn.tokens > budget) break;
    kept.unshift(turn);
    keptTokens += turn.tokens;
  }

  const dropped = turns.slice(0, turns.length - kept.length);
  if (!dropped.length) return base;

  const droppedMessages = dropped.reduce((n, t) => n + t.messages.length, 0);
  let retained = stripOrphanToolBlocks(kept.flatMap((t) => t.messages));

  let notice =
    `Conversation compacted to fit ${modelId}'s context window: ` +
    `${droppedMessages} older message(s) across ${dropped.length} turn(s) were dropped.`;

  if (strategy === 'summarize') {
    const summary = await summarizeDropped(dropped, opts);
    if (summary) {
      retained = [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              // Explicitly framed as a recap so the model does not answer it.
              text:
                '[Conversation summary of earlier messages, provided for context only — do not respond to it directly]\n' +
                summary,
            },
          ],
        },
        ...retained,
      ];
      notice += ' The dropped turns were summarized and prepended.';
    } else {
      notice += ' Summarization was unavailable, so the dropped turns were discarded.';
    }
  }

  logger.info('context.compacted', { modelId, promptTokens, budget, droppedMessages, droppedTurns: dropped.length, strategy });

  return {
    messages: retained,
    notice,
    droppedMessages,
    droppedTurns: dropped.length,
    strategy,
    promptTokens,
    budgetTokens: budget,
  };
}

async function summarizeDropped(dropped: Turn[], opts: FitOptions): Promise<string | undefined> {
  const cfg = appConfig().context;
  const transcript = dropped
    .flatMap((t) => t.messages)
    .map((m) => {
      const text = m.content
        .map((b) =>
          b.type === 'text' ? b.text
          : b.type === 'tool_use' ? `[called tool ${b.name}]`
          : b.type === 'tool_result' ? `[tool result: ${(b.content ?? '').slice(0, 200)}]`
          : '[image]',
        )
        .join(' ');
      return `${m.role}: ${text}`;
    })
    .join('\n')
    .slice(0, 40000);

  try {
    const res = await complete(
      {
        model: cfg.summaryModel,
        system:
          'You compress conversation history. Produce a dense factual summary in under 250 words: ' +
          'decisions made, facts established, open questions, and any identifiers or names mentioned. ' +
          'No preamble, no commentary.',
        messages: [{ role: 'user', content: [{ type: 'text', text: transcript }] }],
        maxTokens: 600,
        temperature: 0,
        signal: opts.signal,
      },
      { kind: 'summary', conversationId: opts.conversationId ?? null },
    );
    return res.content.filter((c) => c.type === 'text').map((c) => c.text).join('').trim() || undefined;
  } catch (err) {
    // Summarization failing must not fail the user's actual message.
    logger.warn('context.summary_failed', { error: (err as Error).message });
    return undefined;
  }
}
