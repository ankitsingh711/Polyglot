import { useCallback, useEffect, useState } from 'react';
import { api, formatMs, formatTokens, formatUsd } from '../lib/api';
import type { MetricsSummary, UsageRecord } from '../lib/types';
import { Badge, EmptyState, Notice, Spinner } from './shared';

/**
 * Observability.
 *
 * Every number here comes from a usage row the gateway wrote, and every cost
 * comes from config/models.json applied to the provider's own reported usage --
 * never from an estimate. Rows are tenant-scoped like everything else.
 */

const WINDOWS = [
  { label: 'Last hour', value: '1h' },
  { label: 'Last 24h', value: '24h' },
  { label: 'Last 7 days', value: '7d' },
  { label: 'All time', value: '' },
];

export function MetricsView({ refreshToken }: { refreshToken: number }) {
  const [since, setSince] = useState('24h');
  const [summary, setSummary] = useState<MetricsSummary | null>(null);
  const [requests, setRequests] = useState<UsageRecord[]>([]);
  const [audit, setAudit] = useState<Array<{ id: string; severity: string; action: string; resource: string | null; created_at: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const query = since ? `?since=${since}` : '';
      const [s, r, a] = await Promise.all([
        api<MetricsSummary>(`/metrics/summary${query}`),
        api<{ requests: UsageRecord[] }>(`/metrics/requests${query ? `${query}&limit=100` : '?limit=100'}`),
        api<{ entries: typeof audit }>('/metrics/audit?limit=40'),
      ]);
      setSummary(s);
      setRequests(r.requests);
      setAudit(a.entries);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [since]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  const budgetPct = summary ? Math.min(100, (summary.budget.spentTodayUsd / summary.budget.dailyBudgetUsd) * 100) : 0;

  return (
    <section className="panel">
      <div className="scroll">
        <div className="row" style={{ marginBottom: 14 }}>
          <select value={since} onChange={(e) => setSince(e.target.value)} style={{ width: 'auto' }}>
            {WINDOWS.map((w) => (
              <option key={w.value} value={w.value}>
                {w.label}
              </option>
            ))}
          </select>
          <button onClick={() => void load()}>{loading ? <Spinner /> : 'Refresh'}</button>
          <div className="grow" />
          <button
            className="ghost"
            onClick={async () => {
              await api('/metrics/cache', { method: 'DELETE' });
              void load();
            }}
          >
            Clear semantic cache
          </button>
        </div>

        {error && <Notice level="err">{error}</Notice>}

        {summary && (
          <>
            <div className="card">
              <div className="section-title">Totals</div>
              <div className="row wrap" style={{ gap: 26 }}>
                <Stat label="Requests" value={String(summary.totals.requests)} />
                <Stat label="Spend" value={formatUsd(summary.totals.total_cost_usd)} />
                <Stat label="Avg latency" value={formatMs(summary.totals.avg_latency_ms)} />
                <Stat label="Avg TTFT" value={formatMs(summary.totals.avg_ttft_ms)} />
                <Stat label="Input tokens" value={formatTokens(summary.totals.input_tokens)} />
                <Stat label="Output tokens" value={formatTokens(summary.totals.output_tokens)} />
                <Stat label="Cached input" value={formatTokens(summary.totals.cached_input_tokens)} />
                <Stat label="Errors" value={String(summary.totals.errors)} tone={summary.totals.errors ? 'err' : undefined} />
                <Stat label="Fallbacks" value={String(summary.totals.fallbacks)} tone={summary.totals.fallbacks ? 'warn' : undefined} />
                <Stat label="Cache hits" value={String(summary.totals.cache_hits)} />
              </div>
            </div>

            <div className="card">
              <div className="section-title">Budget</div>
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                <span className="small muted">
                  {formatUsd(summary.budget.spentTodayUsd)} spent today of {formatUsd(summary.budget.dailyBudgetUsd)}
                </span>
                <span className="small faint">per-request cap {formatUsd(summary.budget.maxCostPerRequestUsd)}</span>
              </div>
              <div className="bar">
                <span style={{ width: `${budgetPct}%`, background: budgetPct > 80 ? 'var(--err)' : 'var(--accent)' }} />
              </div>
              {summary.cache.entries > 0 && (
                <div className="small faint" style={{ marginTop: 10 }}>
                  Semantic cache: {summary.cache.entries} entries, {summary.cache.hits} hits,{' '}
                  {formatUsd(summary.cache.saved_usd)} saved.
                </div>
              )}
            </div>

            <div className="card">
              <div className="section-title">By provider and model</div>
              {summary.byProvider.length === 0 ? (
                <div className="small faint">No requests in this window.</div>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Provider</th>
                      <th>Model</th>
                      <th className="num">Requests</th>
                      <th className="num">Cost</th>
                      <th className="num">Avg latency</th>
                      <th className="num">Avg TTFT</th>
                      <th className="num">In</th>
                      <th className="num">Out</th>
                      <th className="num">Cached</th>
                      <th className="num">Retries</th>
                      <th className="num">Fallbacks</th>
                      <th className="num">Errors</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.byProvider.map((row) => (
                      <tr key={`${row.provider}:${row.model_id}`}>
                        <td>{row.provider}</td>
                        <td className="mono">{row.model_id.split(':')[1]}</td>
                        <td className="num">{row.requests}</td>
                        <td className="num">{formatUsd(row.total_cost_usd)}</td>
                        <td className="num">{formatMs(row.avg_latency_ms)}</td>
                        <td className="num">{formatMs(row.avg_ttft_ms)}</td>
                        <td className="num">{formatTokens(row.input_tokens)}</td>
                        <td className="num">{formatTokens(row.output_tokens)}</td>
                        <td className="num">{formatTokens(row.cached_input_tokens)}</td>
                        <td className="num">{row.retries}</td>
                        <td className="num">{row.fallbacks}</td>
                        <td className="num">{row.errors}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}

        <div className="card">
          <div className="section-title">Requests</div>
          {requests.length === 0 ? (
            <EmptyState title="No requests recorded yet." hint="Send a message and it will appear here." />
          ) : (
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Kind</th>
                  <th>Provider</th>
                  <th>Model</th>
                  <th className="num">TTFT</th>
                  <th className="num">Latency</th>
                  <th className="num">In</th>
                  <th className="num">Out</th>
                  <th className="num">Cost</th>
                  <th>Finish</th>
                  <th className="num">Retries</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((row) => (
                  <tr key={row.id}>
                    <td className="faint">{new Date(row.started_at).toLocaleTimeString()}</td>
                    <td>{row.kind}</td>
                    <td>{row.provider}</td>
                    <td className="mono truncate" style={{ maxWidth: 160 }}>{row.model_id.split(':')[1]}</td>
                    <td className="num">{formatMs(row.ttft_ms)}</td>
                    <td className="num">{formatMs(row.latency_ms)}</td>
                    <td className="num">{formatTokens(row.input_tokens)}</td>
                    <td className="num">{formatTokens(row.output_tokens)}</td>
                    <td className="num">{formatUsd(row.cost_usd)}</td>
                    <td>{row.finish_reason ?? '—'}</td>
                    <td className="num">{row.retry_count || ''}</td>
                    <td>
                      <div className="row" style={{ gap: 4 }}>
                        {row.error_kind && <Badge tone="err">{row.error_kind}</Badge>}
                        {row.fallback_from && <Badge tone="warn" title={`Requested ${row.fallback_from}`}>fallback</Badge>}
                        {row.cached_input_tokens > 0 && <Badge tone="ok">cached</Badge>}
                        {row.cache_hit === 1 && <Badge tone="ok">cache hit</Badge>}
                        {row.tool_call_count > 0 && <Badge>{row.tool_call_count} tools</Badge>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <div className="section-title">Audit trail</div>
          <div className="small faint" style={{ marginBottom: 8 }}>
            Tenant-scoped record of what was touched, and of any guard violation. This is the answer to
            &ldquo;how would you know, in production, if it had ever leaked?&rdquo;
          </div>
          {audit.length === 0 ? (
            <div className="small faint">Nothing recorded yet.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Severity</th>
                  <th>Action</th>
                  <th>Resource</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((entry) => (
                  <tr key={entry.id}>
                    <td className="faint">{new Date(entry.created_at).toLocaleTimeString()}</td>
                    <td>
                      <Badge tone={entry.severity === 'violation' ? 'err' : 'ok'}>{entry.severity}</Badge>
                    </td>
                    <td className="mono">{entry.action}</td>
                    <td className="mono truncate" style={{ maxWidth: 220 }}>{entry.resource ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'err' | 'warn' }) {
  return (
    <div>
      <div className="small faint">{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, color: tone === 'err' ? 'var(--err)' : tone === 'warn' ? 'var(--warn)' : undefined }}>
        {value}
      </div>
    </div>
  );
}
