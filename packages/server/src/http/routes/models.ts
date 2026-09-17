import { Router } from 'express';
import { appConfig, loadConfig } from '../../core/config.js';
import { listModels, registeredProviderNames, isProviderConfigured } from '../../core/registry.js';
import { allTools } from '../../modules/tools/registry.js';
import { currentTenant } from '../../tenancy/context.js';
import { asyncRoute } from '../middleware.js';

export const modelsRouter: Router = Router();

/**
 * The catalogue the UI renders from. Everything here is derived from /config,
 * which is what makes "prices are not hardcoded" verifiable rather than claimed:
 * edit config/models.json, restart, and this endpoint changes.
 *
 * Note what is NOT here: API keys, key prefixes, or which env var holds them.
 * `available` is a boolean, not a hint about the secret behind it.
 */
modelsRouter.get(
  '/models',
  asyncRoute(async (_req, res) => {
    const cfg = loadConfig();
    res.json({
      models: listModels().map((m) => ({
        id: m.id,
        displayName: m.displayName ?? m.id,
        provider: m.provider,
        kind: m.kind,
        contextWindow: m.contextWindow,
        maxOutputTokens: m.maxOutputTokens ?? null,
        dimensions: m.dimensions ?? null,
        capabilities: m.capabilities,
        pricing: m.pricing,
        available: m.available,
      })),
      providers: registeredProviderNames().map((name) => ({
        name,
        configured: isProviderConfigured(name),
        // Fallback targets are useful to see in the UI when a hop happens.
        baseUrl: cfg.providers.providers[name]?.baseUrl ?? null,
      })),
      pricing: {
        checkedOn: cfg.models.pricingCheckedOn ?? null,
        sources: cfg.models.pricingSources ?? {},
      },
      fallbackChains: appConfig().fallback.chains,
      defaults: appConfig().defaults,
    });
  }),
);

modelsRouter.get(
  '/tools',
  asyncRoute(async (_req, res) => {
    const enabled = appConfig().tools.enabled;
    res.json({
      tools: allTools()
        .filter((t) => enabled.includes(t.name))
        .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
    });
  }),
);

/** Who am I? Lets the UI show the active tenant without exposing the key. */
modelsRouter.get(
  '/me',
  asyncRoute(async (_req, res) => {
    const ctx = currentTenant();
    res.json({ tenant: { id: ctx.tenantId, name: ctx.tenantName }, requestId: ctx.requestId });
  }),
);
