# Provider notes

The concrete differences between the five APIs, where each one bit, and how the
abstraction absorbed it. Ordered roughly by how much damage each does if you get
it wrong.

Implemented: **Anthropic**, **Google Gemini**, **OpenAI**, **Groq**, **DeepSeek**,
plus a local offline embedder. All over plain `fetch` — no vendor SDKs, no
abstraction framework.

---

## 1. Token accounting, and the bug that costs you 90%

The single most expensive difference, and the one you cannot see without reading
the docs carefully, because every provider returns plausible-looking numbers.

| Provider | Field | Does `input`/`prompt` include cached tokens? |
|---|---|---|
| Anthropic | `usage.input_tokens` | **No.** `cache_read_input_tokens` and `cache_creation_input_tokens` are *separate, non-overlapping* buckets. |
| Gemini | `usageMetadata.promptTokenCount` | **Yes.** `cachedContentTokenCount` is a subset. |
| OpenAI / Groq | `usage.prompt_tokens` | **Yes.** `prompt_tokens_details.cached_tokens` is a subset. |
| DeepSeek | `usage.prompt_tokens` | **Yes**, and it equals `prompt_cache_hit_tokens + prompt_cache_miss_tokens`. Note the field names differ from OpenAI's entirely. |

So on a request with 100 fresh + 900 cached tokens, Anthropic reports
`input_tokens: 100` and everyone else reports `1000`. Bill straight off
`input_tokens` and you under-report Anthropic's cached workloads by up to 90%,
and — worse — the error scales with how *well* your caching works.

**Reconciled** by making the contract unambiguous: `Usage.inputTokens` is always
the *total* prompt size, and `cachedInputTokens` / `cacheWriteTokens` are subsets
of it. `anthropic.provider.ts → mapUsage()` adds the three buckets before the
usage leaves the adapter. `core/pricing.ts` therefore has no vendor branch — it
computes `fresh = input − cached − written` and prices each bucket. Asserted in
`test/core.test.ts → "bills Anthropic cache reads and writes at their own rates"`.

Two more accounting traps:

- **Gemini's `candidatesTokenCount` excludes thinking tokens.** `thoughtsTokenCount`
  is reported separately but is *billed as output*. We fold it into `outputTokens`
  and also surface it as `reasoningTokens`.
- **OpenAI omits `usage` entirely from streamed responses** unless you send
  `stream_options: {include_usage: true}`. Miss it and every streamed request
  silently costs $0.00 in your own metrics. DeepSeek rejects that parameter, so it
  is a per-provider quirk flag; Groq sometimes puts final usage in `x_groq.usage`
  instead, so the shared base reads both.

---

## 2. Where the system prompt goes

Three different answers, which is why the contract keeps `system` top-level and
makes it the adapter's problem.

| Provider | Shape |
|---|---|
| Anthropic | Top-level `system`, a string **or** an array of content blocks (needed for `cache_control`). |
| Gemini | `systemInstruction: { parts: [{ text }] }` — a `Content` object, not a string. |
| OpenAI / Groq / DeepSeek | No top-level field; a leading `{ role: 'system' }` message. |

Anthropic's array form is what makes prompt caching possible: a long system
prompt (RAG context, tool preamble) gets
`cache_control: { type: 'ephemeral' }` above a configurable character threshold.
Short prompts stay as a plain string, because marking a 200-character system
prompt cacheable costs a cache *write* at a premium and saves nothing.

---

## 3. Roles and content shape

| | Anthropic | Gemini | OpenAI-compatible |
|---|---|---|---|
| Assistant role | `assistant` | **`model`** | `assistant` |
| Tool role | **none** | **none** | `tool` |
| Container | `content: [block]` | `parts: [part]` | `content: string \| [part]` |
| Text | `{type:'text', text}` | `{text}` | `{type:'text', text}` |
| Image | `{type:'image', source:{type:'base64', media_type, data}}` | `{inlineData:{mimeType, data}}` | `{type:'image_url', image_url:{url:'data:...'}}` |
| Tool call | `{type:'tool_use', id, name, input}` | `{functionCall:{name, args}}` | `tool_calls:[{id, function:{name, arguments}}]` |
| Tool result | `{type:'tool_result', tool_use_id, content, is_error}` **inside a user message** | `{functionResponse:{name, response}}` inside a user turn | its own `{role:'tool', tool_call_id, content}` message |

Consequences the adapters absorb:

- **Anthropic has no tool role**, so *N* parallel tool results collapse into **one**
  user turn. OpenAI wants **N separate messages**. Same internal `Message`, two
  different fan-out rules.
