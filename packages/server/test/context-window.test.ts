import { describe, it, expect, beforeAll } from 'vitest';
import { FetchRecorder, resetProviders } from './helpers.js';
import { loadProviders, setFetchImpl } from '../src/core/registry.js';
import { initDatabase } from '../src/db/index.js';
import { ensureTenant } from '../src/tenancy/tenants.js';
import { runWithTenant } from '../src/tenancy/context.js';
import { newRequestId } from '../src/util/ids.js';
import {
  groupIntoTurns,
  stripOrphanToolBlocks,
  fitToContext,
} from '../src/modules/chat/context-window.js';
import type { Message } from '../src/core/types.js';

/**
 * Context-window compaction.
 *
 * The strategy ("summarize", configurable) is the easy half. The half that
 * actually breaks things is the UNIT that gets dropped: cutting individual
 * messages orphans a `tool_result` from its `tool_use`, which is a hard 400 on
 * Anthropic and OpenAI and is silently mis-attributed by Gemini. So turns are
 * dropped whole and an orphan sweep runs afterwards — and that is what these
 * tests pin down.
 */

const text = (t: string) => [{ type: 'text' as const, text: t }];
let tenant: { id: string };

beforeAll(async () => {
  await loadProviders();
  initDatabase();
  tenant = ensureTenant('Context Test', 'key-context');
});

function inTenant<T>(fn: () => Promise<T> | T): Promise<T> {
  return Promise.resolve(
    runWithTenant({ tenantId: tenant.id, tenantName: 'Context Test', requestId: newRequestId() }, fn),
  );
}

/** A conversation big enough to blow any real budget. */
function bigConversation(turns: number, charsPerMessage = 4000): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < turns; i++) {
    out.push({ role: 'user', content: text(`Q${i} ${'q'.repeat(charsPerMessage)}`) });
    out.push({ role: 'assistant', content: text(`A${i} ${'a'.repeat(charsPerMessage)}`) });
  }
  return out;
}

describe('grouping into turns', () => {
  it('attaches every assistant and tool message to the user message that started it', () => {
    const turns = groupIntoTurns([
      { role: 'user', content: text('one') },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'calc', input: {} }] },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 't1', content: '4' }] },
      { role: 'assistant', content: text('the answer is 4') },
      { role: 'user', content: text('two') },
      { role: 'assistant', content: text('ok') },
    ]);

    expect(turns).toHaveLength(2);
    expect(turns[0]!.messages).toHaveLength(4);
    expect(turns[1]!.messages).toHaveLength(2);
  });

  it('does not start a new turn on a user message that only carries tool results', () => {
    // Anthropic sends tool results back as a `user` message. Treating that as a
    // new turn would split a tool exchange down the middle, which is exactly the
    // cut that produces an orphan.
    const turns = groupIntoTurns([
      { role: 'user', content: text('weather?') },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'get_weather', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: '3C' }] },
      { role: 'assistant', content: text('3 degrees') },
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0]!.messages).toHaveLength(4);
  });
});

describe('orphan sweep', () => {
  it('drops a tool_result whose tool_use was cut away', () => {
    const swept = stripOrphanToolBlocks([
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'gone', content: '4' }] },
      { role: 'user', content: text('still here') },
    ]);

    expect(swept).toHaveLength(1);
    expect(swept[0]!.content[0]!.text).toBe('still here');
  });

  it('drops a tool_use whose result was cut away', () => {
    const swept = stripOrphanToolBlocks([
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'calc', input: {} }] },
      { role: 'user', content: text('next question') },
    ]);

    expect(swept.map((m) => m.role)).toEqual(['user']);
  });

  it('keeps a matched pair, and the text that travelled with it', () => {
    const swept = stripOrphanToolBlocks([
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'let me check' }, { type: 'tool_use', id: 't1', name: 'calc', input: {} }],
      },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 't1', content: '4' }] },
    ]);

    expect(swept).toHaveLength(2);
    expect(swept[0]!.content).toHaveLength(2);
  });

  it('never leaves a message with an empty content array', () => {
    // An empty `content: []` is itself a 400 on Anthropic, so a message that
    // loses all of its blocks has to disappear rather than be sent hollow.
    const swept = stripOrphanToolBlocks([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'orphan', name: 'calc', input: {} }] },
    ]);
    expect(swept).toHaveLength(0);
  });
});

