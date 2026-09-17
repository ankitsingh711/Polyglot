import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, formatMs, formatUsd, getTenantKey, setTenantKey } from './lib/api';
import type { CatalogResponse, Collection, MetricsSummary, ModelInfo } from './lib/types';
import { ChatView } from './components/ChatView';
import { DocumentsView } from './components/DocumentsView';
import { MetricsView } from './components/MetricsView';
import { CompareView } from './components/CompareView';
import {
  BrandMark,
  IconChat,
  IconCompare,
  IconDocs,
  IconMetrics,
  IconSidebar,
  Notice,
  ProviderDot,
  Spinner,
  ToastHost,
  useMediaQuery,
  useToast,
} from './components/ui';

type Tab = 'chat' | 'documents' | 'compare' | 'metrics';

const TABS: Array<{ id: Tab; label: string; Icon: (p: { size?: number }) => React.JSX.Element }> = [
  { id: 'chat', label: 'Chat', Icon: IconChat },
  { id: 'documents', label: 'Documents', Icon: IconDocs },
  { id: 'compare', label: 'Compare', Icon: IconCompare },
  { id: 'metrics', label: 'Metrics', Icon: IconMetrics },
];

/**
 * The tenant switcher is a demo affordance, not an auth model: it changes which
 * tenant KEY the browser sends. Everything the server returns afterwards is
 * scoped by that key, which is what makes the isolation boundary observable —
 * switch tenants and the conversations, documents and spend all change.
 */
const DEMO_TENANTS = [
  { label: 'Acme Corp', key: 'pk_demo_acme_do_not_use_in_production' },
  { label: 'Globex Industries', key: 'pk_demo_globex_do_not_use_in_production' },
];

export function App() {
  return (
    <ToastHost>
      <Shell />
    </ToastHost>
  );
}

