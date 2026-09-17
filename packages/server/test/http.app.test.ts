import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import net from 'node:net';
import { createApp } from '../src/http/app.js';
import { setFetchImpl } from '../src/core/registry.js';
import { ensureTenant } from '../src/tenancy/tenants.js';
import { runWithTenant } from '../src/tenancy/context.js';
import { newRequestId } from '../src/util/ids.js';

/**
 * The HTTP layer, driven over a real socket against a fixture upstream.
 *
 * Every other test file exercises a module in isolation. This one boots the
 * actual Express app -- the same `createApp()` that `src/index.ts` serves -- and
 * talks to it with `fetch`, because a whole class of defect only exists at that
 * seam and is invisible from inside a module:
 *
 *   - tenant resolution, rate limiting, CORS and the body limits are middleware,
 *     so no unit test ever runs them;
 *   - SSE is a transport, and "does the browser actually receive tokens one at a
 *     time" is not a question the chat service can answer about itself;
 *   - the cancellation path is defined entirely by socket lifecycle events
 *     (`res.on('close')`, `writableFinished`), which only happen for real when a
 *     real peer hangs up. Getting this wrong is not hypothetical: deriving the
 *     abort signal from `req.on('close')` instead silently aborted every request
 *     on the first line of its handler.
 *
 * The upstream is a fixture, so this is deterministic and needs no API key.
 */

const ANTHROPIC_MODEL = 'anthropic:claude-haiku-4-5';

let server: Server;
let base: string;
let tenantA: string;
let tenantB: string;

/** A minimal but wire-accurate Anthropic streaming response, one frame per chunk. */
function anthropicStream(pieces: string[]): string[] {
  const frames: string[] = [
    `event: message_start\ndata: ${JSON.stringify({
      type: 'message_start',
      message: { id: 'msg_fixture', model: 'claude-haiku-4-5', usage: { input_tokens: 11, output_tokens: 0 } },
    })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({
      type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' },
    })}\n\n`,
  ];
  for (const text of pieces) {
    frames.push(
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text },
      })}\n\n`,
    );
  }
  frames.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
  frames.push(
    `event: message_delta\ndata: ${JSON.stringify({
      type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: pieces.length },
    })}\n\n`,
  );
  frames.push(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
  return frames;
}

/** A deterministic, text-dependent unit vector. Same text → same vector. */
function pseudoEmbedding(text: string, dims = 1536): number[] {
  const vector = new Array<number>(dims).fill(0);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    vector[(code * 31 + i) % dims]! += ((code % 13) - 6) / 6;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((v) => v / norm);
}

/**
 * A URL-aware fixture upstream.
 *
 * It has to route, not just replay: a chat turn also triggers an embedding call
 * (the semantic cache probes for a similar prompt before spending money), and
 * answering that with an SSE stream sends the embedding chain into retries that
 * have nothing to do with what the test is asserting.
 *
 * `pieces` are streamed with a gap between them so a test can hang up midway.
 */
function fixtureUpstream(pieces: string[], gapMs: number, onChatCancel: () => void = () => {}) {
  return async (input: any, init: any = {}) => {
    const url = typeof input === 'string' ? input : input.url;

    if (/embeddings|embedContent/i.test(url)) {
      /*
       * Derived from the text, NOT constant. A fixture that returns the same
       * vector for every input makes every prompt a 1.0 similarity match, so the
       * semantic cache answers the second test from the first test's reply and
       * the upstream is never called at all -- which quietly invalidates any
       * assertion about streaming or cancellation.
       */
      const vector = pseudoEmbedding(String(init.body ?? url));
      const body = url.includes('embedContent')
        ? { embeddings: [{ values: vector }] }
        : { data: [{ embedding: vector }], usage: { prompt_tokens: 4, total_tokens: 4 } };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    const frames = anthropicStream(pieces);
    const encoder = new TextEncoder();
    const upstreamSignal: AbortSignal | undefined = init.signal;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        // The whole point: if the browser hangs up, this signal must fire. That
        // is what distinguishes aborting the upstream request from merely
        // stopping the rendering.
        upstreamSignal?.addEventListener('abort', onChatCancel, { once: true });
        for (const frame of frames) {
          if (upstreamSignal?.aborted) break;
          controller.enqueue(encoder.encode(frame));
          await new Promise((r) => setTimeout(r, gapMs));
        }
        try { controller.close(); } catch { /* already torn down */ }
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
}

async function api(path: string, opts: { key?: string; method?: string; body?: unknown } = {}) {
  return fetch(`${base}${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: {
      ...(opts.key ? { 'x-tenant-key': opts.key } : {}),
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
}

async function newConversation(key: string): Promise<string> {
  const res = await api('/api/conversations', { key, body: { title: 'fixture' } });
  expect(res.status).toBe(201);
  return (await res.json()).conversation.id;
}

/** Read an SSE body into events, recording when each one arrived. */
async function readSse(res: Response): Promise<Array<{ at: number; event: any }>> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const out: Array<{ at: number; event: any }> = [];
  const t0 = Date.now();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = raw.split('\n').find((l) => l.startsWith('data: '));
      if (line) out.push({ at: Date.now() - t0, event: JSON.parse(line.slice(6)) });
    }
  }
  return out;
}

