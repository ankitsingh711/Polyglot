import { Router } from 'express';
import { z } from 'zod';
import { appConfig } from '../../core/config.js';
import { AppError } from '../../core/errors.js';
import { audit } from '../../db/index.js';
import { sendMessage, toChatErrorEvent } from '../../modules/chat/service.js';
import {
  createConversation,
  deleteConversation,
  listConversations,
  listMessages,
  requireConversation,
  updateConversation,
} from '../../modules/chat/store.js';
import { getCollection } from '../../modules/rag/store.js';
import { asyncRoute, pathParam, respondError } from '../middleware.js';
import { openSse } from '../sse.js';
import { logger } from '../../util/logger.js';

/**
 * Chat endpoints.
 *
 * Every body is parsed by a zod schema before it reaches a module. Unknown keys
 * are stripped rather than passed through, so a client cannot smuggle a field
 * into a downstream object literal.
 */

export const chatRouter: Router = Router();

const createSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  collectionId: z.string().min(1).max(64).nullable().optional(),
  systemPrompt: z.string().max(8000).nullable().optional(),
});

const updateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  collectionId: z.string().min(1).max(64).nullable().optional(),
  systemPrompt: z.string().max(8000).nullable().optional(),
});

const sendSchema = z.object({
  text: z.string().min(1).max(100_000),
  model: z.string().min(1).max(120),
  maxTokens: z.number().int().min(1).max(200_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  useTools: z.boolean().optional(),
  useRag: z.boolean().optional(),
  retrieval: z
    .object({
      topK: z.number().int().min(1).max(50).optional(),
      similarityThreshold: z.number().min(0).max(1).optional(),
      retrievalMode: z.enum(['vector', 'keyword', 'hybrid']).optional(),
      rrfK: z.number().int().min(1).max(1000).optional(),
      maxContextChars: z.number().int().min(500).max(200_000).optional(),
    })
    .optional(),
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

/** A collection id supplied by the client must resolve WITHIN this tenant. */
function assertCollection(id: string | null | undefined): void {
  if (!id) return;
  if (!getCollection(id)) throw new AppError(404, 'collection_not_found', 'Collection not found.');
}

chatRouter.get(
  '/conversations',
  asyncRoute(async (req, res) => {
    const limit = Number(req.query.limit ?? 50);
    res.json({ conversations: listConversations(Number.isFinite(limit) ? limit : 50) });
  }),
);

chatRouter.post(
  '/conversations',
  asyncRoute(async (req, res) => {
    const body = parse(createSchema, req.body);
    assertCollection(body.collectionId);
    const conversation = createConversation({
      title: body.title,
      collectionId: body.collectionId ?? null,
      systemPrompt: body.systemPrompt ?? null,
    });
    audit('conversation.created', { resource: conversation.id });
    res.status(201).json({ conversation });
  }),
);

chatRouter.get(
  '/conversations/:id',
  asyncRoute(async (req, res) => {
    const conversation = requireConversation(pathParam(req, 'id'));
    res.json({ conversation, messages: listMessages(conversation.id) });
  }),
);

chatRouter.patch(
  '/conversations/:id',
  asyncRoute(async (req, res) => {
    const body = parse(updateSchema, req.body);
    assertCollection(body.collectionId);
    res.json({ conversation: updateConversation(pathParam(req, 'id'), body) });
  }),
);

chatRouter.delete(
  '/conversations/:id',
  asyncRoute(async (req, res) => {
    const id = pathParam(req, 'id');
    deleteConversation(id);
    audit('conversation.deleted', { resource: id });
    res.status(204).end();
  }),
);

/**
 * The streaming turn.
 *
 * POST rather than GET-with-EventSource: EventSource cannot set headers, which
 * would force the tenant key into the query string, where it lands in access
 * logs and browser history. The browser reads this with fetch + a ReadableStream.
 */
chatRouter.post(
  '/conversations/:id/messages',
  asyncRoute(async (req, res) => {
    const body = parse(sendSchema, req.body);
    const conversationId = pathParam(req, 'id');
    requireConversation(conversationId);

    const channel = openSse(req, res);

    try {
      const events = sendMessage({
        conversationId,
        text: body.text,
        model: body.model,
        maxTokens: body.maxTokens,
        temperature: body.temperature,
        useTools: body.useTools ?? false,
        useRag: body.useRag ?? false,
        retrieval: body.retrieval,
        signal: channel.signal,
      });

      for await (const event of events) {
        if (channel.closed) break;
        channel.send(event);
      }
    } catch (err) {
      // The stream is already open, so an error is an EVENT, not a status code.
      // The client has no way to notice a 500 after headers are flushed.
      if ((err as Error)?.name === 'AbortError') {
        logger.info('chat.cancelled', { conversationId });
        channel.send({ type: 'cancelled' });
      } else {
        channel.send(toChatErrorEvent(err));
      }
    } finally {
      channel.close();
    }
  }),
);

chatRouter.get(
  '/config/defaults',
  asyncRoute(async (_req, res) => {
    const cfg = appConfig();
    res.json({
      defaults: cfg.defaults,
      rag: cfg.rag,
      limits: {
        maxUploadBytes: cfg.limits.maxUploadBytes,
        maxFilesPerUpload: cfg.limits.maxFilesPerUpload,
        maxPromptChars: cfg.limits.maxPromptChars,
        maxToolIterations: cfg.limits.maxToolIterations,
        maxCostPerRequestUsd: cfg.limits.maxCostPerRequestUsd,
        tenantDailyBudgetUsd: cfg.limits.tenantDailyBudgetUsd,
      },
      context: { strategy: cfg.context.strategy, keepRecentTurns: cfg.context.keepRecentTurns },
      tools: cfg.tools.enabled,
    });
  }),
);

export { respondError };
