import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, streamSse, ApiError, formatMs, formatUsd } from '../lib/api';
import type {
  Citation,
  Collection,
  Conversation,
  LiveTurn,
  ModelInfo,
  StoredMessage,
  ToolInvocation,
} from '../lib/types';
import { Badge, EmptyState, Markdown, ModelSelect, Notice, Spinner, UsageStrip } from './shared';

/**
 * Chat.
 *
 * The provider and model dropdowns are enabled DURING a conversation, not just
 * at the start: switching between messages is a hard requirement, and it works
 * because history is persisted in the neutral message format and replayed
 * through whichever adapter is selected next.
 */

interface Props {
  models: ModelInfo[];
  collections: Collection[];
  defaultModel: string;
  onUsageChanged: () => void;
}

export function ChatView({ models, collections, defaultModel, onUsageChanged }: Props) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [model, setModel] = useState(defaultModel);
  const [input, setInput] = useState('');
  const [useTools, setUseTools] = useState(true);
  const [useRag, setUseRag] = useState(false);
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState<Citation | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const selectedModel = models.find((m) => m.id === model);
  const streaming = live !== null;

  const loadConversations = useCallback(async () => {
    const res = await api<{ conversations: Conversation[] }>('/conversations');
    setConversations(res.conversations);
    return res.conversations;
  }, []);

  useEffect(() => {
    loadConversations()
      .then((list) => {
        if (!activeId && list[0]) setActiveId(list[0].id);
      })
      .catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!activeId) {
      setConversation(null);
      setMessages([]);
      return;
    }
    api<{ conversation: Conversation; messages: StoredMessage[] }>(`/conversations/${activeId}`)
      .then((res) => {
        setConversation(res.conversation);
        setMessages(res.messages);
        // Continue in whichever model last answered: switching is explicit.
        const last = [...res.messages].reverse().find((m) => m.modelId);
        if (last?.modelId && models.some((x) => x.id === last.modelId && x.available)) setModel(last.modelId);
        setUseRag(Boolean(res.conversation.collection_id));
      })
      .catch((e) => setError(e.message));
  }, [activeId, models]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, live?.text, live?.tools.length]);

  const createConversation = async (collectionId?: string | null) => {
    const res = await api<{ conversation: Conversation }>('/conversations', {
      method: 'POST',
      body: JSON.stringify({ title: 'New conversation', collectionId: collectionId ?? null }),
    });
    await loadConversations();
    setActiveId(res.conversation.id);
    setMessages([]);
  };

  const removeConversation = async (id: string) => {
    await api(`/conversations/${id}`, { method: 'DELETE' });
    const list = await loadConversations();
    if (activeId === id) setActiveId(list[0]?.id ?? null);
  };

  const attachCollection = async (collectionId: string) => {
    if (!conversation) return;
    const res = await api<{ conversation: Conversation }>(`/conversations/${conversation.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ collectionId: collectionId || null }),
    });
    setConversation(res.conversation);
    setUseRag(Boolean(res.conversation.collection_id));
  };

  /** Cancel: aborts the fetch, which closes the socket, which aborts upstream. */
  const stop = () => abortRef.current?.abort();

  const send = async () => {
    const text = input.trim();
    if (!text || streaming) return;

    let conversationId = activeId;
    if (!conversationId) {
      const res = await api<{ conversation: Conversation }>('/conversations', {
        method: 'POST',
        body: JSON.stringify({ title: text.slice(0, 80) }),
      });
      conversationId = res.conversation.id;
      setActiveId(conversationId);
      setConversation(res.conversation);
      await loadConversations();
    }

    setError(null);
    setInput('');
    setMessages((prev) => [
      ...prev,
      {
        id: `local-${Date.now()}`,
        seq: prev.length,
        role: 'user',
        content: [{ type: 'text', text }],
        createdAt: new Date().toISOString(),
      },
    ]);

    const turn: LiveTurn = {
      text: '', reasoning: '', notices: [], tools: [], citations: [],
      model, provider: selectedModel?.provider ?? '', costUsd: 0, ttftMs: null, latencyMs: null,
    };
    setLive({ ...turn });

    const controller = new AbortController();
    abortRef.current = controller;

    const patch = (fn: (draft: LiveTurn) => void) =>
      setLive((prev) => {
        if (!prev) return prev;
        const next = { ...prev, tools: [...prev.tools], notices: [...prev.notices] };
        fn(next);
        return next;
      });

    try {
      await streamSse(
        `/conversations/${conversationId}/messages`,
        { text, model, useTools, useRag, maxTokens: 2048 },
        (event) => {
          switch (event.type) {
            case 'meta':
              patch((d) => {
                d.model = event.model;
                d.provider = event.provider;
                if (event.fallbackFrom) d.fallbackFrom = event.fallbackFrom;
              });
              break;
            case 'notice':
              patch((d) => d.notices.push({ level: event.level, code: event.code, message: event.message }));
              break;
            case 'retry':
              patch((d) =>
                d.notices.push({
                  level: 'warn',
                  code: 'retry',
                  message: `Retry ${event.attempt} after ${event.kind} — waiting ${formatMs(event.delayMs)}.`,
                }),
              );
              break;
            case 'fallback':
              patch((d) =>
                d.notices.push({
                  level: 'warn',
                  code: 'fallback',
                  message: `${event.from} failed with ${event.kind}; falling back to ${event.to}.`,
                }),
              );
              break;
            case 'delta':
              patch((d) => { d.text += event.text; });
              break;
            case 'reasoning':
              patch((d) => { d.reasoning += event.text; });
              break;
            case 'tool_args_delta':
              patch((d) => {
                const existing = d.tools.find((t) => t.id === event.id);
                if (existing) existing.argsPreview += event.partialJson;
                else d.tools.push({ id: event.id, name: '…', argsPreview: event.partialJson, status: 'streaming' });
              });
              break;
            case 'tool_call':
              patch((d) => {
                const existing = d.tools.find((t) => t.id === event.id);
                const shaped: ToolInvocation = {
                  id: event.id,
                  name: event.name,
                  argsPreview: JSON.stringify(event.input, null, 2),
                  input: event.input,
                  status: 'running',
                };
                if (existing) Object.assign(existing, shaped);
                else d.tools.push(shaped);
              });
              break;
            case 'tool_result':
              patch((d) => {
                const tool = d.tools.find((t) => t.id === event.id);
                if (tool) {
                  tool.status = event.ok ? 'ok' : 'error';
                  tool.result = event.preview;
                  tool.durationMs = event.durationMs;
                  tool.name = event.name;
                }
              });
              break;
            case 'citations':
              patch((d) => { d.citations = event.citations; });
              break;
            case 'usage':
              patch((d) => {
                d.usage = event.usage;
                d.costUsd += event.costUsd;
                if (d.ttftMs === null) d.ttftMs = event.ttftMs;
                d.latencyMs = (d.latencyMs ?? 0) + event.latencyMs;
                if (event.cacheHit) d.cacheHit = true;
              });
              break;
            case 'error':
              patch((d) => {
                d.error = { kind: event.kind, message: event.message, provider: event.provider, retryable: event.retryable };
              });
              break;
            default:
              break;
          }
        },
        controller.signal,
      );
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError(err instanceof ApiError ? err.message : (err as Error).message);
      }
    } finally {
      abortRef.current = null;
      setLive(null);
      // Re-read from the server so what is shown is what was persisted.
      const fresh = await api<{ conversation: Conversation; messages: StoredMessage[] }>(`/conversations/${conversationId}`).catch(() => null);
      if (fresh) {
        setConversation(fresh.conversation);
        setMessages(fresh.messages);
      }
      loadConversations().catch(() => {});
      onUsageChanged();
    }
  };

  const toolsUnsupported = selectedModel && !selectedModel.capabilities.tools;

  return (
    <>
      <aside className="sidebar">
        <button className="primary" style={{ width: '100%' }} onClick={() => createConversation(conversation?.collection_id)}>
          New conversation
        </button>
        <div className="section-title">Conversations</div>
        {conversations.length === 0 && <div className="small faint">No conversations yet.</div>}
        {conversations.map((c) => (
          <div key={c.id} className="row" style={{ gap: 2 }}>
            <button className={`list-item grow ${c.id === activeId ? 'active' : ''}`} onClick={() => setActiveId(c.id)}>
              <div className="truncate">{c.title}</div>
              <div className="small faint">
                {c.message_count ?? 0} messages{c.collection_id ? ' · RAG' : ''}
              </div>
            </button>
            <button className="ghost danger" title="Delete" onClick={() => removeConversation(c.id)}>
              ×
            </button>
          </div>
        ))}
      </aside>

      <section className="panel">
        <div className="scroll" ref={scrollRef}>
          {messages.length === 0 && !live && (
            <EmptyState
              title="Ask something."
              hint="Switch provider or model between messages — the conversation continues coherently."
            />
          )}

          {messages.map((message) => (
            <MessageView key={message.id} message={message} onCitation={setInspecting} />
          ))}

          {live && <LiveTurnView turn={live} onCitation={setInspecting} />}

          {error && <Notice level="err">{error}</Notice>}
        </div>

        <div className="composer">
          <textarea
            value={input}
            placeholder={streaming ? 'Streaming…' : 'Message (Enter to send, Shift+Enter for a newline)'}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            disabled={streaming}
          />
          <div className="controls">
            <ModelSelect models={models} value={model} onChange={setModel} />

            <label title={toolsUnsupported ? 'This model has no tool calling; Polyglot will say so and answer without tools.' : ''}>
              <input type="checkbox" checked={useTools} onChange={(e) => setUseTools(e.target.checked)} />
              Tools
              {toolsUnsupported && <Badge tone="warn">unsupported</Badge>}
            </label>

            <label title={conversation?.collection_id ? 'Retrieve from the attached collection before answering.' : 'Attach a collection first.'}>
              <input
                type="checkbox"
                checked={useRag}
                disabled={!conversation?.collection_id}
                onChange={(e) => setUseRag(e.target.checked)}
              />
              RAG
            </label>

            <select
              value={conversation?.collection_id ?? ''}
              onChange={(e) => void attachCollection(e.target.value)}
              disabled={!conversation}
              style={{ width: 'auto', minWidth: 160 }}
            >
              <option value="">No collection</option>
              {collections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>

            <div className="grow" />
            {streaming ? (
              <button className="danger" onClick={stop} title="Aborts the upstream provider request, not just the render">
                Stop
              </button>
            ) : (
              <button className="primary" onClick={() => void send()} disabled={!input.trim()}>
                Send
              </button>
            )}
          </div>
        </div>
      </section>

      <aside className="inspector">
        <CitationInspector citation={inspecting} onClose={() => setInspecting(null)} model={selectedModel} />
      </aside>
    </>
  );
}

function MessageView({ message, onCitation }: { message: StoredMessage; onCitation: (c: Citation) => void }) {
  if (message.role === 'tool') return null; // rendered inside the assistant turn

  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  const toolUses = message.content.filter((b) => b.type === 'tool_use');
  if (!text && !toolUses.length) return null;

  return (
    <div className={`message ${message.role}`}>
      <div className="who">{message.role === 'user' ? 'You' : message.modelId ?? 'Assistant'}</div>
      <div className="bubble">
        {message.reasoning && <div className="reasoning">{message.reasoning}</div>}
        {toolUses.map((block) => (
          <div className="tool-card" key={block.toolUseId ?? block.name}>
            <div className="head">
              <Badge>tool</Badge>
              <strong>{block.name}</strong>
            </div>
            <div className="body">{JSON.stringify(block.input ?? {}, null, 2)}</div>
          </div>
        ))}
        {message.role === 'user' ? text : <Markdown text={text} citations={message.citations} onCitation={onCitation} />}
        {message.citations?.length ? (
          <div className="meta-strip">
            {message.citations.map((c) => (
              <button key={c.chunkId} className="badge accent" onClick={() => onCitation(c)}>
                [{c.number}] {c.filename}
                {c.page ? ` p${c.page}` : ''}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function LiveTurnView({ turn, onCitation }: { turn: LiveTurn; onCitation: (c: Citation) => void }) {
  return (
    <div className="message assistant">
      <div className="who">
        {turn.model} <Spinner />
      </div>
      <div className="bubble">
        {turn.notices.map((notice, i) => (
          <Notice key={i} level={notice.level}>
            {notice.message}
          </Notice>
        ))}

        {turn.reasoning && <div className="reasoning">{turn.reasoning}</div>}

        {turn.tools.map((tool) => (
          <div className="tool-card" key={tool.id}>
            <div className="head">
              <Badge tone={tool.status === 'error' ? 'err' : tool.status === 'ok' ? 'ok' : 'accent'}>
                {tool.status === 'streaming' ? 'receiving args' : tool.status}
              </Badge>
              <strong>{tool.name}</strong>
              {tool.durationMs != null && <span className="small faint">{formatMs(tool.durationMs)}</span>}
            </div>
            <div className="body">{tool.argsPreview || '…'}</div>
            {tool.result && <div className="body result">{tool.result}</div>}
          </div>
        ))}

        {turn.text ? (
          <Markdown text={turn.text} streaming citations={turn.citations} onCitation={onCitation} />
        ) : (
          !turn.tools.length && <span className="faint cursor" />
        )}

        {turn.error && (
          <Notice level="err">
            <strong>{turn.error.kind}</strong> — {turn.error.message}
            {turn.error.retryable && ' (retryable)'}
          </Notice>
        )}

        <UsageStrip
          provider={turn.provider}
          model={turn.model}
          ttftMs={turn.ttftMs}
          latencyMs={turn.latencyMs}
          usage={turn.usage}
          costUsd={turn.costUsd}
          fallbackFrom={turn.fallbackFrom}
          cacheHit={turn.cacheHit}
          toolCount={turn.tools.length}
        />
      </div>
    </div>
  );
}

function CitationInspector({
  citation,
  onClose,
  model,
}: {
  citation: Citation | null;
  onClose: () => void;
  model?: ModelInfo;
}) {
  if (!citation) {
    return (
      <>
        <div className="section-title">Selected model</div>
        {model ? (
          <div className="card">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <strong>{model.displayName}</strong>
              <Badge tone={model.available ? 'ok' : 'err'}>{model.available ? 'ready' : 'no key'}</Badge>
            </div>
            <dl className="kv" style={{ marginTop: 10 }}>
              <dt>Provider</dt>
              <dd>{model.provider}</dd>
              <dt>Context</dt>
              <dd>{model.contextWindow.toLocaleString()} tokens</dd>
              <dt>Max output</dt>
              <dd>{model.maxOutputTokens?.toLocaleString() ?? '—'}</dd>
              <dt>Input</dt>
              <dd>${model.pricing.inputPerMTok}/MTok</dd>
              <dt>Output</dt>
              <dd>${model.pricing.outputPerMTok}/MTok</dd>
              {model.pricing.cachedInputPerMTok !== undefined && (
                <>
                  <dt>Cached in</dt>
                  <dd>${model.pricing.cachedInputPerMTok}/MTok</dd>
                </>
              )}
            </dl>
            <div className="meta-strip">
              {model.capabilities.tools && <Badge>tools</Badge>}
              {model.capabilities.vision && <Badge>vision</Badge>}
              {model.capabilities.jsonSchema && <Badge>json schema</Badge>}
              {model.capabilities.reasoning && <Badge>reasoning</Badge>}
              {model.capabilities.promptCaching && <Badge>prompt caching</Badge>}
            </div>
          </div>
        ) : (
          <div className="small faint">No model selected.</div>
        )}
        <div className="section-title">Citations</div>
        <div className="small faint">
          Click a <span className="cite">1</span> marker in an answer to see the exact chunk it came from.
        </div>
      </>
    );
  }

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="section-title" style={{ margin: 0 }}>
          Retrieved chunk [{citation.number}]
        </div>
        <button className="ghost" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="card">
        <dl className="kv">
          <dt>Source</dt>
          <dd>{citation.filename}</dd>
          {citation.page && (
            <>
              <dt>Page</dt>
              <dd>{citation.page}</dd>
            </>
          )}
          {citation.heading && (
            <>
              <dt>Section</dt>
              <dd>{citation.heading}</dd>
            </>
          )}
          <dt>Score</dt>
          <dd>{citation.score.toFixed(4)}</dd>
          <dt>Chunk id</dt>
          <dd className="mono truncate">{citation.chunkId}</dd>
        </dl>
      </div>
      <div className="section-title">Chunk text, verbatim</div>
      <div className="chunk-preview">{citation.text}</div>
      <div className="small faint" style={{ marginTop: 10 }}>
        This is exactly what the model was shown for this citation, inside an untrusted-content block.
      </div>
    </>
  );
}

export { formatUsd };
