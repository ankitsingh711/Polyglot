import type { Message } from './types.js';

/**
 * Token estimation.
 *
 * This is an ESTIMATE and is used for exactly two things: deciding when to
 * compact a conversation, and enforcing the pre-flight cost cap. Every billed
 * number in the metrics panel comes from the provider's own `usage`, never from
 * here.
 *
 * Shipping a real tokenizer per vendor would mean four of them (tiktoken,
 * Anthropic's counting endpoint, Gemini's countTokens, and whatever Groq's models
 * use), three of which are network calls on the hot path. The heuristic below is
 * within ~10-15% on English prose, and both of its consumers are guardrails with
 * headroom built in. `config/app.json → context.headroomRatio` is that headroom.
 */

/** Average bytes per token for English prose across the major BPE vocabularies. */
const CHARS_PER_TOKEN = 3.8;
/** Per-message envelope overhead (role, delimiters) that every vendor charges. */
const MESSAGE_OVERHEAD_TOKENS = 4;
/** A base64 image costs far more than its character count suggests. */
const IMAGE_TOKENS_FLOOR = 800;

export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  // CJK and code are denser than prose; bias upward on non-ASCII heavy text.
  const nonAscii = (text.match(/[^\x00-\x7F]/g) ?? []).length;
  const effective = text.length + nonAscii * 0.8;
  return Math.ceil(effective / CHARS_PER_TOKEN);
}

export function estimateMessageTokens(message: Message): number {
  let total = MESSAGE_OVERHEAD_TOKENS;
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        total += estimateTextTokens(block.text ?? '');
        break;
      case 'image':
        total += Math.max(IMAGE_TOKENS_FLOOR, Math.ceil((block.data?.length ?? 0) / 750));
        break;
      case 'tool_use':
        total += estimateTextTokens(block.name ?? '') + estimateTextTokens(JSON.stringify(block.input ?? {})) + 10;
        break;
      case 'tool_result':
        total += estimateTextTokens(block.content ?? '') + 10;
        break;
    }
  }
  return total;
}

export function estimateConversationTokens(messages: Message[], system?: string): number {
  return (
    (system ? estimateTextTokens(system) + MESSAGE_OVERHEAD_TOKENS : 0) +
    messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0)
  );
}
