import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, streamSse, ApiError, formatMs, formatUsd, formatTokens } from '../lib/api';
import type {
  Citation,
  Collection,
  Conversation,
  LiveTurn,
  ModelInfo,
  StoredMessage,
  ToolInvocation,
} from '../lib/types';
import { Markdown, ModelSelect, UsageStrip } from './shared';
import {
  Badge,
  CopyButton,
  EmptyState,
  IconChat,
  IconChevron,
  IconClose,
  IconPlus,
  IconSearch,
  IconSend,
  IconSources,
  IconSpark,
  IconStop,
  IconTool,
  IconTrash,
  Notice,
  Spinner,
  providerColor,
  useAutosize,
  useStickyScroll,
} from './ui';

/**
 * Chat.
 *
 * The model picker stays enabled mid-conversation, because switching provider
 * between messages is a requirement rather than a setting — it works because
 * history is persisted in the provider-agnostic format and replayed through
 * whichever adapter is selected next.
 */

interface Props {
  models: ModelInfo[];
  collections: Collection[];
  model: string;
  onModelChange: (id: string) => void;
  onUsageChanged: () => void;
  onStreamingChange: (streaming: boolean) => void;
  onError: (message: string) => void;
  /** Reveal the details panel — a citation is useless if its panel is hidden. */
  onInspect: () => void;
  noProviderKeys: boolean;
}

type InspectorTab = 'source' | 'model';

