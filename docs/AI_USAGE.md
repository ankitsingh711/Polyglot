# AI usage

## What I used

**Claude Code (Opus)** for the bulk of the implementation, driven from a terminal
against this repository. I used it the way I would use a very fast pair: I decided
the architecture and the trade-offs, described what I wanted in enough detail to
be unambiguous, read everything it produced, and rejected or rewrote the parts
that were wrong.

I did **not** use any provider-abstraction framework, and I did not paste in
generated code I could not explain. Everything in this repository is code I can
walk through, change under time pressure, and defend — which is the bar §11 of the
brief sets, and the reason the sections below matter more than the section above.

## Where it helped most

- **Mechanical breadth.** Five adapters, a schema, a test suite and a UI is a lot
  of typing. Getting a first draft of each in minutes meant the week went into the
  parts that needed judgement instead of the parts that needed keystrokes.
- **Wire-format recall.** Enumerating the shape of `content_block_delta` vs
  `tool_calls[i].function.arguments` vs `parts[].functionCall`, and the fiddly
  spellings around them. I checked each against the vendor docs; more on that below.
- **Test enumeration.** Given "test the tool-argument accumulator", it proposed
  cases I would have got to eventually (fragment boundaries, index-only
  continuation chunks, empty arguments) and some I would not have bothered with
  (a trailing SSE frame with no terminating blank line) — which later caught a real
  parser bug.
- **Docs.** First drafts of these documents, which I then rewrote for accuracy —
  every claim here is one I verified against the code.

## Where I had to correct or reject it

This is the part worth reading. Roughly in descending order of how much damage
each would have done.

### 1. A streaming bug that silently disabled the entire product

The SSE transport originally registered the disconnect handler on the **request**:

```ts
req.on('close', () => abort());   // WRONG
```

It looks right, it is the pattern in a lot of tutorials, and it passed the unit
tests — which exercise the chat service directly, not over HTTP. In Node, for a
POST whose body has been fully read, `'close'` fires on the `IncomingMessage` as
soon as the body ends, which is microseconds after the handler starts. Every
stream was therefore aborted before it produced a token, and the upstream request
was never even made.

I only caught it because I refused to call streaming "done" without an end-to-end
run: a fixture upstream that speaks the Anthropic wire protocol, driven through
the real HTTP layer. The fix is `res.on('close')` guarded by `writableFinished`.

The tail of this one is the more useful part. I fixed the SSE transport and moved
on — and left the identical `req.on('close')` in the three non-SSE routes that
also do upstream work (document ingest, retrieval search, structured extraction),
where it had exactly the same effect: structured output returned
`{"code":"cancelled"}` 100% of the time on every provider, and ingestion failed
for any real embedding provider. It survived because the local offline embedder
never checks the signal, so the one path I happened to exercise looked fine.

Two changes came out of that. The abort signal is now one helper
(`abortOnClientDisconnect`) instead of a pattern people re-type, and the fixture
upstream became a committed test file — `test/http.app.test.ts` boots the real
Express app and drives streaming, persistence, tenant isolation and cancellation
over a real socket. Before that, the entire `src/http/` layer had no tests at all,
which is precisely why a bug in it could survive being "fixed".

**Lesson I would repeat:** the model is good at code that looks like other code.
It is not good at runtime behaviour peculiar to one stack, and unit tests that
mock the boundary will agree with it.

### 2. Pricing and model facts — I did not trust these at all

I treated every price, context window and model id as unverified. The assistant
produces confident, plausible, sometimes stale numbers, and a wrong price is a
silent error that only shows up on an invoice.

Two consequences in the design: pricing lives entirely in `config/models.json`
with a `pricingCheckedOn` date and a `pricingSources` URL per provider, so
refreshing it is a config edit rather than a code change; and
`docs/PROVIDER_NOTES.md §10` states plainly that these numbers were not
re-verified against live pricing pages during this build, along with the modelling
caveats (tiered pricing, cache-write surcharges, batch discounts) that a single
number per model cannot capture.

### 3. A global similarity threshold — right code, wrong model of the problem

The first retrieval implementation used one `similarityThreshold` from
`app.json` for every collection. That is what I asked for and it is what a lot of
RAG tutorials do, and it is wrong: a cosine score has no meaning in the absolute.
A relevant pair scores around 0.35 on `text-embedding-3-small`, around 0.7 on
`gemini-embedding-001`, and around 0.15 on the local hashed embedder.

I found it by actually running retrieval against a seeded document with the local
embedder, where a 0.28 threshold rejected every genuinely relevant chunk and
hybrid search silently covered for it via BM25 — the exact failure mode where the
system looks like it works. The fix moved the threshold onto the model in
`config/models.json`, with `app.json` as a fallback and per-request overrides from
the UI. That is now one of the design decisions I am happiest with, and it came
from measurement, not from the model.

### 4. Two real bugs caught by tests I asked for

- **`'1,000 * 3'` tokenized as two adjacent number tokens** in the calculator.
  Models emit grouped numbers constantly, so this would have fired in the first
  demo. The generated implementation skipped the comma inside the token loop but
  never merged the digits; the fix strips separators before tokenizing.
- **`toGeminiSchema` contained a dead loop** — a `for` over the dropped-keys set
  whose body was `continue`. Harmless, but it was there to make the code *look*
  like it used the set it declared. I removed it and exported the set — but for a
  while that was the same mistake wearing a hat: the set was exported and
  documented as "asserted in the adapter tests" while nothing imported it. It is
  now genuinely asserted, one `it.each` case per keyword, which is the only thing
  that makes a comment like that true.