beforeAll(async () => {
  const app = await createApp();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const a = ensureTenant('HTTP Test A', 'http-key-a');
  const b = ensureTenant('HTTP Test B', 'http-key-b');
  tenantA = 'http-key-a';
  tenantB = 'http-key-b';
  expect(a.id).not.toBe(b.id);
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

describe('HTTP: tenant resolution', () => {
  it('serves /health without a key and says nothing about providers or tenants', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    // A health endpoint that enumerates configured vendors is reconnaissance.
    expect(JSON.stringify(body)).not.toMatch(/anthropic|google|groq|openai|tenant/i);
  });

  it('refuses every API route without a tenant key', async () => {
    for (const path of ['/api/models', '/api/conversations', '/api/collections', '/api/metrics/summary']) {
      const res = await api(path);
      expect(res.status, path).toBe(401);
      expect((await res.json()).error.code, path).toBe('missing_tenant_key');
    }
  });

  it('refuses an unrecognized key, and cannot be talked into trusting a tenant id', async () => {
    expect((await api('/api/models', { key: 'not-a-real-key' })).status).toBe(401);

    // There is no header that names a tenant directly, so there is nothing to forge.
    const forged = await fetch(`${base}/api/collections`, { headers: { 'x-tenant-id': 'ten_anything' } });
    expect(forged.status).toBe(401);
  });
});

describe('HTTP: streaming a turn end to end', () => {
  it('delivers tokens as separate SSE events over time, not one buffered blob', async () => {
    setFetchImpl(fixtureUpstream(['Hel', 'lo ', 'world'], 30, () => {}));
    const conversation = await newConversation(tenantA);

    const res = await fetch(`${base}/api/conversations/${conversation}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant-key': tenantA },
      body: JSON.stringify({ text: 'hi', model: ANTHROPIC_MODEL, maxTokens: 64 }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const events = await readSse(res);
    const deltas = events.filter((e) => e.event.type === 'delta');
    expect(deltas.map((d) => d.event.text).join('')).toBe('Hello world');
    // Three deltas that arrive at three different times is the difference
    // between real streaming and a typewriter animation over a buffered string.
    expect(deltas).toHaveLength(3);
    expect(deltas[2]!.at).toBeGreaterThan(deltas[0]!.at);

    const usage = events.find((e) => e.event.type === 'usage')!.event;
    expect(usage.usage.inputTokens).toBe(11);
    expect(usage.costUsd).toBeGreaterThan(0);
    expect(usage.ttftMs).toBeGreaterThanOrEqual(0);
    expect(events.at(-1)!.event.type).toBe('done');
  });

  it('persists the turn, so a reload shows the same conversation', async () => {
    setFetchImpl(fixtureUpstream(['remembered'], 1, () => {}));
    const conversation = await newConversation(tenantA);
    await readSse(
      await fetch(`${base}/api/conversations/${conversation}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tenant-key': tenantA },
        body: JSON.stringify({ text: 'remember this', model: ANTHROPIC_MODEL, maxTokens: 64 }),
      }),
    );

    const reloaded = await (await api(`/api/conversations/${conversation}`, { key: tenantA })).json();
    expect(reloaded.messages).toHaveLength(2);
    expect(reloaded.messages[0].role).toBe('user');
    expect(reloaded.messages[1].content[0].text).toBe('remembered');
  });

  it('aborts the UPSTREAM request when the browser hangs up mid-stream', async () => {
    let upstreamAborted = false;
    setFetchImpl(
      fixtureUpstream(Array.from({ length: 60 }, (_, i) => `tok${i} `), 40, () => {
        upstreamAborted = true;
      }),
    );
    const conversation = await newConversation(tenantA);

    /*
     * A raw socket, destroyed mid-stream, rather than fetch + AbortController:
     * undici pools connections and an aborted fetch does not reliably close the
     * TCP connection, so the server would never see a disconnect and the test
     * would be asserting the wrong thing. Destroying the socket is what a
     * browser tab closing actually looks like to the server.
     */
    const payload = JSON.stringify({ text: 'long one', model: ANTHROPIC_MODEL, maxTokens: 4000 });
    const port = (server.address() as AddressInfo).port;
    const socket = net.createConnection({ host: '127.0.0.1', port });
    await new Promise((r) => socket.once('connect', r));

    let received = 0;
    socket.on('data', (chunk) => { received += chunk.length; });
    socket.write(
      `POST /api/conversations/${conversation}/messages HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `x-tenant-key: ${tenantA}\r\n` +
        `content-type: application/json\r\n` +
        `content-length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`,
    );

    // Let a few tokens actually arrive, then hang up.
    for (let i = 0; i < 40 && received === 0; i++) await new Promise((r) => setTimeout(r, 25));
    expect(received).toBeGreaterThan(0);
    socket.destroy();

    for (let i = 0; i < 60 && !upstreamAborted; i++) await new Promise((r) => setTimeout(r, 25));
    expect(upstreamAborted).toBe(true);
  });
});

describe('HTTP: tenant isolation across the wire', () => {
  it('hides one tenant\'s conversation from another, and does not let it write there', async () => {
    setFetchImpl(fixtureUpstream(['secret'], 1, () => {}));
    const conversation = await newConversation(tenantA);
    await readSse(
      await fetch(`${base}/api/conversations/${conversation}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tenant-key': tenantA },
        body: JSON.stringify({ text: 'tenant A only', model: ANTHROPIC_MODEL, maxTokens: 64 }),
      }),
    );

    // B cannot read it...
    expect((await api(`/api/conversations/${conversation}`, { key: tenantA })).status).toBe(200);
    expect((await api(`/api/conversations/${conversation}`, { key: tenantB })).status).toBe(404);

    // ...cannot list it...
    const listed = await (await api('/api/conversations', { key: tenantB })).json();
    expect(listed.conversations.map((c: any) => c.id)).not.toContain(conversation);

    // ...and cannot append to it.
    const write = await api(`/api/conversations/${conversation}/messages`, {
      key: tenantB, body: { text: 'inject', model: ANTHROPIC_MODEL },
    });
    expect(write.status).toBe(404);

    // A's conversation is untouched by any of that.
    const still = await (await api(`/api/conversations/${conversation}`, { key: tenantA })).json();
    expect(still.messages).toHaveLength(2);
  });

  it('bills each tenant only for its own requests', async () => {
    const summaryA = await (await api('/api/metrics/summary', { key: tenantA })).json();
    const summaryB = await (await api('/api/metrics/summary', { key: tenantB })).json();
    expect(summaryA.totals.requests).toBeGreaterThan(0);
    expect(summaryB.totals.requests ?? 0).toBe(0);
    expect(summaryB.totals.total_cost_usd ?? 0).toBe(0);
  });
});

describe('HTTP: input validation', () => {
  it('rejects a malformed body with a 400 and field-level detail, before any provider call', async () => {
    const conversation = await newConversation(tenantA);
    const res = await api(`/api/conversations/${conversation}/messages`, {
      key: tenantA, body: { text: '', model: ANTHROPIC_MODEL },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_request');
    expect(JSON.stringify(body.error.details)).toContain('text');
  });

  it('rejects an unknown model rather than guessing a provider', async () => {
    const conversation = await newConversation(tenantA);
    const res = await fetch(`${base}/api/conversations/${conversation}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant-key': tenantA },
      body: JSON.stringify({ text: 'hi', model: 'nope:not-a-model' }),
    });
    const events = await readSse(res);
    const error = events.find((e) => e.event.type === 'error')!.event;
    expect(error.kind).toBe('unknown_model');
  });

  it('never returns an HTML SPA page where a client expects JSON', async () => {
    const res = await api('/api/definitely-not-a-route', { key: tenantA });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});
