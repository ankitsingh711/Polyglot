import type { Request, Response } from 'express';
import { logger } from '../util/logger.js';

/**
 * Server-Sent Events, on the writing side.
 *
 * Why SSE rather than WebSockets: the data flows one way, it is text, it
 * survives proxies, it reconnects for free, and it needs no second protocol on
 * top of the HTTP auth we already have. A WebSocket would mean re-implementing
 * tenant resolution on the upgrade handshake for no gain here.
 *
 * The cancellation path is the part that matters. The browser aborting its
 * fetch closes the socket; Express raises `close` on the request; we abort the
 * AbortController; the signal is already threaded into the provider's fetch call,
 * so the upstream HTTP request is torn down too. Stopping is not "stop
 * rendering" -- the provider stops generating, and stops billing.
 */

export interface SseChannel {
  send(event: unknown): void;
  comment(text: string): void;
  close(): void;
  readonly signal: AbortSignal;
  readonly closed: boolean;
}

export function openSse(req: Request, res: Response): SseChannel {
  res.status(200);
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');
  // Defeats nginx's default proxy buffering, which otherwise holds the whole
  // stream until it completes and turns real streaming into fake streaming.
  res.setHeader('x-accel-buffering', 'no');
  res.flushHeaders?.();

  const controller = new AbortController();
  let closed = false;

  const finish = (reason: string) => {
    if (closed) return;
    closed = true;
    if (!controller.signal.aborted) controller.abort(new DOMException(reason, 'AbortError'));
  };

  // The client went away: abort the upstream provider call immediately.
  req.on('close', () => {
    if (!res.writableEnded) {
      logger.info('sse.client_disconnected', { path: req.path });
      finish('client disconnected');
    }
  });
  req.on('aborted', () => finish('request aborted'));

  // Proxies and load balancers drop idle connections; a comment every 15s keeps
  // the stream alive during a long first token without emitting a real event.
  const heartbeat = setInterval(() => {
    if (!closed && !res.writableEnded) res.write(': ping\n\n');
  }, 15_000);
  heartbeat.unref();

  return {
    get closed() {
      return closed || res.writableEnded;
    },
    get signal() {
      return controller.signal;
    },
    send(event: unknown) {
      if (closed || res.writableEnded) return;
      // JSON.stringify never emits a raw newline, so one data line is always enough.
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    comment(text: string) {
      if (closed || res.writableEnded) return;
      res.write(`: ${text.replace(/\n/g, ' ')}\n\n`);
    },
    close() {
      clearInterval(heartbeat);
      closed = true;
      if (!res.writableEnded) res.end();
    },
  };
}
