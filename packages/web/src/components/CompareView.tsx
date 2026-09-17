import { useEffect, useRef, useState } from 'react';
import { streamSse, formatMs, formatTokens, formatUsd } from '../lib/api';
import type { ModelInfo } from '../lib/types';
import { Markdown } from './shared';
import { Badge, EmptyState, IconCompare, IconSend, IconStop, Notice, Spinner, providerColor } from './ui';

/**
 * Side-by-side comparison.
 *
 * Lanes stream concurrently over one SSE channel, so the columns fill at their
 * real relative speeds — which is most of what a comparison is for. Fallback is
 * disabled server-side for this endpoint: a comparison that silently substitutes
 * a different model is not a comparison.
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

const PRESETS = [
  'Explain the difference between a mutex and a semaphore in three sentences.',
  'Write a SQL query that finds the second-highest salary per department, and explain the edge cases.',
  'Summarise the trade-offs between optimistic and pessimistic locking for a booking system.',
];

export function CompareView({
  models,
  onUsageChanged,
  onStreamingChange,
}: {
  models: ModelInfo[];
  onUsageChanged: () => void;
  onStreamingChange: (streaming: boolean) => void;
}) {
  const available = models.filter((m) => m.kind === 'chat' && m.available);
  const [selected, setSelected] = useState<string[]>(available.slice(0, 2).map((m) => m.id));
  const [prompt, setPrompt] = useState(PRESETS[0]!);
  const [lanes, setLanes] = useState<Record<string, Lane>>({});
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => onStreamingChange(running), [running, onStreamingChange]);

  useEffect(() => {
    // Once the catalogue loads, pick two available models if nothing is chosen.
    if (!selected.length && available.length >= 2) setSelected(available.slice(0, 2).map((m) => m.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available.length]);

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : prev.length >= 4 ? prev : [...prev, id]));

  const run = async () => {
    if (selected.length < 2 || !prompt.trim()) return;
    setRunning(true);
    setError(null);
    setLanes(
      Object.fromEntries(
        selected.map((id, i) => [
          `lane${i + 1}`,
          {
            model: id,
            provider: models.find((m) => m.id === id)?.provider ?? '',
            text: '',
            reasoning: '',
            done: false,
          } satisfies Lane,
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
              case 'delta':
                next.text += event.event.text;
                break;
              case 'reasoning':
                next.reasoning += event.event.text;
                break;
              case 'usage':
                next.usage = event.event.usage;
                next.costUsd = event.event.costUsd;
                next.ttftMs = event.event.ttftMs;
                next.latencyMs = event.event.latencyMs;
                break;
              case 'done':
                next.done = true;
                break;
              case 'error':
                next.error = `${event.event.kind}: ${event.event.message}`;
                next.done = true;
                break;
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
  const firstToken =
    finished.length > 1 ? finished.reduce((a, b) => ((a.ttftMs ?? 1e9) <= (b.ttftMs ?? 1e9) ? a : b)) : null;

  return (
    <section className="canvas" style={{ gridColumn: '1 / -1' }}>
      <div className="canvas-scroll">
        <div className="canvas-inner wide">
          <div className="card">
            <div className="eyebrow" style={{ marginBottom: 6 }}>
              Prompt
            </div>
            <textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} disabled={running} />
            <div className="chips" style={{ marginTop: 'var(--s-2)' }}>
              {PRESETS.map((p, i) => (
                <button key={i} className="sm ghost" onClick={() => setPrompt(p)} disabled={running}>
                  Preset {i + 1}
                </button>
              ))}
            </div>

            <div className="eyebrow" style={{ margin: 'var(--s-4) 0 6px' }}>
              Models · pick 2 to 4
            </div>
            <div className="chips">
              {available.map((model) => (
                <button
                  key={model.id}
                  className={`model-chip${selected.includes(model.id) ? ' on' : ''}`}
                  onClick={() => toggle(model.id)}
                  disabled={running}
                >
                  <span className="swatch" style={{ '--dot': providerColor(model.provider) } as React.CSSProperties} />
                  {model.displayName}
                </button>
              ))}
            </div>

            {available.length < 2 && (
              <Notice level="warn">
                At least two providers need API keys for a comparison. Add them to <code>.env</code> and restart the
                server.
              </Notice>
            )}

            <div className="row" style={{ marginTop: 'var(--s-4)' }}>
              {running ? (
                <button className="danger" onClick={() => abortRef.current?.abort()}>
                  <IconStop size={14} /> Stop all
                </button>
              ) : (
                <button className="primary" onClick={() => void run()} disabled={selected.length < 2 || !prompt.trim()}>
                  <IconSend size={14} /> Run {selected.length} models concurrently
                </button>
              )}
              {error && <span className="sm" style={{ color: 'var(--c-err)' }}>{error}</span>}
              <div className="fill" />
              <span className="xs faint">Fallback is disabled here, so each lane reports its own failures.</span>
            </div>
          </div>

          {Object.keys(lanes).length === 0 ? (
            <EmptyState
              icon={<IconCompare size={20} />}
              title="Nothing to compare yet"
              hint="Pick two or more models and run the prompt. The columns stream in parallel, so latency differences are visible rather than inferred."
            />
          ) : (
            <div className="lanes">
              {Object.entries(lanes).map(([key, lane]) => (
                <div className="lane" key={key} style={{ '--edge': providerColor(lane.provider) } as React.CSSProperties}>
                  <div className="lane-head">
                    <div className="row between">
                      <div className="row" style={{ gap: 6, minWidth: 0 }}>
                        <span
                          className="provider-dot"
                          style={{ '--dot': providerColor(lane.provider) } as React.CSSProperties}
                        />
                        <strong className="sm truncate">{lane.model.split(':')[1] ?? lane.model}</strong>
                      </div>
                      {!lane.done && <Spinner />}
                    </div>
                    <div className="chips" style={{ marginTop: 6 }}>
                      {lane === fastest && <Badge tone="ok">fastest overall</Badge>}
                      {lane === firstToken && lane !== fastest && <Badge tone="accent">first token</Badge>}
                      {lane === cheapest && <Badge tone="ok">cheapest</Badge>}
                    </div>
                  </div>

                  <div className="lane-body">
                    {lane.reasoning && <div className="reasoning">{lane.reasoning}</div>}
                    {lane.error ? (
                      <Notice level="err">{lane.error}</Notice>
                    ) : (
                      <Markdown text={lane.text} streaming={!lane.done} />
                    )}
                  </div>

                  <div className="lane-foot">
                    <div className="chips">
                      {lane.ttftMs != null && <Badge title="Time to first token">TTFT {formatMs(lane.ttftMs)}</Badge>}
                      {lane.latencyMs != null && <Badge title="Total latency">{formatMs(lane.latencyMs)}</Badge>}
                      {lane.usage && (
                        <Badge title="Prompt / completion tokens">
                          {formatTokens(lane.usage.inputTokens)} → {formatTokens(lane.usage.outputTokens)}
                        </Badge>
                      )}
                      {lane.costUsd != null && <Badge tone="accent">{formatUsd(lane.costUsd)}</Badge>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
