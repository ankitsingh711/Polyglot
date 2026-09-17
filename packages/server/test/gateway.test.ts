import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FetchRecorder, resetProviders } from './helpers.js';
import { loadProviders, registeredProviderNames, setFetchImpl } from '../src/core/registry.js';
import { complete, streamCompletion, resolveCandidates, type GatewayEvent } from '../src/core/gateway.js';
import { runWithTenant } from '../src/tenancy/context.js';
import { initDatabase, forTenant } from '../src/db/index.js';
import { ensureTenant } from '../src/tenancy/tenants.js';
import { newRequestId } from '../src/util/ids.js';
import { listUsage, aggregateByProvider } from '../src/modules/metrics/store.js';
import { loadConfig } from '../src/core/config.js';

let tenant: { id: string; name: string };

beforeAll(async () => {
  await loadProviders();
  initDatabase();
  const t = ensureTenant('Gateway Test', 'key-gateway');
  tenant = { id: t.id, name: t.name };
});

const inTenant = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenant({ tenantId: tenant.id, tenantName: tenant.name, requestId: newRequestId() }, fn);

const message = { role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] };

/** A fetch that fails N times with a given status, then succeeds. */
function flakyFetch(failures: number, status: number, body: unknown) {
  let calls = 0;
  const urls: string[] = [];
  setFetchImpl(async (input: any) => {
    urls.push(typeof input === 'string' ? input : input.url);
    calls++;
    if (calls <= failures) {
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }
    return new Response(
      JSON.stringify({
        id: 'm', content: [{ type: 'text', text: 'recovered' }], stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 3 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  return { get calls() { return calls; }, urls };
}

describe('fallback chain resolution', () => {
  it('follows the configured chain and respects maxHops', () => {
    const chain = resolveCandidates('anthropic:claude-haiku-4-5');
    expect(chain[0]).toBe('anthropic:claude-haiku-4-5');
    expect(chain.length).toBeGreaterThan(1);
    expect(chain.length).toBeLessThanOrEqual(loadConfig().app.fallback.maxHops + 1);
  });

  it('can be disabled, which comparison mode relies on', () => {
    expect(resolveCandidates('anthropic:claude-haiku-4-5', true)).toEqual(['anthropic:claude-haiku-4-5']);
  });
});

describe('retry', () => {
  beforeEach(() => resetProviders());

  it('retries a 500 and records the retry count on the usage row', async () => {
    const fetcher = flakyFetch(1, 500, { type: 'error', error: { type: 'api_error', message: 'boom' } });
    resetProviders();

    const res = await inTenant(() =>
      complete(
        { model: 'anthropic:claude-haiku-4-5', messages: [message], maxTokens: 64 },
        { kind: 'chat', policy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5, jitter: 'none', retryOn: ['rate_limit', 'server_error', 'timeout'], respectRetryAfter: false, maxRetryAfterMs: 100 } },
      ),
    );

    expect(res.content[0]).toMatchObject({ type: 'text', text: 'recovered' });
    expect(res.retryCount).toBe(1);
    expect(fetcher.calls).toBe(2);

    const rows = await inTenant(async () => listUsage({ limit: 10 }));
    // Both the failed attempt and the successful one are recorded.
    expect(rows.some((r) => r.error_kind === 'server_error')).toBe(true);
    expect(rows.some((r) => r.retry_count === 1 && r.error_kind === null)).toBe(true);
  });

  it('does NOT retry a 401, and falls through to the next provider instead', async () => {
    let anthropicCalls = 0;
    let googleCalls = 0;
    setFetchImpl(async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('anthropic')) {
        anthropicCalls++;
        return new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'bad key' } }), {
          status: 401, headers: { 'content-type': 'application/json' },
        });
      }
      googleCalls++;
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'from gemini' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    resetProviders();

    const res = await inTenant(() =>
      complete({ model: 'anthropic:claude-haiku-4-5', messages: [message], maxTokens: 64 }, { kind: 'chat' }),
    );

    // One attempt only: auth is permanent, so retrying would just burn quota.
    expect(anthropicCalls).toBe(1);
    expect(googleCalls).toBe(1);
    expect(res.provider).toBe('google');
    expect(res.fallbackFrom).toBe('anthropic:claude-haiku-4-5');
  });

  it('does not fall back on bad_request, which would fail identically anyway', async () => {
    let calls = 0;
    setFetchImpl(async () => {
      calls++;
      return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad tool schema' } }), {
        status: 400, headers: { 'content-type': 'application/json' },
      });
    });
    resetProviders();

    await expect(
      inTenant(() => complete({ model: 'anthropic:claude-haiku-4-5', messages: [message] }, { kind: 'chat' })),
    ).rejects.toMatchObject({ kind: 'bad_request' });
    expect(calls).toBe(1);
  });
});