- **OpenAI serializes tool arguments as a JSON *string***; Anthropic and Gemini use
  an object. Forgetting to `JSON.stringify` on the way back in produces a 400 that
  reads like a schema problem.
- **Assistant messages that only call a tool** need `content: null` on the OpenAI
  surface — omitting the key is not the same thing.
- **Anthropic rejects empty text blocks**, and rejects trailing whitespace on a
  final assistant turn (it reads as a prefill continuation). Both are stripped.
- **Anthropic wants a conversation to open with a user turn.** When history has
  been compacted down to an assistant message, the adapter prepends one.
- **Gemini has no `is_error`** on `functionResponse`, so a failed tool is flagged
  in-band as `{ error: "..." }` rather than `{ result: "..." }`.

### Gemini's `functionResponse` is keyed by NAME, not by call id

This is the divergence most likely to cause a silent wrong answer rather than an
error. Anthropic and OpenAI correlate a tool result to its call by id
(`tool_use_id` / `tool_call_id`). Gemini's `functionResponse` carries a `name`.

Our contract keys results by `toolUseId`, so `toGeminiContents()` walks the
message history building an id → name index and recovers the name from the
originating `tool_use` block. Without it, results attach to the wrong tool with no
error anywhere. Tested explicitly in
`test/google.adapter.test.ts → "recovers the function NAME for a tool result"`.

(Gemini does accept an optional `id` on both sides; we send it when we have one,
but we cannot rely on it round-tripping, so name recovery is the primary
mechanism and `id` is belt-and-braces.)

### Gemini 3 requires its own `thought_signature` handed back verbatim

The single most expensive divergence I hit, because it is invisible right up to
the moment it is not. Gemini 3 attaches an opaque `thoughtSignature` to every
`functionCall` part it emits. Replay that tool call on the next turn without it
and the request fails:

```
400  Function call is missing a thought_signature in functionCall parts.
     This is required for tools to work correctly, and missing
     thought_signature will result in degraded model performance.
```

Note what this breaks. The *first* leg of a tool turn succeeds: the model asks for
a tool and the tools stream perfectly. The failure lands on the second leg, when
the results are fed back — so every single-shot call looks fine and every
multi-turn tool loop dies, which is all of Module D on Gemini. No other provider
has anything like it, and nothing in the brief's contract has a place to put it.

The fix is the smallest hole I could cut in the shared contract:
`ContentBlock.providerMetadata`, a map keyed by provider name holding opaque
vendor tokens. The Gemini adapter writes `{ google: { thoughtSignature } }` when
it reads a `functionCall`, and reads it back when it writes one. Two properties
matter:

- **It is namespaced.** Module B lets a conversation change provider between
  turns, so a `tool_use` block replayed into Gemini may well have been minted by
  Anthropic. The adapter looks under `google` and finds nothing, rather than
  handing a foreign blob to the vendor.
- **Nothing above the adapter reads it.** The chat service carries it from the
  stream event onto the persisted assistant message without inspecting it, and it
  is deliberately not forwarded to the browser.

Tested in `test/google.adapter.test.ts` — both that the signature round-trips, and
that another vendor's metadata is *not* attached to a Gemini function call.

---

## 4. Tool schemas: JSON Schema vs "JSON-Schema-ish"

| Provider | Field | Dialect |
|---|---|---|
| Anthropic | `tools[].input_schema` | JSON Schema |
| OpenAI / Groq / DeepSeek | `tools[].function.parameters` | JSON Schema |
| Gemini | `tools[].functionDeclarations[].parameters` | **OpenAPI 3.0 `Schema`** |

Anthropic just renames the field. Gemini needs a translation, and it is not
cosmetic:

- **Types are UPPERCASE**: `"string"` → `"STRING"`.
- **`additionalProperties` is a hard error**, not an ignored keyword. So are
  `$schema`, `$ref`, `$defs`, `const`, `patternProperties`, `allOf`, `not`.
- **`format` is restricted** to `enum` and `date-time` on strings.
- **`minItems`/`maxItems` are strings**, not numbers.
- **`oneOf` does not exist**; `anyOf` is the closest honest mapping.
- **A union type** `["string","null"]` becomes `type: "STRING", nullable: true`.
- **`{"type":"OBJECT","properties":{}}` is rejected** — a zero-argument tool must
  omit `parameters` entirely.

`toGeminiSchema()` is written as an **allow-list translator**, not a filter: it
builds the output from keys it understands and drops everything else. That is a
deliberate choice. A filter has to enumerate what to remove and therefore breaks
the first time a caller uses a keyword nobody thought of — and the failure is a
400 the caller cannot act on, because they wrote *valid JSON Schema*.

