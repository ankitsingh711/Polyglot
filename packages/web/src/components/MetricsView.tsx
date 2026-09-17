import { useCallback, useEffect, useState } from 'react';
import { api, formatMs, formatTokens, formatUsd } from '../lib/api';
import type { MetricsSummary, UsageRecord } from '../lib/types';
import { Badge, EmptyState, IconMetrics, IconRefresh, Notice, Spinner, Stat, providerColor } from './ui';

/**
 * Observability.
 *
 * Every number here comes from a usage row the gateway wrote, and every cost is
 * config pricing applied to the provider's own reported usage — never an
 * estimate. Rows are tenant-scoped like everything else, which is visible by
 * switching tenant in the header and watching the whole screen change.
 */

const WINDOWS = [
  { label: 'Last hour', value: '1h' },
  { label: 'Last 24 hours', value: '24h' },
  { label: 'Last 7 days', value: '7d' },
  { label: 'All time', value: '' },
];

interface AuditEntry {
  id: string;
  request_id: string;
  severity: string;
  action: string;
  resource: string | null;
  created_at: string;
}

export function MetricsView({ refreshToken, onError }: { refreshToken: number; onError: (m: string) => void }) {
  const [since, setSince] = useState('24h');
  const [summary, setSummary] = useState<MetricsSummary | null>(null);
  const [requests, setRequests] = useState<UsageRecord[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const query = since ? `?since=${since}` : '';
      const [s, r, a] = await Promise.all([
        api<MetricsSummary>(`/metrics/summary${query}`),
        api<{ requests: UsageRecord[] }>(`/metrics/requests${query ? `${query}&limit=100` : '?limit=100'}`),
        api<{ entries: AuditEntry[] }>('/metrics/audit?limit=40'),
      ]);
      setSummary(s);
      setRequests(r.requests);
      setAudit(a.entries);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [since, onError]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  const budgetPct = summary ? Math.min(100, (summary.budget.spentTodayUsd / summary.budget.dailyBudgetUsd) * 100) : 0;
  const maxProviderCost = Math.max(...(summary?.byProvider.map((p) => p.total_cost_usd) ?? [0]), 1e-9);
  const violations = audit.filter((a) => a.severity === 'violation').length;

  return (
    <section className="canvas" style={{ gridColumn: '1 / -1' }}>
      <div className="canvas-scroll">
        <div className="canvas-inner wide">
          <div className="row between" style={{ marginBottom: 'var(--s-4)' }}>
            <div>
              <h3>Observability</h3>
              <div className="sm faint">Per-request cost, latency and provenance for this tenant.</div>
            </div>
            <div className="row">
              <select className="auto" value={since} onChange={(e) => setSince(e.target.value)}>
                {WINDOWS.map((w) => (
                  <option key={w.value} value={w.value}>
                    {w.label}
                  </option>
                ))}
              </select>
              <button onClick={() => void load()} title="Refresh">
                {loading ? <Spinner /> : <IconRefresh size={15} />}
              </button>
            </div>
          </div>

          {violations > 0 && (
            <Notice level="err">
              <strong>{violations} tenant-guard violation{violations === 1 ? '' : 's'} recorded.</strong> A query reached
              the data layer without a tenant predicate and was refused. In production this is a page-worthy event.
            </Notice>
          )}

          {summary && (
            <>
              <div className="stat-grid" style={{ marginBottom: 'var(--s-4)' }}>
                <Stat label="Requests" value={String(summary.totals.requests)} />
                <Stat label="Spend" value={formatUsd(summary.totals.total_cost_usd)} />
                <Stat label="Avg latency" value={formatMs(summary.totals.avg_latency_ms)} />
                <Stat label="Avg TTFT" value={formatMs(summary.totals.avg_ttft_ms)} title="Time to first token" />
                <Stat label="Input tokens" value={formatTokens(summary.totals.input_tokens)} />
                <Stat label="Output tokens" value={formatTokens(summary.totals.output_tokens)} />
                <Stat
                  label="Cached input"
                  value={formatTokens(summary.totals.cached_input_tokens)}
                  tone={summary.totals.cached_input_tokens > 0 ? 'ok' : undefined}
                  title="Prompt tokens served from a provider-side cache, billed at the cached rate"
                />
                <Stat label="Errors" value={String(summary.totals.errors)} tone={summary.totals.errors ? 'err' : undefined} />
                <Stat
                  label="Fallbacks"
                  value={String(summary.totals.fallbacks)}
                  tone={summary.totals.fallbacks ? 'warn' : undefined}
                  title="Requests served by a provider other than the one requested"
                />
                <Stat label="Cache hits" value={String(summary.totals.cache_hits)} />
              </div>

              <div className="card">
                <div className="row between" style={{ marginBottom: 'var(--s-2)' }}>
                  <div className="eyebrow">Daily budget</div>
                  <span className="sm faint">per-request cap {formatUsd(summary.budget.maxCostPerRequestUsd)}</span>
                </div>
                <div className="row between sm" style={{ marginBottom: 6 }}>
                  <span className="muted">
                    <strong>{formatUsd(summary.budget.spentTodayUsd)}</strong> spent today
                  </span>
                  <span className="faint">
                    {formatUsd(summary.budget.remainingUsd)} of {formatUsd(summary.budget.dailyBudgetUsd)} remaining
                  </span>
                </div>
                <div className="meter">
                  <span className={budgetPct > 90 ? 'err' : budgetPct > 70 ? 'warn' : ''} style={{ width: `${budgetPct}%` }} />
                </div>
                {summary.cache.entries > 0 && (
                  <div className="sm faint" style={{ marginTop: 'var(--s-3)' }}>
                    Semantic cache: {summary.cache.entries} entries · {summary.cache.hits} hits ·{' '}
                    {formatUsd(summary.cache.saved_usd)} saved.
                  </div>
                )}
              </div>

              <div className="card flush">
                <div className="card-head">
                  <div className="eyebrow fill">Spend by provider and model</div>
                </div>
                {summary.byProvider.length === 0 ? (
                  <div className="card-body sm faint">No requests in this window.</div>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Provider</th>
                          <th>Model</th>
                          <th style={{ width: 120 }}>Share</th>
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
                            <td>
                              <span className="row" style={{ gap: 6 }}>
                                <span
                                  className="provider-dot"
                                  style={{ '--dot': providerColor(row.provider) } as React.CSSProperties}
                                />
                                {row.provider}
                              </span>
                            </td>
                            <td className="mono">{row.model_id.split(':')[1]}</td>
                            <td>
                              <div className="meter" title={formatUsd(row.total_cost_usd)}>
                                <span
                                  style={{
                                    width: `${(row.total_cost_usd / maxProviderCost) * 100}%`,
                                    background: providerColor(row.provider),
                                  }}
                                />
                              </div>
                            </td>
                            <td className="num">{row.requests}</td>
                            <td className="num">{formatUsd(row.total_cost_usd)}</td>
                            <td className="num">{formatMs(row.avg_latency_ms)}</td>
                            <td className="num">{formatMs(row.avg_ttft_ms)}</td>
                            <td className="num">{formatTokens(row.input_tokens)}</td>
                            <td className="num">{formatTokens(row.output_tokens)}</td>
                            <td className="num">{formatTokens(row.cached_input_tokens)}</td>
                            <td className="num">{row.retries || ''}</td>
                            <td className="num">{row.fallbacks || ''}</td>
                            <td className="num">{row.errors || ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}

          <div className="card flush">
            <div className="card-head">
              <div className="eyebrow fill">Requests</div>
              <span className="xs faint">newest first</span>
            </div>
            {requests.length === 0 ? (
              <div className="card-body">
                <EmptyState
                  icon={<IconMetrics size={20} />}
                  title="No requests recorded yet"
                  hint="Send a message, run a comparison or upload a document — every model and embedding call lands here."
                />
              </div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Kind</th>
                      <th>Provider</th>
                      <th>Model</th>
                      <th className="num">TTFT</th>
                      <th className="num">Latency</th>
                      <th className="num">In</th>
                      <th className="num">Out</th>
                      <th className="num">Cost</th>
                      <th>Finish</th>
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {requests.map((row) => (
                      <tr key={row.id}>
                        <td className="faint nowrap">{new Date(row.started_at).toLocaleTimeString()}</td>
                        <td>{row.kind}</td>
                        <td>
                          <span className="row" style={{ gap: 6 }}>
                            <span
                              className="provider-dot"
                              style={{ '--dot': providerColor(row.provider) } as React.CSSProperties}
                            />
                            {row.provider}
                          </span>
                        </td>
                        <td className="mono truncate" style={{ maxWidth: 170 }}>
                          {row.model_id.split(':')[1]}
                        </td>
                        <td className="num">{formatMs(row.ttft_ms)}</td>
                        <td className="num">{formatMs(row.latency_ms)}</td>
                        <td className="num">{formatTokens(row.input_tokens)}</td>
                        <td className="num">{formatTokens(row.output_tokens)}</td>
                        <td className="num">{formatUsd(row.cost_usd)}</td>
                        <td className="faint">{row.finish_reason ?? '—'}</td>
                        <td>
                          <div className="chips">
                            {row.error_kind && <Badge tone="err">{row.error_kind}</Badge>}
                            {row.retry_count > 0 && <Badge tone="warn">{row.retry_count} retries</Badge>}
                            {row.fallback_from && (
                              <Badge tone="warn" title={`Requested ${row.fallback_from}`}>
                                fallback
                              </Badge>
                            )}
                            {row.cached_input_tokens > 0 && <Badge tone="ok">prompt cache</Badge>}
                            {row.cache_hit === 1 && <Badge tone="ok">cache hit</Badge>}
                            {row.tool_call_count > 0 && <Badge>{row.tool_call_count} tools</Badge>}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="card flush">
            <div className="card-head">
              <div className="fill">
                <div className="eyebrow">Audit trail</div>
              </div>
              <span className="xs faint">tenant-scoped</span>
            </div>
            <div className="card-body" style={{ paddingBottom: 0 }}>
              <p className="sm muted">
                A record of what this tenant touched, and of any guard violation. This is the answer to &ldquo;how would
                you know, in production, if it had ever leaked?&rdquo;
              </p>
            </div>
            {audit.length === 0 ? (
              <div className="card-body sm faint">Nothing recorded yet.</div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Severity</th>
                      <th>Action</th>
                      <th>Resource</th>
                      <th>Request</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.map((entry) => (
                      <tr key={entry.id}>
                        <td className="faint nowrap">{new Date(entry.created_at).toLocaleTimeString()}</td>
                        <td>
                          <Badge tone={entry.severity === 'violation' ? 'err' : 'ok'}>{entry.severity}</Badge>
                        </td>
                        <td className="mono">{entry.action}</td>
                        <td className="mono truncate" style={{ maxWidth: 200 }}>
                          {entry.resource ?? '—'}
                        </td>
                        <td className="mono faint truncate" style={{ maxWidth: 190 }}>
                          {entry.request_id}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
