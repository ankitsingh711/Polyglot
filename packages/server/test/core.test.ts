import { describe, it, expect } from 'vitest';
import { parseSse, parseSseJson } from '../src/providers/_shared/sse.js';
import { ToolCallAccumulator, parseToolInput } from '../src/providers/_shared/tool-args.js';
import { ProviderError, parseRetryAfter, kindFromStatus, isRetryableKind, normalizeTransportError } from '../src/core/errors.js';
import { computeBackoff, shouldRetry, type RetryPolicy } from '../src/core/retry.js';
import { computeCost } from '../src/core/pricing.js';
import { estimateTextTokens, estimateConversationTokens } from '../src/core/tokens.js';
import { loadConfig } from '../src/core/config.js';
import { loadProviders, registeredProviderNames, listModels, getModelEntry } from '../src/core/registry.js';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe('SSE parser', () => {
  it('reassembles a frame split across network chunks', async () => {
    const frames = [];
    for await (const frame of parseSse(streamOf(['data: {"a":', '1}\n\n']))) frames.push(frame);
    expect(frames).toEqual([{ event: undefined, data: '{"a":1}', id: undefined }]);
  });

  it('handles CRLF line endings', async () => {
    const frames = [];
    for await (const frame of parseSse(streamOf(['event: ping\r\ndata: hello\r\n\r\n']))) frames.push(frame);
    expect(frames[0]).toMatchObject({ event: 'ping', data: 'hello' });
  });

  it('joins multi-line data with newlines, per spec', async () => {
    const frames = [];
    for await (const frame of parseSse(streamOf(['data: line one\ndata: line two\n\n']))) frames.push(frame);
    expect(frames[0]!.data).toBe('line one\nline two');
  });

  it('ignores comment heartbeats', async () => {
    const frames = [];
    for await (const frame of parseSse(streamOf([': keep-alive\n\ndata: real\n\n']))) frames.push(frame);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.data).toBe('real');
  });

  it('emits a trailing frame that has no terminating blank line', async () => {
    const frames = [];
    for await (const frame of parseSse(streamOf(['data: last']))) frames.push(frame);
    expect(frames[0]!.data).toBe('last');
  });

  it('strips exactly one leading space after the colon', async () => {
    const frames = [];
    for await (const frame of parseSse(streamOf(['data:  two spaces\n\n']))) frames.push(frame);
    expect(frames[0]!.data).toBe(' two spaces');
  });

  it('skips [DONE] and malformed frames without killing the stream', async () => {
    const out = [];
    for await (const item of parseSseJson(streamOf(['data: {"ok":1}\n\ndata: not json\n\ndata: [DONE]\n\ndata: {"ok":2}\n\n']))) {
      out.push(item.json);
    }
    expect(out).toEqual([{ ok: 1 }, { ok: 2 }]);
  });
});

describe('tool argument accumulator', () => {
  it('concatenates fragments and parses once at the end', () => {
    const acc = new ToolCallAccumulator();
    acc.start('t1', 'calculator', 0);
    for (const fragment of ['{', '"expr', 'ession"', ':"1+', '1"}']) acc.push('t1', fragment);
    expect(acc.finish('t1')).toEqual({ id: 't1', name: 'calculator', input: { expression: '1+1' } });
  });

  it('maps an OpenAI-style index back to the id announced once', () => {
    const acc = new ToolCallAccumulator();
    acc.start('call_x', 'weather', 0);
    expect(acc.idForIndex(0)).toBe('call_x');
  });

  it('treats no arguments as an empty object, which is legitimate', () => {
    expect(parseToolInput('')).toEqual({});
    expect(parseToolInput('{}')).toEqual({});
  });

  it('reports a parse failure rather than guessing at repaired JSON', () => {
    const parsed = parseToolInput('{"expression": "1+');
    expect(parsed._parse_error).toBe(true);
    expect(parsed._raw).toBe('{"expression": "1+');
  });

  it('preserves the order the provider announced tools in', () => {
    const acc = new ToolCallAccumulator();
    acc.start('b', 'second', 1);
    acc.start('a', 'first', 0);
    expect(acc.finishAll().map((t) => t.name)).toEqual(['second', 'first']);
  });
});