The mirror-image problem is OpenAI **strict** mode, which requires
`additionalProperties: false` on every object and every property listed in
`required` (optionality is expressed by unioning with null). `strictifySchema()`
performs that transform so callers write one ordinary schema.

Tool-choice vocabulary differs too: "you must call some tool" is `required` on
OpenAI, **`any`** on Anthropic, and `mode: 'ANY'` in Gemini's
`toolConfig.functionCallingConfig`.

---

## 5. Streaming

Three different event models. The contract flattens all of them to
`text_delta` / `tool_use_start` / `tool_use_delta` / `tool_use_complete` /
`usage` / `done`.

**Anthropic** is the most structured: named SSE events
(`message_start`, `content_block_start`, `content_block_delta`,
`content_block_stop`, `message_delta`, `message_stop`, `ping`, `error`), with
content blocks addressed by **array index**. Usage is split across two events —
`message_start` carries the input side, `message_delta` the output side — so the
adapter merges them and emits `usage` once. Tool arguments arrive as
`input_json_delta.partial_json` fragments, often a few characters at a time.

**OpenAI-compatible** has one anonymous chunk shape, terminated by a literal
`data: [DONE]`. The trap is in `tool_calls`: **only the first chunk for a given
call carries `id` and `function.name`**; every continuation carries *only*
`index` and an arguments fragment. The accumulator therefore keeps an
index → id map for the life of the message. There is also **no per-tool stop
event** — arguments are complete only when `finish_reason` arrives.

**Gemini** needs `?alt=sse` (without it you get a streamed JSON *array*), and then
the biggest behavioural difference of the three: **function-call arguments are not
streamed at all**. The whole `args` object lands in one chunk. Rather than let
that leak upward as "sometimes you get deltas, sometimes you don't", the adapter
**synthesizes** `tool_use_start` → `tool_use_delta` → `tool_use_complete` so every
consumer has exactly one code path. Gemini's `usageMetadata` is also *cumulative*
and repeats on every chunk, so last-one-wins rather than summing.

### The SSE parser itself

Hand-rolled (`_shared/sse.ts`), because these four behaviours all show up in
practice and a naive `split('\n\n')` on each chunk gets three of them wrong:

- a frame split across two TCP chunks (very common under load);
- CRLF line endings (Anthropic through some proxies);
- multi-line `data:` that must be joined with `\n`;
- comment heartbeats (`: ping`) — Groq sends these;
- a trailing frame with no terminating blank line at end-of-stream.

### Accumulating tool arguments

Fragments are concatenated per tool-use id and parsed **once**, at completion. No
partial-JSON repair: a half-written argument object is not a smaller version of
the real one, it is a *different* one. When the final parse fails, we return
`{_parse_error: true}` and the tool loop feeds that back to the model as a tool
error so it can retry with valid JSON — which is a far better outcome than a
crashed turn or a silently wrong argument.

---

## 6. Structured output: four mechanisms, one interface

| Provider | Mechanism | Enforced upstream? |
|---|---|---|
| OpenAI, Groq | `response_format: {type:'json_schema', strict:true}` | Yes |
| Gemini | `generationConfig.responseSchema` | Yes |
| Anthropic | Tool-forcing: declare the schema as one tool, `tool_choice: {type:'tool'}` | Yes |
| DeepSeek | `response_format: {type:'json_object'}` + schema in the prompt | **No** |

`CompletionResponse.structuredMode` reports which one was used, so the caller
knows whether a schema was actually enforced. Two things this taught me:

- **Anthropic's answer arrives as tool *input*, not text.** The extraction layer
  reads `tool_use.input` when present rather than parsing the text body.
- **Validation must run for all four.** "The provider promised" is not a
  validation strategy: strict mode can still return a refusal object, and Gemini
  will happily put a number where the schema said string. `modules/structured`
  validates every response and, on failure, retries **once** with the specific
  validator errors fed back. Retrying blind usually reproduces the same mistake.
- **Gemini cannot combine `responseSchema` with `functionDeclarations`** in one
  call. The adapter refuses that combination up front with an `unsupported` error
  rather than letting the vendor 400.

---

## 7. Errors

HTTP status alone is not enough; every vendor puts the real classification in the
body, and two of them use the same status for very different problems.

