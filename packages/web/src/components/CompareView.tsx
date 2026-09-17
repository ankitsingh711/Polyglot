import { useRef, useState } from 'react';
import { streamSse, formatMs, formatUsd, formatTokens } from '../lib/api';
import type { ModelInfo } from '../lib/types';
import { Badge, Markdown, Notice } from './shared';

/**
 * Side-by-side comparison.
 *
 * The lanes stream concurrently on one SSE channel, so the columns fill at their
 * real relative speeds. Fallback is disabled server-side for this endpoint: a
 * comparison that silently substitutes a different model is not a comparison.
 */

interface Lane {
  model: string;
  provider: string;
  text: string;
  reasoning: string;
  done: boolean;
  error?: string;
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
  costUsd?: number;
  ttftMs?: number | null;
  latencyMs?: number;
}

export function CompareView({ models, onUsageChanged }: { models: ModelInfo[]; onUsageChanged: () => void }) {
  const available = models.filter((m) => m.kind === 'chat' && m.available);
  const [selected, setSelected] = useState<string[]>(available.slice(0, 2).map((m) => m.id));
  const [prompt, setPrompt] = useState('Explain the difference between a mutex and a semaphore in three sentences.');
  const [lanes, setLanes] = useState<Record<string, Lane>>({});
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const toggle = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : prev.length >= 4 ? prev : [...prev, id]));
  };

  const run = async () => {
    if (selected.length < 2 || !prompt.trim()) return;
    setRunning(true);
    setError(null);
    setLanes(
      Object.fromEntries(
        selected.map((id, i) => [
          `lane${i + 1}`,
          { model: id, provider: models.find((m) => m.id === id)?.provider ?? '', text: '', reasoning: '', done: false },
        ]),
      ),
    );

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamSse(
        '/compare',
        { prompt, models: selected, maxTokens: 700 },
        (event) => {
          if (!event.lane) return;
          setLanes((prev) => {
            const lane: Lane =
              prev[event.lane] ?? { model: event.model, provider: event.provider, text: '', reasoning: '', done: false };
            const next: Lane = { ...lane, model: event.model, provider: event.provider };
            switch (event.event?.type) {
              case 'delta': next.text += event.event.text; break;
              case 'reasoning': next.reasoning += event.event.text; break;
              case 'usage':
                next.usage = event.event.usage;
                next.costUsd = event.event.costUsd;
                next.ttftMs = event.event.ttftMs;
                next.latencyMs = event.event.latencyMs;
                break;
              case 'done': next.done = true; break;
              case 'error': next.error = `${event.event.kind}: ${event.event.message}`; next.done = true; break;
            }
            return { ...prev, [event.lane]: next };
          });
        },
        controller.signal,
      );
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message);
    } finally {
      abortRef.current = null;
      setRunning(false);
      onUsageChanged();
    }
  };

  const finished = Object.values(lanes).filter((l) => l.done && !l.error);
  const cheapest = finished.length > 1 ? finished.reduce((a, b) => ((a.costUsd ?? 0) <= (b.costUsd ?? 0) ? a : b)) : null;
  const fastest = finished.length > 1 ? finished.reduce((a, b) => ((a.latencyMs ?? 0) <= (b.latencyMs ?? 0) ? a : b)) : null;

  return (
    <section className="panel">
      <div className="scroll">
        <div className="card">
          <div className="section-title">Prompt</div>
          <textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} disabled={running} />

          <div className="section-title">Models (2–4)</div>
          <div className="row wrap">
            {available.map((model) => (
              <button
                key={model.id}
                className={selected.includes(model.id) ? 'primary' : ''}
                onClick={() => toggle(model.id)}
                disabled={running}
              >
                {model.displayName}
              </button>
            ))}
          </div>
          {available.length < 2 && (
            <Notice level="warn">
              At least two providers need API keys for a comparison. Add them to <code>.env</code> and restart the server.
            </Notice>
          )}

          <div className="row" style={{ marginTop: 12 }}>
            {running ? (
              <button className="danger" onClick={() => abortRef.current?.abort()}>
                Stop all
              </button>
            ) : (
              <button className="primary" onClick={() => void run()} disabled={selected.length < 2 || !prompt.trim()}>
                Run {selected.length} models concurrently
              </button>
            )}
            {error && <span className="small" style={{ color: 'var(--err)' }}>{error}</span>}
          </div>
        </div>

        {Object.keys(lanes).length > 0 && (
          <div className="lanes">
            {Object.entries(lanes).map(([key, lane]) => (
              <div className="lane" key={key}>
                <div className="head row" style={{ justifyContent: 'space-between' }}>
                  <strong className="small">{lane.model}</strong>
                  <div className="row" style={{ gap: 4 }}>
                    {lane === cheapest && <Badge tone="ok">cheapest</Badge>}
                    {lane === fastest && <Badge tone="accent">fastest</Badge>}
                    {!lane.done && <Badge tone="warn">streaming</Badge>}
                  </div>
                </div>
                <div className="body">
                  {lane.reasoning && <div className="reasoning">{lane.reasoning}</div>}
                  {lane.error ? (
                    <Notice level="err">{lane.error}</Notice>
                  ) : (
                    <Markdown text={lane.text} streaming={!lane.done} />
                  )}
                </div>
                <div className="foot">
                  {lane.ttftMs != null && <Badge title="Time to first token">TTFT {formatMs(lane.ttftMs)}</Badge>}
                  {lane.latencyMs != null && <Badge>{formatMs(lane.latencyMs)}</Badge>}
                  {lane.usage && (
                    <Badge>
                      {formatTokens(lane.usage.inputTokens)} in / {formatTokens(lane.usage.outputTokens)} out
                    </Badge>
                  )}
                  {lane.costUsd != null && <Badge tone="ok">{formatUsd(lane.costUsd)}</Badge>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
