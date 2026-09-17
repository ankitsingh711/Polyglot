import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Citation, ModelInfo } from '../lib/types';
import { formatMs, formatTokens, formatUsd } from '../lib/api';
import { Badge, IconChevron, providerColor } from './ui';

export { Badge, Notice, Spinner, EmptyState, Stat, CopyButton } from './ui';

/* ===========================================================================
   Streaming markdown
   =========================================================================== */

/**
 * Close constructs the stream has opened but not yet finished.
 *
 * Mid-stream the text routinely ends inside an unclosed fence or a half-written
 * bold run, and a markdown renderer will either swallow the rest of the message
 * or flash mis-styled text on every token. Debouncing hides it but makes
 * streaming feel laggy, so instead we balance a COPY of the text before
 * rendering. The stored message is never modified.
 */
function balanceMarkdown(text: string): string {
  let out = text;

  if (((out.match(/^```/gm) ?? []).length) % 2 === 1) out += '\n```';
  if (((out.match(/(?<!`)`(?!`)/g) ?? []).length) % 2 === 1) out += '`';
  if (((out.match(/\*\*/g) ?? []).length) % 2 === 1) out += '**';

  // A trailing half-typed link renders as literal noise, so hold it back until
  // the closing paren arrives.
  const openLink = /\[[^\]]*\]\([^)]*$/.exec(out);
  if (openLink) out = out.slice(0, openLink.index);

  return out;
}

/**
 * Markdown with `[n]` citation markers turned into clickable chips.
 *
 * The substitution runs on TEXT nodes only, so a `[1]` inside a code block stays
 * literal — which matters when the answer is about citation syntax itself.
 */
export function Markdown({
  text,
  streaming,
  citations,
  onCitation,
  activeCitation,
}: {
  text: string;
  streaming?: boolean;
  citations?: Citation[];
  onCitation?: (citation: Citation) => void;
  activeCitation?: string | null;
}) {
  const body = useMemo(() => (streaming ? balanceMarkdown(text) : text), [text, streaming]);
  const byNumber = useMemo(() => new Map((citations ?? []).map((c) => [c.number, c])), [citations]);

  const renderText = (value: string): React.ReactNode => {
    if (!byNumber.size) return value;
    return value.split(/(\[\d{1,2}\])/g).map((part, i) => {
      const match = /^\[(\d{1,2})\]$/.exec(part);
      const citation = match ? byNumber.get(Number(match[1])) : undefined;
      if (!citation) return part;
      return (
        <button
          key={i}
          className={`cite${activeCitation === citation.chunkId ? ' active' : ''}`}
          title={`${citation.filename}${citation.page ? `, page ${citation.page}` : ''} — click to read the source`}
          onClick={() => onCitation?.(citation)}
        >
          {citation.number}
        </button>
      );
    });
  };

  const map = (children: React.ReactNode): React.ReactNode =>
    Array.isArray(children)
      ? children.map((child, i) => (typeof child === 'string' ? <span key={i}>{renderText(child)}</span> : child))
      : typeof children === 'string'
        ? renderText(children)
        : children;

  return (
    <div className={`md${streaming ? ' streaming-caret' : ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p>{map(children)}</p>,
          li: ({ children }) => <li>{map(children)}</li>,
          td: ({ children }) => <td>{map(children)}</td>,
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer nofollow">
              {children}
            </a>
          ),
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

/* ===========================================================================
   Model picker
   =========================================================================== */

export function ModelSelect({
  models,
  value,
  onChange,
  kind = 'chat',
  disabled,
  compact,
}: {
  models: ModelInfo[];
  value: string;
  onChange: (id: string) => void;
  kind?: 'chat' | 'embedding';
  disabled?: boolean;
  compact?: boolean;
}) {
  const grouped = useMemo(() => {
    const groups = new Map<string, ModelInfo[]>();
    for (const model of models.filter((m) => m.kind === kind)) {
      const list = groups.get(model.provider) ?? [];
      list.push(model);
      groups.set(model.provider, list);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [models, kind]);

  const selected = models.find((m) => m.id === value);

  return (
    <div className="row" style={{ gap: 6, minWidth: 0 }}>
      <span
        className="provider-dot"
        style={{ '--dot': providerColor(selected?.provider) } as React.CSSProperties}
        title={selected?.provider}
      />
      <select
        className="auto"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        title={selected ? `${selected.displayName} — ${selected.contextWindow.toLocaleString()} token context` : undefined}
        style={{ maxWidth: compact ? 190 : 240, fontSize: 'var(--t-sm)' }}
      >
        {grouped.map(([provider, list]) => (
          <optgroup key={provider} label={provider}>
            {list.map((model) => (
              // Unconfigured providers stay visible but unselectable: hiding them
              // turns "why can't I see Gemini?" into a support question.
              <option key={model.id} value={model.id} disabled={!model.available}>
                {model.displayName}
                {model.available ? '' : ' · no key'}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

/* ===========================================================================
   Telemetry strip
   =========================================================================== */

export function UsageStrip({
  provider,
  model,
  ttftMs,
  latencyMs,
  usage,
  costUsd,
  fallbackFrom,
  cacheHit,
  toolCount,
}: {
  provider?: string;
  model?: string;
  ttftMs?: number | null;
  latencyMs?: number | null;
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number; reasoningTokens?: number };
  costUsd?: number;
  fallbackFrom?: string;
  cacheHit?: boolean;
  toolCount?: number;
}) {
  return (
    <div className="chips" style={{ marginTop: 'var(--s-3)' }}>
      {model && (
        <Badge tone="default" title={`Served by ${provider}`}>
          <span className="dot" style={{ background: providerColor(provider) }} />
          {model.split(':')[1] ?? model}
        </Badge>
      )}
      {fallbackFrom && (
        <Badge tone="warn" title={`Primary was ${fallbackFrom}; it failed and Polyglot fell back.`}>
          fallback
        </Badge>
      )}
      {cacheHit && <Badge tone="ok" title="Served from the semantic cache">cached answer</Badge>}
      {ttftMs != null && <Badge title="Time to first token">TTFT {formatMs(ttftMs)}</Badge>}
      {latencyMs != null && <Badge title="Total latency for this turn">{formatMs(latencyMs)}</Badge>}
      {usage && (
        <Badge title="Prompt / completion tokens as reported by the provider">
          {formatTokens(usage.inputTokens)} → {formatTokens(usage.outputTokens)}
        </Badge>
      )}
      {usage?.cachedInputTokens ? (
        <Badge tone="ok" title="Prompt tokens served from the provider's own cache">
          {formatTokens(usage.cachedInputTokens)} cached
        </Badge>
      ) : null}
      {usage?.reasoningTokens ? (
        <Badge title="Reasoning tokens — billed as output">{formatTokens(usage.reasoningTokens)} reasoning</Badge>
      ) : null}
      {toolCount ? <Badge title="Tool calls in this turn">{toolCount} tool{toolCount === 1 ? '' : 's'}</Badge> : null}
      {costUsd != null && (
        <Badge tone="accent" title="Computed from config/models.json and the provider's reported usage">
          {formatUsd(costUsd)}
        </Badge>
      )}
    </div>
  );
}

/* ===========================================================================
   Collapsible
   =========================================================================== */

export function Collapsible({
  title,
  badge,
  defaultOpen,
  children,
}: {
  title: React.ReactNode;
  badge?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  return (
    <div className="tool">
      <button className="tool-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {title}
        {badge}
        <IconChevron size={14} className={`chev${open ? ' open' : ''}`} />
      </button>
      {open && children}
    </div>
  );
}
