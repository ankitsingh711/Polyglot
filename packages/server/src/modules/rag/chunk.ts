import { estimateTextTokens } from '../../core/tokens.js';

/**
 * Chunking.
 *
 * The goal is chunks that are individually answerable and individually citable.
 * That rules out the two easy options: a fixed character window (splits
 * mid-sentence, so a citation points at half a thought) and one-chunk-per-page
 * (a page is a printing artefact, not a unit of meaning, and a 3,000-word page
 * dominates retrieval).
 *
 * What we do instead is a recursive split down a ladder of separators, from most
 * semantic to least:
 *
 *   markdown heading -> blank line -> newline -> sentence -> space -> character
 *
 * A chunk is emitted as soon as adding the next piece would exceed the budget,
 * so most chunks end on a paragraph boundary and only pathological input (a
 * 4,000-character sentence) reaches the character-level fallback.
 *
 * Overlap is applied in WHOLE SENTENCES taken from the tail of the previous
 * chunk, not a raw character slice. A character slice routinely starts a chunk
 * mid-word, which both wastes the overlap budget and produces citations that
 * look broken to the user reading the retrieved text.
 *
 * Heading context is carried onto each chunk ("2.1 Termination") because a chunk
 * that says "Either party may terminate with 30 days notice" is far more useful
 * to the model, and far more legible as a citation, when it knows which section
 * it came from.
 */

export interface Chunk {
  ordinal: number;
  text: string;
  tokenEstimate: number;
  charStart: number;
  charEnd: number;
  page?: number;
  heading?: string;
}

export interface ChunkOptions {
  /** Target chunk size in CHARACTERS (see note below on why not tokens). */
  chunkSize: number;
  chunkOverlap: number;
  /** Chunks shorter than this are merged into their neighbour. */
  minChunkChars?: number;
  /** Page boundaries, for PDFs: pages[i] is the text of page i+1. */
  pages?: string[];
}