function Shell() {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('chat');
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [summary, setSummary] = useState<MetricsSummary | null>(null);
  const [tenant, setTenant] = useState<{ id: string; name: string } | null>(null);
  const [key, setKey] = useState(getTenantKey() || DEMO_TENANTS[0]!.key);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [usageToken, setUsageToken] = useState(0);
  const [streaming, setStreaming] = useState(false);
  /*
   * Panels are furniture only while there is room for them. These breakpoints
   * mirror the CSS: below them the side panels become overlays, so they default
   * closed and opening one closes the other rather than stacking.
   */
  const roomForContext = useMediaQuery('(min-width: 901px)');
  const roomForInspector = useMediaQuery('(min-width: 1181px)');
  const [contextOpen, setContextOpen] = useState(roomForContext);
  const [inspectorOpen, setInspectorOpen] = useState(roomForInspector);

  useEffect(() => setContextOpen(roomForContext), [roomForContext]);
  useEffect(() => setInspectorOpen(roomForInspector), [roomForInspector]);

  const overlayContext = contextOpen && !roomForContext;
  const overlayInspector = inspectorOpen && !roomForInspector;

  const openContext = (open: boolean) => {
    setContextOpen(open);
    if (open && !roomForInspector) setInspectorOpen(false);
  };
  const openInspector = (open: boolean) => {
    setInspectorOpen(open);
    if (open && !roomForContext) setContextOpen(false);
  };
  const [activeModel, setActiveModel] = useState<string>('');

  const bumpUsage = useCallback(() => setUsageToken((n) => n + 1), []);

  const loadCollections = useCallback(async () => {
    const res = await api<{ collections: Collection[] }>('/collections');
    setCollections(res.collections);
  }, []);

  const connect = useCallback(
    async (nextKey: string) => {
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
        setCatalog(null);
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [loadCollections],
  );

  useEffect(() => {
    void connect(key);
  }, [key, connect]);

  // The status bar is live, so its numbers refresh whenever a turn completes.
  useEffect(() => {
    if (!tenant) return;
    api<MetricsSummary>('/metrics/summary?since=24h')
      .then(setSummary)
      .catch(() => {});
  }, [tenant, usageToken]);

  const models: ModelInfo[] = useMemo(() => catalog?.models ?? [], [catalog]);
  const chatProviders = (catalog?.providers ?? []).filter((p) => p.configured && p.name !== 'local');

  useEffect(() => {
    if (catalog && !activeModel) setActiveModel(pickDefaultModel(catalog));
  }, [catalog, activeModel]);

  const hasContextColumn = tab === 'chat' || tab === 'documents';
  const hasInspector = tab === 'chat' || tab === 'documents';

  return (
    <div className="app">
      <header className="header">
        <button
          className="ghost icon"
          title={contextOpen ? 'Hide the sidebar' : 'Show the sidebar'}
          onClick={() => openContext(!contextOpen)}
          disabled={!hasContextColumn}
          style={{ opacity: hasContextColumn ? 1 : 0.3 }}
        >
          <IconSidebar size={16} />
        </button>

        <div className="brand">
          <BrandMark />
          <span>Polyglot</span>
        </div>

        <nav className="segmented" aria-label="Workspace">
          {TABS.map(({ id, label, Icon }) => (
            <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)} aria-current={tab === id}>
              <Icon size={15} />
              <span className="label">{label}</span>
            </button>
          ))}
        </nav>

        <div className="fill" />

        <div className="provider-dots" title="Provider keys configured in .env">
          {catalog?.providers.map((p) => (
            <ProviderDot
              key={p.name}
              provider={p.name}
              off={!p.configured}
              title={`${p.name} — ${p.configured ? 'key configured' : 'no API key'}`}
            />
          ))}
        </div>

        <select
          value={DEMO_TENANTS.some((t) => t.key === key) ? key : 'custom'}
          onChange={(e) => e.target.value !== 'custom' && setKey(e.target.value)}
          title="Switch tenant — everything below is scoped to this key"
          className="auto tenant-select"
          style={{ fontSize: 'var(--t-sm)' }}
        >
          {DEMO_TENANTS.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
          <option value="custom">Custom key…</option>
        </select>

        {loading ? (
          <Spinner />
        ) : tenant ? (
          <span className="avatar" title={`Tenant ${tenant.name} (${tenant.id})`}>
            {initials(tenant.name)}
          </span>
        ) : null}

        <button
          className="ghost icon"
          title={inspectorOpen ? 'Hide the details panel' : 'Show the details panel'}
          onClick={() => openInspector(!inspectorOpen)}
          disabled={!hasInspector}
          style={{ opacity: hasInspector ? 1 : 0.3, transform: 'scaleX(-1)' }}
          aria-pressed={inspectorOpen}
        >
          <IconSidebar size={16} />
        </button>
      </header>

      <div
        className={[
          'workspace',
          hasContextColumn && contextOpen ? '' : 'no-context',
          hasInspector && inspectorOpen ? 'with-inspector' : '',
          contextOpen ? 'context-open' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {error ? (
          <>
            <div className="context" />
            <div className="canvas">
              <div className="canvas-scroll">
                <div className="canvas-inner">
                  <Notice level="err">
                    <strong>Cannot reach the API.</strong> {error}
                    <div className="sm" style={{ marginTop: 6 }}>
                      Run <code>npm run seed</code> to create the demo tenants, then <code>npm run dev</code>.
                    </div>
                  </Notice>
                </div>
              </div>
            </div>
            <div className="inspector" />
          </>
        ) : !catalog ? (
          <>
            <div className="context" />
            <div className="canvas">
              <div className="canvas-scroll">
                <div className="canvas-inner">
                  <div className="col gap-3" style={{ marginTop: 40 }}>
                    <div className="skeleton" style={{ height: 22, width: '38%' }} />
                    <div className="skeleton" style={{ height: 120 }} />
                    <div className="skeleton" style={{ height: 120 }} />
                  </div>
                </div>
              </div>
            </div>
            <div className="inspector" />
          </>
        ) : (
          <>
            {tab === 'chat' && (
              <ChatView
                models={models}
                collections={collections}
                model={activeModel || pickDefaultModel(catalog)}
                onModelChange={setActiveModel}
                onUsageChanged={bumpUsage}
                onStreamingChange={setStreaming}
                onError={(m) => toast('err', m)}
                onInspect={() => openInspector(true)}
                noProviderKeys={chatProviders.length === 0}
              />
            )}
            {tab === 'documents' && (
              <DocumentsView
                models={models}
                collections={collections}
                defaultEmbeddingModel={pickDefaultEmbedding(catalog)}
                onCollectionsChanged={() => void loadCollections()}
                onError={(m) => toast('err', m)}
                onUsageChanged={bumpUsage}
                onInspect={() => openInspector(true)}
              />
            )}
            {tab === 'compare' && (
              <CompareView models={models} onUsageChanged={bumpUsage} onStreamingChange={setStreaming} />
            )}
            {tab === 'metrics' && <MetricsView refreshToken={usageToken} onError={(m) => toast('err', m)} />}
          </>
        )}
      </div>

      {(overlayContext || overlayInspector) && (
        <button
          className="scrim"
          aria-label="Close panel"
          onClick={() => {
            if (overlayContext) setContextOpen(false);
            if (overlayInspector) setInspectorOpen(false);
          }}
        />
      )}

      {/*
        Permanent telemetry. The product exists to make cost and latency legible,
        so those numbers get permanent screen space rather than living only in a
        tab you have to remember to open.
      */}
      <footer className="statusbar tnum">
        <span className="status-item">
          <span className={`live-dot${streaming ? ' busy' : tenant ? '' : ' off'}`} />
          <b>{tenant?.name ?? 'Not connected'}</b>
        </span>

        <span className="status-sep" />

        <span className="status-item hide-sm" title="Spend today across every provider, for this tenant">
          spend today <b>{formatUsd(summary?.budget.spentTodayUsd ?? 0)}</b>
          <span className="faint">/ {formatUsd(summary?.budget.dailyBudgetUsd ?? 0)}</span>
        </span>

        <span className="status-sep hide-sm" />

        <span className="status-item hide-sm" title="Requests recorded in the last 24 hours">
          <b>{summary?.totals.requests ?? 0}</b> requests
        </span>

        <span className="status-item hide-sm" title="Average total latency over the last 24 hours">
          avg <b>{formatMs(summary?.totals.avg_latency_ms ?? 0)}</b>
        </span>

        {summary?.totals.avg_ttft_ms != null && (
          <span className="status-item hide-sm" title="Average time to first token">
            ttft <b>{formatMs(summary.totals.avg_ttft_ms)}</b>
          </span>
        )}

        {(summary?.totals.fallbacks ?? 0) > 0 && (
          <span className="status-item" style={{ color: 'var(--c-warn)' }} title="Requests served by a fallback provider">
            <b>{summary!.totals.fallbacks}</b> fallbacks
          </span>
        )}
        {(summary?.totals.errors ?? 0) > 0 && (
          <span className="status-item" style={{ color: 'var(--c-err)' }} title="Requests that ended in an error">
            <b>{summary!.totals.errors}</b> errors
          </span>
        )}

        <span className="fill" />

        {chatProviders.length === 0 && catalog && (
          <span className="status-item" style={{ color: 'var(--c-warn)' }}>
            no chat provider key — add one to .env
          </span>
        )}
        <span className="status-item faint hide-sm">{streaming ? 'streaming…' : 'idle'}</span>
      </footer>
    </div>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
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
