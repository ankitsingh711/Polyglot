import { AppError } from '../../core/errors.js';
import { forTenant } from '../../db/index.js';
import { newId } from '../../util/ids.js';
import type { ContentBlock, Message, Role } from '../../core/types.js';

/**
 * Conversation persistence.
 *
 * What is stored is the PROVIDER-AGNOSTIC message, never a vendor shape. That is
 * what makes "switch provider and model between messages inside the same
 * conversation" work: history is replayed through whichever adapter is selected
 * next, and each adapter translates the same neutral blocks into its own dialect.
 * Persisting Anthropic's `tool_result` blocks would make the next Gemini turn a
 * migration problem.
 */

export interface ConversationRow {
  id: string;
  title: string;
  collection_id: string | null;
  system_prompt: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  seq: number;
  role: Role;
  content_json: string;
  reasoning: string | null;
  model_id: string | null;
  provider: string | null;
  citations_json: string | null;
  created_at: string;
}

export interface StoredMessage {
  id: string;
  seq: number;
  role: Role;
  content: ContentBlock[];
  reasoning?: string;
  modelId?: string;
  provider?: string;
  citations?: unknown[];
  createdAt: string;
}

export function createConversation(input: {
  title?: string;
  collectionId?: string | null;
  systemPrompt?: string | null;
}): ConversationRow {
  const now = new Date().toISOString();
  const row: ConversationRow = {
    id: newId('cnv'),
    title: (input.title ?? 'New conversation').trim().slice(0, 200) || 'New conversation',
    collection_id: input.collectionId ?? null,
    system_prompt: input.systemPrompt?.slice(0, 8000) ?? null,
    created_at: now,
    updated_at: now,
  };
  forTenant()
    .prepare(
      `INSERT INTO conversations (tenant_id, id, title, collection_id, system_prompt, created_at, updated_at)
       VALUES (:tenant_id, :id, :title, :collection_id, :system_prompt, :created_at, :updated_at)`,
    )
    .run(row as unknown as Record<string, unknown>);
  return row;
}

export function listConversations(limit = 50): Array<ConversationRow & { message_count: number }> {
  return forTenant()
    .prepare<ConversationRow & { message_count: number }>(
      `SELECT c.id, c.title, c.collection_id, c.system_prompt, c.created_at, c.updated_at,
              (SELECT COUNT(*) FROM messages m
                WHERE m.tenant_id = c.tenant_id AND m.conversation_id = c.id) AS message_count
         FROM conversations c
        WHERE c.tenant_id = :tenant_id
        ORDER BY c.updated_at DESC
        LIMIT :limit`,
    )
    .all({ limit: Math.min(Math.max(limit, 1), 200) });
}

export function getConversation(id: string): ConversationRow | undefined {
  return forTenant()
    .prepare<ConversationRow>(
      `SELECT id, title, collection_id, system_prompt, created_at, updated_at
         FROM conversations WHERE tenant_id = :tenant_id AND id = :id`,
    )
    .get({ id });
}

export function requireConversation(id: string): ConversationRow {
  const row = getConversation(id);
  // 404, not 403: another tenant's conversation must be indistinguishable from
  // one that does not exist, or the error code itself becomes an oracle.
  if (!row) throw new AppError(404, 'conversation_not_found', 'Conversation not found.');
  return row;
}

export function updateConversation(
  id: string,
  patch: { title?: string; collectionId?: string | null; systemPrompt?: string | null },
): ConversationRow {
  requireConversation(id);
  forTenant()
    .prepare(
      `UPDATE conversations
          SET title = COALESCE(:title, title),
              collection_id = CASE WHEN :set_collection = 1 THEN :collection_id ELSE collection_id END,
              system_prompt = CASE WHEN :set_system = 1 THEN :system_prompt ELSE system_prompt END,
              updated_at = :updated_at
        WHERE tenant_id = :tenant_id AND id = :id`,
    )
    .run({
      id,
      title: patch.title?.trim().slice(0, 200) ?? null,
      set_collection: patch.collectionId === undefined ? 0 : 1,
      collection_id: patch.collectionId ?? null,
      set_system: patch.systemPrompt === undefined ? 0 : 1,
      system_prompt: patch.systemPrompt?.slice(0, 8000) ?? null,
      updated_at: new Date().toISOString(),
    });
  return requireConversation(id);
}

export function deleteConversation(id: string): void {
  requireConversation(id);
  forTenant().prepare('DELETE FROM conversations WHERE tenant_id = :tenant_id AND id = :id').run({ id });
}

export function touchConversation(id: string): void {
  forTenant()
    .prepare('UPDATE conversations SET updated_at = :updated_at WHERE tenant_id = :tenant_id AND id = :id')
    .run({ id, updated_at: new Date().toISOString() });
}

function nextSeq(conversationId: string): number {
  const row = forTenant()
    .prepare<{ next: number }>(
      `SELECT COALESCE(MAX(seq), -1) + 1 AS next
         FROM messages WHERE tenant_id = :tenant_id AND conversation_id = :conversation_id`,
    )
    .get({ conversation_id: conversationId });
  return row?.next ?? 0;
}

export function appendMessage(
  conversationId: string,
  input: {
    role: Role;
    content: ContentBlock[];
    reasoning?: string | null;
    modelId?: string | null;
    provider?: string | null;
    citations?: unknown[] | null;
  },
): StoredMessage {
  const seq = nextSeq(conversationId);
  const row: MessageRow = {
    id: newId('msg'),
    conversation_id: conversationId,
    seq,
    role: input.role,
    content_json: JSON.stringify(input.content),
    reasoning: input.reasoning ?? null,
    model_id: input.modelId ?? null,
    provider: input.provider ?? null,
    citations_json: input.citations?.length ? JSON.stringify(input.citations) : null,
    created_at: new Date().toISOString(),
  };

  forTenant()
    .prepare(
      `INSERT INTO messages (tenant_id, id, conversation_id, seq, role, content_json, reasoning,
                             model_id, provider, citations_json, created_at)
       VALUES (:tenant_id, :id, :conversation_id, :seq, :role, :content_json, :reasoning,
               :model_id, :provider, :citations_json, :created_at)`,
    )
    .run(row as unknown as Record<string, unknown>);
  touchConversation(conversationId);

  return toStored(row);
}

function toStored(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    seq: row.seq,
    role: row.role,
    content: JSON.parse(row.content_json) as ContentBlock[],
    ...(row.reasoning ? { reasoning: row.reasoning } : {}),
    ...(row.model_id ? { modelId: row.model_id } : {}),
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.citations_json ? { citations: JSON.parse(row.citations_json) as unknown[] } : {}),
    createdAt: row.created_at,
  };
}

export function listMessages(conversationId: string): StoredMessage[] {
  requireConversation(conversationId);
  return forTenant()
    .prepare<MessageRow>(
      `SELECT id, conversation_id, seq, role, content_json, reasoning, model_id, provider,
              citations_json, created_at
         FROM messages
        WHERE tenant_id = :tenant_id AND conversation_id = :conversation_id
        ORDER BY seq ASC`,
    )
    .all({ conversation_id: conversationId })
    .map(toStored);
}

export function countMessages(conversationId: string): number {
  return (
    forTenant()
      .prepare<{ n: number }>(
        'SELECT COUNT(*) AS n FROM messages WHERE tenant_id = :tenant_id AND conversation_id = :conversation_id',
      )
      .get({ conversation_id: conversationId })?.n ?? 0
  );
}

/** History in the shape the provider contract expects. */
export function toProviderMessages(stored: StoredMessage[]): Message[] {
  return stored.map((m) => ({ role: m.role, content: m.content }));
}
