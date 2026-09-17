// Loads `dotenv/config` first, so this module must be imported before anything
// that reads process.env at module scope.
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { join } from 'node:path';
import { REPO_ROOT } from './config.js';

/**
 * Environment loading.
 *
 * `dotenv/config` alone reads only `<cwd>/.env`, which made every entry point
 * cwd-sensitive: `npm run seed` from packages/server never saw the repo's .env,
 * so it ran with no provider keys and (with a relative DATABASE_PATH) against a
 * different database than the server did. The repo root is where .env.example
 * tells you to put the file, so it is always read.
 *
 * The cwd file is loaded first and dotenv never overwrites an already-set
 * variable, so a local .env still wins where both define the same key.
 */
loadEnv({ path: join(REPO_ROOT, '.env') });