describe('error taxonomy', () => {
  it('maps statuses the way every vendor agrees', () => {
    expect(kindFromStatus(401)).toBe('auth');
    expect(kindFromStatus(429)).toBe('rate_limit');
    expect(kindFromStatus(400)).toBe('bad_request');
    expect(kindFromStatus(503)).toBe('server_error');
  });

  it('retries only rate_limit, server_error and timeout', () => {
    expect(isRetryableKind('rate_limit')).toBe(true);
    expect(isRetryableKind('server_error')).toBe(true);
    expect(isRetryableKind('timeout')).toBe(true);
    expect(isRetryableKind('auth')).toBe(false);
    expect(isRetryableKind('bad_request')).toBe(false);
    expect(isRetryableKind('context_length')).toBe(false);
    expect(isRetryableKind('content_filter')).toBe(false);
    expect(isRetryableKind('cancelled')).toBe(false);
  });

  it('parses Retry-After as seconds, as a duration, and as an HTTP date', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter(new Headers({ 'retry-after': '5' }))).toBe(5000);
    expect(parseRetryAfter(new Headers({ 'retry-after': '1.5' }))).toBe(1500);
    expect(parseRetryAfter(new Headers({ 'x-ratelimit-reset-requests': '6m30s' }))).toBe(390_000);
    expect(parseRetryAfter(new Headers({ 'retry-after': 'Thu, 01 Jan 2026 00:00:10 GMT' }), now)).toBe(10_000);
    expect(parseRetryAfter(new Headers())).toBeUndefined();
  });

  it('keeps raw bodies out of the client-facing shape', () => {
    const err = new ProviderError({
      kind: 'bad_request',
      provider: 'openai',
      message: 'nope',
      raw: { authorization: 'Bearer sk-secret' },
    });
    const client = err.toClient() as Record<string, unknown>;
    expect(client.raw).toBeUndefined();
    expect(JSON.stringify(client)).not.toContain('sk-secret');
  });

  it('distinguishes a user cancel from a timeout', () => {
    const abort = normalizeTransportError('anthropic', Object.assign(new Error('aborted'), { name: 'AbortError' }));
    expect(abort.kind).toBe('cancelled');
    expect(abort.retryable).toBe(false);

    const timeout = normalizeTransportError('anthropic', Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
    expect(timeout.kind).toBe('timeout');
    expect(timeout.retryable).toBe(true);
  });
});

describe('retry policy', () => {
  const policy: RetryPolicy = {
    maxAttempts: 4,
    baseDelayMs: 100,
    maxDelayMs: 5000,
    jitter: 'full',
    retryOn: ['rate_limit', 'server_error', 'timeout'],
    respectRetryAfter: true,
    maxRetryAfterMs: 30_000,
  };

  it('grows exponentially and stays inside the jitter envelope', () => {
    // Full jitter is random(0, exponential): the ceiling is what we can assert.
    expect(computeBackoff(1, policy, undefined, () => 1)).toBe(100);
    expect(computeBackoff(2, policy, undefined, () => 1)).toBe(200);
    expect(computeBackoff(3, policy, undefined, () => 1)).toBe(400);
    expect(computeBackoff(1, policy, undefined, () => 0)).toBe(0);
  });

  it('caps at maxDelayMs', () => {
    expect(computeBackoff(12, policy, undefined, () => 1)).toBe(5000);
  });

  it('prefers the provider\'s Retry-After but refuses an unbounded one', () => {
    expect(computeBackoff(1, policy, 2500, () => 1)).toBe(2500);
    expect(computeBackoff(1, policy, 600_000, () => 1)).toBe(30_000);
  });

  it('never retries auth or bad_request, whatever the status was', () => {
    expect(shouldRetry(new ProviderError({ kind: 'auth', provider: 'x', message: '' }), policy)).toBe(false);
    expect(shouldRetry(new ProviderError({ kind: 'bad_request', provider: 'x', message: '' }), policy)).toBe(false);
    expect(shouldRetry(new ProviderError({ kind: 'rate_limit', provider: 'x', message: '' }), policy)).toBe(true);
    expect(shouldRetry(new Error('plain'), policy)).toBe(false);
  });
});

