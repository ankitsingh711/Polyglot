import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * tsc only emits JavaScript. Non-TS runtime assets have to be copied, and
 * forgetting one is the classic "works in dev, crashes in prod" bug -- which is
 * exactly what happened here before this script existed.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const assets = ['db/schema.sql'];

for (const asset of assets) {
  const to = join(root, 'dist', asset);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(join(root, 'src', asset), to);
  process.stdout.write(`copied ${asset}\n`);
}
