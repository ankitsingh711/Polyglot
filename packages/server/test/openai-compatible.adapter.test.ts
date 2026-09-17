import { describe, it, expect, beforeEach } from 'vitest';
import { FetchRecorder, providerFor, resetProviders, collect, textOf, eventsOfType, sseFrames } from './helpers.js';
import { toOpenAIMessages, strictifySchema, mapOaiUsage } from '../src/providers/_shared/openai-compatible.js';
import type { Message } from '../src/core/types.js';

/**
 * These three providers share a request envelope and disagree about everything
 * that matters operationally. The tests below are organized around those
 * disagreements rather than around the shared parts.
 */

describe('OpenAI-compatible — message translation', () => {
  it('folds the system prompt into a leading message', () => {
    const out = toOpenAIMessages([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], 'Be terse.');
    expect(out[0]).toEqual({ role: 'system', content: 'Be terse.' });
  });

  it('emits ONE message per tool result, unlike Anthropic which collapses them', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'c1', name: 'calculator', input: { expression: '1+1' } },
          { type: 'tool_use', id: 'c2', name: 'get_weather', input: { location: 'Oslo' } },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool_result', toolUseId: 'c1', content: '2' },
          { type: 'tool_result', toolUseId: 'c2', content: '3C' },
        ],
      },
    ];
    const out = toOpenAIMessages(messages);
    expect(out[0]).toMatchObject({ role: 'assistant', content: null });
    expect((out[0] as any).tool_calls).toHaveLength(2);
    expect(out[1]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '2' });
    expect(out[2]).toEqual({ role: 'tool', tool_call_id: 'c2', content: '3C' });
  });

  it('serializes tool arguments as a JSON STRING, not an object', () => {
    const out = toOpenAIMessages([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'calc', input: { expression: '2^8' } }] },
    ]);
    expect((out[0] as any).tool_calls[0].function.arguments).toBe('{"expression":"2^8"}');
  });

  it('sends a text-only user turn as a plain string, and mixed content as parts', () => {
    const textOnly = toOpenAIMessages([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
    expect(textOnly[0]!.content).toBe('hi');

    const withImage = toOpenAIMessages([
      { role: 'user', content: [{ type: 'text', text: 'what is this' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }] },
    ]);
    const parts = withImage[0]!.content as any[];
    expect(parts[1].image_url.url).toBe('data:image/png;base64,AAAA');
  });

  it('marks an errored tool result inline, since this surface has no is_error', () => {
    const out = toOpenAIMessages([
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'c1', content: 'boom', isError: true }] },
    ]);
    expect(out[0]!.content).toBe('ERROR: boom');
  });
});

describe('OpenAI-compatible — strict schema', () => {
  it('adds additionalProperties:false and requires every property, recursively', () => {
    const strict = strictifySchema({
      type: 'object',
      properties: {
        name: { type: 'string' },
        address: { type: 'object', properties: { city: { type: 'string' } } },
      },
      required: ['name'],
    }) as any;

    expect(strict.additionalProperties).toBe(false);
    expect(strict.required).toEqual(['name', 'address']);
    expect(strict.properties.address.additionalProperties).toBe(false);
    expect(strict.properties.address.required).toEqual(['city']);
  });
});

describe('OpenAI-compatible — usage', () => {
  it('reads cached tokens from prompt_tokens_details (OpenAI/Groq)', () => {
    const usage = mapOaiUsage({
      prompt_tokens: 1000,
      completion_tokens: 40,
      prompt_tokens_details: { cached_tokens: 768 },
      completion_tokens_details: { reasoning_tokens: 12 },
    });
    expect(usage).toMatchObject({ inputTokens: 1000, outputTokens: 40, cachedInputTokens: 768, reasoningTokens: 12 });
  });

  it('reads cached tokens from prompt_cache_hit_tokens (DeepSeek)', () => {
    const usage = mapOaiUsage({ prompt_tokens: 900, completion_tokens: 30, prompt_cache_hit_tokens: 640, prompt_cache_miss_tokens: 260 });
    expect(usage.cachedInputTokens).toBe(640);
    expect(usage.inputTokens).toBe(900);
  });
});

