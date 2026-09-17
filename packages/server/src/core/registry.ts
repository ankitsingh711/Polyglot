import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { AppError, ProviderError } from './errors.js';
import type { ModelEntry, Provider, ProviderFactory, ProviderInit } from './types.js';

/**
 * The registry is the whole extensibility story.
 *
 * A provider file calls `registerProvider('x', init => new XProvider(init))` at
 * module scope. `loadProviders()` scans `src/providers/*.provider.{ts,js}` and
 * imports each one, so no index file, switch statement or DI wiring ever needs to
 * learn a new name. Adding a provider is literally:
 *
 *   1. src/providers/<name>.provider.ts   (one new file)
 *   2. an entry in config/providers.json + its models in config/models.json
 *
 * Nothing else in the codebase changes. See docs/DESIGN.md → "Adding a provider".
 */

const factories = new Map<string, ProviderFactory>();
const instances = new Map<string, Provider>();

export function registerProvider(name: string, factory: ProviderFactory): void {
  if (factories.has(name)) {
    throw new Error(`Provider "${name}" is already registered. Provider names must be unique.`);
  }
  factories.set(name, factory);
}

export function registeredProviderNames(): string[] {
  return [...factories.keys()].sort();
}

let loaded = false;

/** Import every adapter file exactly once. Idempotent; safe to await repeatedly. */
export async function loadProviders(): Promise<void> {
  if (loaded) return;
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'providers');
  const files = readdirSync(dir)
    // Convention: only `*.provider.ts|js` self-register. Shared helpers live in
    // `_shared/` and are deliberately excluded so they cannot be constructed.
    .filter((f) => /\.provider\.(ts|js|mts|mjs)$/.test(f) && !f.endsWith('.d.ts'))
    .sort();

  for (const file of files) {
    await import(pathToFileURL(join(dir, file)).href);
  }
  loaded = true;
}

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------

export function getModelEntry(modelId: string): ModelEntry {
  const entry = loadConfig().models.models[modelId];
  if (!entry) {
    throw new AppError(400, 'unknown_model', `Unknown model "${modelId}".`, {
      hint: 'Model ids come from config/models.json and are namespaced "<provider>:<name>".',
    });
  }
  return entry;
}

export function hasModel(modelId: string): boolean {
  return Boolean(loadConfig().models.models[modelId]);
}

export interface CatalogItem extends ModelEntry {
  id: string;
  /** False when the provider has no API key configured in the environment. */
  available: boolean;
}

export function listModels(kind?: 'chat' | 'embedding'): CatalogItem[] {
  const { models } = loadConfig();
  return Object.entries(models.models)
    .filter(([, m]) => !kind || m.kind === kind)
    .map(([id, m]) => ({ ...m, id, available: isProviderConfigured(m.provider) }))
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Provider instances
// ---------------------------------------------------------------------------

export function isProviderConfigured(providerName: string): boolean {
  const cfg = loadConfig().providers.providers[providerName];
  if (!cfg) return false;
  if (cfg.apiKeyEnv === null) return true; // e.g. the local embedding provider
  return Boolean(process.env[cfg.apiKeyEnv]?.trim());
}

/** Test seam: lets adapter tests swap in a fixture-driven fetch. */
let fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args);
export function setFetchImpl(f: typeof fetch): void {
  fetchImpl = f;
  instances.clear();
}

export function getProvider(providerName: string): Provider {
  const existing = instances.get(providerName);
  if (existing) return existing;

  const factory = factories.get(providerName);
  if (!factory) {
    throw new AppError(500, 'provider_not_registered', `No adapter registered for provider "${providerName}".`, {
      registered: registeredProviderNames(),
    });
  }
  const cfg = loadConfig().providers.providers[providerName];
  if (!cfg) {
    throw new AppError(500, 'provider_not_configured', `Provider "${providerName}" has no entry in config/providers.json.`);
  }

  const apiKey = cfg.apiKeyEnv ? (process.env[cfg.apiKeyEnv] ?? '') : '';
  if (cfg.apiKeyEnv && !apiKey.trim()) {
    throw new ProviderError({
      kind: 'auth',
      provider: providerName,
      message: `No API key configured for "${providerName}". Set ${cfg.apiKeyEnv} in your .env.`,
      retryable: false,
    });
  }

  const init: ProviderInit = {
    name: providerName,
    apiKey,
    baseUrl: cfg.baseUrl.replace(/\/+$/, ''),
    timeoutMs: cfg.timeoutMs,
    lookup: getModelEntry,
    fetchImpl: (...args) => fetchImpl(...args),
    options: cfg.options,
  };

  const instance = factory(init);
  instances.set(providerName, instance);
  return instance;
}

/** Resolve a Polyglot model id to the adapter that serves it. */
export function providerForModel(modelId: string): { provider: Provider; entry: ModelEntry } {
  const entry = getModelEntry(modelId);
  return { provider: getProvider(entry.provider), entry };
}

/** Drop cached instances — used by tests and after an env change. */
export function resetProviderInstances(): void {
  instances.clear();
}
