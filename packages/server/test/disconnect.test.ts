import { describe, it, expect } from 'vitest';
import express from 'express';
import multer from 'multer';
import type { AddressInfo } from 'node:net';
import { abortOnClientDisconnect } from '../src/http/middleware.js';

/**
 * Regression: the RAG and structured-output routes derived their AbortSignal
 * from `req.on('close')`. For a POST whose body has been fully read — which is
 * every JSON route and every multipart route, because the body parser drains it
 * before the handler runs — Node emits 'close' on the IncomingMessage as soon as
 * the body ends. The signal was therefore already aborted on the first line of
 * every handler, so document ingestion and structured extraction aborted
 * themselves before reaching the provider.
 *
 * These tests assert the two halves that matter: a connected client is NOT
 * aborted, and a disconnected one IS.
 */
async function withServer<T>(app: express.Express, fn: (base: string) => Promise<T>): Promise<T> {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

describe('abortOnClientDisconnect', () => {
  it('does NOT abort while the client is still connected (JSON body)', async () => {
    const app = express();
    app.post('/x', express.json(), async (req, res) => {
      const signal = abortOnClientDisconnect(res);
      await new Promise((r) => setTimeout(r, 150));
      res.json({ aborted: signal.aborted });
    });

    const body = await withServer(app, async (base) => {
      const r = await fetch(`${base}/x`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ a: 1 }),
      });
      return r.json() as Promise<{ aborted: boolean }>;
    });

    expect(body.aborted).toBe(false);
  });

  it('does NOT abort while the client is still connected (multipart upload)', async () => {
    const app = express();
    const upload = multer({ storage: multer.memoryStorage() }).array('files', 5);
    app.post('/u', upload, async (req, res) => {
      const signal = abortOnClientDisconnect(res);
      await new Promise((r) => setTimeout(r, 150));
      res.json({ aborted: signal.aborted, files: (req.files as unknown[] | undefined)?.length ?? 0 });
    });

    const body = await withServer(app, async (base) => {
      const form = new FormData();
      form.append('files', new Blob(['hello world']), 'a.txt');
      const r = await fetch(`${base}/u`, { method: 'POST', body: form });
      return r.json() as Promise<{ aborted: boolean; files: number }>;
    });

    expect(body.files).toBe(1);
    expect(body.aborted).toBe(false);
  });

  it('DOES abort once the client goes away', async () => {
    let observed: boolean | undefined;
    const app = express();
    app.post('/slow', express.json(), async (_req, res) => {
      const signal = abortOnClientDisconnect(res);
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
        setTimeout(resolve, 3000); // safety net so a failure is a failure, not a hang
      });
      observed = signal.aborted;
      if (!res.writableEnded) res.end();
    });

    await withServer(app, async (base) => {
      const controller = new AbortController();
      const inflight = fetch(`${base}/slow`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ a: 1 }),
        signal: controller.signal,
      }).catch(() => undefined);

      await new Promise((r) => setTimeout(r, 100));
      controller.abort();
      await inflight;
      await new Promise((r) => setTimeout(r, 400));
    });

    expect(observed).toBe(true);
  });
});
