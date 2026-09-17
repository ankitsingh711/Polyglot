import { describe, it, expect, beforeEach } from 'vitest';
import { FetchRecorder, providerFor, resetProviders, collect, textOf, eventsOfType, sseFrames } from './helpers.js';
import { toGeminiSchema, toGeminiContents, mapGeminiUsage } from '../src/providers/google.provider.js';
import type { Message } from '../src/core/types.js';

const MODEL = 'google:gemini-2.5-flash';

describe('Gemini adapter — schema translation', () => {
  it('uppercases types and drops the keywords Gemini rejects', () => {
    const schema = toGeminiSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
      properties: {
        city: { type: 'string', description: 'City name' },
        days: { type: 'integer', minimum: 1, maximum: 7, default: 3 },
        units: { type: 'string', enum: ['c', 'f'] },
      },
      required: ['city'],
    })!;

    expect(schema.type).toBe('OBJECT');
    expect(schema).not.toHaveProperty('additionalProperties');
    expect(schema).not.toHaveProperty('$schema');
    const props = schema.properties as Record<string, any>;
    expect(props.city.type).toBe('STRING');
    expect(props.days).toMatchObject({ type: 'INTEGER', minimum: 1, maximum: 7 });
    expect(props.days).not.toHaveProperty('default');
    expect(props.units.enum).toEqual(['c', 'f']);
    expect(schema.required).toEqual(['city']);
    expect(schema.propertyOrdering).toEqual(['city', 'days', 'units']);
  });

  it('converts a nullable union type into type + nullable', () => {
    const schema = toGeminiSchema({ type: ['string', 'null'] })!;
    expect(schema).toMatchObject({ type: 'STRING', nullable: true });
  });

  it('maps oneOf to anyOf, the closest honest equivalent', () => {
    const schema = toGeminiSchema({ oneOf: [{ type: 'string' }, { type: 'number' }] })!;
    expect((schema.anyOf as any[]).map((v) => v.type)).toEqual(['STRING', 'NUMBER']);
  });

  it('recurses into array items', () => {
    const schema = toGeminiSchema({ type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } })!;
    expect(schema.type).toBe('ARRAY');
    expect((schema.items as any).properties.id.type).toBe('STRING');
  });
});

describe('Gemini adapter — message translation', () => {
  beforeEach(() => resetProviders());

  it('renames assistant to model and folds the tool role into a user turn', () => {
    const contents = toGeminiContents([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    ]);
    expect(contents.map((c) => c.role)).toEqual(['user', 'model']);
  });

  it('recovers the function NAME for a tool result, since Gemini correlates by name', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'weather?' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_42', name: 'get_weather', input: { location: 'Oslo' } }] },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'tu_42', content: '{"c":3}' }] },
    ];
    const contents = toGeminiContents(messages);
    const response = contents[2]!.parts[0]!.functionResponse!;

    // The tool_result block never carried the name; it came from the tool_use.
    expect(response.name).toBe('get_weather');
    expect(response.response).toEqual({ result: '{"c":3}' });
  });

  it('flags a failed tool result in-band, because Gemini has no is_error field', () => {
    const contents = toGeminiContents([
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'calculator', input: {} }] },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 't1', content: 'divide by zero', isError: true }] },
    ]);
    expect(contents[1]!.parts[0]!.functionResponse!.response).toEqual({ error: 'divide by zero' });
  });

  it('sends systemInstruction rather than a system message, and hits the right URL', async () => {
    const recorder = new FetchRecorder().json({
      candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1 },
    });
    const provider = await providerFor('google', recorder);

    await provider.complete({ model: MODEL, system: 'Be terse.', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] });

    expect(recorder.last.url).toContain('/v1beta/models/gemini-2.5-flash:generateContent');
    expect(recorder.last.body.systemInstruction).toEqual({ parts: [{ text: 'Be terse.' }] });
    // Key in a header, never in the query string.
    expect(recorder.last.headers['x-goog-api-key']).toBe('test-gemini-key');
    expect(recorder.last.url).not.toContain('key=');
  });

  it('omits parameters entirely for a zero-argument tool', async () => {
    const recorder = new FetchRecorder().json({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] });
    const provider = await providerFor('google', recorder);

    await provider.complete({
      model: MODEL,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
      tools: [{ name: 'ping', description: 'ping', parameters: { type: 'object', properties: {} } }],
    });

    const declaration = recorder.last.body.tools[0].functionDeclarations[0];
    expect(declaration.name).toBe('ping');
    expect(declaration).not.toHaveProperty('parameters');
  });

  it('refuses to combine tools with a response schema', async () => {
    const recorder = new FetchRecorder();
    const provider = await providerFor('google', recorder);

    await expect(
      provider.complete({
        model: MODEL,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
        tools: [{ name: 't', description: 'd', parameters: { type: 'object', properties: { a: { type: 'string' } } } }],
        responseFormat: { type: 'json_schema', name: 'x', schema: { type: 'object' } },
      }),
    ).rejects.toMatchObject({ kind: 'unsupported' });
  });
});

