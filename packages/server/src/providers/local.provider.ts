import { createHash } from 'node:crypto';
import { registerProvider } from '../core/registry.js';
import { ProviderError } from '../core/errors.js';
import type {
  CompletionRequest,
  CompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  Provider,
  ProviderInit,
  StreamEvent,
} from '../core/types.js';

/**
 * Local, dependency-free embedding provider.
 *
 * Purpose: make Module C (RAG) runnable, testable and demo-able with zero API
 * keys, and prove that the embedding side of the abstraction is genuinely
 * swappable — it is the last hop of `fallback.embeddingChain`.
 *
 * It is a hashed character n-gram model (the "hashing trick"): deterministic,
 * offline, and good enough for lexical overlap. It is NOT semantic — it will not
 * match "car" to "automobile". That is stated plainly in the README rather than
 * dressed up, because pretending a hash is an embedding model is exactly the kind
 * of claim this assignment says it will find out about.
 *
 * It also demonstrates the `unsupported` branch of the error taxonomy: this
 * provider implements `embed` but not `complete`/`stream`, and says so in the
 * normalized vocabulary rather than throwing a bare Error.
 */

const TOKEN_RE = /[\p{L}\p{N}]+/gu;

function hashToIndex(token: string, dims: number, salt: string): number {
  const digest = createHash('sha256').update(salt).update(token).digest();
  return digest.readUInt32BE(0) % dims;
}

/** Sign hashing keeps collisions from systematically inflating similarity. */
function hashSign(token: string): number {
  return createHash('sha256').update('sign').update(token).digest()[0]! % 2 === 0 ? 1 : -1;
}

export function hashEmbed(text: string, dims: number): number[] {
  const vec = new Array<number>(dims).fill(0);
  const tokens = (text.toLowerCase().match(TOKEN_RE) ?? []).slice(0, 4000);

  for (let i = 0; i < tokens.length; i++) {
    const unigram = tokens[i]!;
    const ui = hashToIndex(unigram, dims, 'u');
    vec[ui] = (vec[ui] ?? 0) + hashSign(unigram);
    // Bigrams give a little word-order sensitivity, which materially improves
    // retrieval on short chunks.
    if (i + 1 < tokens.length) {
      const bigram = `${unigram}_${tokens[i + 1]}`;
      const bi = hashToIndex(bigram, dims, 'b');
      vec[bi] = (vec[bi] ?? 0) + 0.5 * hashSign(bigram);
    }
  }

  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

class LocalProvider implements Provider {
  readonly name: string;

  constructor(private readonly init: ProviderInit) {
    this.name = init.name;
  }

  private unsupported(what: string): ProviderError {
    return new ProviderError({
      kind: 'unsupported',
      provider: this.name,
      message: `The local provider offers embeddings only; ${what} is not available. Configure a chat provider in .env.`,
      retryable: false,
    });
  }

  async complete(_req: CompletionRequest): Promise<CompletionResponse> {
    throw this.unsupported('text generation');
  }

  async *stream(_req: CompletionRequest): AsyncIterable<StreamEvent> {
    yield { type: 'error', error: this.unsupported('text generation') };
  }

  async embed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
    const entry = this.init.lookup(req.model);
    const dims = entry.dimensions ?? 384;
    return {
      vectors: req.texts.map((t) => hashEmbed(t, dims)),
      usage: { inputTokens: Math.ceil(req.texts.join(' ').length / 4), outputTokens: 0 },
      model: req.model,
      provider: this.name,
    };
  }
}

registerProvider('local', (init) => new LocalProvider(init));
