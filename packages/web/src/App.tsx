import { useCallback, useEffect, useState } from 'react';
import { api, getTenantKey, setTenantKey } from './lib/api';
import type { CatalogResponse, Collection, ModelInfo } from './lib/types';
import { ChatView } from './components/ChatView';
import { DocumentsView } from './components/DocumentsView';
import { MetricsView } from './components/MetricsView';
import { CompareView } from './components/CompareView';
import { Badge, Notice, Spinner } from './components/shared';

type Tab = 'chat' | 'documents' | 'compare' | 'metrics';

/**
 * The tenant switcher is a demo affordance, not an auth model: it swaps which
 * tenant KEY the browser sends. Everything the server returns afterwards is
 * scoped by that key, which is what makes the isolation boundary observable —
 * switch tenants and the conversations, collections and spend all change.
 */
const DEMO_TENANTS = [
  { label: 'Acme Corp', key: 'pk_demo_acme_do_not_use_in_production' },
  { label: 'Globex Industries', key: 'pk_demo_globex_do_not_use_in_production' },
];

export function App() {
  const [tab, setTab] = useState<Tab>('chat');
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [tenant, setTenant] = useState<{ id: string; name: string } | null>(null);
  const [key, setKey] = useState(getTenantKey() || DEMO_TENANTS[0]!.key);
  const [customKey, setCustomKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [usageToken, setUsageToken] = useState(0);

  const bumpUsage = useCallback(() => setUsageToken((n) => n + 1), []);

  const loadCollections = useCallback(async () => {
    const res = await api<{ collections: Collection[] }>('/collections');
    setCollections(res.collections);
  }, []);

  const connect = useCallback(async (nextKey: string) => {
    setLoading(true);
    setError(null);
    setTenantKey(nextKey);
    try {
      const [me, models] = await Promise.all([
        api<{ tenant: { id: string; name: string } }>('/me'),
        api<CatalogResponse>('/models'),
      ]);
      setTenant(me.tenant);
      setCatalog(models);
      await loadCollections();
    } catch (e) {
      setTenant(null);
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [loadCollections]);

  useEffect(() => {
    void connect(key);
  }, [key, connect]);

  const models: ModelInfo[] = catalog?.models ?? [];
  const configuredChatProviders = (catalog?.providers ?? []).filter(
    (p) => p.configured && p.name !== 'local',
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          Polyglot <small>multi-provider AI workbench</small>
        </div>

        <nav className="tabs">
          {(['chat', 'documents', 'compare', 'metrics'] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
              {t[0]!.toUpperCase() + t.slice(1)}
            </button>
          ))}
        </nav>

        <div className="spacer" />

        <div className="row" style={{ gap: 6 }}>
          {catalog?.providers.map((p) => (
            <Badge key={p.name} tone={p.configured ? 'ok' : 'default'} title={p.configured ? 'API key configured' : 'No API key in .env'}>
              {p.name}
            </Badge>
          ))}
        </div>

        <div className="tenant-switch">
          <select
            value={DEMO_TENANTS.some((t) => t.key === key) ? key : 'custom'}
            onChange={(e) => {
              if (e.target.value === 'custom') return;
              setKey(e.target.value);
            }}
          >
            {DEMO_TENANTS.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
            <option value="custom">Custom key…</option>
          </select>
          {!DEMO_TENANTS.some((t) => t.key === key) && (
            <input
              type="password"
              placeholder="x-tenant-key"
              value={customKey}
              onChange={(e) => setCustomKey(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && setKey(customKey.trim())}
              style={{ width: 200 }}
            />
          )}
          {loading ? <Spinner /> : tenant ? <Badge tone="accent">{tenant.name}</Badge> : <Badge tone="err">not connected</Badge>}
        </div>
      </header>

      {error && (
        <div style={{ padding: '10px 18px' }}>
          <Notice level="err">
            {error}
            <div className="small" style={{ marginTop: 6 }}>
              Run <code>npm run seed</code> to create the demo tenants, and make sure the server is running.
            </div>
          </Notice>
        </div>
      )}

      {!error && catalog && configuredChatProviders.length === 0 && (
        <div style={{ padding: '10px 18px' }}>
          <Notice level="warn">
            No chat provider has an API key. Copy <code>.env.example</code> to <code>.env</code>, add at least
            <code> ANTHROPIC_API_KEY</code> or <code>GEMINI_API_KEY</code>, and restart the server. Document upload and
            retrieval still work offline using the local embedding model.
          </Notice>
        </div>
      )}

      <main className="main">
        {tab === 'chat' && catalog && (
          <ChatView
            models={models}
            collections={collections}
            defaultModel={pickDefaultModel(catalog)}
            onUsageChanged={bumpUsage}
          />
        )}
        {tab === 'documents' && catalog && (
          <DocumentsView
            models={models}
            collections={collections}
            defaultEmbeddingModel={pickDefaultEmbedding(catalog)}
            onCollectionsChanged={() => void loadCollections()}
          />
        )}
        {tab === 'compare' && catalog && <CompareView models={models} onUsageChanged={bumpUsage} />}
        {tab === 'metrics' && <MetricsView refreshToken={usageToken} />}
        {!catalog && !error && (
          <section className="panel">
            <div className="empty">
              <Spinner /> Connecting…
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

/** Prefer the configured default; fall back to any available chat model. */
function pickDefaultModel(catalog: CatalogResponse): string {
  const configured = catalog.models.find((m) => m.id === catalog.defaults.chatModel && m.available);
  if (configured) return configured.id;
  return catalog.models.find((m) => m.kind === 'chat' && m.available)?.id ?? catalog.defaults.chatModel;
}

function pickDefaultEmbedding(catalog: CatalogResponse): string {
  const configured = catalog.models.find((m) => m.id === catalog.defaults.embeddingModel && m.available);
  if (configured) return configured.id;
  return catalog.models.find((m) => m.kind === 'embedding' && m.available)?.id ?? catalog.defaults.embeddingModel;
}
