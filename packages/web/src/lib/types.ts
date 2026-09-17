export interface ModelCapabilities {
  tools: boolean;
  vision: boolean;
  jsonSchema: boolean;
  streaming: boolean;
  reasoning?: boolean;
  promptCaching?: boolean;
}

export interface ModelInfo {
  id: string;
  displayName: string;
  provider: string;
  kind: 'chat' | 'embedding';
  contextWindow: number;
  maxOutputTokens: number | null;
  dimensions: number | null;
  capabilities: ModelCapabilities;
  pricing: {
    inputPerMTok: number;
    outputPerMTok: number;
    cachedInputPerMTok?: number;
    cacheWritePerMTok?: number;
  };
  available: boolean;
}

export interface ProviderInfo {
  name: string;
  configured: boolean;
  baseUrl: string | null;
}

export interface CatalogResponse {
  models: ModelInfo[];
  providers: ProviderInfo[];
  pricing: { checkedOn: string | null; sources: Record<string, string> };
  fallbackChains: Record<string, string[]>;
  defaults: { chatModel: string; embeddingModel: string; maxTokens: number; temperature: number };
}

export interface Conversation {
  id: string;
  title: string;
  collection_id: string | null;
  system_prompt: string | null;
  created_at: string;
  updated_at: string;
  message_count?: number;
}

export interface Citation {
  number: number;
  chunkId: string;
  documentId: string;
  filename: string;
  page: number | null;
  heading: string | null;
  score: number;
  text: string;
}

export interface ContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result';
  text?: string;
  /** tool_use: the provider-agnostic call id the tool_result refers back to. */
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  toolUseId?: string;
  content?: string;
  isError?: boolean;
}

export interface StoredMessage {
  id: string;
  seq: number;
  role: 'user' | 'assistant' | 'tool';
  content: ContentBlock[];
  reasoning?: string;
  modelId?: string;
  provider?: string;
  citations?: Citation[];
  createdAt: string;
}

export interface Collection {
  id: string;
  name: string;
  embedding_model: string;
  chunk_size: number;
  chunk_overlap: number;
  dimensions: number;
  created_at: string;
  document_count?: number;
  chunk_count?: number;
}

export interface DocumentRow {
  id: string;
  collection_id: string;
  filename: string;
  mime_type: string;
  byte_size: number;
  page_count: number | null;
  char_count: number;
  chunk_count: number;
  status: 'pending' | 'processing' | 'ready' | 'failed';
  error: string | null;
  created_at: string;
}

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  filename: string;
  ordinal: number;
  page: number | null;
  heading: string | null;
  text: string;
  vectorScore?: number;
  keywordScore?: number;
  score: number;
  rank: number;
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  empty: boolean;
  params: {
    topK: number;
    similarityThreshold: number;
    retrievalMode: 'vector' | 'keyword' | 'hybrid';
    rrfK: number;
    maxContextChars: number;
  };
  embeddingModel?: string;
  rejected: number;
  timings: { embedMs: number; searchMs: number };
  costUsd: number;
}

export interface UsageRecord {
  id: string;
  request_id: string;
  conversation_id: string | null;
  kind: string;
  provider: string;
  model_id: string;
  started_at: string;
  ttft_ms: number | null;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
  finish_reason: string | null;
  retry_count: number;
  fallback_from: string | null;
  error_kind: string | null;
  tool_call_count: number;
  cache_hit: number;
}

export interface MetricsSummary {
  totals: {
    requests: number;
    total_cost_usd: number;
    avg_latency_ms: number;
    avg_ttft_ms: number | null;
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens: number;
    reasoning_tokens: number;
    errors: number;
    fallbacks: number;
    cache_hits: number;
  };
  byProvider: Array<{
    provider: string;
    model_id: string;
    requests: number;
    total_cost_usd: number;
    avg_latency_ms: number;
    avg_ttft_ms: number | null;
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens: number;
    errors: number;
    fallbacks: number;
    retries: number;
    cache_hits: number;
  }>;
  cache: { entries: number; hits: number; saved_usd: number };
  budget: {
    spentTodayUsd: number;
    dailyBudgetUsd: number;
    remainingUsd: number;
    maxCostPerRequestUsd: number;
  };
}

/** Live UI state for one assistant turn as it streams. */
export interface ToolInvocation {
  id: string;
  name: string;
  argsPreview: string;
  input?: Record<string, unknown>;
  status: 'streaming' | 'running' | 'ok' | 'error';
  result?: string;
  durationMs?: number;
}

export interface TurnNotice {
  level: 'info' | 'warn';
  code: string;
  message: string;
}

export interface LiveTurn {
  text: string;
  reasoning: string;
  notices: TurnNotice[];
  tools: ToolInvocation[];
  citations: Citation[];
  model: string;
  provider: string;
  fallbackFrom?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    reasoningTokens?: number;
  };
  costUsd: number;
  ttftMs: number | null;
  latencyMs: number | null;
  cacheHit?: boolean;
  error?: { kind: string; message: string; provider: string; retryable: boolean };
}