export function ChatView({
  models,
  collections,
  model,
  onModelChange,
  onUsageChanged,
  onStreamingChange,
  onError,
  onInspect,
  noProviderKeys,
}: Props) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [filter, setFilter] = useState('');
  const [input, setInput] = useState('');
  const [useTools, setUseTools] = useState(true);
  const [useRag, setUseRag] = useState(false);
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [inspecting, setInspecting] = useState<Citation | null>(null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('model');
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useAutosize(input);

  const selectedModel = models.find((m) => m.id === model);
  const streaming = live !== null;
  const scroll = useStickyScroll([messages.length, live?.text, live?.tools.length]);

  useEffect(() => onStreamingChange(streaming), [streaming, onStreamingChange]);

  const loadConversations = useCallback(async () => {
    const res = await api<{ conversations: Conversation[] }>('/conversations');
    setConversations(res.conversations);
    return res.conversations;
  }, []);

  useEffect(() => {
    loadConversations()
      .then((list) => setActiveId((current) => current ?? list[0]?.id ?? null))
      .catch((e) => onError((e as Error).message));
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
        // Continue in whichever model last answered; switching stays explicit.
        const last = [...res.messages].reverse().find((m) => m.modelId);
        if (last?.modelId && models.some((x) => x.id === last.modelId && x.available)) onModelChange(last.modelId);
        setUseRag(Boolean(res.conversation.collection_id));
        setInspecting(null);
      })
      .catch((e) => onError((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const grouped = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const list = query ? conversations.filter((c) => c.title.toLowerCase().includes(query)) : conversations;
    const today: Conversation[] = [];
    const week: Conversation[] = [];
    const older: Conversation[] = [];
    const now = Date.now();
    for (const c of list) {
      const age = now - new Date(c.updated_at).getTime();
      if (age < 86_400_000) today.push(c);
      else if (age < 604_800_000) week.push(c);
      else older.push(c);
    }
    return [
      { label: 'Today', items: today },
      { label: 'Past week', items: week },
      { label: 'Older', items: older },
    ].filter((g) => g.items.length);
  }, [conversations, filter]);

  const createConversation = async (collectionId?: string | null) => {
    try {
      const res = await api<{ conversation: Conversation }>('/conversations', {
        method: 'POST',
        body: JSON.stringify({ title: 'New conversation', collectionId: collectionId ?? null }),
      });
      await loadConversations();
      setActiveId(res.conversation.id);
      setMessages([]);
      textareaRef.current?.focus();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const removeConversation = async (id: string) => {
    try {
      await api(`/conversations/${id}`, { method: 'DELETE' });
      const list = await loadConversations();
      if (activeId === id) setActiveId(list[0]?.id ?? null);
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const attachCollection = async (collectionId: string) => {
    if (!conversation) return;
    try {
      const res = await api<{ conversation: Conversation }>(`/conversations/${conversation.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ collectionId: collectionId || null }),
      });
      setConversation(res.conversation);
      setUseRag(Boolean(res.conversation.collection_id));
    } catch (e) {
      onError((e as Error).message);
    }
  };

  /** Stop: aborts the fetch → closes the socket → aborts the upstream request. */
  const stop = () => abortRef.current?.abort();

  const send = async () => {
    const text = input.trim();
    if (!text || streaming) return;

    let conversationId = activeId;
    if (!conversationId) {
      try {
        const res = await api<{ conversation: Conversation }>('/conversations', {
          method: 'POST',
          body: JSON.stringify({ title: text.slice(0, 80) }),
        });
        conversationId = res.conversation.id;
        setActiveId(conversationId);
        setConversation(res.conversation);
        await loadConversations();
      } catch (e) {
        onError((e as Error).message);
        return;
      }
    }

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

    setLive({
      text: '',
      reasoning: '',
      notices: [],
      tools: [],
      citations: [],
      model,
      provider: selectedModel?.provider ?? '',
      costUsd: 0,
      ttftMs: null,
      latencyMs: null,
    });

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
                  message: `Attempt ${event.attempt} failed with ${event.kind}. Retrying in ${formatMs(event.delayMs)}.`,
                }),
              );
              break;
            case 'fallback':
              patch((d) =>
                d.notices.push({
                  level: 'warn',
                  code: 'fallback',
                  message: `${event.from} failed with ${event.kind}. Falling back to ${event.to}.`,
                }),
              );
              break;
            case 'delta':
              patch((d) => {
                d.text += event.text;
              });
              break;
            case 'reasoning':
              patch((d) => {
                d.reasoning += event.text;
              });
              break;
            case 'tool_args_delta':
              patch((d) => {
                const existing = d.tools.find((t) => t.id === event.id);
                if (existing) existing.argsPreview += event.partialJson;
                else d.tools.push({ id: event.id, name: 'preparing…', argsPreview: event.partialJson, status: 'streaming' });
              });
              break;
            case 'tool_call':
              patch((d) => {
                const shaped: ToolInvocation = {
                  id: event.id,
                  name: event.name,
                  argsPreview: JSON.stringify(event.input, null, 2),
                  input: event.input,
                  status: 'running',
                };
                const existing = d.tools.find((t) => t.id === event.id);
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
              patch((d) => {
                d.citations = event.citations;
              });
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
                d.error = {
                  kind: event.kind,
                  message: event.message,
                  provider: event.provider,
                  retryable: event.retryable,
                };
              });
              onError(`${event.kind}: ${event.message}`);
              break;
            default:
              break;
          }
        },
        controller.signal,
      );
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        onError(err instanceof ApiError ? err.message : (err as Error).message);
      }
    } finally {
      abortRef.current = null;
      setLive(null);
      // Re-read from the server so what is shown is what was persisted.
      const fresh = await api<{ conversation: Conversation; messages: StoredMessage[] }>(
        `/conversations/${conversationId}`,
      ).catch(() => null);
      if (fresh) {
        setConversation(fresh.conversation);
        setMessages(fresh.messages);
      }
      loadConversations().catch(() => {});
      onUsageChanged();
    }
  };

  const toolsUnsupported = Boolean(selectedModel && !selectedModel.capabilities.tools);

  const openCitation = (citation: Citation) => {
    setInspecting(citation);
    setInspectorTab('source');
    onInspect();
  };

  return (
    <>
      <aside className="context">
        <div className="context-head">
          <button className="primary block" onClick={() => void createConversation(conversation?.collection_id)}>
            <IconPlus size={15} /> New conversation
          </button>
          <div style={{ position: 'relative' }}>
            <span style={{ position: 'absolute', left: 10, top: 9, color: 'var(--c-ink-4)', pointerEvents: 'none' }}>
              <IconSearch size={14} />
            </span>
            <input
              type="search"
              value={filter}
              placeholder="Search conversations"
              onChange={(e) => setFilter(e.target.value)}
              style={{ paddingLeft: 30, fontSize: 'var(--t-sm)' }}
            />
          </div>
        </div>

        <div className="context-body">
          {conversations.length === 0 && <div className="sm faint" style={{ padding: 10 }}>No conversations yet.</div>}
          {grouped.map((group) => (
            <div className="list-group" key={group.label}>
              <div className="eyebrow">{group.label}</div>
              {group.items.map((c) => (
                <div className="list-item-wrap" key={c.id}>
                  <button
                    className={`list-row fill${c.id === activeId ? ' active' : ''}`}
                    onClick={() => setActiveId(c.id)}
                  >
                    <span className="fill" style={{ minWidth: 0 }}>
                      <span className="title truncate" style={{ display: 'block' }}>
                        {c.title}
                      </span>
                      <span className="sub">
                        {c.message_count ?? 0} message{(c.message_count ?? 0) === 1 ? '' : 's'}
                        {c.collection_id ? ' · grounded' : ''}
                      </span>
                    </span>
                  </button>
                  <button
                    className="ghost icon hover-reveal"
                    title="Delete conversation"
                    onClick={() => void removeConversation(c.id)}
                  >
                    <IconTrash size={14} />
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      </aside>

      <section className="canvas">
        <div className="canvas-scroll" ref={scroll.ref} onScroll={scroll.onScroll}>
          <div className="canvas-inner">
            {messages.length === 0 && !live ? (
              <EmptyState
                icon={<IconSpark size={20} />}
                title={noProviderKeys ? 'Add a provider key to start chatting' : 'Ask anything'}
                hint={
                  noProviderKeys ? (
                    <>
                      Copy <code>.env.example</code> to <code>.env</code>, add <code>ANTHROPIC_API_KEY</code> or{' '}
                      <code>GEMINI_API_KEY</code>, and restart the server. Documents and retrieval work offline without
                      any key.
                    </>
                  ) : (
                    <>
                      Switch provider or model between messages — the conversation continues coherently, because history
                      is stored in a provider-agnostic format.
                    </>
                  )
                }
              />
            ) : (
              <div className="thread">
                {messages.map((message) => (
                  <MessageView
                    key={message.id}
                    message={message}
                    onCitation={openCitation}
                    activeCitation={inspecting?.chunkId ?? null}
                  />
                ))}
                {live && (
                  <LiveTurnView turn={live} onCitation={openCitation} activeCitation={inspecting?.chunkId ?? null} />
                )}
              </div>
            )}
          </div>
        </div>

        <div className="composer-wrap">
          {!scroll.pinned && (
            <button className="scroll-pin" onClick={scroll.scrollToBottom}>
              Jump to latest <IconChevron size={13} className="chev open" />
            </button>
          )}

          <div className="composer">
            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              placeholder={streaming ? 'Streaming — press Esc to stop' : 'Send a message…'}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
                if (e.key === 'Escape' && streaming) stop();
              }}
              disabled={streaming}
            />
            <div className="composer-hint">
              <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a newline
              {streaming ? ' · Esc to stop' : ''}
            </div>
            <div className="composer-bar">
              <ModelSelect models={models} value={model} onChange={onModelChange} />

              <label
                className={`switch-row${useTools ? ' on' : ''}`}
                title={
                  toolsUnsupported
                    ? 'This model has no tool calling. Polyglot will say so and answer without tools.'
                    : 'Let the model call the calculator, weather and document search'
                }
              >
                <input type="checkbox" checked={useTools} onChange={(e) => setUseTools(e.target.checked)} />
                <IconTool size={14} /> Tools
                {toolsUnsupported && useTools && <Badge tone="warn">n/a</Badge>}
              </label>

              <label
                className={`switch-row${useRag ? ' on' : ''}`}
                title={
                  conversation?.collection_id
                    ? 'Retrieve from the attached collection before answering'
                    : 'Attach a collection first'
                }
              >
                <input
                  type="checkbox"
                  checked={useRag}
                  disabled={!conversation?.collection_id}
                  onChange={(e) => setUseRag(e.target.checked)}
                />
                <IconSources size={14} /> Grounded
              </label>

              <select
                className="auto"
                value={conversation?.collection_id ?? ''}
                onChange={(e) => void attachCollection(e.target.value)}
                disabled={!conversation}
                title="Document collection for this conversation"
                style={{ fontSize: 'var(--t-sm)', maxWidth: 170 }}
              >
                <option value="">No documents</option>
                {collections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>

              <div className="fill" />

              {streaming ? (
                <button className="danger" onClick={stop} title="Aborts the upstream provider request, not just the render">
                  <IconStop size={14} /> Stop
                </button>
              ) : (
                <button className="primary" onClick={() => void send()} disabled={!input.trim()}>
                  <IconSend size={14} /> Send
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      <aside className="inspector">
        <div className="inspector-head">
          <div className="segmented">
            <button className={inspectorTab === 'source' ? 'active' : ''} onClick={() => setInspectorTab('source')}>
              <IconSources size={14} /> Source
            </button>
            <button className={inspectorTab === 'model' ? 'active' : ''} onClick={() => setInspectorTab('model')}>
              <IconChat size={14} /> Model
            </button>
          </div>
        </div>
        <div className="inspector-body">
          {inspectorTab === 'source' ? (
            <SourcePanel citation={inspecting} onClose={() => setInspecting(null)} />
          ) : (
            <ModelPanel model={selectedModel} />
          )}
        </div>
      </aside>
    </>
  );
}

/* ===========================================================================
   Messages
   =========================================================================== */

function MessageView({
  message,
  onCitation,
  activeCitation,
}: {
  message: StoredMessage;
  onCitation: (c: Citation) => void;
  activeCitation: string | null;
}) {
  if (message.role === 'tool') return null; // rendered inside the assistant turn

  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  const toolUses = message.content.filter((b) => b.type === 'tool_use');
  if (!text && !toolUses.length) return null;

  if (message.role === 'user') {
    return (
      <div className="msg user fade-in">
        <div className="bubble-user">{text}</div>
      </div>
    );
  }

  return (
    <div className="msg assistant fade-in">
      <div className="msg-meta">
        <span className="provider-dot" style={{ '--dot': providerColor(message.provider) } as React.CSSProperties} />
        {message.modelId?.split(':')[1] ?? 'assistant'}
        <span className="fill" />
        <span className="msg-actions">
          <CopyButton text={text} label="Copy answer" />
        </span>
      </div>

      <div
        className="bubble-assistant"
        style={{ '--edge': providerColor(message.provider) } as React.CSSProperties}
      >
        {message.reasoning && <div className="reasoning">{message.reasoning}</div>}

        {toolUses.map((block) => (
          <ToolCard
            key={block.id ?? block.name}
            name={block.name ?? 'tool'}
            args={JSON.stringify(block.input ?? {}, null, 2)}
            status="ok"
          />
        ))}

        <Markdown
          text={text}
          citations={message.citations}
          onCitation={onCitation}
          activeCitation={activeCitation}
        />

        {message.citations?.length ? (
          <div className="source-strip">
            {message.citations.map((c) => (
              <button key={c.chunkId} className="source-pill" onClick={() => onCitation(c)}>
                <span className="n">{c.number}</span>
                <span className="truncate" style={{ maxWidth: 190 }}>
                  {c.filename}
                  {c.page ? ` · p${c.page}` : ''}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function LiveTurnView({
  turn,
  onCitation,
  activeCitation,
}: {
  turn: LiveTurn;
  onCitation: (c: Citation) => void;
  activeCitation: string | null;
}) {
  return (
    <div className="msg assistant">
      <div className="msg-meta">
        <span className="provider-dot" style={{ '--dot': providerColor(turn.provider) } as React.CSSProperties} />
        {turn.model.split(':')[1] ?? turn.model}
        <Spinner />
      </div>

      <div className="bubble-assistant" style={{ '--edge': providerColor(turn.provider) } as React.CSSProperties}>
        {turn.notices.map((notice, i) => (
          <Notice key={i} level={notice.level}>
            {notice.message}
          </Notice>
        ))}

        {turn.reasoning && <div className="reasoning">{turn.reasoning}</div>}

        {turn.tools.map((tool) => (
          <ToolCard
            key={tool.id}
            name={tool.name}
            args={tool.argsPreview}
            result={tool.result}
            status={tool.status}
            durationMs={tool.durationMs}
            openByDefault
          />
        ))}

        {turn.text ? (
          <Markdown
            text={turn.text}
            streaming
            citations={turn.citations}
            onCitation={onCitation}
            activeCitation={activeCitation}
          />
        ) : (
          !turn.tools.length && <div className="md streaming-caret" />
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

/**
 * A tool call. The arguments pane fills in as fragments arrive, which is the
 * visible proof that tool arguments really do stream rather than landing whole.
 */
function ToolCard({
  name,
  args,
  result,
  status,
  durationMs,
  openByDefault,
}: {
  name: string;
  args: string;
  result?: string;
  status: 'streaming' | 'running' | 'ok' | 'error';
  durationMs?: number;
  openByDefault?: boolean;
}) {
  const [open, setOpen] = useState(Boolean(openByDefault));
  const tone = status === 'error' ? 'err' : status === 'ok' ? 'ok' : 'accent';
  const label =
    status === 'streaming' ? 'receiving arguments' : status === 'running' ? 'running' : status === 'ok' ? 'done' : 'failed';

  return (
    <div className="tool">
      <button className="tool-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <IconTool size={14} className="faint" />
        <span className="name">{name}</span>
        <Badge tone={tone}>{label}</Badge>
        {durationMs != null && <span className="xs faint">{formatMs(durationMs)}</span>}
        <IconChevron size={14} className={`chev${open ? ' open' : ''}`} />
      </button>

      {open && (
        <>
          <div className="tool-section">
            <div className="eyebrow">Arguments</div>
            <pre className="tool-code">{args || '…'}</pre>
          </div>
          {result && (
            <div className="tool-section">
              <div className="eyebrow">Result</div>
              <pre className="tool-code">{result}</pre>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ===========================================================================
   Inspector panels
   =========================================================================== */

function SourcePanel({ citation, onClose }: { citation: Citation | null; onClose: () => void }) {
  if (!citation) {
    return (
      <EmptyState
        icon={<IconSources size={20} />}
        title="No source selected"
        hint={
          <>
            When an answer is grounded in your documents, click a <span className="cite">1</span> marker to read the
            exact chunk the model was given.
          </>
        }
      />
    );
  }

  return (
    <div className="fade-in">
      <div className="row between" style={{ marginBottom: 'var(--s-3)' }}>
        <div className="row" style={{ gap: 6 }}>
          <span className="source-pill" style={{ pointerEvents: 'none' }}>
            <span className="n">{citation.number}</span>
          </span>
          <strong className="truncate" style={{ maxWidth: 210 }}>
            {citation.filename}
          </strong>
        </div>
        <button className="ghost icon" onClick={onClose} title="Close">
          <IconClose size={14} />
        </button>
      </div>

      <dl className="dl" style={{ marginBottom: 'var(--s-4)' }}>
        {citation.page != null && (
          <>
            <dt>Page</dt>
            <dd>{citation.page}</dd>
          </>
        )}
        {citation.heading && (
          <>
            <dt>Section</dt>
            <dd className="truncate">{citation.heading}</dd>
          </>
        )}
        <dt>Score</dt>
        <dd>{citation.score.toFixed(4)}</dd>
        <dt>Chunk</dt>
        <dd className="mono xs truncate">{citation.chunkId}</dd>
      </dl>

      <div className="eyebrow" style={{ marginBottom: 6 }}>
        Chunk text, verbatim
      </div>
      <div className="chunk">{citation.text}</div>

      <Notice level="info">
        This is exactly what the model was shown, inside a block marked as untrusted third-party content.
      </Notice>
    </div>
  );
}

function ModelPanel({ model }: { model?: ModelInfo }) {
  if (!model) return <EmptyState icon={<IconChat size={20} />} title="No model selected" />;

  const caps = [
    model.capabilities.tools && 'tools',
    model.capabilities.vision && 'vision',
    model.capabilities.jsonSchema && 'json schema',
    model.capabilities.reasoning && 'reasoning',
    model.capabilities.promptCaching && 'prompt caching',
  ].filter(Boolean) as string[];

  return (
    <div className="fade-in">
      <div className="row between" style={{ marginBottom: 'var(--s-3)' }}>
        <div className="row" style={{ gap: 7 }}>
          <span className="provider-dot" style={{ '--dot': providerColor(model.provider) } as React.CSSProperties} />
          <strong>{model.displayName}</strong>
        </div>
        <Badge tone={model.available ? 'ok' : 'err'}>{model.available ? 'ready' : 'no key'}</Badge>
      </div>

      <div className="mono xs faint" style={{ marginBottom: 'var(--s-4)' }}>
        {model.id}
      </div>

      <div className="eyebrow" style={{ marginBottom: 6 }}>
        Limits
      </div>
      <dl className="dl" style={{ marginBottom: 'var(--s-4)' }}>
        <dt>Provider</dt>
        <dd>{model.provider}</dd>
        <dt>Context window</dt>
        <dd>{model.contextWindow.toLocaleString()}</dd>
        <dt>Max output</dt>
        <dd>{model.maxOutputTokens?.toLocaleString() ?? '—'}</dd>
      </dl>

      <div className="eyebrow" style={{ marginBottom: 6 }}>
        Pricing · USD per million tokens
      </div>
      <dl className="dl" style={{ marginBottom: 'var(--s-4)' }}>
        <dt>Input</dt>
        <dd>${model.pricing.inputPerMTok}</dd>
        <dt>Output</dt>
        <dd>${model.pricing.outputPerMTok}</dd>
        {model.pricing.cachedInputPerMTok !== undefined && (
          <>
            <dt>Cached input</dt>
            <dd>${model.pricing.cachedInputPerMTok}</dd>
          </>
        )}
        {model.pricing.cacheWritePerMTok !== undefined && (
          <>
            <dt>Cache write</dt>
            <dd>${model.pricing.cacheWritePerMTok}</dd>
          </>
        )}
      </dl>

      <div className="eyebrow" style={{ marginBottom: 6 }}>
        Capabilities
      </div>
      <div className="chips">
        {caps.length ? caps.map((c) => <Badge key={c}>{c}</Badge>) : <span className="sm faint">none declared</span>}
      </div>

      <Notice level="info">
        Every value here is read from <code>config/models.json</code>. Nothing about a model is hardcoded.
      </Notice>

      <div className="eyebrow" style={{ margin: 'var(--s-4) 0 6px' }}>
        Example cost
      </div>
      <div className="sm muted">
        A 10k-token prompt with a 1k-token answer costs{' '}
        <strong>
          {formatUsd((10_000 / 1e6) * model.pricing.inputPerMTok + (1_000 / 1e6) * model.pricing.outputPerMTok)}
        </strong>{' '}
        on this model ({formatTokens(10_000)} in, {formatTokens(1_000)} out).
      </div>
    </div>
  );
}
