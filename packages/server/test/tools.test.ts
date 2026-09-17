import { describe, it, expect, beforeAll } from 'vitest';
import { evaluateExpression, tokenize, CalculatorError, formatResult } from '../src/modules/tools/calculator.js';
import { getTool, toolDefinitions, allTools } from '../src/modules/tools/registry.js';
import { toGeminiTools } from '../src/providers/google.provider.js';
import { toOpenAITools } from '../src/providers/_shared/openai-compatible.js';
import { toAnthropicTools } from '../src/providers/anthropic.provider.js';

beforeAll(async () => {
  await import('../src/modules/tools/calculator.js');
  await import('../src/modules/tools/weather.js');
  await import('../src/modules/tools/search-documents.js');
});

describe('calculator — correctness', () => {
  it('respects precedence and associativity', () => {
    expect(evaluateExpression('2 + 3 * 4')).toBe(14);
    expect(evaluateExpression('(2 + 3) * 4')).toBe(20);
    // ^ is right-associative: 2^(3^2) = 512, not (2^3)^2 = 64.
    expect(evaluateExpression('2 ^ 3 ^ 2')).toBe(512);
    expect(evaluateExpression('10 - 4 - 3')).toBe(3);
    expect(evaluateExpression('-2 ^ 2')).toBe(-4);
  });

  it('supports the documented functions and constants', () => {
    expect(evaluateExpression('sqrt(81)')).toBe(9);
    expect(evaluateExpression('max(4, sqrt(81), 7)')).toBe(9);
    expect(evaluateExpression('round(pi * 100) / 100')).toBe(3.14);
    expect(evaluateExpression('ln(e)')).toBeCloseTo(1, 10);
    expect(evaluateExpression('2 ** 10')).toBe(1024);
  });

  it('accepts thousands separators, which models emit constantly', () => {
    expect(evaluateExpression('1,000 * 3')).toBe(3000);
    expect(evaluateExpression('18,000 / 12')).toBe(1500);
  });

  it('formats results without exponent noise', () => {
    expect(formatResult(3000)).toBe('3000');
    expect(formatResult(1 / 3)).toBe('0.333333333333');
  });
});

describe('calculator — it is a parser, not an interpreter', () => {
  const attacks = [
    'process.exit(1)',
    'require("fs")',
    'globalThis',
    'constructor.constructor("return 1")()',
    '[].constructor',
    'this',
    '__proto__',
    'eval("1+1")',
    'fetch("http://evil")',
    '1; console.log(1)',
    '`${1+1}`',
  ];

  it.each(attacks)('refuses %s', (expression) => {
    // Nothing in the grammar can name a host object, so these fail at parse
    // time rather than being sanitized away by a denylist.
    expect(() => evaluateExpression(expression)).toThrowError(CalculatorError);
  });

  it('has no identifier lookup at all beyond its own table', () => {
    expect(() => evaluateExpression('x + 1')).toThrowError(/Unknown name "x"/);
    expect(() => evaluateExpression('nope(2)')).toThrowError(/Unknown function "nope"/);
  });
});

describe('calculator — denial of service bounds', () => {
  it('bounds input length', () => {
    expect(() => evaluateExpression('1+'.repeat(400) + '1')).toThrowError(/under 500 characters/);
  });

  it('bounds token count', () => {
    expect(() => evaluateExpression('1+'.repeat(120) + '1')).toThrowError(/too complex/);
  });

  it('bounds nesting depth', () => {
    const nested = '('.repeat(60) + '1' + ')'.repeat(60);
    expect(() => evaluateExpression(nested)).toThrowError(/nests too deeply|too complex/);
  });

  it('refuses an exponent that would only produce Infinity', () => {
    expect(() => evaluateExpression('9 ^ 99999')).toThrowError(/out of the supported range/);
  });

  it('reports division by zero rather than returning Infinity', () => {
    expect(() => evaluateExpression('1 / 0')).toThrowError(/Division by zero/);
  });

  it('refuses NaN results instead of returning them to the model', () => {
    expect(() => evaluateExpression('sqrt(-4)')).toThrowError(/not a number/);
  });

  it('tokenizes without throwing on unusual but valid numbers', () => {
    expect(tokenize('1.5e3 + .5').map((t) => t.value)).toEqual(['1.5e3', '+', '.5']);
  });
});

describe('calculator — tool behaviour', () => {
  it('returns errors TO THE MODEL so it can correct itself', async () => {
    const tool = getTool('calculator')!;
    const result = await tool.execute({ expression: '2 +* 3' }, {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Could not evaluate');
  });

  it('returns the result as JSON the model can quote', async () => {
    const result = await getTool('calculator')!.execute({ expression: '(1200 * 1.08)' }, {});
    expect(JSON.parse(result.content)).toEqual({ expression: '(1200 * 1.08)', result: '1296' });
  });
});

describe('tool availability', () => {
  it('hides search_documents when the conversation has no collection', () => {
    const names = toolDefinitions({ collectionId: null }).map((t) => t.name);
    expect(names).toContain('calculator');
    expect(names).toContain('get_weather');
    // Offering a tool that can only fail wastes a turn and teaches bad habits.
    expect(names).not.toContain('search_documents');
  });

  it('respects the enabled list from config', () => {
    expect(toolDefinitions({}, ['calculator']).map((t) => t.name)).toEqual(['calculator']);
  });

  it('search_documents does not expose a collection parameter to the model', () => {
    const tool = getTool('search_documents')!;
    const properties = (tool.parameters as any).properties;
    expect(Object.keys(properties).sort()).toEqual(['query', 'top_k']);
    expect(properties.collection_id).toBeUndefined();
    expect(properties.tenant_id).toBeUndefined();
  });
});

describe('one tool definition, three vendor dialects', () => {
  const definitions = allTools().map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));

  it('Anthropic gets input_schema', () => {
    const translated = toAnthropicTools(definitions);
    expect(translated[0]).toHaveProperty('input_schema');
    expect(translated[0]).not.toHaveProperty('parameters');
  });

  it('OpenAI gets a nested function object', () => {
    const translated = toOpenAITools(definitions) as any[];
    expect(translated[0].type).toBe('function');
    expect(translated[0].function.parameters).toBeDefined();
  });

  it('Gemini gets functionDeclarations with uppercase types', () => {
    const translated = toGeminiTools(definitions) as any[];
    const declaration = translated[0].functionDeclarations.find((d: any) => d.name === 'calculator');
    expect(declaration.parameters.type).toBe('OBJECT');
    expect(declaration.parameters.properties.expression.type).toBe('STRING');
  });

  it('produces the same tool NAMES for every vendor, which is the point', () => {
    const anthropic = toAnthropicTools(definitions).map((t: any) => t.name).sort();
    const openai = (toOpenAITools(definitions) as any[]).map((t) => t.function.name).sort();
    const gemini = (toGeminiTools(definitions) as any[])[0].functionDeclarations.map((d: any) => d.name).sort();
    expect(anthropic).toEqual(openai);
    expect(openai).toEqual(gemini);
  });
});
