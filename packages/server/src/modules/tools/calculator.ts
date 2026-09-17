import { registerTool, type Tool } from './registry.js';

/**
 * A safe arithmetic evaluator.
 *
 * The brief says "do not eval() raw user input", and the usual workarounds are
 * no better: `new Function`, a sandboxed vm, and regex-allowlist-then-eval all
 * end in an interpreter that was not designed to be one. So this is a real
 * tokenizer plus a recursive-descent parser over a closed grammar. There is no
 * identifier lookup, no property access, no call into anything the parser did
 * not define, and the only values that exist are numbers.
 *
 * Grammar:
 *   expr    := term (('+' | '-') term)*
 *   term    := unary (('*' | '/' | '%') unary)*
 *   unary   := ('+' | '-') unary | power
 *   power   := atom ('^' unary)?            -- right associative
 *   atom    := NUMBER | CONST | FUNC '(' args ')' | '(' expr ')'
 *
 * Denial of service is a real concern for a tool the model can call in a loop,
 * so input length, token count, nesting depth and the magnitude of `^` are all
 * bounded.
 */

const MAX_INPUT_CHARS = 500;
const MAX_TOKENS = 200;
const MAX_DEPTH = 32;
/** 2^4096 overflows to Infinity anyway; refusing early keeps the error useful. */
const MAX_EXPONENT = 1024;

type TokenType = 'number' | 'op' | 'lparen' | 'rparen' | 'comma' | 'ident';
interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
};

const FUNCTIONS: Record<string, { arity: number | 'variadic'; fn: (...args: number[]) => number }> = {
  sqrt: { arity: 1, fn: (x) => Math.sqrt(x!) },
  abs: { arity: 1, fn: (x) => Math.abs(x!) },
  floor: { arity: 1, fn: (x) => Math.floor(x!) },
  ceil: { arity: 1, fn: (x) => Math.ceil(x!) },
  round: { arity: 1, fn: (x) => Math.round(x!) },
  ln: { arity: 1, fn: (x) => Math.log(x!) },
  log: { arity: 1, fn: (x) => Math.log10(x!) },
  log2: { arity: 1, fn: (x) => Math.log2(x!) },
  exp: { arity: 1, fn: (x) => Math.exp(x!) },
  sin: { arity: 1, fn: (x) => Math.sin(x!) },
  cos: { arity: 1, fn: (x) => Math.cos(x!) },
  tan: { arity: 1, fn: (x) => Math.tan(x!) },
  atan: { arity: 1, fn: (x) => Math.atan(x!) },
  sign: { arity: 1, fn: (x) => Math.sign(x!) },
  pow: { arity: 2, fn: (x, y) => x! ** y! },
  min: { arity: 'variadic', fn: (...a) => Math.min(...a) },
  max: { arity: 'variadic', fn: (...a) => Math.max(...a) },
};

export class CalculatorError extends Error {}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i]!;

    if (/\s/.test(ch)) { i++; continue; }

    // Thousands separators are common in model output ("1,000 * 3").
    if (ch === ',' ) {
      const before = input.slice(0, i);
      const after = input.slice(i + 1);
      if (/\d\s*$/.test(before) && /^\s*\d{3}(?!\d)/.test(after)) { i++; continue; }
      tokens.push({ type: 'comma', value: ',', pos: i });
      i++;
      continue;
    }

    if (/[0-9.]/.test(ch)) {
      const match = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(input.slice(i));
      if (!match) throw new CalculatorError(`Malformed number at position ${i}.`);
      tokens.push({ type: 'number', value: match[0], pos: i });
      i += match[0].length;
      continue;
    }

    if (/[a-zA-Z_]/.test(ch)) {
      const match = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(input.slice(i))!;
      tokens.push({ type: 'ident', value: match[0].toLowerCase(), pos: i });
      i += match[0].length;
      continue;
    }

    if (ch === '(') { tokens.push({ type: 'lparen', value: ch, pos: i++ }); continue; }
    if (ch === ')') { tokens.push({ type: 'rparen', value: ch, pos: i++ }); continue; }

    // `**` is accepted as a synonym for `^`.
    if (ch === '*' && input[i + 1] === '*') { tokens.push({ type: 'op', value: '^', pos: i }); i += 2; continue; }

    if ('+-*/%^'.includes(ch)) { tokens.push({ type: 'op', value: ch, pos: i++ }); continue; }

    throw new CalculatorError(`Unexpected character "${ch}" at position ${i}.`);
  }

  if (tokens.length > MAX_TOKENS) throw new CalculatorError(`Expression is too complex (${tokens.length} tokens).`);
  return tokens;
}

