# Polyglot

A multi-provider, multi-tenant AI workbench. One internal contract; five provider
adapters behind it; chat with real streaming, retrieval with citations, tool
calling, and per-request cost and latency accounting — all scoped to a tenant
boundary that the database itself enforces.

```
packages/server   Node + TypeScript + Express 5 + SQLite (better-sqlite3)
packages/web      React 19 + Vite
config/           models, pricing, providers, retry, fallback, RAG defaults
docs/             DESIGN.md · PROVIDER_NOTES.md · AI_USAGE.md
```

---

## Setup

Requires Node 20.11+ (developed on 24). No database server, no Docker, no keys
required to boot.

```bash
git clone <this-repo> polyglot && cd polyglot
npm install
cp .env.example .env          # add whichever API keys you have
npm run seed                  # creates two demo tenants + their documents
npm run dev                   # server on :8787, UI on :5173
```

Open <http://localhost:5173>. The tenant switcher in the top right toggles
between the two seeded tenants.

```bash
npm test          # 179 tests, no network
npm run typecheck # server + web
npm run build     # production build of both
```

**With no API keys at all**, the app still boots and the Documents tab works
end to end: upload, chunk, embed (via the local offline embedder), retrieve,
inspect chunks. Chat needs at least one provider key.

Reviewers running with their own keys need only `ANTHROPIC_API_KEY` and
`GEMINI_API_KEY` to exercise everything that matters; the rest are optional.

### Try this first

1. **Chat → Send** with tools enabled: ask *"Our premium tier is $18,000/year —
   what's that per month, and what's the weather in Oslo?"* Two sequential tool
   calls, arguments visibly streaming in fragments, results fed back, final answer.
2. **Switch the model dropdown mid-conversation** and ask a follow-up. History
   replays through a different adapter without a hitch.
3. **Documents → Retrieval playground**: search the seeded Acme handbook, drag
   the threshold slider, watch what gets rejected.
4. **Chat with RAG on**: ask *"What's the termination notice period?"* → cited
   answer, click a `[1]` chip to see the exact chunk. Then ask about sourdough →
   `I don't know based on the provided documents.`, with zero model calls made.
5. **Switch tenant to Globex** and ask for Acme's deployment passphrase. It is
   not merely filtered out — the query cannot reach it.
6. **Metrics tab**: TTFT, latency, tokens (including cached), USD per request,
   retries, fallbacks, and the audit trail.

---

## What I implemented

### Providers (Module A) — 5 of the 5 offered

| Provider | Chat | Stream | Tools | Structured output | Embeddings |
|---|---|---|---|---|---|
| **Anthropic** | ✅ | ✅ | ✅ | tool-forcing | — |
| **Google Gemini** | ✅ | ✅ | ✅ | `responseSchema` | ✅ |
| **OpenAI** | ✅ | ✅ | ✅ | native `json_schema` | ✅ |
| **Groq** | ✅ | ✅ | ✅ | native `json_schema` | — |
| **DeepSeek** | ✅ | ✅ | ✅ (chat only) | `json_object` + validate + retry | — |
| *local (offline embedder)* | — | — | — | — | ✅ |

Plain `fetch` throughout, no vendor SDKs and no abstraction framework. See
[`docs/PROVIDER_NOTES.md`](docs/PROVIDER_NOTES.md) for the concrete differences
between these APIs and how each one was reconciled — that document is the real
answer to "do you understand these providers".

### Modules

- **A — Provider abstraction.** Done, and protected above everything else.
  Adding a provider is one file in `src/providers/` plus config entries; the
  registry discovers adapters by scanning the directory, so no index, switch or
  DI wiring exists to edit. Two tests enforce this rather than just asserting it.
- **B — Chat.** Done. Token-by-token SSE, provider/model switching mid-conversation,
  SQLite persistence, cancel that aborts the upstream socket, and an explicit
  documented context-overflow strategy (summarize, configurable to truncate/reject).
- **C — RAG.** Done. PDF/TXT/MD, structure-aware chunking with sentence-level
  overlap, hybrid retrieval (dense + BM25 fused with RRF), inline citations that
  open the exact chunk, runtime-tunable parameters, and a real "I don't know"
  path that short-circuits before any model call.
- **D — Tool calling.** Done. Three tools, one definition format, working on all
  five providers. Multi-turn loop with parallel and sequential calls; arguments
  accumulated from streamed fragments; graceful degradation with an explanation
  when a model (e.g. `deepseek-reasoner`) cannot do tools.
- **E — Observability and resilience.** Done. Per-request provider, model, tenant,
  TTFT, latency, tokens (fresh/cached/cache-write/reasoning), USD, finish reason,
  retry count, fallback origin. Jittered backoff on retryable kinds only,
  configurable fallback chains, per-request timeouts, per-request and
  per-tenant-per-day cost caps, and aggregate views.

### Optional extras

