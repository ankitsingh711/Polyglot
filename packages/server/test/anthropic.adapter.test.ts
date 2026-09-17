import { describe, it, expect, beforeEach } from 'vitest';
import { FetchRecorder, providerFor, resetProviders, collect, textOf, eventsOfType, sseFrames } from './helpers.js';
import { isProviderError } from '../src/core/errors.js';
import type { Message } from '../src/core/types.js';

const MODEL = 'anthropic:claude-haiku-4-5';

describe('Anthropic adapter — request mapping', () => {
  beforeEach(() => resetProviders());

  it('puts system at the TOP LEVEL, never as a message', async () => {
    const recorder = new FetchRecorder().json({
      id: 'msg_1', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 2 },
    });
    const provider = await providerFor('anthropic', recorder);

    await provider.complete({
      model: MODEL,
      system: 'You are terse.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    });

    const body = recorder.last.body;
    expect(body.system).toBe('You are terse.');
    expect(body.messages).toHaveLength(1);
    expect(body.messages.some((m: any) => m.role === 'system')).toBe(false);
    expect(recorder.last.headers['anthropic-version']).toBe('2023-06-01');
    expect(recorder.last.headers['x-api-key']).toBe('test-anthropic-key');
  });

  it('marks a long system prompt as cacheable and leaves a short one plain', async () => {
    const recorder = new FetchRecorder()
      .json({ id: 'm', content: [], stop_reason: 'end_turn', usage: {} })
      .json({ id: 'm', content: [], stop_reason: 'end_turn', usage: {} });
    const provider = await providerFor('anthropic', recorder);

    await provider.complete({ model: MODEL, system: 'short', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] });
    expect(typeof recorder.last.body.system).toBe('string');

    await provider.complete({ model: MODEL, system: 'x'.repeat(2500), messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] });
    expect(recorder.last.body.system[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('turns the tool role into tool_result blocks inside a USER message', async () => {
    const recorder = new FetchRecorder().json({ id: 'm', content: [], stop_reason: 'end_turn', usage: {} });
    const provider = await providerFor('anthropic', recorder);

    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'weather in Oslo?' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { location: 'Oslo' } }] },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'tu_1', content: '{"c":3}' }] },
    ];
    await provider.complete({ model: MODEL, messages });

    const sent = recorder.last.body.messages;
    expect(sent[1].role).toBe('assistant');
    expect(sent[1].content[0].type).toBe('tool_use');
    // The critical assertion: Anthropic has no tool role.
    expect(sent[2].role).toBe('user');
    expect(sent[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu_1' });
  });

  it('merges consecutive same-role turns and never opens with an assistant turn', async () => {
    const recorder = new FetchRecorder().json({ id: 'm', content: [], stop_reason: 'end_turn', usage: {} });
    const provider = await providerFor('anthropic', recorder);

    await provider.complete({
      model: MODEL,
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: 'I was resumed' }] },
        { role: 'user', content: [{ type: 'text', text: 'a' }] },
        { role: 'user', content: [{ type: 'text', text: 'b' }] },
      ],
    });

    const sent = recorder.last.body.messages;
    expect(sent[0].role).toBe('user');
    const userTurns = sent.filter((m: any) => m.role === 'user');
    expect(userTurns[userTurns.length - 1].content).toHaveLength(2);
  });

  it('renames parameters to input_schema and maps "required" tool choice to "any"', async () => {
    const recorder = new FetchRecorder().json({ id: 'm', content: [], stop_reason: 'end_turn', usage: {} });
    const provider = await providerFor('anthropic', recorder);

    await provider.complete({
      model: MODEL,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
      tools: [{ name: 'calculator', description: 'math', parameters: { type: 'object', properties: { expression: { type: 'string' } } } }],
      toolChoice: { type: 'required' },
    });

    expect(recorder.last.body.tools[0].input_schema.properties.expression.type).toBe('string');
    expect(recorder.last.body.tools[0].parameters).toBeUndefined();
    expect(recorder.last.body.tool_choice).toEqual({ type: 'any' });
  });

  it('uses tool-forcing for structured output, since Anthropic has no json_schema mode', async () => {
    const recorder = new FetchRecorder().json({
      id: 'm', content: [{ type: 'tool_use', id: 't', name: 'invoice', input: { total: 12 } }],
      stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 },
    });
    const provider = await providerFor('anthropic', recorder);

    const res = await provider.complete({
      model: MODEL,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
      responseFormat: { type: 'json_schema', name: 'invoice', schema: { type: 'object', properties: { total: { type: 'number' } } } },
    });

    expect(recorder.last.body.tool_choice).toEqual({ type: 'tool', name: 'invoice' });
    expect(res.structuredMode).toBe('tool_forcing');
  });
});

describe('Anthropic adapter — usage normalization', () => {
  beforeEach(() => resetProviders());

  it('adds the cache buckets into inputTokens, because Anthropic excludes them', async () => {
    const recorder = new FetchRecorder().json({
      id: 'm', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 },
    });
    const provider = await providerFor('anthropic', recorder);
    const res = await provider.complete({ model: MODEL, messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] });

    // 100 fresh + 900 read + 50 written = 1050 total prompt tokens.
    expect(res.usage.inputTokens).toBe(1050);
    expect(res.usage.cachedInputTokens).toBe(900);
    expect(res.usage.cacheWriteTokens).toBe(50);
    expect(res.usage.outputTokens).toBe(20);
  });
});

