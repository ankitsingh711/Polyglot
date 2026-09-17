-- Polyglot schema.
--
-- The tenant boundary is expressed three times on purpose:
--   1. every tenant-scoped table carries `tenant_id NOT NULL`;
--   2. every primary key is (tenant_id, id), so ids are only ever unique WITHIN
--      a tenant and a bare `WHERE id = ?` cannot silently match another tenant's row;
--   3. every foreign key is COMPOSITE and includes tenant_id, which makes a
--      cross-tenant reference structurally impossible — SQLite itself rejects
--      inserting a message into another tenant's conversation, with no application
--      code involved.
--
-- (3) is the part that matters. It means a leak requires defeating the database,
-- not merely forgetting a WHERE clause.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT    NOT NULL
);

-- ---------------------------------------------------------------------------
-- Global
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tenants (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  -- SHA-256 of the API key. The plaintext key is shown once, at seed time, and
  -- is never stored, logged or returned by any endpoint.
  api_key_hash      TEXT NOT NULL UNIQUE,
  daily_budget_usd  REAL,
  created_at        TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Chat
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS conversations (
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,
  title         TEXT NOT NULL,
  -- Optional RAG collection bound to this conversation.
  collection_id TEXT,
  system_prompt TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, collection_id) REFERENCES collections(tenant_id, id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS messages (
  tenant_id       TEXT NOT NULL,
  id              TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant','tool')),
  -- Provider-agnostic ContentBlock[]; the vendor shape is never persisted.
  content_json    TEXT NOT NULL,
  -- Reasoning is stored OUT of content on purpose: DeepSeek rejects requests
  -- that echo `reasoning_content` back, and replaying it would corrupt the turn.
  reasoning       TEXT,
  model_id        TEXT,
  provider        TEXT,
  citations_json  TEXT,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages (tenant_id, conversation_id, seq);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations (tenant_id, updated_at DESC);

-- ---------------------------------------------------------------------------
-- Retrieval
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS collections (
  tenant_id        TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id               TEXT NOT NULL,
  name             TEXT NOT NULL,
  -- Retrieval settings are per collection so they can be tuned from the UI
  -- without re-ingesting everything else.
  embedding_model  TEXT NOT NULL,
  chunk_size       INTEGER NOT NULL,
  chunk_overlap    INTEGER NOT NULL,
  dimensions       INTEGER NOT NULL,
  created_at       TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS documents (
  tenant_id     TEXT NOT NULL,
  id            TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  filename      TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  byte_size     INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  page_count    INTEGER,
  char_count    INTEGER NOT NULL DEFAULT 0,
  chunk_count   INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL CHECK (status IN ('pending','processing','ready','failed')),
  error         TEXT,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, collection_id) REFERENCES collections(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents (tenant_id, collection_id);

CREATE TABLE IF NOT EXISTS chunks (
  tenant_id     TEXT NOT NULL,
  id            TEXT NOT NULL,
  document_id   TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  ordinal       INTEGER NOT NULL,
  text          TEXT NOT NULL,
  token_estimate INTEGER NOT NULL,
  char_start    INTEGER NOT NULL,
  char_end      INTEGER NOT NULL,
  page          INTEGER,
  heading       TEXT,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chunks_collection ON chunks (tenant_id, collection_id, ordinal);

CREATE TABLE IF NOT EXISTS chunk_vectors (
  tenant_id     TEXT NOT NULL,
  chunk_id      TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  model_id      TEXT NOT NULL,
  dimensions    INTEGER NOT NULL,
  -- Little-endian Float32Array. L2-normalized at write time so retrieval is a
  -- dot product rather than a cosine with two square roots per candidate.
  vector        BLOB NOT NULL,
  PRIMARY KEY (tenant_id, chunk_id),
  FOREIGN KEY (tenant_id, chunk_id) REFERENCES chunks(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chunk_vectors_collection ON chunk_vectors (tenant_id, collection_id);

-- BM25 half of hybrid retrieval. tenant_id/collection_id are carried as
-- UNINDEXED columns so the MATCH can still be constrained to one tenant; the
-- guard requires that predicate exactly as it does for an ordinary table.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  tenant_id     UNINDEXED,
  collection_id UNINDEXED,
  chunk_id      UNINDEXED,
  tokenize = 'porter unicode61'
);

-- ---------------------------------------------------------------------------
-- Observability
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS usage_records (
  tenant_id          TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id                 TEXT NOT NULL,
  request_id         TEXT NOT NULL,
  conversation_id    TEXT,
  kind               TEXT NOT NULL CHECK (kind IN ('chat','embedding','tool','summary','compare','structured','judge')),
  provider           TEXT NOT NULL,
  model_id           TEXT NOT NULL,
  started_at         TEXT NOT NULL,
  ttft_ms            INTEGER,
  latency_ms         INTEGER NOT NULL,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens   INTEGER NOT NULL DEFAULT 0,
  cost_usd           REAL NOT NULL DEFAULT 0,
  finish_reason      TEXT,
  retry_count        INTEGER NOT NULL DEFAULT 0,
  -- Set when this request was served by a fallback: the model originally asked for.
  fallback_from      TEXT,
  error_kind         TEXT,
  tool_call_count    INTEGER NOT NULL DEFAULT 0,
  cache_hit          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_usage_time ON usage_records (tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_request ON usage_records (tenant_id, request_id);

-- ---------------------------------------------------------------------------
-- Semantic cache (optional extra)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS semantic_cache (
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id              TEXT NOT NULL,
  model_id        TEXT NOT NULL,
  scope_hash      TEXT NOT NULL,
  prompt          TEXT NOT NULL,
  dimensions      INTEGER NOT NULL,
  vector          BLOB NOT NULL,
  response_text   TEXT NOT NULL,
  usage_json      TEXT NOT NULL,
  cost_usd        REAL NOT NULL,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  hits            INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_cache_scope ON semantic_cache (tenant_id, scope_hash, expires_at);

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------

-- Answers "how would you know, in production, if it had ever leaked?".
-- Every tenant-scoped read/write records which tables it touched under which
-- tenant; a guard violation is recorded here with severity 'violation'.
CREATE TABLE IF NOT EXISTS audit_log (
  tenant_id   TEXT NOT NULL,
  id          TEXT NOT NULL,
  request_id  TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('info','violation')),
  action      TEXT NOT NULL,
  resource    TEXT,
  detail      TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log (tenant_id, created_at DESC);