describe('fitting to the window', () => {
  it('leaves a conversation that already fits completely untouched', async () => {
    const messages: Message[] = [
      { role: 'user', content: text('hello') },
      { role: 'assistant', content: text('hi') },
    ];
    const fitted = await inTenant(() =>
      fitToContext(messages, 'be brief', 'anthropic:claude-haiku-4-5', { strategy: 'truncate' }),
    );

    expect(fitted.messages).toEqual(messages);
    expect(fitted.droppedTurns).toBe(0);
    expect(fitted.notice).toBeUndefined();
    expect(fitted.promptTokens).toBeLessThan(fitted.budgetTokens);
  });

  it('rejects loudly under the "reject" strategy instead of silently forgetting', async () => {
    await expect(
      inTenant(() =>
        // 131k-token window, and far more than that in the conversation.
        fitToContext(bigConversation(400), undefined, 'groq:gpt-oss-120b', { strategy: 'reject' }),
      ),
    ).rejects.toMatchObject({ status: 413, code: 'context_length_exceeded' });
  });

  it('drops whole turns under "truncate", keeps the newest, and tells the user', async () => {
    const messages = bigConversation(400);
    const fitted = await inTenant(() =>
      fitToContext(messages, undefined, 'groq:gpt-oss-120b', { strategy: 'truncate' }),
    );

    expect(fitted.droppedTurns).toBeGreaterThan(0);
    expect(fitted.messages.length).toBeLessThan(messages.length);
    // Silent truncation is how people spend a day debugging "the model forgot".
    expect(fitted.notice).toMatch(/compacted/i);
    // The most recent exchange always survives...
    expect(fitted.messages.at(-1)).toEqual(messages.at(-1));
    // ...and the oldest one does not.
    expect(fitted.messages[0]).not.toEqual(messages[0]);
  });

  it('never cuts a turn in half, so no orphaned tool block can reach a provider', async () => {
    // Long filler turns, then a tool exchange right at the end.
    const messages: Message[] = [
      ...bigConversation(400),
      { role: 'user', content: text('what is 2+2?') },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_last', name: 'calculator', input: { e: '2+2' } }] },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'tu_last', content: '4' }] },
      { role: 'assistant', content: text('4') },
    ];

    const fitted = await inTenant(() =>
      fitToContext(messages, undefined, 'groq:gpt-oss-120b', { strategy: 'truncate' }),
    );

    const uses = new Set<string>();
    const results = new Set<string>();
    for (const m of fitted.messages) {
      for (const b of m.content) {
        if (b.type === 'tool_use' && b.id) uses.add(b.id);
        if (b.type === 'tool_result' && b.toolUseId) results.add(b.toolUseId);
      }
    }
    expect([...results].every((id) => uses.has(id))).toBe(true);
    expect([...uses].every((id) => results.has(id))).toBe(true);
    expect(uses.has('tu_last')).toBe(true);
  });

  it('prepends a summary of the dropped turns under "summarize", framed as context only', async () => {
    resetProviders();
    const recorder = new FetchRecorder().json({
      id: 'msg_sum',
      model: 'claude-haiku-4-5',
      content: [{ type: 'text', text: 'Earlier: the user asked 400 questions about nothing in particular.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    recorder.install();

    const fitted = await inTenant(() =>
      fitToContext(bigConversation(400), undefined, 'groq:gpt-oss-120b', { strategy: 'summarize' }),
    );

    expect(fitted.droppedTurns).toBeGreaterThan(0);
    const first = fitted.messages[0]!;
    expect(first.role).toBe('user');
    expect(first.content[0]!.text).toContain('Earlier: the user asked 400 questions');
    // The recap must not read as a new question, or the model answers the recap.
    expect(first.content[0]!.text).toMatch(/do not respond to it directly/i);
    expect(fitted.notice).toMatch(/summarized/i);
  });

  it('degrades to plain truncation, with a notice, when the summarizer itself fails', async () => {
    resetProviders();
    const recorder = new FetchRecorder();
    // Every attempt AND every fallback hop fails.
    for (let i = 0; i < 12; i++) recorder.json({ error: { message: 'upstream down' } }, { status: 500 });
    recorder.install();

    const fitted = await inTenant(() =>
      fitToContext(bigConversation(400), undefined, 'groq:gpt-oss-120b', { strategy: 'summarize' }),
    );

    // Losing the summary must not lose the turn.
    expect(fitted.droppedTurns).toBeGreaterThan(0);
    expect(fitted.messages.length).toBeGreaterThan(0);
    expect(fitted.notice).toMatch(/unavailable|discarded/i);

    setFetchImpl(undefined as never);
  });

  it('refuses when the system prompt alone cannot fit', async () => {
    await expect(
      inTenant(() =>
        fitToContext([{ role: 'user', content: text('hi') }], 'x'.repeat(4_000_000), 'groq:gpt-oss-120b'),
      ),
    ).rejects.toMatchObject({ code: 'context_budget_exhausted' });
  });
});
