import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../../core/errors.js';
import { runComparison, validateCompareModels } from '../../modules/compare/run.js';
import { extractStructured } from '../../modules/structured/extract.js';
import { getChunks } from '../../modules/rag/store.js';
import { forTenant } from '../../db/index.js';
import { asyncRoute, respondError } from '../middleware.js';
import { openSse } from '../sse.js';

/**
 * The two optional extras that needed their own endpoints: side-by-side
 * comparison and structured extraction.
 */
export const labsRouter: Router = Router();

const compareSchema = z.object({
  prompt: z.string().min(1).max(50_000),
  system: z.string().max(8000).optional(),
  models: z.array(z.string().min(1).max(120)).min(2).max(4),
  maxTokens: z.number().int().min(1).max(32_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
});

const structuredSchema = z.object({
  model: z.string().min(1).max(120),
  schema: z.record(z.string(), z.unknown()),
  schemaName: z.string().max(60).optional(),
  instruction: z.string().max(4000).optional(),
  /** Extract from pasted text... */
  content: z.string().max(200_000).optional(),
  /** ...or from a document already ingested into a collection. */
  documentId: z.string().min(1).max(64).optional(),
  maxTokens: z.number().int().min(1).max(16_000).optional(),
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

labsRouter.post(
  '/compare',
  asyncRoute(async (req, res) => {
    const body = parse(compareSchema, req.body);
    // Validate BEFORE the SSE headers go out: once they are flushed the status
    // line is spent and a 400 can only be delivered as an event on a 200.
    try {
      validateCompareModels(body.models);
    } catch (err) {
      respondError(res, err);
      return;
    }

    const channel = openSse(req, res);
    try {
      const events = runComparison({ ...body, signal: channel.signal });
      for await (const event of events) {
        if (channel.closed) break;
        channel.send(event);
      }
      channel.send({ type: 'complete' });
    } catch (err) {
      channel.send({ type: 'error', message: (err as Error).message });
    } finally {
      channel.close();
    }
  }),
);

/** Reassemble a document's text from its chunks, tenant-scoped throughout. */
function documentText(documentId: string): string {
  const ids = forTenant()
    .prepare<{ id: string }>(
      `SELECT id FROM chunks
        WHERE tenant_id = :tenant_id AND document_id = :document_id
        ORDER BY ordinal ASC`,
    )
    .all({ document_id: documentId })
    .map((r) => r.id);

  if (!ids.length) throw new AppError(404, 'document_not_found', 'Document not found, or it has no indexed text.');

  const byId = new Map(getChunks(ids).map((c) => [c.id, c]));
  return ids
    .map((id) => byId.get(id)?.text ?? '')
    .join('\n\n')
    .slice(0, 200_000);
}

labsRouter.post(
  '/structured',
  asyncRoute(async (req, res) => {
    const body = parse(structuredSchema, req.body);
    if (!body.content && !body.documentId) {
      throw new AppError(400, 'missing_content', 'Provide either "content" or "documentId".');
    }

    const controller = new AbortController();
    req.on('close', () => controller.abort());

    const content = body.content ?? documentText(body.documentId!);
    const result = await extractStructured({
      model: body.model,
      schema: body.schema as Record<string, unknown>,
      schemaName: body.schemaName,
      instruction: body.instruction,
      content,
      maxTokens: body.maxTokens,
      signal: controller.signal,
    });

    // 422 when the model could not satisfy the schema after its retry: the
    // caller gets the partial data and the validator errors, not a lie.
    res.status(result.valid ? 200 : 422).json(result);
  }),
);