describe('streaming gateway', () => {
  beforeEach(() => resetProviders());

  it('announces the fallback hop to the caller instead of hiding it', async () => {
    setFetchImpl(async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('anthropic')) {
        return new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }), {
          status: 529, headers: { 'content-type': 'application/json' },
        });
      }
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(encoder.encode('data: {"candidates":[{"content":{"parts":[{"text":"hi from gemini"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":4}}\n\n'));
            c.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    });
    resetProviders();

    const events: GatewayEvent[] = [];
    await inTenant(async () => {
      for await (const event of streamCompletion(
        { model: 'anthropic:claude-haiku-4-5', messages: [message], maxTokens: 32 },
        { kind: 'chat', policy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 2, jitter: 'none', retryOn: ['rate_limit', 'server_error', 'timeout'], respectRetryAfter: false, maxRetryAfterMs: 10 } },
      )) {
        events.push(event);
      }
    });

    const fallback = events.find((e) => e.type === 'fallback');
    expect(fallback).toMatchObject({ from: 'anthropic:claude-haiku-4-5', kind: 'rate_limit' });
    expect(events.filter((e) => e.type === 'text_delta').map((e: any) => e.text).join('')).toBe('hi from gemini');

    const meta = events.filter((e) => e.type === 'meta') as any[];
    expect(meta[meta.length - 1]!.fallbackFrom).toBe('anthropic:claude-haiku-4-5');
  });

  it('records time to first token and cost on the usage row', async () => {
    const encoder = new TextEncoder();
    setFetchImpl(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(encoder.encode('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1000}}}\n\n'));
              c.enqueue(encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n'));
              c.enqueue(encoder.encode('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":500}}\n\n'));
              c.enqueue(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
              c.close();
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    resetProviders();

    await inTenant(async () => {
      for await (const _ of streamCompletion(
        { model: 'anthropic:claude-haiku-4-5', messages: [message], maxTokens: 512 },
        { kind: 'chat' },
      )) {
        void _;
      }
    });

    const row = (await inTenant(async () => listUsage({ limit: 1 })))[0]!;
    expect(row.ttft_ms).not.toBeNull();
    expect(row.input_tokens).toBe(1000);
    expect(row.output_tokens).toBe(500);
    // haiku-4.5: 1000/1e6 * $1 + 500/1e6 * $5 = $0.0035
    expect(row.cost_usd).toBeCloseTo(0.0035, 8);
    expect(row.finish_reason).toBe('stop');
  });

  it('aggregates spend and latency by provider', async () => {
    const summary = await inTenant(async () => aggregateByProvider());
    expect(summary.length).toBeGreaterThan(0);
    for (const row of summary) {
      expect(row.requests).toBeGreaterThan(0);
      expect(row.total_cost_usd).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('cost caps', () => {
  beforeEach(() => resetProviders());

  it('refuses a request whose worst case exceeds the per-request cap', async () => {
    // Budgeting happens BEFORE the upstream call, priced at the worst case
    // (every one of maxTokens billed as output). Both the cap and the rate come
    // from config, so this stays a test of the guard rather than of today's
    // price list: ask for 1.5x the tokens the cap can pay for.
    const model = 'anthropic:claude-opus-4-5';
    const cfg = loadConfig();
    const capUsd = cfg.app.limits.maxCostPerRequestUsd;
    const outputPerMTok = cfg.models.models[model]!.pricing.outputPerMTok;
    const maxTokens = Math.ceil((capUsd / outputPerMTok) * 1_000_000 * 1.5);

    await expect(
      inTenant(() => complete({ model, messages: [message], maxTokens }, { kind: 'chat' })),
    ).rejects.toMatchObject({ code: 'request_cost_cap' });
  });
});

/**
 * The extensibility claim from the brief, asserted rather than described.
 * The registry scans the providers directory, so these invariants are what
 * "one new file and one config entry" actually depends on.
 */
describe('extensibility — adding a provider is one file plus one config entry', () => {
  const providersDir = join(import.meta.dirname, '..', 'src', 'providers');

  it('registers exactly the adapters present on disk', async () => {
    await loadProviders();
    const onDisk = readdirSync(providersDir)
      .filter((f) => f.endsWith('.provider.ts'))
      .map((f) => f.replace('.provider.ts', ''))
      .sort();
    expect(registeredProviderNames()).toEqual(onDisk);
  });

  it('has no file that enumerates provider names', () => {
    // If such a list existed, adding a provider would mean editing it -- which
    // is exactly the thing the brief says will be tested live.
    const search = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...search(full));
        else if (entry.name.endsWith('.ts')) out.push(full);
      }
      return out;
    };

    // Comments are stripped first: several files deliberately DISCUSS the branch
    // they avoid ("that is why pricing has no `if (provider === 'anthropic')`"),
    // and matching prose would make this assertion meaningless.
    const stripComments = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

    const srcDir = join(import.meta.dirname, '..', 'src');
    const offenders: string[] = [];
    for (const file of search(srcDir)) {
      if (file.includes(`${'providers'}/`)) continue; // an adapter may name itself
      const code = stripComments(readFileSync(file, 'utf8'));
      // A switch or comparison over vendor names outside the adapters is the smell.
      if (/case\s+'(anthropic|google|openai|groq|deepseek)'/.test(code)) offenders.push(`${file} (switch)`);
      if (/provider\s*===\s*'(anthropic|google|openai|groq|deepseek)'/.test(code)) offenders.push(`${file} (comparison)`);
      if (/\bif\s*\(\s*(?:\w+\.)?provider\s*==/.test(code)) offenders.push(`${file} (branch)`);
    }
    expect(offenders).toEqual([]);
  });

  it('keeps every model id resolvable to a registered adapter', async () => {
    await loadProviders();
    const registered = new Set(registeredProviderNames());
    for (const [id, entry] of Object.entries(loadConfig().models.models)) {
      expect(registered.has(entry.provider), `${id} -> ${entry.provider}`).toBe(true);
    }
  });
});

describe('usage records are tenant-scoped like everything else', () => {
  it('does not show one tenant the other\'s spend', async () => {
    const other = ensureTenant('Gateway Other', 'key-gateway-other');
    const rowsForOther = await runWithTenant(
      { tenantId: other.id, tenantName: other.name, requestId: newRequestId() },
      async () => listUsage({ limit: 100 }),
    );
    const rowsForMine = await inTenant(async () => listUsage({ limit: 100 }));

    expect(rowsForMine.length).toBeGreaterThan(0);
    expect(rowsForOther).toHaveLength(0);

    // And the table itself refuses an unscoped read.
    await inTenant(async () => {
      expect(() => forTenant().prepare('SELECT * FROM usage_records')).toThrow();
    });
  });
});

/** Keep the unused import honest. */
void FetchRecorder;