Built: **side-by-side comparison** (concurrent lanes on one SSE channel),
**hybrid retrieval with RRF**, **structured output** (each provider's native
mechanism, with validation for all of them), **semantic caching** (per tenant),
**prompt caching** (Anthropic `cache_control`, with the cost delta visible in
metrics), and **streaming markdown** that does not break on partial tokens.

---

## What I cut, and why

I would rather ship this list than a longer feature table.

| Cut | Why |
|---|---|
| **Live-key verification** | I built this without provider API keys. Every adapter is covered by fixture tests built from the vendors' documented wire formats, and the whole chat/tool/RAG path was verified end to end against a mock upstream that speaks the Anthropic protocol. **Nothing here has been run against a live provider.** Per §7 of the brief, that is stated plainly rather than implied otherwise. |
| **OCR for scanned PDFs** | A PDF with no text layer is rejected with a clear message. OCR is a different problem (and a much heavier dependency) than retrieval. |
| **Real authentication** | A tenant API key stands in for auth, as the brief permits. What I did spend effort on is the *enforcement model* behind it — see DESIGN.md §4. |
| **Distributed rate limiting** | The limiter is an in-memory token bucket: correct for one process, wrong for several. Redis or the edge is the production answer. Flagged in code, not hidden. |
| **Async ingestion queue** | Ingestion is synchronous per file. A queue is more production-shaped but makes failure modes invisible in a live walkthrough. Failures are recorded on the document row rather than swallowed. |
| **ANN vector index** | Brute-force scan over Float32 blobs: exact, no index build, no second system to keep consistent. It is O(n) and stops being right somewhere around 10^5 chunks per collection — which is why `VectorStore` is an interface. |
| **Evaluation harness, reranking** | Genuinely interesting, and the two extras I most wanted. They lost to finishing the five modules properly. |
| **Image input** | The contract carries image blocks and the adapters translate them for all five providers. There is no upload button, so it is reachable by API only. |
| **Postgres row-level security** | SQLite has no RLS, so I built the closest structural equivalent (DESIGN.md §4) and documented the migration path rather than pretending SQLite can do it. |

---

## Architecture in one paragraph

An HTTP request resolves a tenant from a hashed API key and runs the rest of its
life inside an `AsyncLocalStorage` tenant context. Feature modules (chat, RAG,
tools, metrics) speak only the internal contract in `src/core/types.ts`. All
model calls funnel through one gateway that owns retry, fallback, cost caps,
cancellation and usage recording. Below it, adapters translate to and from vendor
shapes — the only place in the codebase that knows a vendor exists. Data access
goes through a guarded layer that refuses any SQL touching tenant data without a
tenant predicate, over a schema whose composite foreign keys make a cross-tenant
reference impossible at the database level.

Full diagrams, the request lifecycle, the decision log and the security posture
are in [`docs/DESIGN.md`](docs/DESIGN.md).

---

## Repository map

```
config/
  models.json          model catalog: context, capabilities, pricing, retrieval defaults
  providers.json       base URLs, key env names, timeouts, per-provider quirks
  app.json             retry policy, fallback chains, RAG defaults, limits, tools
packages/server/src/
  core/                the contract, registry, config, errors, gateway, retry, pricing, tokens
  providers/           one file per provider (+ _shared/ for HTTP, SSE, tool args, OAI-compatible base)
  tenancy/             ambient tenant context, SQL guard, tenant records
  db/                  schema.sql, guarded data access, seed
  modules/
    chat/              turn orchestration, tool loop, context-window handling, persistence
    rag/               extract, chunk, embed, store, retrieve, grounded prompt
    tools/             registry + calculator, get_weather, search_documents
    metrics/           usage records and aggregates
    cache/             semantic cache
    structured/        structured output with validation
    compare/           concurrent multi-model comparison
  http/                routes, middleware, SSE transport
packages/server/test/  179 tests; adapters driven by recorded fixtures
packages/web/src/      React UI
```

---

## Security posture in brief

No secrets in the repo; `.env` is gitignored and `.env.example` ships. API keys
never reach the client, and raw upstream error bodies never leave the server —
`ProviderError.toClient()` deliberately drops them. Uploads are validated by
magic bytes rather than the declared content type, held in memory (never written
to disk), and size/count capped. The calculator is a real parser, not `eval` in
disguise. Retrieved document content is treated as untrusted data throughout.
Every request body is schema-validated; unknown keys are stripped. Logs redact
vendor key shapes and secret-looking fields.

The full list, including what I consciously left out and what I would add before
production, is DESIGN.md §5.

---

## Notes for the walkthrough

The two things I would most like to be asked about: `src/tenancy/guard.ts`
(why the boundary is structural rather than conventional, and what it still
cannot catch) and `src/providers/google.provider.ts` (`toGeminiSchema`, and why
it is an allow-list translator rather than a filter).

`docs/AI_USAGE.md` records what I used AI for and, more usefully, where I had to
correct it.
