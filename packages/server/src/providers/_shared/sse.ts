/**
 * A correct-enough SSE parser (WHATWG "Server-sent events", §9.2.6).
 *
 * Why hand-rolled rather than a dependency: the three vendors disagree about
 * almost everything above the wire format, and we need a single place to see the
 * raw frames when a vendor misbehaves. The wire format itself is 40 lines.
 *
 * Handled explicitly because real providers do all of these:
 *  - a frame split across two TCP chunks (very common under load);
 *  - CRLF line endings (Anthropic via some proxies);
 *  - multi-line `data:` that must be joined with "\n";
 *  - `event:` names (Anthropic uses them; OpenAI does not);
 *  - comment/heartbeat lines starting with ":" (Groq sends these);
 *  - a trailing frame with no terminating blank line at end-of-stream.
 */

export interface SseFrame {
  event?: string;
  data: string;
  id?: string;
}

export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder('utf-8');
  const reader = stream.getReader();
  let buffer = '';

  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Normalize line endings once, so the split below stays simple.
      buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const frame = decodeFrame(raw);
        if (frame) yield frame;
      }
    }
    buffer += decoder.decode();
    const tail = decodeFrame(buffer);
    if (tail) yield tail;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock?.();
  }
}

function decodeFrame(raw: string): SseFrame | undefined {
  const lines = raw.split('\n');
  const dataLines: string[] = [];
  let event: string | undefined;
  let id: string | undefined;

  for (const line of lines) {
    if (!line || line.startsWith(':')) continue; // heartbeat / comment
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // Exactly one optional leading space is stripped, per spec.
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'data') dataLines.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id') id = value;
  }

  if (!dataLines.length && !event) return undefined;
  return { event, data: dataLines.join('\n'), id };
}

/** Convenience: yield parsed JSON payloads, skipping `[DONE]` sentinels. */
export async function* parseSseJson<T = unknown>(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<{ event?: string; json: T }> {
  for await (const frame of parseSse(stream, signal)) {
    const data = frame.data.trim();
    if (!data || data === '[DONE]') continue;
    let json: T;
    try {
      json = JSON.parse(data) as T;
    } catch {
      // A vendor that emits a malformed frame should not kill the stream; the
      // caller still gets `done` from whatever frames do parse.
      continue;
    }
    yield { event: frame.event, json };
  }
}