| Case | Status | Where the truth is |
|---|---|---|
| Anthropic, prompt too long | **400** `invalid_request_error` | The *message* ("prompt is too long"). Classified as `bad_request` by status alone — and then truncation never runs. |
| Gemini, token overflow | **400** `INVALID_ARGUMENT` | Same problem; matched on "token count … exceeds". |
| OpenAI, out of credit | **429** `insufficient_quota` | Looks like a rate limit, **is not retryable**. Classified as `auth`, because retrying a billing problem just burns the rate limit. |
| Anthropic, overloaded | 529 `overloaded_error` | Mapped to `rate_limit` (retryable), not `server_error`. |
| Gemini | any | `error.status` is a gRPC name (`RESOURCE_EXHAUSTED`, `UNAUTHENTICATED`, `FAILED_PRECONDITION`), not an HTTP-shaped code. |

So each adapter supplies a `classify()` hook that refines the generic status
mapping using its vendor's own envelope.

**`Retry-After` has three formats in the wild** and we parse all of them: integer
seconds, a float (Groq sends `1.5`), a Go-style duration on the reset headers
(`6m0s`), and an HTTP-date. Whatever the provider says is honoured but capped
(`retry.maxRetryAfterMs`), so one provider's "try again in 6 minutes" cannot pin a
request open past its own timeout budget.

**Cancel and timeout must stay distinguishable.** `AbortSignal.any([callerSignal,
AbortSignal.timeout(ms)])` propagates the *reason* of whichever fired, so an
`AbortError` becomes `cancelled` (never retried, no error shown to the user) and a
`TimeoutError` becomes `timeout` (retryable). Conflating them either retries work
the user cancelled or hides a real timeout.

---

## 8. Capability variance *inside* one provider

Capabilities are per **model**, not per provider, and assuming otherwise breaks in
production:

- **`temperature` is deprecated on Anthropic's newest models but not its older
  ones.** Claude Sonnet 5 and Opus 5 answer a request carrying `temperature: 0.2`
  with a 400 — `` `temperature` is deprecated for this model `` — while Haiku 4.5,
  Sonnet 4.5, Sonnet 4.6 and Opus 4.5 accept the identical request through the
  *same adapter*. Verified model by model against the live API:

  | Model | `temperature: 0.2` | omitted |
  |---|---|---|
  | claude-haiku-4-5 | ok | ok |
  | claude-sonnet-4-5 | ok | ok |
  | claude-opus-4-5 | ok | ok |
  | claude-sonnet-5 | **400** | ok |
  | claude-opus-5 | **400** | ok |

  This cannot live in the adapter, because the adapter is the same for all five.
  It is `capabilities.temperature: false` in `config/models.json`, and the gateway
  strips the parameter when it binds a request to a concrete model — on *every*
  hop, so a fallback that lands on a stricter model does not resurrect the 400.
- **`groq/compound-mini` rejects user-defined tools** (`` `tool calling` is not
  supported with this model ``) because it ships Groq's own built-in ones.
  Declared as `capabilities.tools: false` in `config/models.json`; the adapter
  raises `unsupported` before anything is sent, and the chat UI degrades to a
  tool-free turn with an explanation rather than a vendor 400. DeepSeek's
  retired `deepseek-reasoner` used to be this example; its replacements both
  support function calling, which is itself the argument for keeping the flag in
  config rather than in code.
- **OpenAI reasoning models** rename `max_tokens` to `max_completion_tokens` and
  **reject a non-default `temperature`** outright (a 400, not a warning).
  Keyed off `capabilities.reasoning` in the adapter.
- **Groq's `openai/gpt-oss-*`** models also require `max_completion_tokens`.
- **Groq has no `/embeddings` endpoint** at all; DeepSeek likewise. Declared via
  `supportsEmbeddings`, surfaced as `unsupported` rather than a 404.

---

## 9. Embeddings

- **OpenAI** `/embeddings` accepts a batch and supports a `dimensions` parameter
  (Matryoshka truncation). **`data` is not guaranteed to come back in request
  order** — it carries an `index` you must sort by. Getting this wrong misattributes
  every vector in the batch to the wrong chunk, and nothing errors.
- **Gemini** uses `:batchEmbedContents` with a per-request `taskType`
  (`RETRIEVAL_QUERY` vs `RETRIEVAL_DOCUMENT`) — queries and documents are embedded
  *differently*, which OpenAI does not do. It also **reports no token usage**, so
  we estimate from characters rather than showing a misleading $0.00.
- **Gemini's embedding models accept `outputDimensionality`**, and the width you
  ask for is the width you must keep: `gemini-embedding-2` will return 3072, 1536
  or 768 for the same text. The collection records the width it was built with,
  because a later call at a different width produces vectors that are silently
  incomparable with the ones already stored.
