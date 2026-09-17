/**
 * Test environment.
 *
 * Fake keys for every provider so the registry will construct adapters; the
 * network is never reached because every adapter test injects a fixture `fetch`.
 * A real key leaking into a test run would be a very expensive accident, so the
 * values here are deliberately obvious.
 */
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_PATH = ':memory:';

process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.GROQ_API_KEY = 'test-groq-key';
process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
