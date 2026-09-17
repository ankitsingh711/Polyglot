import './core/env.js';
import { createApp } from './http/app.js';
import { loadConfig } from './core/config.js';
import { closeDatabase } from './db/index.js';
import { isProviderConfigured, listModels, registeredProviderNames } from './core/registry.js';
import { logger } from './util/logger.js';

/**
 * Entry point.
 *
 * Config is validated and providers are loaded BEFORE the socket is bound, so a
 * misconfiguration is a startup crash rather than a 500 on the first user
 * request. The boot banner reports which providers are usable, because "why is
 * this model greyed out" is the first question anyone running this will have.
 */
async function main(): Promise<void> {
  loadConfig();

  const app = await createApp();
  const port = Number(process.env.PORT ?? 8787);

  const configured = registeredProviderNames().filter(isProviderConfigured);
  const missing = registeredProviderNames().filter((p) => !isProviderConfigured(p));

  const server = app.listen(port, () => {
    logger.info('server.listening', {
      port,
      env: process.env.NODE_ENV ?? 'development',
      providersRegistered: registeredProviderNames(),
      providersConfigured: configured,
      providersMissingKeys: missing,
      chatModelsAvailable: listModels('chat').filter((m) => m.available).length,
    });
    if (!configured.filter((p) => p !== 'local').length) {
      logger.warn('server.no_provider_keys', {
        hint: 'No chat provider has an API key. Copy .env.example to .env and add at least ANTHROPIC_API_KEY or GEMINI_API_KEY.',
      });
    }
  });

  // Graceful shutdown: stop accepting, let in-flight streams finish, then close
  // SQLite so WAL is checkpointed rather than left for recovery.
  const shutdown = (signal: string) => {
    logger.info('server.shutdown', { signal });
    server.close(() => {
      closeDatabase();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('server.boot_failed', { error: (err as Error).message, stack: (err as Error).stack });
  process.exitCode = 1;
});