describe('OpenAI adapter', () => {
  beforeEach(() => resetProviders());

  it('asks for usage on streamed responses, which OpenAI otherwise omits entirely', async () => {
    const recorder = new FetchRecorder().sse(sseFrames([{ data: '[DONE]' }]));
    const provider = await providerFor('openai', recorder);
    await collect(provider.stream({ model: 'openai:gpt-4.1-mini', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }));

    expect(recorder.last.body.stream_options).toEqual({ include_usage: true });
  });

  it('accumulates tool arguments across chunks that carry only an index', async () => {
    const recorder = new FetchRecorder().sse(
      sseFrames([
        { data: { choices: [{ index: 0, delta: { content: 'Let me compute. ' } }] } },
        { data: { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'calculator', arguments: '' } }] } }] } },
        { data: { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"expre' } }] } }] } },
        { data: { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'ssion":"6*7"}' } }] } }] } },
        { data: { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] } },
        { data: { choices: [], usage: { prompt_tokens: 88, completion_tokens: 19 } } },
        { data: '[DONE]' },
      ]),
    );
    const provider = await providerFor('openai', recorder);
    const events = await collect(
      provider.stream({
        model: 'openai:gpt-4.1-mini',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
        tools: [{ name: 'calculator', description: 'math', parameters: { type: 'object', properties: { expression: { type: 'string' } } } }],
      }),
    );

    expect(textOf(events)).toBe('Let me compute. ');
    const complete = eventsOfType(events, 'tool_use_complete');
    expect(complete).toHaveLength(1);
    // The id arrived once, on the first chunk; the rest carried only index 0.
    expect(complete[0]!.id).toBe('call_abc');
    expect(complete[0]!.input).toEqual({ expression: '6*7' });
    expect(eventsOfType(events, 'usage')[0]!.usage).toMatchObject({ inputTokens: 88, outputTokens: 19 });
  });

  it('handles two parallel tool calls distinguished only by index', async () => {
    const recorder = new FetchRecorder().sse(
      sseFrames([
        { data: { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'calculator', arguments: '{"expression":"1+1"}' } }] } }] } },
        { data: { choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'get_weather', arguments: '{"location":"Oslo"}' } }] } }] } },
        { data: { choices: [{ delta: {}, finish_reason: 'tool_calls' }] } },
        { data: '[DONE]' },
      ]),
    );
    const provider = await providerFor('openai', recorder);
    const events = await collect(
      provider.stream({
        model: 'openai:gpt-4.1-mini',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
        tools: [
          { name: 'calculator', description: 'm', parameters: { type: 'object', properties: { expression: { type: 'string' } } } },
          { name: 'get_weather', description: 'w', parameters: { type: 'object', properties: { location: { type: 'string' } } } },
        ],
      }),
    );

    const complete = eventsOfType(events, 'tool_use_complete');
    expect(complete.map((c) => [c.name, c.input])).toEqual([
      ['calculator', { expression: '1+1' }],
      ['get_weather', { location: 'Oslo' }],
    ]);
  });

  it('uses native json_schema with strict mode for structured output', async () => {
    const recorder = new FetchRecorder().json({
      id: 'r', choices: [{ message: { content: '{"total":42}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4 },
    });
    const provider = await providerFor('openai', recorder);
    const res = await provider.complete({
      model: 'openai:gpt-4.1-mini',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
      responseFormat: { type: 'json_schema', name: 'invoice', schema: { type: 'object', properties: { total: { type: 'number' } } } },
    });

    expect(recorder.last.body.response_format.type).toBe('json_schema');
    expect(recorder.last.body.response_format.json_schema.strict).toBe(true);
    expect(recorder.last.body.response_format.json_schema.schema.additionalProperties).toBe(false);
    expect(res.structuredMode).toBe('native_json_schema');
  });

  it('treats insufficient_quota as auth, not rate_limit, because retrying never helps', async () => {
    const recorder = new FetchRecorder().json(
      { error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } },
      { status: 429 },
    );
    const provider = await providerFor('openai', recorder);
    const err = await provider
      .complete({ model: 'openai:gpt-4.1-mini', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })
      .catch((e) => e);

    expect(err.kind).toBe('auth');
    expect(err.retryable).toBe(false);
  });

  it('sorts embeddings by index, since order is not guaranteed', async () => {
    const recorder = new FetchRecorder().json({
      data: [
        { index: 1, embedding: [0.3, 0.4] },
        { index: 0, embedding: [0.1, 0.2] },
      ],
      usage: { prompt_tokens: 6 },
    });
    const provider = await providerFor('openai', recorder);
    const res = await provider.embed!({ texts: ['first', 'second'], model: 'openai:text-embedding-3-small' });
    expect(res.vectors[0]).toEqual([0.1, 0.2]);
  });
});

