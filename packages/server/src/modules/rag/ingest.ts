import { appConfig } from '../../core/config.js';
import { AppError } from '../../core/errors.js';
import { getModelEntry } from '../../core/registry.js';
import { audit } from '../../db/index.js';
import { sha256Hex } from '../../util/ids.js';
import { logger } from '../../util/logger.js';
import { chunkText } from './chunk.js';
import { embed, resolveEmbeddingModel } from './embeddings.js';
import { extractDocument, sanitizeFilename } from './extract.js';
import {
  countChunks,
  countCollections,
  countDocuments,
  createCollection,
  createDocument,
  findDocumentByHash,
  insertChunks,
  repinCollectionEmbedding,
  requireCollection,
  updateDocumentStatus,
  type CollectionRow,
  type DocumentRow,
} from './store.js';

/**
 * Ingestion: validate -> extract -> chunk -> embed -> index.
 *
 * Ingestion is synchronous per file. For a take-home that is the right trade:
 * a queue plus workers would be more production-shaped, but it would also make
 * the failure modes invisible during a live walkthrough. What IS production-
 * shaped is that a failure is recorded on the document row (status='failed' with
 * the reason) rather than being swallowed, so a partially ingested collection is
 * visible in the UI instead of quietly under-retrieving.
 */

export interface CreateCollectionInput {
  name: string;
  embeddingModel?: string;
  chunkSize?: number;
  chunkOverlap?: number;
}

export function createCollectionWithDefaults(input: CreateCollectionInput): CollectionRow {
  const cfg = appConfig();
  if (countCollections() >= cfg.limits.maxCollectionsPerTenant) {
    throw new AppError(
      429,
      'collection_limit',
      `This tenant already has the maximum of ${cfg.limits.maxCollectionsPerTenant} collections.`,
    );
  }

  const embeddingModel = resolveEmbeddingModel(input.embeddingModel);
  const entry = getModelEntry(embeddingModel);
  const chunkSize = clamp(input.chunkSize ?? cfg.rag.chunkSize, 200, 4000);
  const chunkOverlap = clamp(input.chunkOverlap ?? cfg.rag.chunkOverlap, 0, chunkSize - 50);

  const collection = createCollection({
    name: input.name.trim().slice(0, 120) || 'Untitled collection',
    embeddingModel,
    chunkSize,
    chunkOverlap,
    // A provisional pin: nothing has proven this model can actually answer yet,
    // so ingestFile may re-pin while the collection is still empty.
    dimensions: entry.dimensions ?? 0,
  });
  audit('collection.created', { resource: collection.id, detail: { embeddingModel, chunkSize, chunkOverlap } });
  return collection;
}

export interface IngestResult {
  document: DocumentRow;
  chunkCount: number;
  costUsd: number;
  /** Set when an identical file was already in this collection. */
  duplicateOf?: string;
}

export async function ingestFile(
  collectionId: string,
  file: { originalname: string; mimetype: string; buffer: Buffer },
  opts: { signal?: AbortSignal } = {},
): Promise<IngestResult> {
  const cfg = appConfig();
  const collection = requireCollection(collectionId);

  if (countDocuments(collectionId) >= cfg.limits.maxDocumentsPerCollection) {
    throw new AppError(
      429,
      'document_limit',
      `This collection already has the maximum of ${cfg.limits.maxDocumentsPerCollection} documents.`,
    );
  }
  if (file.buffer.length > cfg.limits.maxUploadBytes) {
    throw new AppError(413, 'file_too_large', `Files must be under ${Math.floor(cfg.limits.maxUploadBytes / 1024 / 1024)} MB.`);
  }
  if (!file.buffer.length) {
    throw new AppError(400, 'empty_file', 'The uploaded file is empty.');
  }

  const filename = sanitizeFilename(file.originalname);
  const sha256 = sha256Hex(file.buffer);

  // Content-addressed de-duplication. Re-uploading the same contract twice
  // should not double its weight in retrieval.
  const existing = findDocumentByHash(collectionId, sha256);
  if (existing && existing.status === 'ready') {
    return { document: existing, chunkCount: existing.chunk_count, costUsd: 0, duplicateOf: existing.id };
  }

  const document = createDocument({
    collectionId,
    filename,
    mimeType: file.mimetype || 'application/octet-stream',
    byteSize: file.buffer.length,
    sha256,
  });

  try {
    updateDocumentStatus(document.id, 'processing');

    const extracted = await extractDocument(filename, file.mimetype ?? '', file.buffer);

    const chunks = chunkText(extracted.text, {
      chunkSize: collection.chunk_size,
      chunkOverlap: collection.chunk_overlap,
      minChunkChars: cfg.rag.minChunkChars,
      pages: extracted.kind === 'pdf' ? extracted.pages : undefined,
    });

    if (!chunks.length) {
      throw new AppError(422, 'no_chunks', `"${filename}" produced no indexable text.`);
    }

    // An empty collection has no vectors for a substitute to be incomparable
    // with, so the chain may still rescue it. A populated one is committed: its
    // pinned model is the only one that can produce comparable vectors, and its
    // own failure ("key suspended") is a far better error than the dimension
    // mismatch a substitute would trigger two lines down.
    const isEmpty = countChunks(collectionId) === 0;
    const embedded = await embed(
      chunks.map((c) => c.text),
      {
        model: collection.embedding_model,
        taskType: 'document',
        signal: opts.signal,
        allowFallback: isEmpty,
      },
    );

    if (embedded.dimensions !== collection.dimensions) {
      // Hard stop rather than a silent downgrade: mixing widths inside a
      // collection makes every later similarity score meaningless.
      if (!isEmpty) {
        throw new AppError(
          409,
          'embedding_dimension_mismatch',
          `This collection is indexed with ${collection.embedding_model} (${collection.dimensions} dimensions) but the ` +
            `embedding request was served by ${embedded.model} (${embedded.dimensions} dimensions). ` +
            'Restore access to the original provider, or create a new collection.',
        );
      }
      // Still empty: adopt the model that actually answered, so a dead key on
      // the preferred provider costs a warning rather than the collection.
      repinCollectionEmbedding(collectionId, embedded.model, embedded.dimensions);
      logger.warn('rag.collection_repinned', {
        collectionId,
        from: collection.embedding_model,
        to: embedded.model,
        dimensions: embedded.dimensions,
      });
      audit('collection.repinned', {
        resource: collectionId,
        detail: { from: collection.embedding_model, to: embedded.model, dimensions: embedded.dimensions },
      });
    }

    insertChunks(document.id, collectionId, chunks, embedded.vectors, embedded.model);
    updateDocumentStatus(document.id, 'ready', {
      pageCount: extracted.pageCount,
      charCount: extracted.text.length,
      chunkCount: chunks.length,
      error: null,
    });

    audit('document.ingested', {
      resource: document.id,
      detail: { filename, chunks: chunks.length, model: embedded.model },
    });
    logger.info('rag.ingested', {
      documentId: document.id, filename, chunks: chunks.length, costUsd: embedded.costUsd,
    });

    return {
      document: { ...document, status: 'ready', chunk_count: chunks.length, page_count: extracted.pageCount },
      chunkCount: chunks.length,
      costUsd: embedded.costUsd,
    };
  } catch (err) {
    const message = err instanceof AppError ? err.message : `Ingestion failed: ${(err as Error).message}`;
    updateDocumentStatus(document.id, 'failed', { error: message.slice(0, 500) });
    logger.warn('rag.ingest_failed', { documentId: document.id, filename, error: message });
    throw err;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
