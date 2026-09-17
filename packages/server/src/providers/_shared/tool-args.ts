/**
 * Streaming tool arguments arrive as JSON fragments — sometimes one character
 * at a time ("{", "\"ci", "ty\":"), and the vendors disagree about whether the
 * first fragment even contains the tool name.
 *
 * This accumulator is deliberately dumb about content and strict about ordering:
 * it concatenates fragments per tool-use id and only parses once, at completion.
 * Partial-JSON "repair" is not attempted — a half-written argument object is not
 * a smaller version of the real one, it is a different one, and guessing has bitten
 * every codebase that tried.
 */

export interface PendingToolUse {
  id: string;
  name: string;
  /** Vendor index (OpenAI streams `tool_calls[i]` and only sends `id` once). */
  index?: number;
  fragments: string[];
}

export class ToolCallAccumulator {
  private byId = new Map<string, PendingToolUse>();
  private byIndex = new Map<number, string>();
  private order: string[] = [];

  start(id: string, name: string, index?: number): void {
    if (!this.byId.has(id)) {
      this.byId.set(id, { id, name, index, fragments: [] });
      this.order.push(id);
    } else {
      const existing = this.byId.get(id)!;
      if (name) existing.name = name;
    }
    if (index !== undefined) this.byIndex.set(index, id);
  }

  /** OpenAI-compatible streams identify continuation chunks by array index only. */
  idForIndex(index: number): string | undefined {
    return this.byIndex.get(index);
  }

  push(id: string, fragment: string): void {
    const entry = this.byId.get(id);
    if (!entry) return;
    if (fragment) entry.fragments.push(fragment);
  }

  name(id: string): string {
    return this.byId.get(id)?.name ?? '';
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /**
   * Parse the accumulated fragments. An empty argument list is legitimate
   * (a zero-parameter tool), so "" and "{}" both mean "no arguments".
   */
  finish(id: string): { id: string; name: string; input: Record<string, unknown> } | undefined {
    const entry = this.byId.get(id);
    if (!entry) return undefined;
    return { id: entry.id, name: entry.name, input: parseToolInput(entry.fragments.join('')) };
  }

  /** All started tool uses, in the order the provider announced them. */
  finishAll(): Array<{ id: string; name: string; input: Record<string, unknown> }> {
    return this.order.map((id) => this.finish(id)!).filter(Boolean);
  }

  pendingIds(): string[] {
    return [...this.order];
  }

  reset(): void {
    this.byId.clear();
    this.byIndex.clear();
    this.order = [];
  }
}

export function parseToolInput(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    // Some models emit a bare scalar for single-parameter tools.
    return { value: parsed };
  } catch {
    // Surfaced to the model as a tool error rather than crashing the turn:
    // the loop feeds `_parse_error` back so the model can retry with valid JSON.
    return { _parse_error: true, _raw: trimmed.slice(0, 2000) };
  }
}