- **Cosine scores are not comparable across models.** Measured here on the same
  query/passage pair: ~0.73 on `gemini-embedding-2`, ~0.40 on our local hashed
  embedder. A single global threshold is wrong for at least one of them — at 0.55
  the local embedder returns nothing; at 0.15 Gemini returns everything. This is why
  the similarity threshold lives on the *model* in `config/models.json` and why
  a collection pins its embedding model at creation: mixing vectors from two
  models produces meaningless similarity with no error anywhere.

---

## 10. Pricing

All prices are USD per 1,000,000 tokens and live in `config/models.json` —
nothing is hardcoded in TypeScript, so refreshing them is a config edit and a
restart.

**Every number was read off the vendor's own pricing page on the date recorded as
`pricingCheckedOn` in `config/models.json` (currently `2026-09-17`).** The
`pricingSources` block records the URL each provider's figures came from:

| Provider | Source |
|---|---|
| Anthropic | <https://platform.claude.com/docs/en/about-claude/pricing> |
| Google | <https://ai.google.dev/gemini-api/docs/pricing> |
| OpenAI | <https://developers.openai.com/api/docs/pricing> |
| Groq | <https://console.groq.com/docs/models> |
| DeepSeek | <https://api-docs.deepseek.com/quick_start/pricing> |

A model catalog is a perishable good, and this one proved it. Between writing the
adapters and finishing the docs: Gemini's entire 2.5 generation stopped serving
new API keys (`"This model is no longer available to new users. Please update
your code to use models/gemini-3.6-flash"`), Groq decommissioned both Llama
entries, Anthropic retired Opus 4.1 and Haiku 3.5 from the first-party API, and
DeepSeek replaced `deepseek-chat`/`deepseek-reasoner` wholesale with
`deepseek-flash`/`deepseek-v4-pro` at different prices and a 1M context. Each of
those was a `config/models.json` edit with no TypeScript touched, which is the
strongest argument I have for why the catalog is configuration.

Caveats that a single number per model does not capture, and which a production
system would need:

- **Gemini 3.1 Pro is tiered** — input and output both rise above a 200k-token
  prompt. We encode the lower tier, so long-context requests are *under*-reported.
- **Gemini 3.8/3.6 Flash carry promotional pricing** that doubles on 2027-01-01.
  We encode today's rate; the config will be wrong on that date unless refreshed.
- **Anthropic cache writes cost more than fresh input** (1.25× for a 5-minute TTL,
  2× for an hour). We encode the 5-minute rate; `cacheWritePerMTok` exists for
  exactly this reason.
- **Batch APIs are ~50% cheaper** on several providers. Not modelled — we make no
  batch calls.
- **DeepSeek prices off-peak at roughly half of peak**; there is no time-of-day
  dimension here, so we encode the peak (higher) rate and over-report off-peak.
- **Groq's free tier is $0** but rate-limited; we price at the paid rate, so a
  free-tier reviewer will see costs that were not actually charged. The same is
  true of Gemini's free tier, which additionally caps some models at a handful of
  requests — `gemini-3.8-flash` returned `RESOURCE_EXHAUSTED` after five calls
  during testing, which is what the fallback chain is for.
- **`groq/compound-mini` is billed at its underlying model's rate**, not its own;
  it is in the catalog because it rejects user-defined tools and is therefore the
  live case for graceful degradation.

Where a model reports cached tokens but publishes no cached rate (Groq), the
breakdown is flagged `approximated: true` and billed at the full input rate rather
than silently free.

---

## 11. Smaller things that cost me time

- **`?alt=sse` on Gemini.** Without it, `streamGenerateContent` returns a streamed
  JSON array, not SSE, and a naive SSE parser sees nothing at all.
- **Gemini's API key belongs in the `x-goog-api-key` header,** not `?key=`. Query
  strings end up in proxy and CDN logs.
- **Anthropic requires `max_tokens`.** It is optional everywhere else. The adapter
  falls back to the model's own ceiling from config so no caller has to know.
- **`data: [DONE]`** is an OpenAI-ism. Anthropic and Gemini just end the stream.
- **Groq's error body for a 429** contains a human-readable "try again in 6m0s"
  and the machine-readable value is in the header — parse the header.
- **A 502 from a gateway in front of a provider is HTML, not JSON.** The shared
  HTTP layer drains and parses defensively, falling back to raw text.
- **Anthropic's `stop_reason: 'pause_turn'`** (long-running server tools) maps to
  `tool_use`, not `stop` — treating it as `stop` truncates the turn.
- **Empty `parts`/`content` arrays are rejected** by Gemini and Anthropic. After
  filtering empty text blocks you have to drop the whole message, not send an
  empty one.
