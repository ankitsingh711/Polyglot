# Polyglot

A multi-provider, multi-tenant AI workbench. One internal contract; five provider
adapters behind it; chat with real streaming, retrieval with citations, tool
calling, and per-request cost and latency accounting — all scoped to a tenant
boundary that the database itself enforces.

```
packages/server   Node + TypeScript + Express 5 + SQLite (better-sqlite3)
packages/web      React 19 + Vite — light theme, self-hosted Inter/JetBrains Mono
config/           models, pricing, providers, retry, fallback, RAG defaults
docs/             ARCHITECTURE.md · DESIGN.md · PROVIDER_NOTES.md · AI_USAGE.md
```

The interface is built around the thing this product is for: a header showing
which provider keys are configured, a context column, the work, a details panel, and a
**permanent telemetry bar** along the bottom showing spend today, request count,
average latency and TTFT. Cost and provenance are not buried in a tab you have to
remember to open. Each provider has a fixed colour that identifies it everywhere
it appears — header dot, the left edge of its messages, its comparison lane, its
metrics row — so a dense table is scannable without reading a label.

---

## Setup

Requires Node 22.12+ (developed on 24 — Vite 8 and Vitest 5 set that floor).
No database server, no keys required to boot.

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
npm test          # 237 tests, no network
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

Everything above has been run against live Anthropic, Gemini and Groq keys, and
is also pinned down by the test suite: `test/http.app.test.ts` boots the real
Express app and drives these paths — SSE token streaming, persistence, tenant
isolation and cancellation — over a real socket against a fixture upstream, so
they are reproducible without an API key.

### Run it in Docker

```bash
cp .env.example .env          # add your keys
docker compose up --build     # single origin, UI + API on :8787
```

The image builds both workspaces and serves the built SPA from the API process
(`SERVE_WEB_DIR`), so there is one container and one port.

---

## What I implemented

### Providers (Module A) — 5 of the 5 offered

| Provider | Chat | Stream | Tools | Structured output | Embeddings | Verified against a live key |
|---|---|---|---|---|---|---|
| **Anthropic** | ✅ | ✅ | ✅ | tool-forcing | — | **yes** — Haiku 4.5, Sonnet 4.5, Sonnet 5, Opus 4.5 |
| **Google Gemini** | ✅ | ✅ | ✅ | `responseSchema` | ✅ | **yes** — 3.8 Flash, 3.5/3.1 Flash-Lite, embedding-2 |
| **Groq** | ✅ | ✅ | ✅ | native `json_schema` | — | **yes** — GPT-OSS 120B/20B, Qwen3.8 27B |
| **OpenAI** | ✅ | ✅ | ✅ | native `json_schema` | ✅ | no key — recorded-fixture tests only |
| **DeepSeek** | ✅ | ✅ | ✅ | `json_object` + validate + retry | — | no key — recorded-fixture tests only |
| *local (offline embedder)* | — | — | — | — | ✅ | n/a |

Per §7 of the brief: OpenAI and DeepSeek are implemented fully and proved by
recorded-fixture tests of the request/response mapping, but I have no key for
either, so **those two adapters have never made a real call.** Run them with your
own keys and they should work; I would not claim more than that.

Plain `fetch` throughout, no vendor SDKs and no abstraction framework. See
[`docs/PROVIDER_NOTES.md`](docs/PROVIDER_NOTES.md) for the concrete differences
between these APIs and how each one was reconciled — that document is the real
answer to "do you understand these providers".

### Modules

- **A — Provider abstraction.** Done, and protected above everything else.
  Adding a provider is one file in `src/providers/` plus config entries; the
  registry discovers adapters by scanning the directory, so no index, switch or
  DI wiring exists to edit. Two tests enforce this rather than just asserting it.
  Capabilities that differ *per model* rather than per vendor — tool support, and
  whether the model still accepts `temperature` — are config flags the gateway
  applies on every hop, including after a fallback.
- **B — Chat.** Done. Token-by-token SSE, provider/model switching mid-conversation,
  SQLite persistence, cancel that aborts the upstream socket, and an explicit
  documented context-overflow strategy (summarize, configurable to truncate/reject).
- **C — RAG.** Done. PDF/TXT/MD, structure-aware chunking with sentence-level
  overlap, hybrid retrieval (dense + BM25 fused with RRF), inline citations that
  open the exact chunk, runtime-tunable parameters, and a real "I don't know"
  path that short-circuits before any model call.
- **D — Tool calling.** Done. Three tools, one definition format, translated per
  vendor. Verified live on Anthropic, Gemini and Groq (the brief asks for two,
  one of which must be Anthropic or Gemini); implemented and fixture-tested on
  OpenAI and DeepSeek. Multi-turn loop with parallel and sequential calls;
  arguments accumulated from streamed fragments; graceful degradation with an
  explanation when a model cannot do tools — `groq:compound-mini` is the live
  case, since it ships Groq's own built-in tools and rejects user-defined ones.
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
| **Live keys for OpenAI and DeepSeek** | Those two adapters are complete and covered by recorded-fixture tests of their wire mapping, but I have no key for either and have never made a real call with them. Anthropic, Gemini and Groq *are* verified live — see the table above. Per §7 of the brief, stated plainly rather than implied otherwise. |
| **OCR for scanned PDFs** | A PDF with no text layer is rejected with a clear message. OCR is a different problem (and a much heavier dependency) than retrieval. |
| **Real authentication** | A tenant API key stands in for auth, as the brief permits. What I did spend effort on is the *enforcement model* behind it — see DESIGN.md §4. |
| **Distributed rate limiting** | The limiter is an in-memory token bucket: correct for one process, wrong for several. Redis or the edge is the production answer. Flagged in code, not hidden. |
| **Async ingestion queue** | Ingestion is synchronous per file. A queue is more production-shaped but makes failure modes invisible in a live walkthrough. Failures are recorded on the document row rather than swallowed. |
| **ANN vector index** | Brute-force scan over Float32 blobs: exact, no index build, no second system to keep consistent. It is O(n) and stops being right somewhere around 10^5 chunks per collection — which is why `VectorStore` is an interface. |
| **Evaluation harness, reranking** | Genuinely interesting, and the two extras I most wanted. They lost to finishing the five modules properly. |
| **Image input** | The contract carries image blocks and the adapters translate them for all five providers. There is no upload button, so it is reachable by API only. |
| **A pinned model catalog** | Vendors retire models faster than a take-home lives. Building this, Gemini 2.5 closed to new keys mid-review, Groq decommissioned both Llama entries, and DeepSeek replaced its whole lineup. `config/models.json` is current as of the date in `pricingCheckedOn`, and every id in it was called for real where a key existed — but it *is* a snapshot, and refreshing it is a config edit, not a code change. |
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

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) is the map — system context, the module
layering, the request lifecycle, the tenant boundary, the RAG pipeline and a proposed
AWS topology, as diagrams. [`docs/DESIGN.md`](docs/DESIGN.md) is the decision record:
what was chosen, what was rejected, and why.

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
packages/server/test/  237 tests; adapters and the HTTP layer driven by recorded fixtures
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

The three things I would most like to be asked about: `src/tenancy/guard.ts`
(why the boundary is structural rather than conventional, and what it still
cannot catch); `src/providers/google.provider.ts` (`toGeminiSchema`, and why it
is an allow-list translator rather than a filter); and `ContentBlock.providerMetadata`
(the smallest change to the shared contract that makes Gemini 3's
`thoughtSignature` survive a multi-turn tool loop without any other layer
learning that Google exists).

`docs/AI_USAGE.md` records what I used AI for and, more usefully, where I had to
correct it.