describe('Gemini adapter — usage', () => {
  it('folds thinking tokens into output and treats cached as part of prompt', () => {
    const usage = mapGeminiUsage({
      promptTokenCount: 1000,
      candidatesTokenCount: 50,
      cachedContentTokenCount: 800,
      thoughtsTokenCount: 120,
    });
    // Unlike Anthropic, promptTokenCount already INCLUDES the cached tokens.
    expect(usage.inputTokens).toBe(1000);
    expect(usage.cachedInputTokens).toBe(800);
    // Thinking tokens are billed as output but excluded from candidatesTokenCount.
    expect(usage.outputTokens).toBe(170);
    expect(usage.reasoningTokens).toBe(120);
  });
});

describe('Gemini adapter — streaming', () => {
  beforeEach(() => resetProviders());

  it('synthesizes start/delta/complete for a tool call delivered in one chunk', async () => {
    const recorder = new FetchRecorder().sse(
      sseFrames([
        { data: { candidates: [{ content: { role: 'model', parts: [{ text: 'Checking. ' }] } }] } },
        {
          data: {
            candidates: [
              { content: { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { location: 'Oslo' } } }] } },
            ],
            usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 9 },
          },
        },
      ]),
    );
    const provider = await providerFor('google', recorder);
    const events = await collect(provider.stream({ model: MODEL, messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }));

    expect(recorder.last.url).toContain(':streamGenerateContent?alt=sse');
    expect(textOf(events)).toBe('Checking. ');

    // Gemini sends whole args at once; callers still see the three-event shape.
    expect(eventsOfType(events, 'tool_use_start')).toHaveLength(1);
    expect(eventsOfType(events, 'tool_use_delta')).toHaveLength(1);
    const complete = eventsOfType(events, 'tool_use_complete')[0]!;
    expect(complete.input).toEqual({ location: 'Oslo' });
    expect(eventsOfType(events, 'done')[0]!.finishReason).toBe('tool_use');
  });

  it('routes thought parts to the reasoning channel', async () => {
    const recorder = new FetchRecorder().sse(
      sseFrames([
        { data: { candidates: [{ content: { parts: [{ text: 'considering', thought: true }, { text: 'answer' }] }, finishReason: 'STOP' }] } },
      ]),
    );
    const provider = await providerFor('google', recorder);
    const events = await collect(provider.stream({ model: MODEL, messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }));

    expect(textOf(events)).toBe('answer');
    expect(eventsOfType(events, 'reasoning_delta')[0]!.text).toBe('considering');
  });

  it('reports a blocked prompt as a non-retryable content_filter', async () => {
    const recorder = new FetchRecorder().sse(sseFrames([{ data: { promptFeedback: { blockReason: 'SAFETY' } } }]));
    const provider = await providerFor('google', recorder);
    const events = await collect(provider.stream({ model: MODEL, messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }));

    const error = eventsOfType(events, 'error')[0]!.error;
    expect(error.kind).toBe('content_filter');
    expect(error.retryable).toBe(false);
  });

  it('takes the LAST usageMetadata, since Gemini repeats it cumulatively', async () => {
    const recorder = new FetchRecorder().sse(
      sseFrames([
        { data: { candidates: [{ content: { parts: [{ text: 'a' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 } } },
        { data: { candidates: [{ content: { parts: [{ text: 'b' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } } },
      ]),
    );
    const provider = await providerFor('google', recorder);
    const events = await collect(provider.stream({ model: MODEL, messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }));

    expect(eventsOfType(events, 'usage')[0]!.usage).toMatchObject({ inputTokens: 10, outputTokens: 2 });
  });
});

describe('Gemini adapter — errors', () => {
  beforeEach(() => resetProviders());

  it('maps RESOURCE_EXHAUSTED to rate_limit', async () => {
    const recorder = new FetchRecorder().json(
      { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } },
      { status: 429 },
    );
    const provider = await providerFor('google', recorder);
    await expect(
      provider.complete({ model: MODEL, messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }),
    ).rejects.toMatchObject({ kind: 'rate_limit', retryable: true });
  });

  it('detects a token-count overflow as context_length despite INVALID_ARGUMENT', async () => {
    const recorder = new FetchRecorder().json(
      { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'The input token count (1200000) exceeds the maximum' } },
      { status: 400 },
    );
    const provider = await providerFor('google', recorder);
    await expect(
      provider.complete({ model: MODEL, messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }),
    ).rejects.toMatchObject({ kind: 'context_length' });
  });
});

describe('Gemini adapter — embeddings', () => {
  beforeEach(() => resetProviders());

  it('batches through batchEmbedContents and tags the task type', async () => {
    const recorder = new FetchRecorder().json({ embeddings: [{ values: [0.1, 0.2] }, { values: [0.3, 0.4] }] });
    const provider = await providerFor('google', recorder);

    const res = await provider.embed!({ texts: ['a', 'b'], model: 'google:gemini-embedding-001', taskType: 'query' });

    expect(recorder.last.url).toContain(':batchEmbedContents');
    expect(recorder.last.body.requests[0].taskType).toBe('RETRIEVAL_QUERY');
    expect(res.vectors).toHaveLength(2);
  });

  it('fails loudly if the vendor returns the wrong number of vectors', async () => {
    const recorder = new FetchRecorder().json({ embeddings: [{ values: [0.1] }] });
    const provider = await providerFor('google', recorder);
    await expect(
      provider.embed!({ texts: ['a', 'b'], model: 'google:gemini-embedding-001' }),
    ).rejects.toMatchObject({ kind: 'server_error' });
  });
});
