import { blobToVector, dotProduct, forTenant, normalizeVector, vectorToBlob } from '../../db/index.js';
import { AppError } from '../../core/errors.js';
import { newId } from '../../util/ids.js';
import type { Chunk } from './chunk.js';

/**
 * Retrieval storage.
 *
 * Every statement in this file names `tenant_id = :tenant_id`; the guard in
 * src/tenancy/guard.ts refuses to prepare one that does not, and binds the value
 * itself from the request context. That is the whole reason a query here cannot
 * accidentally read another tenant's documents.
 */

export interface CollectionRow {
  id: string;
  name: string;
  embedding_model: string;
  chunk_size: number;
  chunk_overlap: number;
  dimensions: number;
  created_at: string;
}

export interface DocumentRow {
  id: string;
  collection_id: string;
  filename: string;
  mime_type: string;
  byte_size: number;
  sha256: string;
  page_count: number | null;
  char_count: number;
  chunk_count: number;
  status: 'pending' | 'processing' | 'ready' | 'failed';
  error: string | null;
  created_at: string;
}

export interface ChunkRow {
  id: string;
  document_id: string;
  collection_id: string;
  ordinal: number;
  text: string;
  token_estimate: number;
  char_start: number;
  char_end: number;
  page: number | null;
  heading: string | null;
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

export function createCollection(input: {
  name: string;
  embeddingModel: string;
  chunkSize: number;
  chunkOverlap: number;
  dimensions: number;
}): CollectionRow {
  const row: CollectionRow = {
    id: newId('col'),
    name: input.name,
    embedding_model: input.embeddingModel,
    chunk_size: input.chunkSize,
    chunk_overlap: input.chunkOverlap,
    dimensions: input.dimensions,
    created_at: new Date().toISOString(),
  };
  forTenant()
    .prepare(
      `INSERT INTO collections (tenant_id, id, name, embedding_model, chunk_size, chunk_overlap, dimensions, created_at)
       VALUES (:tenant_id, :id, :name, :embedding_model, :chunk_size, :chunk_overlap, :dimensions, :created_at)`,
    )
    .run(row as unknown as Record<string, unknown>);
  return row;
}

export function listCollections(): Array<CollectionRow & { document_count: number; chunk_count: number }> {
  return forTenant()
    .prepare<CollectionRow & { document_count: number; chunk_count: number }>(
      `SELECT c.id, c.name, c.embedding_model, c.chunk_size, c.chunk_overlap, c.dimensions, c.created_at,
              (SELECT COUNT(*) FROM documents d
                WHERE d.tenant_id = c.tenant_id AND d.collection_id = c.id) AS document_count,
              (SELECT COUNT(*) FROM chunks k
                WHERE k.tenant_id = c.tenant_id AND k.collection_id = c.id) AS chunk_count
         FROM collections c
        WHERE c.tenant_id = :tenant_id
        ORDER BY c.created_at DESC`,
    )
    .all();
}

export function getCollection(id: string): CollectionRow | undefined {
  return forTenant()
    .prepare<CollectionRow>(
      `SELECT id, name, embedding_model, chunk_size, chunk_overlap, dimensions, created_at
         FROM collections WHERE tenant_id = :tenant_id AND id = :id`,
    )
    .get({ id });
}

export function requireCollection(id: string): CollectionRow {
  const row = getCollection(id);
  // A collection belonging to another tenant is indistinguishable from one that
  // does not exist. Returning 403 here would be an existence oracle.
  if (!row) throw new AppError(404, 'collection_not_found', 'Collection not found.');
  return row;
}

export function deleteCollection(id: string): void {
  requireCollection(id);
  forTenant().transaction(() => {
    // chunks_fts is not covered by ON DELETE CASCADE (it is a virtual table).
    forTenant()
      .prepare('DELETE FROM chunks_fts WHERE tenant_id = :tenant_id AND collection_id = :id')
      .run({ id });
    forTenant().prepare('DELETE FROM collections WHERE tenant_id = :tenant_id AND id = :id').run({ id });
  });
}

export function countChunks(collectionId: string): number {
  return (
    forTenant()
      .prepare<{ n: number }>(
        'SELECT COUNT(*) AS n FROM chunks WHERE tenant_id = :tenant_id AND collection_id = :collection_id',
      )
      .get({ collection_id: collectionId })?.n ?? 0
  );
}

/**
 * Re-pin an EMPTY collection to the model that actually served its first embed.
 * Legal only while the collection holds no vectors -- see ingestFile, which is
 * the sole caller and checks that.
 */
export function repinCollectionEmbedding(id: string, embeddingModel: string, dimensions: number): void {
  forTenant()
    .prepare(
      `UPDATE collections SET embedding_model = :embedding_model, dimensions = :dimensions
        WHERE tenant_id = :tenant_id AND id = :id`,
    )
    .run({ id, embedding_model: embeddingModel, dimensions });
}

export function countCollections(): number {
  return (
    forTenant()
      .prepare<{ n: number }>('SELECT COUNT(*) AS n FROM collections WHERE tenant_id = :tenant_id')
      .get()?.n ?? 0
  );
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export function createDocument(input: {
  collectionId: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
}): DocumentRow {
  const row: DocumentRow = {
    id: newId('doc'),
    collection_id: input.collectionId,
    filename: input.filename,
    mime_type: input.mimeType,
    byte_size: input.byteSize,
    sha256: input.sha256,
    page_count: null,
    char_count: 0,
    chunk_count: 0,
    status: 'pending',
    error: null,
    created_at: new Date().toISOString(),
  };
  forTenant()
    .prepare(
      `INSERT INTO documents (tenant_id, id, collection_id, filename, mime_type, byte_size, sha256,
                              page_count, char_count, chunk_count, status, error, created_at)
       VALUES (:tenant_id, :id, :collection_id, :filename, :mime_type, :byte_size, :sha256,
               :page_count, :char_count, :chunk_count, :status, :error, :created_at)`,
    )
    .run(row as unknown as Record<string, unknown>);
  return row;
}

export function updateDocumentStatus(
  id: string,
  status: DocumentRow['status'],
  patch: { error?: string | null; pageCount?: number | null; charCount?: number; chunkCount?: number } = {},
): void {
  forTenant()
    .prepare(
      `UPDATE documents
          SET status = :status,
              error = COALESCE(:error, error),
              page_count = COALESCE(:page_count, page_count),
              char_count = COALESCE(:char_count, char_count),
              chunk_count = COALESCE(:chunk_count, chunk_count)
        WHERE tenant_id = :tenant_id AND id = :id`,
    )
    .run({
      id,
      status,
      error: patch.error ?? null,
      page_count: patch.pageCount ?? null,
      char_count: patch.charCount ?? null,
      chunk_count: patch.chunkCount ?? null,
    });
}

export function listDocuments(collectionId: string): DocumentRow[] {
  requireCollection(collectionId);
  return forTenant()
    .prepare<DocumentRow>(
      `SELECT id, collection_id, filename, mime_type, byte_size, sha256, page_count, char_count,
              chunk_count, status, error, created_at
         FROM documents
        WHERE tenant_id = :tenant_id AND collection_id = :collection_id
        ORDER BY created_at DESC`,
    )
    .all({ collection_id: collectionId });
}

export function countDocuments(collectionId: string): number {
  return (
    forTenant()
      .prepare<{ n: number }>(
        'SELECT COUNT(*) AS n FROM documents WHERE tenant_id = :tenant_id AND collection_id = :collection_id',
      )
      .get({ collection_id: collectionId })?.n ?? 0
  );
}

export function findDocumentByHash(collectionId: string, sha256: string): DocumentRow | undefined {
  return forTenant()
    .prepare<DocumentRow>(
      `SELECT id, collection_id, filename, mime_type, byte_size, sha256, page_count, char_count,
              chunk_count, status, error, created_at
         FROM documents
        WHERE tenant_id = :tenant_id AND collection_id = :collection_id AND sha256 = :sha256`,
    )
    .get({ collection_id: collectionId, sha256 });
}

export function deleteDocument(id: string): void {
  forTenant().transaction(() => {
    forTenant()
      .prepare(
        `DELETE FROM chunks_fts
          WHERE tenant_id = :tenant_id
            AND chunk_id IN (SELECT id FROM chunks WHERE tenant_id = :tenant_id AND document_id = :id)`,
      )
      .run({ id });
    forTenant().prepare('DELETE FROM documents WHERE tenant_id = :tenant_id AND id = :id').run({ id });
  });
}

// ---------------------------------------------------------------------------
// Chunks + vectors
// ---------------------------------------------------------------------------

export function insertChunks(
  documentId: string,
  collectionId: string,
  chunks: Chunk[],
  vectors: number[][],
  embeddingModel: string,
): ChunkRow[] {
  if (chunks.length !== vectors.length) {
    throw new AppError(500, 'embedding_count_mismatch', 'Chunk and vector counts disagree; refusing to index.');
  }
  const now = new Date().toISOString();
  const rows: ChunkRow[] = chunks.map((c) => ({
    id: newId('chk'),
    document_id: documentId,
    collection_id: collectionId,
    ordinal: c.ordinal,
    text: c.text,
    token_estimate: c.tokenEstimate,
    char_start: c.charStart,
    char_end: c.charEnd,
    page: c.page ?? null,
    heading: c.heading ?? null,
  }));

  const db = forTenant();
  const insertChunk = db.prepare(
    `INSERT INTO chunks (tenant_id, id, document_id, collection_id, ordinal, text, token_estimate,
                         char_start, char_end, page, heading, created_at)
     VALUES (:tenant_id, :id, :document_id, :collection_id, :ordinal, :text, :token_estimate,
             :char_start, :char_end, :page, :heading, :created_at)`,
  );
  const insertVector = db.prepare(
    `INSERT INTO chunk_vectors (tenant_id, chunk_id, collection_id, model_id, dimensions, vector)
     VALUES (:tenant_id, :chunk_id, :collection_id, :model_id, :dimensions, :vector)`,
  );
  const insertFts = db.prepare(
    `INSERT INTO chunks_fts (tenant_id, collection_id, chunk_id, text)
     VALUES (:tenant_id, :collection_id, :chunk_id, :text)`,
  );

  db.transaction(() => {
    rows.forEach((row, i) => {
      insertChunk.run({ ...row, created_at: now } as unknown as Record<string, unknown>);
      insertVector.run({
        chunk_id: row.id,
        collection_id: collectionId,
        model_id: embeddingModel,
        dimensions: vectors[i]!.length,
        vector: vectorToBlob(vectors[i]!),
      });
      insertFts.run({ collection_id: collectionId, chunk_id: row.id, text: row.text });
    });
  });

  return rows;
}

export function getChunk(id: string): (ChunkRow & { filename: string }) | undefined {
  return forTenant()
    .prepare<ChunkRow & { filename: string }>(
      `SELECT k.id, k.document_id, k.collection_id, k.ordinal, k.text, k.token_estimate,
              k.char_start, k.char_end, k.page, k.heading, d.filename
         FROM chunks k
         JOIN documents d ON d.tenant_id = k.tenant_id AND d.id = k.document_id
        WHERE k.tenant_id = :tenant_id AND k.id = :id`,
    )
    .get({ id });
}

export function getChunks(ids: string[]): Array<ChunkRow & { filename: string }> {
  if (!ids.length) return [];
  // SQLite has no array binding; a json_each over a bound JSON array keeps this
  // a single prepared statement instead of an interpolated IN list.
  return forTenant()
    .prepare<ChunkRow & { filename: string }>(
      `SELECT k.id, k.document_id, k.collection_id, k.ordinal, k.text, k.token_estimate,
              k.char_start, k.char_end, k.page, k.heading, d.filename
         FROM chunks k
         JOIN documents d ON d.tenant_id = k.tenant_id AND d.id = k.document_id
        WHERE k.tenant_id = :tenant_id
          AND k.id IN (SELECT value FROM json_each(:ids))`,
    )
    .all({ ids: JSON.stringify(ids) });
}

// ---------------------------------------------------------------------------
// Vector store
// ---------------------------------------------------------------------------

export interface VectorHit {
  chunkId: string;
  score: number;
}

/**
 * The seam that makes "any vector store is fine" true rather than aspirational.
 * `SqliteVectorStore` below is the only implementation shipped; swapping in
 * pgvector or Qdrant means writing this interface once, not editing retrieval.
 */
export interface VectorStore {
  search(collectionId: string, queryVector: number[], topK: number): VectorHit[];
}

/**
 * Brute-force scan over Float32 blobs.
 *
 * Defensible at this scale and deliberately chosen: vectors are L2-normalized at
 * write time so similarity is a dot product with no square roots; a collection
 * capped at 200 documents is a few thousand chunks, which is single-digit
 * milliseconds; and an exact scan has no index build step, no recall cliff, and
 * no second system to keep consistent with SQLite's transaction boundary.
 *
 * It is O(n) and it will stop being the right answer somewhere around 10^5-10^6
 * chunks per collection. At that point the fix is this interface with an ANN
 * implementation behind it, which is why the interface exists now.
 */
export class SqliteVectorStore implements VectorStore {
  search(collectionId: string, queryVector: number[], topK: number): VectorHit[] {
    const query = normalizeVector(queryVector);
    const rows = forTenant()
      .prepare<{ chunk_id: string; vector: Buffer; dimensions: number }>(
        `SELECT chunk_id, vector, dimensions
           FROM chunk_vectors
          WHERE tenant_id = :tenant_id AND collection_id = :collection_id`,
      )
      .all({ collection_id: collectionId });

    const hits: VectorHit[] = [];
    for (const row of rows) {
      // Mismatched dimensions mean the collection was embedded with a different
      // model; scoring them together would be meaningless, so they are skipped
      // and the ingest path prevents the situation arising in the first place.
      if (row.dimensions !== query.length) continue;
      hits.push({ chunkId: row.chunk_id, score: dotProduct(query, blobToVector(row.vector)) });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, topK);
  }
}

/** BM25 over the FTS5 index. Scores are negative in SQLite; lower is better. */
export function keywordSearch(collectionId: string, query: string, topK: number): VectorHit[] {
  const match = toFtsQuery(query);
  if (!match) return [];
  try {
    const rows = forTenant()
      .prepare<{ chunk_id: string; score: number }>(
        `SELECT chunk_id, bm25(chunks_fts) AS score
           FROM chunks_fts
          WHERE chunks_fts MATCH :match
            AND tenant_id = :tenant_id
            AND collection_id = :collection_id
          ORDER BY score
          LIMIT :limit`,
      )
      .all({ match, collection_id: collectionId, limit: topK });
    // Flip the sign so "higher is better" holds for every scorer in this module.
    return rows.map((r) => ({ chunkId: r.chunk_id, score: -r.score }));
  } catch {
    // A malformed MATCH expression should degrade to vector-only retrieval, not
    // fail the user's question.
    return [];
  }
}

/**
 * Turn a natural-language question into a safe FTS5 MATCH expression.
 * Every term is quoted, which neutralizes the FTS5 operators (NEAR, OR, ^, *, -)
 * that would otherwise let document text or a question act as a query operator.
 */
export function toFtsQuery(query: string): string {
  const terms = (query.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? [])
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .slice(0, 32)
    .map((t) => `"${t.replace(/"/g, '')}"`);
  if (!terms.length) return '';
  return terms.join(' OR ');
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was', 'one', 'our', 'out',
  'day', 'get', 'has', 'him', 'his', 'how', 'its', 'new', 'now', 'old', 'see', 'two', 'way', 'who',
  'did', 'yes', 'this', 'that', 'with', 'from', 'they', 'what', 'when', 'where', 'which', 'while',
  'does', 'do', 'is', 'of', 'to', 'in', 'on', 'it', 'as', 'at', 'by', 'or', 'an', 'be', 'a', 'i',
]);