/*
 * Why characters rather than tokens as the unit: the only accurate token count
 * is the provider's own, and there are four different tokenizers in play across
 * the five providers we support. A character budget is stable, is what the UI
 * slider exposes, and is within ~15% of a token budget on prose. The token
 * estimate is still recorded per chunk so the retrieval context budget can be
 * enforced in tokens.
 */

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
/** Sentence end followed by whitespace; tolerates quotes and brackets. */
const SENTENCE_SPLIT = /(?<=[.!?][)"'”’]?)\s+(?=[A-Z0-9"'(“‘])/;

interface Piece {
  text: string;
  start: number;
  heading?: string;
  page?: number;
}

/** Split into paragraph-ish pieces, tracking absolute offsets and headings. */
function toPieces(text: string, pageOf: (offset: number) => number | undefined): Piece[] {
  const pieces: Piece[] = [];
  let heading: string | undefined;
  let offset = 0;

  for (const block of text.split(/\n{2,}/)) {
    const start = text.indexOf(block, offset);
    const at = start === -1 ? offset : start;
    offset = at + block.length;

    const trimmed = block.trim();
    if (!trimmed) continue;

    const headingMatch = HEADING_RE.exec(trimmed.split('\n')[0] ?? '');
    if (headingMatch) {
      heading = headingMatch[2];
    }
    pieces.push({ text: trimmed, start: at, heading, page: pageOf(at) });
  }
  return pieces;
}

/** Recursively break a piece that is on its own larger than the budget. */
function splitOversized(piece: Piece, limit: number): Piece[] {
  if (piece.text.length <= limit) return [piece];

  const out: Piece[] = [];
  const pushSlice = (slice: string, offset: number) => {
    if (slice.trim()) out.push({ ...piece, text: slice.trim(), start: piece.start + offset });
  };

  // 1. lines
  const byLine = piece.text.split('\n');
  if (byLine.length > 1) {
    let buffer = '';
    let bufferStart = 0;
    let cursor = 0;
    for (const line of byLine) {
      if (buffer && buffer.length + line.length + 1 > limit) {
        pushSlice(buffer, bufferStart);
        buffer = '';
        bufferStart = cursor;
      }
      if (!buffer) bufferStart = cursor;
      buffer += (buffer ? '\n' : '') + line;
      cursor += line.length + 1;
    }
    pushSlice(buffer, bufferStart);
    if (out.every((p) => p.text.length <= limit)) return out;
    return out.flatMap((p) => (p.text.length > limit ? splitBySentence(p, limit) : [p]));
  }

  return splitBySentence(piece, limit);
}

function splitBySentence(piece: Piece, limit: number): Piece[] {
  const sentences = piece.text.split(SENTENCE_SPLIT);
  const out: Piece[] = [];
  let buffer = '';
  let cursor = 0;
  let bufferStart = 0;

  const flush = () => {
    if (buffer.trim()) out.push({ ...piece, text: buffer.trim(), start: piece.start + bufferStart });
    buffer = '';
  };

  for (const sentence of sentences) {
    if (sentence.length > limit) {
      flush();
      // Last resort: hard character slices. Only pathological input gets here.
      for (let i = 0; i < sentence.length; i += limit) {
        out.push({ ...piece, text: sentence.slice(i, i + limit).trim(), start: piece.start + cursor + i });
      }
      cursor += sentence.length + 1;
      bufferStart = cursor;
      continue;
    }
    if (buffer && buffer.length + sentence.length + 1 > limit) flush();
    if (!buffer) bufferStart = cursor;
    buffer += (buffer ? ' ' : '') + sentence;
    cursor += sentence.length + 1;
  }
  flush();
  return out.filter((p) => p.text.length);
}

/** Take whole sentences from the tail of `text` up to `budget` characters. */
export function tailOverlap(text: string, budget: number): string {
  if (budget <= 0 || !text) return '';
  const sentences = text.split(SENTENCE_SPLIT);
  const taken: string[] = [];
  let length = 0;
  for (let i = sentences.length - 1; i >= 0; i--) {
    const sentence = sentences[i]!;
    if (length + sentence.length > budget && taken.length) break;
    taken.unshift(sentence);
    length += sentence.length + 1;
    if (length >= budget) break;
  }
  const overlap = taken.join(' ').trim();
  // A single sentence longer than the budget would otherwise duplicate the whole
  // chunk; clip it to the budget on a word boundary instead.
  if (overlap.length > budget * 1.5) {
    const clipped = overlap.slice(-budget);
    return clipped.slice(clipped.indexOf(' ') + 1);
  }
  return overlap;
}

export function chunkText(text: string, opts: ChunkOptions): Chunk[] {
  const limit = Math.max(100, opts.chunkSize);
  const overlapBudget = Math.max(0, Math.min(opts.chunkOverlap, limit - 50));
  const minChars = opts.minChunkChars ?? 60;

  // Map an absolute offset to a 1-based page number for PDFs.
  const pageBounds: number[] = [];
  if (opts.pages?.length) {
    let running = 0;
    for (const page of opts.pages) {
      running += page.length + 2; // the "\n\n" join used in extract.ts
      pageBounds.push(running);
    }
  }
  const pageOf = (offset: number): number | undefined => {
    if (!pageBounds.length) return undefined;
    for (let i = 0; i < pageBounds.length; i++) if (offset < pageBounds[i]!) return i + 1;
    return pageBounds.length;
  };

  const pieces = toPieces(text, pageOf).flatMap((p) => splitOversized(p, limit));

  const chunks: Chunk[] = [];
  let buffer = '';
  let bufferStart = 0;
  let bufferHeading: string | undefined;
  let bufferPage: number | undefined;

  const flush = () => {
    const body = buffer.trim();
    if (!body) return;
    chunks.push({
      ordinal: chunks.length,
      text: body,
      tokenEstimate: estimateTextTokens(body),
      charStart: bufferStart,
      charEnd: bufferStart + body.length,
      ...(bufferPage !== undefined ? { page: bufferPage } : {}),
      ...(bufferHeading ? { heading: bufferHeading } : {}),
    });
    buffer = '';
  };

  for (const piece of pieces) {
    if (buffer && buffer.length + piece.text.length + 2 > limit) {
      const previous = buffer;
      flush();
      // Seed the next chunk with whole sentences from the tail of the last one.
      const overlap = tailOverlap(previous, overlapBudget);
      buffer = overlap;
      bufferStart = Math.max(0, piece.start - overlap.length);
      bufferHeading = piece.heading;
      bufferPage = piece.page;
    }
    if (!buffer) {
      bufferStart = piece.start;
      bufferHeading = piece.heading;
      bufferPage = piece.page;
    }
    buffer += (buffer ? '\n\n' : '') + piece.text;
  }
  flush();

  // Merge a runt tail chunk into its predecessor rather than indexing a fragment
  // that will never be retrieved but will pollute BM25 statistics.
  if (chunks.length > 1) {
    const last = chunks[chunks.length - 1]!;
    if (last.text.length < minChars) {
      const previous = chunks[chunks.length - 2]!;
      previous.text = `${previous.text}\n\n${last.text}`;
      previous.tokenEstimate = estimateTextTokens(previous.text);
      previous.charEnd = last.charEnd;
      chunks.pop();
    }
  }

  return chunks.filter((c) => c.text.length >= Math.min(minChars, limit)).map((c, i) => ({ ...c, ordinal: i }));
}
