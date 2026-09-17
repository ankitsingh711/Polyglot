import { useEffect, useMemo, useRef, useState } from 'react';
import { api, formatMs, formatUsd, getTenantKey } from '../lib/api';
import type { Collection, DocumentRow, ModelInfo, RetrievalResult } from '../lib/types';
import { Badge, EmptyState, ModelSelect, Notice, Spinner } from './shared';

/**
 * Collections, ingestion and a retrieval playground.
 *
 * The playground exists because retrieval quality is invisible otherwise: you
 * can see what was retrieved, what each retriever scored, and what the threshold
 * rejected, before any model is asked to write a sentence about it.
 */

interface Props {
  models: ModelInfo[];
  collections: Collection[];
  defaultEmbeddingModel: string;
  onCollectionsChanged: () => void;
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

export function DocumentsView({ models, collections, defaultEmbeddingModel, onCollectionsChanged }: Props) {
  const [activeId, setActiveId] = useState<string | null>(collections[0]?.id ?? null);
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploads, setUploads] = useState<UploadResult[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  // New-collection form
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
      .catch((e) => setError(e.message));
  }, [activeId]);

  const createCollection = async () => {
    setError(null);
    try {
      const res = await api<{ collection: Collection }>('/collections', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim() || 'Untitled collection', embeddingModel, chunkSize, chunkOverlap }),
      });
      setName('');
      onCollectionsChanged();
      setActiveId(res.collection.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const upload = async (files: FileList | null) => {
    if (!files?.length || !activeId) return;
    setBusy(true);
    setError(null);
    setUploads([]);
    try {
      const form = new FormData();
      for (const file of Array.from(files)) form.append('files', file);
      // FormData, so no content-type header: the browser must set the boundary.
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
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const removeDocument = async (id: string) => {
    await api(`/documents/${id}`, { method: 'DELETE' });
    setDocuments((prev) => prev.filter((d) => d.id !== id));
    onCollectionsChanged();
  };

  const removeCollection = async (id: string) => {
    await api(`/collections/${id}`, { method: 'DELETE' });
    onCollectionsChanged();
    setActiveId(null);
  };

  return (
    <>
      <aside className="sidebar">
        <div className="section-title">New collection</div>
        <div className="stack">
          <div className="field">
            <label>Name</label>
            <input type="text" value={name} placeholder="Contracts" onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label>Embedding model</label>
            <ModelSelect models={models} kind="embedding" value={embeddingModel} onChange={setEmbeddingModel} />
          </div>
          <div className="field">
            <label>Chunk size: {chunkSize} chars</label>
            <input type="range" min={200} max={3000} step={50} value={chunkSize} onChange={(e) => setChunkSize(Number(e.target.value))} />
          </div>
          <div className="field">
            <label>Overlap: {chunkOverlap} chars</label>
            <input
              type="range"
              min={0}
              max={Math.max(50, chunkSize - 50)}
              step={10}
              value={chunkOverlap}
              onChange={(e) => setChunkOverlap(Number(e.target.value))}
            />
          </div>
          <button className="primary" onClick={() => void createCollection()}>
            Create
          </button>
          <div className="small faint">
            The embedding model is pinned at creation: vectors from two models are not comparable, so changing it
            would mean re-embedding everything.
          </div>
        </div>

        <div className="section-title">Collections</div>
        {collections.length === 0 && <div className="small faint">None yet.</div>}
        {collections.map((c) => (
          <div key={c.id} className="row" style={{ gap: 2 }}>
            <button className={`list-item grow ${c.id === activeId ? 'active' : ''}`} onClick={() => setActiveId(c.id)}>
              <div className="truncate">{c.name}</div>
              <div className="small faint">
                {c.document_count ?? 0} docs · {c.chunk_count ?? 0} chunks
              </div>
            </button>
            <button className="ghost danger" title="Delete" onClick={() => void removeCollection(c.id)}>
              ×
            </button>
          </div>
        ))}
      </aside>

      <section className="panel">
        <div className="scroll">
          {!active && <EmptyState title="Create a collection to get started." hint="PDF, TXT and Markdown are supported." />}

          {active && (
            <>
              <div className="card">
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <h3 style={{ margin: 0 }}>{active.name}</h3>
                  <div className="row">
                    <Badge>{active.embedding_model}</Badge>
                    <Badge>{active.dimensions}d</Badge>
                    <Badge>
                      {active.chunk_size}/{active.chunk_overlap}
                    </Badge>
                  </div>
                </div>

                <div className="row" style={{ marginTop: 12 }}>
                  <input ref={fileRef} type="file" multiple accept=".pdf,.txt,.md,.markdown,text/plain,text/markdown,application/pdf" onChange={(e) => void upload(e.target.files)} disabled={busy} />
                  {busy && <Spinner />}
                </div>

                {uploads.map((result) => (
                  <Notice key={result.filename} level={result.ok ? 'info' : 'err'}>
                    <strong>{result.filename}</strong>{' '}
                    {result.ok
                      ? result.duplicateOf
                        ? '— identical content already indexed, skipped.'
                        : `— ${result.chunks} chunks, ${formatUsd(result.costUsd ?? 0)} to embed.`
                      : `— ${result.error}`}
                  </Notice>
                ))}
                {error && <Notice level="err">{error}</Notice>}
              </div>

              <div className="card">
                <div className="section-title">Documents</div>
                {documents.length === 0 ? (
                  <div className="small faint">No documents yet.</div>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>File</th>
                        <th>Status</th>
                        <th className="num">Pages</th>
                        <th className="num">Chars</th>
                        <th className="num">Chunks</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {documents.map((doc) => (
                        <tr key={doc.id}>
                          <td className="truncate" style={{ maxWidth: 260 }}>{doc.filename}</td>
                          <td>
                            <Badge tone={doc.status === 'ready' ? 'ok' : doc.status === 'failed' ? 'err' : 'warn'} title={doc.error ?? ''}>
                              {doc.status}
                            </Badge>
                          </td>
                          <td className="num">{doc.page_count ?? '—'}</td>
                          <td className="num">{doc.char_count.toLocaleString()}</td>
                          <td className="num">{doc.chunk_count}</td>
                          <td className="num">
                            <button className="ghost danger" onClick={() => void removeDocument(doc.id)}>
                              ×
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <RetrievalPlayground collection={active} />
            </>
          )}
        </div>
      </section>
    </>
  );
}

function RetrievalPlayground({ collection }: { collection: Collection }) {
  const [query, setQuery] = useState('');
  const [topK, setTopK] = useState(6);
  const [threshold, setThreshold] = useState<number | null>(null);
  const [mode, setMode] = useState<'hybrid' | 'vector' | 'keyword'>('hybrid');
  const [result, setResult] = useState<RetrievalResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the threshold when the collection changes: the sensible default
  // depends on the embedding model, and the server knows it.
  useEffect(() => setThreshold(null), [collection.id]);

  const search = async () => {
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
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
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="section-title">Retrieval playground</div>
      <div className="small faint" style={{ marginBottom: 10 }}>
        See exactly what retrieval returns before a model writes a word about it. Parameters apply per request.
      </div>

      <div className="row" style={{ marginBottom: 10 }}>
        <input
          className="grow"
          type="text"
          value={query}
          placeholder="What does the contract say about termination?"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void search()}
        />
        <button className="primary" onClick={() => void search()} disabled={busy || !query.trim()}>
          {busy ? <Spinner /> : 'Search'}
        </button>
      </div>

      <div className="row wrap" style={{ gap: 16, marginBottom: 12 }}>
        <div className="field" style={{ minWidth: 150 }}>
          <label>Mode</label>
          <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="hybrid">hybrid (vector + BM25, RRF)</option>
            <option value="vector">vector only</option>
            <option value="keyword">keyword only (BM25)</option>
          </select>
        </div>
        <div className="field grow">
          <label>top-k: {topK}</label>
          <input type="range" min={1} max={20} value={topK} onChange={(e) => setTopK(Number(e.target.value))} />
        </div>
        <div className="field grow">
          <label>
            similarity threshold: {threshold === null ? `model default` : threshold.toFixed(3)}
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

      {error && <Notice level="err">{error}</Notice>}

      {result && (
        <>
          <div className="meta-strip" style={{ marginBottom: 10 }}>
            <Badge tone={result.empty ? 'warn' : 'ok'}>{result.empty ? 'nothing above threshold' : `${result.chunks.length} chunks`}</Badge>
            <Badge>{result.embeddingModel ?? 'no embedding'}</Badge>
            <Badge title="Candidates found but rejected by the threshold">{result.rejected} rejected</Badge>
            <Badge>embed {formatMs(result.timings.embedMs)}</Badge>
            <Badge>search {formatMs(result.timings.searchMs)}</Badge>
            <Badge tone="ok">{formatUsd(result.costUsd)}</Badge>
          </div>

          {result.empty && (
            <Notice level="warn">
              Nothing cleared the threshold, so a RAG answer here would be exactly
              &ldquo;I don&rsquo;t know based on the provided documents.&rdquo; That is the intended behaviour, not a failure.
            </Notice>
          )}

          {result.chunks.map((chunk) => (
            <div className="card" key={chunk.chunkId} style={{ marginBottom: 8 }}>
              <div className="row wrap" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                <strong className="small">
                  #{chunk.rank} {chunk.filename}
                  {chunk.page ? ` · page ${chunk.page}` : ''}
                  {chunk.heading ? ` · ${chunk.heading}` : ''}
                </strong>
                <div className="row">
                  {chunk.vectorScore !== undefined && <Badge title="Cosine similarity">vec {chunk.vectorScore.toFixed(3)}</Badge>}
                  {chunk.keywordScore !== undefined && <Badge title="BM25, sign-flipped">bm25 {chunk.keywordScore.toFixed(2)}</Badge>}
                  <Badge tone="accent" title="Final ranking score">{chunk.score.toFixed(4)}</Badge>
                </div>
              </div>
              <div className="chunk-preview">{chunk.text}</div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