class Parser {
  private index = 0;
  private depth = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): number {
    if (!this.tokens.length) throw new CalculatorError('Empty expression.');
    const value = this.expr();
    if (this.index < this.tokens.length) {
      const token = this.tokens[this.index]!;
      throw new CalculatorError(`Unexpected "${token.value}" at position ${token.pos}.`);
    }
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private eat(type: TokenType, value?: string): Token {
    const token = this.peek();
    if (!token || token.type !== type || (value !== undefined && token.value !== value)) {
      throw new CalculatorError(`Expected ${value ?? type}${token ? ` but found "${token.value}"` : ' but reached the end'}.`);
    }
    this.index++;
    return token;
  }

  private enter(): void {
    if (++this.depth > MAX_DEPTH) throw new CalculatorError('Expression nests too deeply.');
  }

  private exit(): void {
    this.depth--;
  }

  private expr(): number {
    let left = this.term();
    while (this.peek()?.type === 'op' && (this.peek()!.value === '+' || this.peek()!.value === '-')) {
      const op = this.tokens[this.index++]!.value;
      const right = this.term();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  private term(): number {
    let left = this.unary();
    while (this.peek()?.type === 'op' && '*/%'.includes(this.peek()!.value)) {
      const op = this.tokens[this.index++]!.value;
      const right = this.unary();
      if ((op === '/' || op === '%') && right === 0) throw new CalculatorError('Division by zero.');
      left = op === '*' ? left * right : op === '/' ? left / right : left % right;
    }
    return left;
  }

  private unary(): number {
    const token = this.peek();
    if (token?.type === 'op' && (token.value === '-' || token.value === '+')) {
      this.index++;
      const value = this.unary();
      return token.value === '-' ? -value : value;
    }
    return this.power();
  }

  private power(): number {
    const base = this.atom();
    if (this.peek()?.type === 'op' && this.peek()!.value === '^') {
      this.index++;
      const exponent = this.unary(); // right-associative
      if (Math.abs(exponent) > MAX_EXPONENT) {
        throw new CalculatorError(`Exponent ${exponent} is out of the supported range.`);
      }
      return base ** exponent;
    }
    return base;
  }

  private atom(): number {
    this.enter();
    try {
      const token = this.peek();
      if (!token) throw new CalculatorError('Unexpected end of expression.');

      if (token.type === 'number') {
        this.index++;
        const value = Number(token.value);
        if (!Number.isFinite(value)) throw new CalculatorError(`"${token.value}" is not a finite number.`);
        return value;
      }

      if (token.type === 'lparen') {
        this.index++;
        const value = this.expr();
        this.eat('rparen');
        return value;
      }

      if (token.type === 'ident') {
        this.index++;
        const name = token.value;

        if (this.peek()?.type === 'lparen') {
          const spec = FUNCTIONS[name];
          if (!spec) throw new CalculatorError(`Unknown function "${name}".`);
          this.eat('lparen');
          const args: number[] = [];
          if (this.peek()?.type !== 'rparen') {
            args.push(this.expr());
            while (this.peek()?.type === 'comma') {
              this.index++;
              args.push(this.expr());
            }
          }
          this.eat('rparen');
          if (spec.arity !== 'variadic' && args.length !== spec.arity) {
            throw new CalculatorError(`${name}() takes ${spec.arity} argument(s), received ${args.length}.`);
          }
          if (spec.arity === 'variadic' && !args.length) {
            throw new CalculatorError(`${name}() needs at least one argument.`);
          }
          return spec.fn(...args);
        }

        const constant = CONSTANTS[name];
        if (constant === undefined) throw new CalculatorError(`Unknown name "${name}".`);
        return constant;
      }

      throw new CalculatorError(`Unexpected "${token.value}" at position ${token.pos}.`);
    } finally {
      this.exit();
    }
  }
}

export function evaluateExpression(expression: string): number {
  if (typeof expression !== 'string') throw new CalculatorError('Expression must be a string.');
  if (expression.length > MAX_INPUT_CHARS) {
    throw new CalculatorError(`Expression must be under ${MAX_INPUT_CHARS} characters.`);
  }
  const result = new Parser(tokenize(expression)).parse();
  if (Number.isNaN(result)) throw new CalculatorError('The expression is not a number (check for log/sqrt of a negative).');
  if (!Number.isFinite(result)) throw new CalculatorError('The result overflowed to infinity.');
  return result;
}

/** Full precision without exponent noise for everyday magnitudes. */
export function formatResult(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  const rounded = Number(value.toPrecision(12));
  return String(rounded);
}

const calculator: Tool = {
  name: 'calculator',
  description:
    'Evaluate an arithmetic expression and return the numeric result. Supports + - * / % ^, parentheses, ' +
    'and the functions sqrt, abs, floor, ceil, round, ln, log, log2, exp, sin, cos, tan, atan, sign, pow, min, max, ' +
    'plus the constants pi and e. Use this for any calculation instead of doing arithmetic yourself.',
  parameters: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description: 'The arithmetic expression, e.g. "(1200 * 1.08) ^ 2 / 3" or "max(4, sqrt(81))".',
      },
    },
    required: ['expression'],
  },
  async execute(input) {
    const expression = typeof input.expression === 'string' ? input.expression : '';
    try {
      const value = evaluateExpression(expression);
      return { content: JSON.stringify({ expression, result: formatResult(value) }) };
    } catch (err) {
      // Errors go back to the MODEL as a tool result, not to the user as a 500:
      // the model can then correct the expression and call again, which is the
      // whole point of a multi-turn tool loop.
      return {
        content: `Could not evaluate "${expression}": ${(err as Error).message}`,
        isError: true,
      };
    }
  },
};

registerTool(calculator);