### 5. Source files written with raw control bytes

Two files ended up containing literal NUL and C0 bytes where the source should
have carried the textual escapes (`\u0000` and friends). The regexes behaved
correctly, so nothing failed — but `git` classified `extract.ts` as **binary**,
which kills diffs and blame on the file that does upload validation and
prompt-injection stripping. That is the file a reviewer most needs to read.
Caught by scanning the tree for control bytes after noticing a `Bin 0 -> 5398
bytes` line in a commit stat.

### 6. Build-time assets it forgot existed

`tsc` only emits JavaScript, so `db/schema.sql` never reached `dist/` and
`npm run build && npm start` crashed on a missing file while `npm run dev` was
perfectly happy. Classic works-in-dev failure. Now there is an explicit
`copy-assets.mjs` step and I verified the production build boots.

### 7. Two silent UI bugs that only a real browser would show

I rebuilt the interface late in the project, and treated "it compiles and the
tests pass" as meaning nothing. Driving the running app in a real browser found
two failures that no amount of reading would have. (That was a debugging session,
not a committed harness — unlike the fixture upstream in §1, it left no artifact
in the repo, so what you can actually check here is the two fixes it produced:
the `overrides` block in the root `package.json` and the explicit `grid-column`
below 900px in `styles.css`.)

- **A duplicate React.** The page rendered a blank screen in production and
  nothing in the console except a *minified* React error. Unminified, it was "A
  React Element from an older version of React was rendered" — a stale hoisted
  `react@18.3.1` at the workspace root that `react-markdown` resolved to, while
  the app rendered with React 19. It only manifested when a message was actually
  displayed, which is why every earlier check had missed it. Fixed by pinning a
  single React with an `overrides` block. Worth noting the assistant confidently
  suggested several component-level causes first; the answer was `npm ls react`.
- **A grid that silently gave the canvas zero width.** Below 900px the sidebar
  becomes `position: fixed`, which removes it from the grid flow — so the
  remaining panels auto-placed one column to the left and the details panel took
  the entire viewport. Screenshots made it *look* like a styling problem; measuring
  the actual element widths at four breakpoints made it obvious in one line.
  Fixed by pinning each panel to an explicit `grid-column`.

The lesson is the same one as §1: the model writes code that looks like working
code, and only execution distinguishes the two.

### 8. Tests that asserted the wrong thing

Two test failures turned out to be bugs in the *tests*, not the code, and both
were worth the time:

- A test expected `section "Termination"` in the grounded prompt. The code strips
  quotes from that attribute so a filename or heading cannot close it and inject
  another attribute — the code was right and the assertion was wrong. I rewrote
  the test to assert the escaping behaviour explicitly.
- The architecture test that forbids branching on a provider name outside the
  adapters flagged `core/pricing.ts` — whose only match was a **comment** saying
  "that is why pricing has no `if (provider === 'anthropic')` branch". The test now
  strips comments first. A test that matches prose is a test that will be deleted
  the first time it cries wolf.

### 9. Things I directed rather than accepted

Several of the load-bearing decisions were mine against the grain of the first
proposal, and are the ones I would most want to be asked about:

- **The SQL guard.** The default suggestion was "always filter by `tenant_id` in
  the repository layer", which is convention, not enforcement — precisely what §4
  of the brief warns about. I specified a guard that refuses to *prepare* a
  statement touching tenant data without the predicate, binds the parameter itself,
  and fails closed on unclassified tables.
- **Composite foreign keys including `tenant_id`.** The natural schema is
  `id PRIMARY KEY` plus a `tenant_id` column. Making every PK `(tenant_id, id)` and
  every FK composite is what makes a cross-tenant reference impossible at the
  database level rather than merely unlikely.
- **Not sharing a base class across all five adapters.** The tidy-looking move is
  one base with hooks. I kept the OpenAI-compatible base for the three that share a
  surface and had Anthropic and Gemini implement `Provider` directly, because their
  divergences are structural and the abstraction would have leaked within a week.
- **Cold-stream-only retry.** Buffering a response so it can be replayed is fake
  streaming with extra memory.
- **Short-circuiting "I don't know" before any model call** when retrieval returns
  nothing above threshold, rather than sending an empty context and hoping the
  prompt holds.

## Honest summary

AI wrote most of the characters in this repository. It did not make any of the
decisions that the scoring rubric is actually about — the contract, the layering,
the enforcement model, what to cut — and left to itself it produced code that was
plausible and, in at least three places, quietly broken in ways that unit tests
agreed with.

What made the difference was not prompting. It was insisting on evidence: an
end-to-end run against a fixture upstream rather than a green unit suite;
measuring retrieval scores rather than accepting a threshold; scanning the
repository for control bytes; running the production build instead of the dev
server; and, once keys were available, calling every model in the catalog rather
than trusting that the ids still resolved — which is how I found that Gemini 2.5
had closed to new keys, that Sonnet 5 now rejects `temperature`, and that Gemini 3
will not accept a replayed tool call without its `thought_signature`.

Every one of the corrections above came from checking, and none came from reading
the code and thinking it looked fine — because it did look fine. The one I would
underline is the `req.on('close')` bug: I found it, fixed it, wrote a paragraph
about it in this file, and still left it in three other files, because I fixed the
instance instead of the class and had no test at the layer where it lived.