describe('Anthropic adapter — streaming', () => {
  beforeEach(() => resetProviders());

  it('accumulates tool arguments across input_json_delta fragments', async () => {
    const frames = sseFrames([
      { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 12 } } } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me ' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'check.' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_9', name: 'calculator' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"expr' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'ession":' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"2+2"}' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 31 } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);

    const recorder = new FetchRecorder().sse(frames);
    const provider = await providerFor('anthropic', recorder);
    const events = await collect(provider.stream({ model: MODEL, messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }));

    expect(recorder.last.body.stream).toBe(true);
    expect(textOf(events)).toBe('Let me check.');

    const complete = eventsOfType(events, 'tool_use_complete');
    expect(complete).toHaveLength(1);
    expect(complete[0]!.name).toBe('calculator');
    expect(complete[0]!.input).toEqual({ expression: '2+2' });

    // Three fragments in, three deltas out: arguments really do stream.
    expect(eventsOfType(events, 'tool_use_delta')).toHaveLength(3);

    const usage = eventsOfType(events, 'usage')[0]!;
    expect(usage.usage).toMatchObject({ inputTokens: 12, outputTokens: 31 });
    expect(eventsOfType(events, 'done')[0]!.finishReason).toBe('tool_use');
  });

  it('survives a frame split across two network chunks', async () => {
    const recorder = new FetchRecorder().sse([
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n' +
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_bl',
      'ock":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"typ',
      'e":"text_delta","text":"split works"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);
    const provider = await providerFor('anthropic', recorder);
    const events = await collect(provider.stream({ model: MODEL, messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }));
    expect(textOf(events)).toBe('split works');
  });

  it('maps thinking_delta onto the reasoning channel, not the text channel', async () => {
    const recorder = new FetchRecorder().sse(
      sseFrames([
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'answer' } } },
        { event: 'message_stop', data: { type: 'message_stop' } },
      ]),
    );
    const provider = await providerFor('anthropic', recorder);
    const events = await collect(provider.stream({ model: MODEL, messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }));

    expect(textOf(events)).toBe('answer');
    expect(eventsOfType(events, 'reasoning_delta')[0]!.text).toBe('hmm');
  });

  it('still emits usage and done when the stream ends without message_stop', async () => {
    const recorder = new FetchRecorder().sse(
      sseFrames([
        { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 7 } } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'cut' } } },
      ]),
    );
    const provider = await providerFor('anthropic', recorder);
    const events = await collect(provider.stream({ model: MODEL, messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }));

    expect(eventsOfType(events, 'usage')).toHaveLength(1);
    expect(eventsOfType(events, 'done')).toHaveLength(1);
  });

  it('turns an in-band overloaded_error into a retryable rate_limit', async () => {
    const recorder = new FetchRecorder().sse(
      sseFrames([{ event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } }]),
    );
    const provider = await providerFor('anthropic', recorder);
    const events = await collect(provider.stream({ model: MODEL, messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }));

    const error = eventsOfType(events, 'error')[0]!.error;
    expect(error.kind).toBe('rate_limit');
    expect(error.retryable).toBe(true);
  });
});

describe('Anthropic adapter — error normalization', () => {
  beforeEach(() => resetProviders());

  it('classifies a 400 "prompt is too long" as context_length, not bad_request', async () => {
    const recorder = new FetchRecorder().json(
      { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 250000 tokens > 200000 maximum' } },
      { status: 400 },
    );
    const provider = await providerFor('anthropic', recorder);

    await expect(
      provider.complete({ model: MODEL, messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }),
    ).rejects.toMatchObject({ kind: 'context_length', retryable: false });
  });

  it('classifies 401 as auth and never retries it', async () => {
    const recorder = new FetchRecorder().json(
      { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
      { status: 401 },
    );
    const provider = await providerFor('anthropic', recorder);
    const err = await provider
      .complete({ model: MODEL, messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })
      .catch((e) => e);

    expect(isProviderError(err)).toBe(true);
    expect(err.kind).toBe('auth');
    expect(err.retryable).toBe(false);
    // The raw body is kept for logs but must not be in the client shape.
    expect(Object.keys(err.toClient())).toEqual(['kind', 'provider', 'message', 'retryable']);
  });

  it('honours retry-after on a 429', async () => {
    const recorder = new FetchRecorder().json(
      { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } },
      { status: 429, headers: { 'retry-after': '3' } },
    );
    const provider = await providerFor('anthropic', recorder);
    const err = await provider
      .complete({ model: MODEL, messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })
      .catch((e) => e);

    expect(err.kind).toBe('rate_limit');
    expect(err.retryAfterMs).toBe(3000);
  });

  it('normalizes a transport reset into a retryable server_error', async () => {
    const recorder = new FetchRecorder().networkError('ECONNRESET');
    const provider = await providerFor('anthropic', recorder);
    const err = await provider
      .complete({ model: MODEL, messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })
      .catch((e) => e);

    expect(err.kind).toBe('server_error');
    expect(err.retryable).toBe(true);
  });
});
