import { useEffect, useMemo, useRef, useState } from 'react';
import { api, formatMs, formatUsd, getTenantKey } from '../lib/api';
import type { Collection, DocumentRow, ModelInfo, RetrievalResult, RetrievedChunk } from '../lib/types';
import { ModelSelect } from './shared';
import {
  Badge,
  EmptyState,
  IconClose,
  IconDocs,
  IconPlus,
  IconSearch,
  IconSources,
  IconTrash,
  IconUpload,
  Notice,
  Spinner,
} from './ui';

/**
 * Collections, ingestion, and a retrieval playground.
 *
 * The playground is the point of this screen. Retrieval quality is otherwise
 * invisible: you can see what came back, what each retriever scored it, and
 * what the threshold rejected, before any model writes a sentence about it.
 */

interface Props {
  models: ModelInfo[];
  collections: Collection[];
  defaultEmbeddingModel: string;
  onCollectionsChanged: () => void;
  onError: (message: string) => void;
  onUsageChanged: () => void;
  /** Reveal the details panel when a chunk is selected. */
  onInspect: () => void;
}

interface UploadResult {
  ok: boolean;
  filename: string;
  documentId?: string;
  chunks?: number;
  costUsd?: number;
  duplicateOf?: string;
  error?: string;
}

export function DocumentsView({
  models,
  collections,
  defaultEmbeddingModel,
  onCollectionsChanged,
  onError,
  onUsageChanged,
  onInspect,
}: Props) {
  const [activeId, setActiveId] = useState<string | null>(collections[0]?.id ?? null);
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [uploads, setUploads] = useState<UploadResult[]>([]);
  const [dragging, setDragging] = useState(false);
  const [creating, setCreating] = useState(false);
  const [preview, setPreview] = useState<RetrievedChunk | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState('');
  const [embeddingModel, setEmbeddingModel] = useState(defaultEmbeddingModel);
  const [chunkSize, setChunkSize] = useState(900);
  const [chunkOverlap, setChunkOverlap] = useState(150);

  const active = useMemo(() => collections.find((c) => c.id === activeId) ?? null, [collections, activeId]);

  useEffect(() => {
    if (!activeId && collections[0]) setActiveId(collections[0].id);
  }, [collections, activeId]);

  useEffect(() => {
    if (!activeId) {
      setDocuments([]);
      return;
    }
    api<{ collection: Collection; documents: DocumentRow[] }>(`/collections/${activeId}`)
      .then((res) => setDocuments(res.documents))
      .catch((e) => onError((e as Error).message));
    setPreview(null);
    setUploads([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const createCollection = async () => {
    try {
      const res = await api<{ collection: Collection }>('/collections', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim() || 'Untitled collection', embeddingModel, chunkSize, chunkOverlap }),
      });
      setName('');
      setCreating(false);
      onCollectionsChanged();
      setActiveId(res.collection.id);
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const upload = async (files: FileList | File[] | null) => {
    const list = files ? Array.from(files) : [];
    if (!list.length || !activeId) return;
    setBusy(true);
    setUploads([]);
    try {
      const form = new FormData();
      for (const file of list) form.append('files', file);
      // FormData deliberately carries no content-type header: the browser has to
      // set the multipart boundary itself.
      const res = await fetch(`/api/collections/${activeId}/documents`, {
        method: 'POST',
        headers: { 'x-tenant-key': getTenantKey() },
        body: form,
      });
      const body = await res.json();
      if (!res.ok && !body.results) throw new Error(body?.error?.message ?? 'Upload failed');
      setUploads(body.results ?? []);
      setDocuments(body.documents ?? []);
      onCollectionsChanged();
      onUsageChanged();
      for (const r of (body.results ?? []) as UploadResult[]) {
        if (!r.ok) onError(`${r.filename}: ${r.error}`);
      }
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const removeDocument = async (id: string) => {
    try {
      await api(`/documents/${id}`, { method: 'DELETE' });
      setDocuments((prev) => prev.filter((d) => d.id !== id));
      onCollectionsChanged();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const removeCollection = async (id: string) => {
    try {
      await api(`/collections/${id}`, { method: 'DELETE' });
      onCollectionsChanged();
      setActiveId(null);
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <>
      <aside className="context">
        <div className="context-head">
          <button className="primary block" onClick={() => setCreating((v) => !v)}>
            <IconPlus size={15} /> New collection
          </button>
        </div>

        <div className="context-body">
          {creating && (
            <div className="card" style={{ padding: 'var(--s-3)', marginBottom: 'var(--s-3)' }}>
              <div className="col gap-3">
                <div className="field">
                  <label>Name</label>
                  <input
                    type="text"
                    value={name}
                    placeholder="Contracts"
                    autoFocus
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void createCollection()}
                  />
                </div>
                <div className="field">
                  <label>Embedding model</label>
                  <ModelSelect models={models} kind="embedding" value={embeddingModel} onChange={setEmbeddingModel} />
                  <span className="hint">
                    Pinned at creation — vectors from two models are not comparable, so changing it later means
                    re-embedding.
                  </span>
                </div>
                <div className="field">
                  <label>
                    Chunk size <span className="faint">{chunkSize} chars</span>
                  </label>
                  <input
                    type="range"
                    min={200}
                    max={3000}
                    step={50}
                    value={chunkSize}
                    onChange={(e) => setChunkSize(Number(e.target.value))}
                  />
                </div>
                <div className="field">
                  <label>
                    Overlap <span className="faint">{chunkOverlap} chars</span>
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(50, chunkSize - 50)}
                    step={10}
                    value={chunkOverlap}
                    onChange={(e) => setChunkOverlap(Number(e.target.value))}
                  />
                </div>
                <div className="row">
                  <button className="primary fill" onClick={() => void createCollection()}>
                    Create
                  </button>
                  <button className="ghost" onClick={() => setCreating(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="eyebrow" style={{ padding: '0 10px 4px' }}>
            Collections
          </div>
          {collections.length === 0 && <div className="sm faint" style={{ padding: 10 }}>None yet.</div>}
          {collections.map((c) => (
            <div className="list-item-wrap" key={c.id}>
              <button className={`list-row fill${c.id === activeId ? ' active' : ''}`} onClick={() => setActiveId(c.id)}>
                <span className="fill" style={{ minWidth: 0 }}>
                  <span className="title truncate" style={{ display: 'block' }}>
                    {c.name}
                  </span>
                  <span className="sub">
                    {c.document_count ?? 0} doc{(c.document_count ?? 0) === 1 ? '' : 's'} · {c.chunk_count ?? 0} chunks
                  </span>
                </span>
              </button>
              <button className="ghost icon hover-reveal" title="Delete collection" onClick={() => void removeCollection(c.id)}>
                <IconTrash size={14} />
              </button>
            </div>
          ))}
        </div>
      </aside>

      <section className="canvas">
        <div className="canvas-scroll">
          <div className="canvas-inner">
            {!active ? (
              <EmptyState
                icon={<IconDocs size={20} />}
                title="Create a collection to get started"
                hint="PDF, TXT and Markdown. With no API keys at all, the offline embedder still indexes and retrieves."
              />
            ) : (
              <>
                <div className="row between" style={{ marginBottom: 'var(--s-4)' }}>
                  <div>
                    <h3>{active.name}</h3>
                    <div className="sm faint">
                      {active.document_count ?? documents.length} documents · {active.chunk_count ?? 0} chunks
                    </div>
                  </div>
                  <div className="chips">
                    <Badge title="Embedding model pinned to this collection">{active.embedding_model}</Badge>
                    <Badge title="Vector dimensions">{active.dimensions}d</Badge>
                    <Badge title="Chunk size / overlap in characters">
                      {active.chunk_size}/{active.chunk_overlap}
                    </Badge>
                  </div>
                </div>

                <div
                  className={`dropzone${dragging ? ' over' : ''}`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragging(false);
                    void upload(e.dataTransfer.files);
                  }}
                  style={{ marginBottom: 'var(--s-4)' }}
                >
                  <div className="col" style={{ alignItems: 'center', gap: 'var(--s-2)' }}>
                    <span className="faint">{busy ? <Spinner /> : <IconUpload size={20} />}</span>
                    <div>
                      <strong>Drop files here</strong> <span className="faint">or</span>{' '}
                      <button className="sm" onClick={() => fileRef.current?.click()} disabled={busy}>
                        browse
                      </button>
                    </div>
                    <div className="xs faint">PDF · TXT · Markdown — validated by magic bytes, never by extension</div>
                  </div>
                  <input
                    ref={fileRef}
                    type="file"
                    multiple
                    hidden
                    accept=".pdf,.txt,.md,.markdown,text/plain,text/markdown,application/pdf"
                    onChange={(e) => void upload(e.target.files)}
                  />
                </div>

                {uploads.map((result) => (
                  <Notice key={result.filename} level={result.ok ? 'info' : 'err'}>
                    <strong>{result.filename}</strong>{' '}
                    {result.ok
                      ? result.duplicateOf
                        ? '— identical content was already indexed, so it was skipped.'
                        : `— ${result.chunks} chunks, ${formatUsd(result.costUsd ?? 0)} to embed.`
                      : `— ${result.error}`}
                  </Notice>
                ))}

                <div className="card flush">
                  <div className="card-head">
                    <div className="eyebrow fill">Documents</div>
                  </div>
                  {documents.length === 0 ? (
                    <div className="card-body sm faint">No documents yet.</div>
                  ) : (
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>File</th>
                            <th>Status</th>
                            <th className="num">Pages</th>
                            <th className="num">Characters</th>
                            <th className="num">Chunks</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {documents.map((doc) => (
                            <tr key={doc.id}>
                              <td className="truncate" style={{ maxWidth: 280 }}>
                                {doc.filename}
                              </td>
                              <td>
                                <Badge
                                  tone={doc.status === 'ready' ? 'ok' : doc.status === 'failed' ? 'err' : 'warn'}
                                  title={doc.error ?? undefined}
                                >
                                  {doc.status}
                                </Badge>
                              </td>
                              <td className="num">{doc.page_count ?? '—'}</td>
                              <td className="num">{doc.char_count.toLocaleString()}</td>
                              <td className="num">{doc.chunk_count}</td>
                              <td className="num">
                                <button className="ghost icon" title="Delete" onClick={() => void removeDocument(doc.id)}>
                                  <IconTrash size={14} />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                <RetrievalPlayground
                  collection={active}
                  onPreview={(chunk) => {
                    setPreview(chunk);
                    onInspect();
                  }}
                  onError={onError}
                  onUsageChanged={onUsageChanged}
                />
              </>
            )}
          </div>
        </div>
      </section>

      <aside className="inspector">
        <div className="inspector-head">
          <div className="eyebrow fill">Chunk preview</div>
          {preview && (
            <button className="ghost icon" onClick={() => setPreview(null)}>
              <IconClose size={14} />
            </button>
          )}
        </div>
        <div className="inspector-body">
          {preview ? (
            <div className="fade-in">
              <strong className="truncate" style={{ display: 'block' }}>
                {preview.filename}
              </strong>
              <dl className="dl" style={{ margin: 'var(--s-3) 0 var(--s-4)' }}>
                <dt>Rank</dt>
                <dd>#{preview.rank}</dd>
                {preview.page != null && (
                  <>
                    <dt>Page</dt>
                    <dd>{preview.page}</dd>
                  </>
                )}
                {preview.heading && (
                  <>
                    <dt>Section</dt>
                    <dd className="truncate">{preview.heading}</dd>
                  </>
                )}
                {preview.vectorScore !== undefined && (
                  <>
                    <dt>Cosine</dt>
                    <dd>{preview.vectorScore.toFixed(4)}</dd>
                  </>
                )}
                {preview.keywordScore !== undefined && (
                  <>
                    <dt>BM25</dt>
                    <dd>{preview.keywordScore.toFixed(2)}</dd>
                  </>
                )}
                <dt>Final</dt>
                <dd>{preview.score.toFixed(4)}</dd>
              </dl>
              <div className="chunk">{preview.text}</div>
            </div>
          ) : (
            <EmptyState
              icon={<IconSources size={20} />}
              title="No chunk selected"
              hint="Run a search below and click a result to read the chunk exactly as it would be given to a model."
            />
          )}
        </div>
      </aside>
    </>
  );
}

function RetrievalPlayground({
  collection,
  onPreview,
  onError,
  onUsageChanged,
}: {
  collection: Collection;
  // The parent decides what selecting a chunk means; this component just reports it.
  onPreview: (chunk: RetrievedChunk) => void;
  onError: (message: string) => void;
  onUsageChanged: () => void;
}) {
  const [query, setQuery] = useState('');
  const [topK, setTopK] = useState(6);
  const [threshold, setThreshold] = useState<number | null>(null);
  const [mode, setMode] = useState<'hybrid' | 'vector' | 'keyword'>('hybrid');
  const [result, setResult] = useState<RetrievalResult | null>(null);
  const [busy, setBusy] = useState(false);

  // The sensible threshold depends on the embedding model, and the server knows
  // it — so we start from "model default" rather than inventing a number.
  useEffect(() => {
    setThreshold(null);
    setResult(null);
  }, [collection.id]);

  const search = async () => {
    if (!query.trim()) return;
    setBusy(true);
    try {
      const res = await api<RetrievalResult>(`/collections/${collection.id}/search`, {
        method: 'POST',
        body: JSON.stringify({
          query,
          topK,
          retrievalMode: mode,
          ...(threshold === null ? {} : { similarityThreshold: threshold }),
        }),
      });
      setResult(res);
      if (threshold === null) setThreshold(res.params.similarityThreshold);
      onUsageChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="row between" style={{ marginBottom: 'var(--s-2)' }}>
        <div className="eyebrow">Retrieval playground</div>
        <span className="xs faint">parameters apply per request</span>
      </div>
      <p className="sm muted">
        See exactly what retrieval returns, and what the threshold rejected, before a model writes a word about it.
      </p>

      <div className="row" style={{ marginBottom: 'var(--s-4)' }}>
        <div className="fill" style={{ position: 'relative' }}>
          <span style={{ position: 'absolute', left: 10, top: 9, color: 'var(--c-ink-4)', pointerEvents: 'none' }}>
            <IconSearch size={14} />
          </span>
          <input
            type="search"
            value={query}
            placeholder="What does the contract say about termination?"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void search()}
            style={{ paddingLeft: 30 }}
          />
        </div>
        <button className="primary" onClick={() => void search()} disabled={busy || !query.trim()}>
          {busy ? <Spinner /> : 'Search'}
        </button>
      </div>

      <div className="row wrap gap-4" style={{ marginBottom: 'var(--s-4)', alignItems: 'flex-end' }}>
        <div className="field" style={{ minWidth: 190 }}>
          <label>Mode</label>
          <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="hybrid">Hybrid — vectors + BM25, fused by RRF</option>
            <option value="vector">Vector only</option>
            <option value="keyword">Keyword only (BM25)</option>
          </select>
        </div>
        <div className="field fill" style={{ minWidth: 140 }}>
          <label>
            top-k <span className="faint">{topK}</span>
          </label>
          <input type="range" min={1} max={20} value={topK} onChange={(e) => setTopK(Number(e.target.value))} />
        </div>
        <div className="field fill" style={{ minWidth: 170 }}>
          <label>
            similarity threshold{' '}
            <span className="faint">{threshold === null ? 'model default' : threshold.toFixed(3)}</span>
          </label>
          <input
            type="range"
            min={0}
            max={1}
            step={0.005}
            value={threshold ?? 0.3}
            onChange={(e) => setThreshold(Number(e.target.value))}
          />
        </div>
      </div>

      {result && (
        <>
          <div className="chips" style={{ marginBottom: 'var(--s-3)' }}>
            <Badge tone={result.empty ? 'warn' : 'ok'}>
              {result.empty ? 'nothing above threshold' : `${result.chunks.length} chunks`}
            </Badge>
            <Badge>{result.embeddingModel ?? 'no embedding'}</Badge>
            <Badge title="Candidates found but rejected by the threshold">{result.rejected} rejected</Badge>
            <Badge title="Time spent embedding the query">embed {formatMs(result.timings.embedMs)}</Badge>
            <Badge title="Time spent searching">search {formatMs(result.timings.searchMs)}</Badge>
            <Badge tone="accent">{formatUsd(result.costUsd)}</Badge>
          </div>

          {result.empty && (
            <Notice level="warn">
              Nothing cleared the threshold, so a grounded answer here would be exactly &ldquo;I don&rsquo;t know based on
              the provided documents.&rdquo; That is the intended behaviour, not a failure.
            </Notice>
          )}

          {result.chunks.map((chunk) => (
            <button
              key={chunk.chunkId}
              className="result"
              style={{ display: 'block', width: '100%', textAlign: 'left', boxShadow: 'none' }}
              onClick={() => onPreview(chunk)}
            >
              <div className="row between" style={{ marginBottom: 5 }}>
                <div className="row" style={{ gap: 7, minWidth: 0 }}>
                  <span className="rank">{chunk.rank}</span>
                  <span className="sm truncate">
                    {chunk.filename}
                    {chunk.page ? ` · page ${chunk.page}` : ''}
                    {chunk.heading ? ` · ${chunk.heading}` : ''}
                  </span>
                </div>
                <div className="chips">
                  {chunk.vectorScore !== undefined && <Badge title="Cosine similarity">vec {chunk.vectorScore.toFixed(3)}</Badge>}
                  {chunk.keywordScore !== undefined && <Badge title="BM25, sign-flipped">bm25 {chunk.keywordScore.toFixed(2)}</Badge>}
                  <Badge tone="accent" title="Final ranking score">
                    {chunk.score.toFixed(4)}
                  </Badge>
                </div>
              </div>
              <div className="sm muted" style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                {chunk.text}
              </div>
            </button>
          ))}
        </>
      )}
    </div>
  );
}
