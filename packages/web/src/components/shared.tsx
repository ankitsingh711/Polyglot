import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Citation, ModelInfo } from '../lib/types';
import { formatMs, formatTokens, formatUsd } from '../lib/api';

export function Badge({
  children,
  tone = 'default',
  title,
}: {
  children: React.ReactNode;
  tone?: 'default' | 'ok' | 'warn' | 'err' | 'accent';
  title?: string;
}) {
  return (
    <span className={`badge ${tone === 'default' ? '' : tone}`} title={title}>
      {children}
    </span>
  );
}

export function Notice({ level, children }: { level: 'info' | 'warn' | 'err'; children: React.ReactNode }) {
  return <div className={`notice ${level}`}>{children}</div>;
}

/**
 * Streaming markdown that does not break on partial tokens.
 *
 * The problem: mid-stream the text often ends inside an unclosed fence or a
 * half-written bold run, and a markdown renderer will either swallow the rest of
 * the message or flash mis-styled text on every token. Rather than debounce
 * (which makes streaming feel laggy) we close the open constructs in a COPY of
 * the text before rendering. The underlying message is untouched.
 */
function balanceMarkdown(text: string): string {
  let out = text;

  const fences = (out.match(/^```/gm) ?? []).length;
  if (fences % 2 === 1) out += '\n```';

  // Inline code, then bold, then italic — closing the outermost first.
  const ticks = (out.match(/(?<!`)`(?!`)/g) ?? []).length;
  if (ticks % 2 === 1) out += '`';

  const bold = (out.match(/\*\*/g) ?? []).length;
  if (bold % 2 === 1) out += '**';

  // A trailing incomplete link "[text](htt" renders as literal noise.
  const openLink = /\[[^\]]*\]\([^)]*$/.exec(out);
  if (openLink) out = out.slice(0, openLink.index);

  return out;
}

/**
 * Render markdown with `[n]` citation markers turned into clickable chips.
 * The split happens on the TEXT nodes only, so a `[1]` inside a code block stays
 * literal, which matters when the answer is about the citation syntax itself.
 */
export function Markdown({
  text,
  streaming,
  citations,
  onCitation,
}: {
  text: string;
  streaming?: boolean;
  citations?: Citation[];
  onCitation?: (citation: Citation) => void;
}) {
  const body = useMemo(() => (streaming ? balanceMarkdown(text) : text), [text, streaming]);
  const byNumber = useMemo(() => new Map((citations ?? []).map((c) => [c.number, c])), [citations]);

  const renderText = (value: string): React.ReactNode => {
    if (!byNumber.size) return value;
    const parts = value.split(/(\[\d{1,2}\])/g);
    return parts.map((part, i) => {
      const match = /^\[(\d{1,2})\]$/.exec(part);
      const citation = match ? byNumber.get(Number(match[1])) : undefined;
      if (!citation) return part;
      return (
        <button
          key={i}
          className="cite"
          title={`${citation.filename}${citation.page ? `, page ${citation.page}` : ''}`}
          onClick={() => onCitation?.(citation)}
        >
          {citation.number}
        </button>
      );
    });
  };

  return (
    <div className={`markdown ${streaming ? 'cursor' : ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p>{mapChildren(children, renderText)}</p>,
          li: ({ children }) => <li>{mapChildren(children, renderText)}</li>,
          td: ({ children }) => <td>{mapChildren(children, renderText)}</td>,
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

function mapChildren(children: React.ReactNode, render: (value: string) => React.ReactNode): React.ReactNode {
  return Array.isArray(children)
    ? children.map((child, i) =>
        typeof child === 'string' ? <span key={i}>{render(child)}</span> : child,
      )
    : typeof children === 'string'
      ? render(children)
      : children;
}

export function ModelSelect({
  models,
  value,
  onChange,
  kind = 'chat',
  disabled,
}: {
  models: ModelInfo[];
  value: string;
  onChange: (id: string) => void;
  kind?: 'chat' | 'embedding';
  disabled?: boolean;
}) {
  const byProvider = useMemo(() => {
    const groups = new Map<string, ModelInfo[]>();
    for (const model of models.filter((m) => m.kind === kind)) {
      const list = groups.get(model.provider) ?? [];
      list.push(model);
      groups.set(model.provider, list);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [models, kind]);

  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} style={{ width: 'auto', minWidth: 230 }}>
      {byProvider.map(([provider, list]) => (
        <optgroup key={provider} label={provider}>
          {list.map((model) => (
            // Unconfigured providers stay visible but unselectable: hiding them
            // makes "why can't I see Gemini?" a support question.
            <option key={model.id} value={model.id} disabled={!model.available}>
              {model.displayName}
              {model.available ? '' : ' — no API key'}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

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
    <div className="meta-strip">
      {model && <Badge tone="accent" title={provider}>{model}</Badge>}
      {fallbackFrom && <Badge tone="warn" title={`Primary was ${fallbackFrom}`}>fallback</Badge>}
      {cacheHit && <Badge tone="ok">cache hit</Badge>}
      {ttftMs != null && <Badge title="Time to first token">TTFT {formatMs(ttftMs)}</Badge>}
      {latencyMs != null && <Badge title="Total latency">{formatMs(latencyMs)}</Badge>}
      {usage && (
        <Badge title="Input / output tokens">
          {formatTokens(usage.inputTokens)} in / {formatTokens(usage.outputTokens)} out
        </Badge>
      )}
      {usage?.cachedInputTokens ? <Badge tone="ok" title="Tokens served from the provider cache">{formatTokens(usage.cachedInputTokens)} cached</Badge> : null}
      {usage?.reasoningTokens ? <Badge title="Reasoning tokens (billed as output)">{formatTokens(usage.reasoningTokens)} reasoning</Badge> : null}
      {toolCount ? <Badge>{toolCount} tool call{toolCount === 1 ? '' : 's'}</Badge> : null}
      {costUsd != null && <Badge tone="ok" title="Computed from config/models.json">{formatUsd(costUsd)}</Badge>}
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" aria-label="loading" />;
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty">
      <div>{title}</div>
      {hint && <div className="small faint" style={{ marginTop: 6 }}>{hint}</div>}
    </div>
  );
}
