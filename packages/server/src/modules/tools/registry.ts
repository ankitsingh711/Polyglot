import type { ToolDefinition } from '../../core/types.js';

/**
 * One tool definition format, translated per provider.
 *
 * A tool declares plain JSON Schema. The adapters own the translation:
 * Anthropic renames `parameters` to `input_schema`, OpenAI nests it under
 * `function`, and Gemini needs it rewritten into its OpenAPI 3.0 dialect. None
 * of that leaks here, which is the point -- a tool author never learns that
 * Gemini rejects `additionalProperties`.
 */

export interface ToolExecutionContext {
  signal?: AbortSignal;
  conversationId?: string | null;
  /** Collection bound to the current conversation, for search_documents. */
  collectionId?: string | null;
}

export interface ToolResult {
  /** Text handed back to the model. Always a string; the contract has no richer type. */
  content: string;
  isError?: boolean;
  /** Structured payload for the UI (e.g. citations), never sent to the model. */
  meta?: Record<string, unknown>;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  /**
   * Tools that need per-conversation state (search_documents needs a collection)
   * declare it so the loop can hide them rather than let the model call a tool
   * that will certainly fail.
   */
  isAvailable?(ctx: ToolExecutionContext): boolean;
  execute(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult>;
}

const tools = new Map<string, Tool>();

export function registerTool(tool: Tool): void {
  if (tools.has(tool.name)) throw new Error(`Tool "${tool.name}" is already registered.`);
  tools.set(tool.name, tool);
}

export function getTool(name: string): Tool | undefined {
  return tools.get(name);
}

export function allTools(): Tool[] {
  return [...tools.values()];
}

/** The tools usable right now, as provider-agnostic definitions. */
export function toolDefinitions(ctx: ToolExecutionContext, enabled?: string[]): ToolDefinition[] {
  return allTools()
    .filter((t) => !enabled || enabled.includes(t.name))
    .filter((t) => t.isAvailable?.(ctx) ?? true)
    .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}
