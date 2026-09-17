import { appConfig } from '../../core/config.js';
import { embed } from './embeddings.js';
import {
  getChunks,
  keywordSearch,
  requireCollection,
  SqliteVectorStore,
  type VectorHit,
} from './store.js';
import { logger } from '../../util/logger.js';

/**
 * Retrieval.
 *
 * Default mode is hybrid: dense vectors for meaning, BM25 for the things dense
 * retrieval is reliably bad at (exact identifiers, product codes, section
 * numbers, rare proper nouns), fused with Reciprocal Rank Fusion.
 *
 * RRF rather than a weighted score blend because the two scores are not
 * commensurable -- a cosine of 0.42 and a BM25 of -7.3 have no common scale, and
 * any weighting you pick is tuned to one corpus. RRF only uses RANK, so it needs
 * no normalization and no per-corpus tuning:
 *
 *     score(d) = sum over retrievers of 1 / (k + rank(d))
 *
 * The similarity threshold is applied to the DENSE score, before fusion, because
 * that is the only one of the two with an interpretable absolute scale. This is
 * what makes "I do not know" possible: if nothing clears the threshold there is
 * nothing to ground an answer in, and we say so rather than letting the model
 * improvise from whatever ranked highest among bad options.
 */

export interface RetrievalParams {
  topK: number;
  similarityThreshold: number;
  retrievalMode: 'vector' | 'keyword' | 'hybrid';
  rrfK: number;
  maxContextChars: number;
}

export function defaultRetrievalParams(): RetrievalParams {
  const rag = appConfig().rag;
  return {
    topK: rag.topK,
    similarityThreshold: rag.similarityThreshold,
    retrievalMode: rag.retrievalMode,
    rrfK: rag.rrfK,
    maxContextChars: rag.maxContextChars,
  };
}

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  filename: string;
  ordinal: number;
  page: number | null;
  heading: string | null;
  text: string;
  /** Cosine similarity, when dense retrieval contributed. */
  vectorScore?: number;
  /** BM25, sign-flipped so higher is better. */
  keywordScore?: number;
  /** Final ranking score (RRF in hybrid mode, raw score otherwise). */
  score: number;
  rank: number;
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  /** True when nothing cleared the threshold -- the caller must answer "I don't know". */
  empty: boolean;
  params: RetrievalParams;
  embeddingModel?: string;
  /** Candidates that were found but rejected by the threshold, for the UI. */
  rejected: number;
  timings: { embedMs: number; searchMs: number };
  costUsd: number;
}

function rrf(rankings: VectorHit[][], k: number): Map<string, number> {
  const fused = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((hit, index) => {
      fused.set(hit.chunkId, (fused.get(hit.chunkId) ?? 0) + 1 / (k + index + 1));
    });
  }
  return fused;
}

export async function retrieve(
  collectionId: string,
  query: string,
  overrides: Partial<RetrievalParams> = {},
  opts: { signal?: AbortSignal; conversationId?: string | null } = {},
): Promise<RetrievalResult> {
  const collection = requireCollection(collectionId);
  const params = { ...defaultRetrievalParams(), ...stripUndefined(overrides) };
  const trimmed = query.trim();

  if (!trimmed) {
    return {
      chunks: [], empty: true, params, rejected: 0,
      timings: { embedMs: 0, searchMs: 0 }, costUsd: 0,
    };
  }

  // Over-fetch before fusion: the union of two rankings has to be wider than the
  // final top-k or fusion has nothing to rearrange.
  const candidateK = Math.max(params.topK * 4, 20);

  let vectorHits: VectorHit[] = [];
  let embedMs = 0;
  let costUsd = 0;
  let embeddingModel: string | undefined;

  if (params.retrievalMode !== 'keyword') {
    const t0 = performance.now();
    // The collection's OWN embedding model, not the current default: vectors
    // from two models are not comparable, and silently mixing them is the
    // classic way RAG quality degrades without any error being raised.
    const embedded = await embed([trimmed], {
      model: collection.embedding_model,
      taskType: 'query',
      signal: opts.signal,
      conversationId: opts.conversationId ?? null,
    });
    embedMs = performance.now() - t0;
    costUsd += embedded.costUsd;
    embeddingModel = embedded.model;

    if (embedded.dimensions !== collection.dimensions) {
      // Happens when the collection's model became unavailable and the chain
      // substituted a different one. Better to retrieve on keywords than to
      // rank against meaningless vectors.
      logger.warn('retrieve.dimension_mismatch', {
        collectionId, expected: collection.dimensions, got: embedded.dimensions,
      });
    } else {
      vectorHits = new SqliteVectorStore().search(collectionId, embedded.vectors[0] ?? [], candidateK);
    }
  }

  const t1 = performance.now();
  const keywordHits =
    params.retrievalMode === 'vector' ? [] : keywordSearch(collectionId, trimmed, candidateK);
  const searchMs = performance.now() - t1;

  // Threshold on the dense score only -- BM25 has no absolute scale.
  const above = vectorHits.filter((h) => h.score >= params.similarityThreshold);
  const rejected = vectorHits.length - above.length;

  let ordered: Array<{ chunkId: string; score: number }>;
  const vectorScores = new Map(vectorHits.map((h) => [h.chunkId, h.score]));
  const keywordScores = new Map(keywordHits.map((h) => [h.chunkId, h.score]));

  if (params.retrievalMode === 'hybrid') {
    // A keyword-only hit is kept: an exact identifier match is strong evidence
    // even when the embedding model has never seen the token.
    const fused = rrf([above, keywordHits], params.rrfK);
    ordered = [...fused.entries()]
      .map(([chunkId, score]) => ({ chunkId, score }))
      .sort((a, b) => b.score - a.score);
  } else if (params.retrievalMode === 'keyword') {
    ordered = keywordHits.map((h) => ({ chunkId: h.chunkId, score: h.score }));
  } else {
    ordered = above.map((h) => ({ chunkId: h.chunkId, score: h.score }));
  }

  const top = ordered.slice(0, params.topK);
  const rows = getChunks(top.map((t) => t.chunkId));
  const byId = new Map(rows.map((r) => [r.id, r]));

  const chunks: RetrievedChunk[] = [];
  let usedChars = 0;
  for (const [index, hit] of top.entries()) {
    const row = byId.get(hit.chunkId);
    if (!row) continue;
    // Context budget: stop before we blow the prompt out, and prefer fewer
    // complete chunks over many truncated ones.
    if (usedChars + row.text.length > params.maxContextChars && chunks.length) break;
    usedChars += row.text.length;

    chunks.push({
      chunkId: row.id,
      documentId: row.document_id,
      filename: row.filename,
      ordinal: row.ordinal,
      page: row.page,
      heading: row.heading,
      text: row.text,
      ...(vectorScores.has(row.id) ? { vectorScore: vectorScores.get(row.id) } : {}),
      ...(keywordScores.has(row.id) ? { keywordScore: keywordScores.get(row.id) } : {}),
      score: hit.score,
      rank: index + 1,
    });
  }

  return {
    chunks,
    empty: chunks.length === 0,
    params,
    embeddingModel,
    rejected,
    timings: { embedMs, searchMs },
    costUsd,
  };
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