describe('cost computation', () => {
  it('bills Anthropic cache reads and writes at their own rates', () => {
    // claude-haiku-4-5: $1.00 in, $5.00 out, $0.10 cache read, $1.25 cache write.
    const cost = computeCost('anthropic:claude-haiku-4-5', {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 900_000,
      cacheWriteTokens: 50_000,
    });
    // 50k fresh @ $1 + 900k read @ $0.10 + 50k write @ $1.25
    expect(cost.inputUsd).toBeCloseTo(0.05, 6);
    expect(cost.cachedInputUsd).toBeCloseTo(0.09, 6);
    expect(cost.cacheWriteUsd).toBeCloseTo(0.0625, 6);
    expect(cost.totalUsd).toBeCloseTo(0.2025, 6);
  });

  it('shows the saving a cache hit actually produced', () => {
    const uncached = computeCost('anthropic:claude-haiku-4-5', { inputTokens: 1_000_000, outputTokens: 0 });
    const cached = computeCost('anthropic:claude-haiku-4-5', {
      inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 1_000_000,
    });
    expect(uncached.totalUsd).toBeCloseTo(1.0, 6);
    expect(cached.totalUsd).toBeCloseTo(0.1, 6);
  });

  it('falls back to the full input rate when no cached price is published', () => {
    const cost = computeCost('groq:llama-3.1-8b-instant', {
      inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 500_000,
    });
    expect(cost.approximated).toBe(true);
    expect(cost.totalUsd).toBeCloseTo(0.05, 6);
  });

  it('returns zero for an unknown model instead of throwing inside metrics', () => {
    expect(computeCost('nope:nothing', { inputTokens: 100, outputTokens: 100 }).totalUsd).toBe(0);
  });
});

describe('token estimation', () => {
  it('scales with length and counts message overhead', () => {
    expect(estimateTextTokens('')).toBe(0);
    expect(estimateTextTokens('hello world')).toBeGreaterThan(0);
    const short = estimateConversationTokens([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
    const long = estimateConversationTokens([{ role: 'user', content: [{ type: 'text', text: 'hi '.repeat(500) }] }]);
    expect(long).toBeGreaterThan(short * 10);
  });

  it('charges an image far more than its character count', () => {
    const tokens = estimateConversationTokens([
      { role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }] },
    ]);
    expect(tokens).toBeGreaterThan(800);
  });
});

describe('configuration and registry', () => {
  it('validates every config file at load and cross-checks them', () => {
    const cfg = loadConfig(true);
    expect(Object.keys(cfg.models.models).length).toBeGreaterThan(10);
    for (const [id, entry] of Object.entries(cfg.models.models)) {
      expect(id.startsWith(`${entry.provider}:`)).toBe(true);
      expect(cfg.providers.providers[entry.provider]).toBeDefined();
      expect(entry.pricing.inputPerMTok).toBeGreaterThanOrEqual(0);
    }
  });

  it('auto-discovers every adapter file without an index or a switch', async () => {
    await loadProviders();
    // This is the extensibility claim, asserted rather than described: the list
    // comes from scanning src/providers, so a new file appears here for free.
    expect(registeredProviderNames()).toEqual(['anthropic', 'deepseek', 'google', 'groq', 'local', 'openai']);
  });

  it('exposes prices from config, not from code', () => {
    // Change config/models.json and this changes; there is no price literal in
    // any .ts file to keep in sync.
    expect(getModelEntry('anthropic:claude-sonnet-4-5').pricing).toEqual({
      inputPerMTok: 3.0, outputPerMTok: 15.0, cachedInputPerMTok: 0.3, cacheWritePerMTok: 3.75,
    });
    expect(listModels('embedding').every((m) => m.dimensions && m.dimensions > 0)).toBe(true);
  });
});
