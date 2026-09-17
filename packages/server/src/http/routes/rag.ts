import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { appConfig } from '../../core/config.js';
import { AppError } from '../../core/errors.js';
import { audit } from '../../db/index.js';
import { createCollectionWithDefaults, ingestFile } from '../../modules/rag/ingest.js';
import { retrieve } from '../../modules/rag/retrieve.js';
import {
  deleteCollection,
  deleteDocument,
  getChunk,
  listCollections,
  listDocuments,
  requireCollection,
} from '../../modules/rag/store.js';
import { asyncRoute, pathParam } from '../middleware.js';

export const ragRouter: Router = Router();

/**
 * Uploads are held in memory, not written to disk. Nothing ever reaches the
 * filesystem, so path traversal, symlink and leftover-temp-file classes of bug
 * do not exist here. The cost is that upload size is bounded by RAM, which is
 * exactly why `maxUploadBytes` is enforced by multer AND re-checked in ingest.
 */
function uploader() {
  const limits = appConfig().limits;
  return multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: limits.maxUploadBytes,
      files: limits.maxFilesPerUpload,
      fields: 10,
      parts: limits.maxFilesPerUpload + 10,
    },
  }).array('files', limits.maxFilesPerUpload);
}

const createCollectionSchema = z.object({
  name: z.string().min(1).max(120),
  embeddingModel: z.string().min(1).max(120).optional(),
  chunkSize: z.number().int().min(200).max(4000).optional(),
  chunkOverlap: z.number().int().min(0).max(2000).optional(),
});

const searchSchema = z.object({
  query: z.string().min(1).max(2000),
  topK: z.number().int().min(1).max(50).optional(),
  similarityThreshold: z.number().min(0).max(1).optional(),
  retrievalMode: z.enum(['vector', 'keyword', 'hybrid']).optional(),
  rrfK: z.number().int().min(1).max(1000).optional(),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new AppError(400, 'invalid_request', 'The request body is not valid.', {
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}

ragRouter.get(
  '/collections',
  asyncRoute(async (_req, res) => {
    res.json({ collections: listCollections() });
  }),
);

ragRouter.post(
  '/collections',
  asyncRoute(async (req, res) => {
    const body = parse(createCollectionSchema, req.body);
    const collection = createCollectionWithDefaults(body);
    res.status(201).json({ collection });
  }),
);

ragRouter.get(
  '/collections/:id',
  asyncRoute(async (req, res) => {
    const collection = requireCollection(pathParam(req, 'id'));
    res.json({ collection, documents: listDocuments(collection.id) });
  }),
);

ragRouter.delete(
  '/collections/:id',
  asyncRoute(async (req, res) => {
    const id = pathParam(req, 'id');
    deleteCollection(id);
    audit('collection.deleted', { resource: id });
    res.status(204).end();
  }),
);

ragRouter.post(
  '/collections/:id/documents',
  (req, res, next) => {
    uploader()(req, res, (err: unknown) => {
      if (!err) return next();
      const code = (err as { code?: string }).code;
      if (code === 'LIMIT_FILE_SIZE') {
        return next(new AppError(413, 'file_too_large', `Files must be under ${Math.floor(appConfig().limits.maxUploadBytes / 1024 / 1024)} MB.`));
      }
      if (code === 'LIMIT_FILE_COUNT' || code === 'LIMIT_PART_COUNT') {
        return next(new AppError(413, 'too_many_files', `Upload at most ${appConfig().limits.maxFilesPerUpload} files at a time.`));
      }
      if (code === 'LIMIT_UNEXPECTED_FILE') {
        return next(new AppError(400, 'unexpected_field', 'Files must be sent in the "files" field.'));
      }
      return next(new AppError(400, 'upload_failed', 'The upload could not be read.'));
    });
  },
  asyncRoute(async (req, res) => {
    const collectionId = pathParam(req, 'id');
    requireCollection(collectionId);

    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (!files.length) throw new AppError(400, 'no_files', 'Attach at least one file in the "files" field.');

    const controller = new AbortController();
    req.on('close', () => controller.abort());

    // Per-file results rather than all-or-nothing: one unreadable PDF in a batch
    // of ten should not discard the nine that ingested fine.
    const results = [];
    for (const file of files) {
      try {
        const result = await ingestFile(collectionId, file, { signal: controller.signal });
        results.push({
          ok: true as const,
          filename: result.document.filename,
          documentId: result.document.id,
          chunks: result.chunkCount,
          costUsd: result.costUsd,
          ...(result.duplicateOf ? { duplicateOf: result.duplicateOf } : {}),
        });
      } catch (err) {
        results.push({
          ok: false as const,
          filename: file.originalname,
          error: err instanceof AppError ? err.message : 'Ingestion failed.',
          code: err instanceof AppError ? err.code : 'ingest_failed',
        });
      }
    }

    const anyOk = results.some((r) => r.ok);
    res.status(anyOk ? 201 : 422).json({ results, documents: listDocuments(collectionId) });
  }),
);

ragRouter.delete(
  '/documents/:id',
  asyncRoute(async (req, res) => {
    const id = pathParam(req, 'id');
    deleteDocument(id);
    audit('document.deleted', { resource: id });
    res.status(204).end();
  }),
);

/** Retrieval without generation: the "show me what would be retrieved" panel. */
ragRouter.post(
  '/collections/:id/search',
  asyncRoute(async (req, res) => {
    const body = parse(searchSchema, req.body);
    const controller = new AbortController();
    req.on('close', () => controller.abort());

    const result = await retrieve(
      pathParam(req, 'id'),
      body.query,
      {
        topK: body.topK,
        similarityThreshold: body.similarityThreshold,
        retrievalMode: body.retrievalMode,
        rrfK: body.rrfK,
      },
      { signal: controller.signal },
    );
    res.json(result);
  }),
);

/** The chunk behind a citation, so the UI can show the source text verbatim. */
ragRouter.get(
  '/chunks/:id',
  asyncRoute(async (req, res) => {
    const chunk = getChunk(pathParam(req, 'id'));
    if (!chunk) throw new AppError(404, 'chunk_not_found', 'Chunk not found.');
    res.json({ chunk });
  }),
);
