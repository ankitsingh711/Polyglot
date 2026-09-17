import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Config loading. Everything that a reviewer might reasonably want to change
 * without touching TypeScript lives in /config and is validated here at boot.
 * A malformed config is a startup crash, not a 3am surprise.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** Walk up from this file until we find the repo's /config directory. */
function findConfigDir(): string {
  if (process.env.POLYGLOT_CONFIG_DIR) return resolve(process.env.POLYGLOT_CONFIG_DIR);
  let dir = here;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'config', 'models.json');
    if (existsSync(candidate)) return join(dir, 'config');
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate the /config directory. Set POLYGLOT_CONFIG_DIR.');
}

export const CONFIG_DIR = findConfigDir();
export const REPO_ROOT = dirname(CONFIG_DIR);

function readJson(name: string): unknown {
  const path = join(CONFIG_DIR, name);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to read config ${path}: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const capabilitiesSchema = z.object({
  tools: z.boolean(),
  vision: z.boolean(),
  jsonSchema: z.boolean(),
  streaming: z.boolean(),
  reasoning: z.boolean().optional(),
  promptCaching: z.boolean().optional(),
});

const pricingSchema = z.object({
  inputPerMTok: z.number().min(0),
  outputPerMTok: z.number().min(0),
  cachedInputPerMTok: z.number().min(0).optional(),
  cacheWritePerMTok: z.number().min(0).optional(),
  reasoningPerMTok: z.number().min(0).optional(),
});

const modelEntrySchema = z.object({
  displayName: z.string().optional(),
  provider: z.string().min(1),
  providerModelId: z.string().min(1),
  kind: z.enum(['chat', 'embedding']).default('chat'),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive().optional(),
  dimensions: z.number().int().positive().optional(),
  capabilities: capabilitiesSchema,
  pricing: pricingSchema,
});

const modelsFileSchema = z.object({
  $schemaVersion: z.number().optional(),
  pricingCheckedOn: z.string().optional(),
  pricingSources: z.record(z.string(), z.string()).optional(),
  _comment: z.string().optional(),
  models: z.record(z.string(), modelEntrySchema),
});

const providerEntrySchema = z.object({
  baseUrl: z.string().min(1),
  apiKeyEnv: z.string().min(1).nullable(),
  timeoutMs: z.number().int().positive().default(120000),
  options: z.record(z.string(), z.unknown()).default({}),
});

const providersFileSchema = z.object({
  $schemaVersion: z.number().optional(),
  _comment: z.string().optional(),
  providers: z.record(z.string(), providerEntrySchema),
});

const appFileSchema = z.object({
  $schemaVersion: z.number().optional(),
  defaults: z.object({
    chatModel: z.string(),
    embeddingModel: z.string(),
    maxTokens: z.number().int().positive(),
    temperature: z.number().min(0).max(2),
  }),
  retry: z.object({
    _comment: z.string().optional(),
    maxAttempts: z.number().int().min(1).max(10),
    baseDelayMs: z.number().int().positive(),
    maxDelayMs: z.number().int().positive(),
    jitter: z.enum(['none', 'full', 'equal']),
    retryOn: z.array(z.string()),
    respectRetryAfter: z.boolean(),
    maxRetryAfterMs: z.number().int().positive(),
  }),
  fallback: z.object({
    _comment: z.string().optional(),
    enabled: z.boolean(),
    maxHops: z.number().int().min(0).max(5),
    chains: z.record(z.string(), z.array(z.string())),
    embeddingChain: z.array(z.string()),
  }),
  context: z.object({
    _comment: z.string().optional(),
    strategy: z.enum(['reject', 'truncate', 'summarize']),
    summaryModel: z.string(),
    reservedOutputTokens: z.number().int().positive(),
    headroomRatio: z.number().min(0.1).max(1),
    keepRecentTurns: z.number().int().min(1),
  }),
  rag: z.object({
    chunkSize: z.number().int().min(100).max(8000),
    chunkOverlap: z.number().int().min(0).max(2000),
    topK: z.number().int().min(1).max(50),
    similarityThreshold: z.number().min(0).max(1),
    retrievalMode: z.enum(['vector', 'keyword', 'hybrid']),
    rrfK: z.number().int().positive(),
    maxContextChars: z.number().int().positive(),
    minChunkChars: z.number().int().min(1),
  }),
  limits: z.object({
    maxRequestBodyBytes: z.number().int().positive(),
    maxUploadBytes: z.number().int().positive(),
    maxFilesPerUpload: z.number().int().positive(),
    maxMessagesPerConversation: z.number().int().positive(),
    maxPromptChars: z.number().int().positive(),
    maxToolIterations: z.number().int().min(1).max(20),
    maxCostPerRequestUsd: z.number().positive(),
    tenantDailyBudgetUsd: z.number().positive(),
    rateLimitPerMinute: z.number().int().positive(),
    maxCollectionsPerTenant: z.number().int().positive(),
    maxDocumentsPerCollection: z.number().int().positive(),
  }),
  tools: z.object({
    enabled: z.array(z.string()),
    weather: z.object({
      geocodeUrl: z.string().url(),
      forecastUrl: z.string().url(),
      timeoutMs: z.number().int().positive(),
    }),
  }),
  cache: z.object({
    _comment: z.string().optional(),
    semantic: z.object({
      enabled: z.boolean(),
      similarityThreshold: z.number().min(0).max(1),
      ttlSeconds: z.number().int().positive(),
      maxEntriesPerTenant: z.number().int().positive(),
    }),
  }),
});

export type ModelsFile = z.infer<typeof modelsFileSchema>;
export type ProvidersFile = z.infer<typeof providersFileSchema>;
export type AppConfig = z.infer<typeof appFileSchema>;
export type ProviderConfigEntry = z.infer<typeof providerEntrySchema>;

// ---------------------------------------------------------------------------
// Load + cross-validate
// ---------------------------------------------------------------------------

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, file: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`);
    throw new Error(`Invalid ${file}:\n${lines.join('\n')}`);
  }
  return result.data;
}

let cached: { models: ModelsFile; providers: ProvidersFile; app: AppConfig } | null = null;

export function loadConfig(force = false) {
  if (cached && !force) return cached;

  const models = parseOrThrow(modelsFileSchema, readJson('models.json'), 'config/models.json');
  const providers = parseOrThrow(providersFileSchema, readJson('providers.json'), 'config/providers.json');
  const app = parseOrThrow(appFileSchema, readJson('app.json'), 'config/app.json');

  // Cross-file integrity. Catching this at boot is much cheaper than at 2am.
  const problems: string[] = [];
  for (const [id, entry] of Object.entries(models.models)) {
    if (!providers.providers[entry.provider]) {
      problems.push(`models.json: "${id}" references unknown provider "${entry.provider}"`);
    }
    if (entry.kind === 'embedding' && !entry.dimensions) {
      problems.push(`models.json: embedding model "${id}" must declare "dimensions"`);
    }
    if (!id.startsWith(`${entry.provider}:`)) {
      problems.push(`models.json: id "${id}" must be namespaced as "${entry.provider}:<name>"`);
    }
  }
  const known = new Set(Object.keys(models.models));
  if (!known.has(app.defaults.chatModel)) problems.push(`app.json: defaults.chatModel "${app.defaults.chatModel}" is not in models.json`);
  if (!known.has(app.defaults.embeddingModel)) problems.push(`app.json: defaults.embeddingModel "${app.defaults.embeddingModel}" is not in models.json`);
  if (!known.has(app.context.summaryModel)) problems.push(`app.json: context.summaryModel "${app.context.summaryModel}" is not in models.json`);
  for (const [from, chain] of Object.entries(app.fallback.chains)) {
    if (!known.has(from)) problems.push(`app.json: fallback chain key "${from}" is not in models.json`);
    for (const to of chain) if (!known.has(to)) problems.push(`app.json: fallback target "${to}" (from "${from}") is not in models.json`);
  }
  for (const id of app.fallback.embeddingChain) {
    if (!known.has(id)) problems.push(`app.json: embeddingChain entry "${id}" is not in models.json`);
    else if (models.models[id]!.kind !== 'embedding') problems.push(`app.json: embeddingChain entry "${id}" is not an embedding model`);
  }
  if (app.rag.chunkOverlap >= app.rag.chunkSize) {
    problems.push('app.json: rag.chunkOverlap must be smaller than rag.chunkSize');
  }
  if (problems.length) throw new Error(`Configuration is inconsistent:\n${problems.map((p) => `  - ${p}`).join('\n')}`);

  cached = { models, providers, app };
  return cached;
}

export function appConfig(): AppConfig {
  return loadConfig().app;
}
