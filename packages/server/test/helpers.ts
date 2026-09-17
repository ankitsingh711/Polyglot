import { loadProviders, setFetchImpl, getProvider, resetProviderInstances } from '../src/core/registry.js';
import type { Provider, StreamEvent } from '../src/core/types.js';

/**
 * Fixture-driven HTTP.
 *
 * Adapter tests record what the adapter SENT and replay what the vendor WOULD
 * have sent. That is the only way to test the mapping honestly: the interesting
 * bugs are in the translation, and a live call hides them behind a model that is
 * forgiving of a slightly wrong request.
 */

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

export interface FixtureOptions {
  status?: number;
  headers?: Record<string, string>;
}

export class FetchRecorder {
  readonly requests: RecordedRequest[] = [];
  private queue: Array<() => Response> = [];

  get last(): RecordedRequest {
    const value = this.requests[this.requests.length - 1];
    if (!value) throw new Error('No request was recorded.');
    return value;
  }

  /** Respond with a JSON body. */
  json(body: unknown, opts: FixtureOptions = {}): this {
    this.queue.push(
      () =>
        new Response(JSON.stringify(body), {
          status: opts.status ?? 200,
          headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
        }),
    );
    return this;
  }

  /** Respond with raw text (for malformed-body cases). */
  text(body: string, opts: FixtureOptions = {}): this {
    this.queue.push(
      () => new Response(body, { status: opts.status ?? 200, headers: { 'content-type': 'text/plain', ...(opts.headers ?? {}) } }),
    );
    return this;
  }

  /**
   * Respond with an SSE stream. Each element is written as its own network
   * chunk, so a fixture can deliberately split a frame across chunk boundaries
   * the way a real socket does.
   */
  sse(chunks: string[], opts: FixtureOptions = {}): this {
    this.queue.push(() => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      });
      return new Response(stream, {
        status: opts.status ?? 200,
        headers: { 'content-type': 'text/event-stream', ...(opts.headers ?? {}) },
      });
    });
    return this;
  }

  /** Fail the connection, as a DNS or reset failure would. */
  networkError(code = 'ECONNRESET'): this {
    this.queue.push(() => {
      const err = new TypeError('fetch failed');
      (err as any).cause = { code };
      throw err;
    });
    return this;
  }

  install(): void {
    setFetchImpl(async (input: any, init: any = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      this.requests.push({
        url,
        method: init.method ?? 'GET',
        headers: Object.fromEntries(
          Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
        ),
        body: init.body ? JSON.parse(init.body as string) : undefined,
      });
      const next = this.queue.shift();
      if (!next) throw new Error(`No fixture queued for ${url}`);
      return next();
    });
  }
}

export async function providerFor(name: string, recorder: FetchRecorder): Promise<Provider> {
  await loadProviders();
  recorder.install();
  return getProvider(name);
}

export function resetProviders(): void {
  resetProviderInstances();
}

export async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

export function textOf(events: StreamEvent[]): string {
  return events.filter((e) => e.type === 'text_delta').map((e) => (e as any).text).join('');
}

export function eventsOfType<T extends StreamEvent['type']>(
  events: StreamEvent[],
  type: T,
): Array<Extract<StreamEvent, { type: T }>> {
  return events.filter((e) => e.type === type) as Array<Extract<StreamEvent, { type: T }>>;
}

/** Build an SSE payload from (event, data) pairs, Anthropic-style. */
export function sseFrames(frames: Array<{ event?: string; data: unknown }>): string[] {
  return frames.map((f) => {
    const data = typeof f.data === 'string' ? f.data : JSON.stringify(f.data);
    return `${f.event ? `event: ${f.event}\n` : ''}data: ${data}\n\n`;
  });
}
