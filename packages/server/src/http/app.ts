import express, { type Express } from 'express';
import { appConfig } from '../core/config.js';
import { initDatabase } from '../db/index.js';
import { loadProviders } from '../core/registry.js';
import {
  corsMiddleware,
  errorHandler,
  notFound,
  rateLimitMiddleware,
  securityHeaders,
  tenantMiddleware,
} from './middleware.js';
import { chatRouter } from './routes/chat.js';
import { labsRouter } from './routes/labs.js';
import { metricsRouter } from './routes/metrics.js';
import { modelsRouter } from './routes/models.js';
import { ragRouter } from './routes/rag.js';
import { logger } from '../util/logger.js';

/**
 * Wiring.
 *
 * Note the ordering: security headers and CORS are unconditional, /health is
 * public, and EVERYTHING else sits behind tenant resolution. There is no route
 * that reads tenant data without a tenant context, because there is no route
 * mounted outside `tenantMiddleware`.
 */
export async function createApp(): Promise<Express> {
  // Import every adapter file. Tools self-register the same way.
  await loadProviders();
  await import('../modules/tools/calculator.js');
  await import('../modules/tools/weather.js');
  await import('../modules/tools/search-documents.js');

  initDatabase();

  const app = express();
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1));
  app.disable('x-powered-by');
  app.disable('etag');

  app.use(securityHeaders);
  app.use(corsMiddleware);
  app.use(express.json({ limit: appConfig().limits.maxRequestBodyBytes }));

  // Liveness only. Deliberately says nothing about providers, keys or tenants:
  // a health endpoint that enumerates configured vendors is reconnaissance.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
  });

  const api = express.Router();
  api.use(tenantMiddleware);
  api.use(rateLimitMiddleware);
  api.use(modelsRouter);
  api.use(chatRouter);
  api.use(ragRouter);
  api.use(metricsRouter);
  api.use(labsRouter);
  app.use('/api', api);

  app.use(notFound);
  app.use(errorHandler);

  logger.info('http.ready');
  return app;
}