describe('Groq adapter', () => {
  beforeEach(() => resetProviders());

  it('reads final usage from x_groq.usage when it is not on the chunk', async () => {
    const recorder = new FetchRecorder().sse(
      sseFrames([
        { data: { choices: [{ delta: { content: 'fast' }, finish_reason: null }] } },
        { data: { choices: [{ delta: {}, finish_reason: 'stop' }], x_groq: { usage: { prompt_tokens: 11, completion_tokens: 2 } } } },
        { data: '[DONE]' },
      ]),
    );
    const provider = await providerFor('groq', recorder);
    const events = await collect(
      provider.stream({ model: 'groq:gpt-oss-20b', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }),
    );
    expect(textOf(events)).toBe('fast');
    expect(eventsOfType(events, 'usage')[0]!.usage).toMatchObject({ inputTokens: 11, outputTokens: 2 });
  });

  it('renames max_tokens for gpt-oss models, which reject it', async () => {
    const recorder = new FetchRecorder().json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} });
    const provider = await providerFor('groq', recorder);
    await provider.complete({
      model: 'groq:gpt-oss-120b',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
      maxTokens: 256,
    });
    expect(recorder.last.body.max_completion_tokens).toBe(256);
    expect(recorder.last.body.max_tokens).toBeUndefined();
  });

  it('parses a "6m0s"-style rate limit reset header', async () => {
    const recorder = new FetchRecorder().json(
      { error: { message: 'rate limit reached', type: 'rate_limit_exceeded' } },
      { status: 429, headers: { 'retry-after': '2.5' } },
    );
    const provider = await providerFor('groq', recorder);
    const err = await provider
      .complete({ model: 'groq:gpt-oss-20b', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })
      .catch((e) => e);
    expect(err.kind).toBe('rate_limit');
    expect(err.retryAfterMs).toBe(2500);
  });
});

describe('DeepSeek adapter', () => {
  beforeEach(() => resetProviders());

  it('surfaces reasoning_content on the reasoning channel and keeps it out of text', async () => {
    const recorder = new FetchRecorder().sse(
      sseFrames([
        { data: { choices: [{ delta: { reasoning_content: 'Let me think...' } }] } },
        { data: { choices: [{ delta: { content: 'The answer is 4.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 6 } } },
        { data: '[DONE]' },
      ]),
    );
    const provider = await providerFor('deepseek', recorder);
    const events = await collect(
      provider.stream({ model: 'deepseek:deepseek-flash', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }),
    );

    expect(textOf(events)).toBe('The answer is 4.');
    expect(eventsOfType(events, 'reasoning_delta')[0]!.text).toBe('Let me think...');
  });

  it('omits stream_options, which DeepSeek does not accept', async () => {
    const recorder = new FetchRecorder().sse(sseFrames([{ data: '[DONE]' }]));
    const provider = await providerFor('deepseek', recorder);
    await collect(
      provider.stream({ model: 'deepseek:deepseek-flash', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }),
    );
    expect(recorder.last.body.stream_options).toBeUndefined();
  });

  it('degrades structured output to json_object and says the mode was not enforced', async () => {
    const recorder = new FetchRecorder().json({
      choices: [{ message: { content: '{"total":1}' }, finish_reason: 'stop' }], usage: {},
    });
    const provider = await providerFor('deepseek', recorder);
    const res = await provider.complete({
      model: 'deepseek:deepseek-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
      responseFormat: { type: 'json_schema', name: 'x', schema: { type: 'object', properties: { total: { type: 'number' } } } },
    });

    expect(recorder.last.body.response_format).toEqual({ type: 'json_object' });
    expect(res.structuredMode).toBe('prompt_fallback');
  });

  it('refuses tools on a model whose config says it has none, without calling upstream', async () => {
    // groq/compound-mini is an agentic system with Groq's OWN built-in tools and
    // it rejects user-defined function calling ("`tool calling` is not supported
    // with this model", verified live). The capability flag has to catch that
    // before the request leaves, otherwise every such turn costs a round trip to
    // learn something config already knew.
    const recorder = new FetchRecorder();
    const provider = await providerFor('groq', recorder);

    await expect(
      provider.complete({
        model: 'groq:compound-mini',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
        tools: [{ name: 'calculator', description: 'm', parameters: { type: 'object', properties: { e: { type: 'string' } } } }],
      }),
    ).rejects.toMatchObject({ kind: 'unsupported', retryable: false });
    // Nothing was sent upstream: the capability flag caught it first.
    expect(recorder.requests).toHaveLength(0);
  });
});
