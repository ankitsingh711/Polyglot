import '../core/env.js';
import { initDatabase, closeDatabase, forTenant } from './index.js';
import { ensureTenant, listTenants } from '../tenancy/tenants.js';
import { runWithTenant } from '../tenancy/context.js';
import { newRequestId } from '../util/ids.js';
import { createCollectionWithDefaults, ingestFile } from '../modules/rag/ingest.js';
import { getCollection } from '../modules/rag/store.js';
import { createConversation } from '../modules/chat/store.js';
import { loadProviders } from '../core/registry.js';

/**
 * Seed two tenants so the isolation story is demonstrable rather than asserted.
 *
 * Each gets its own collection containing a document that mentions a distinctive
 * secret string. Asking Tenant A about Tenant B's secret must return
 * "I don't know" -- and the guard makes it impossible for a query to even reach
 * the other tenant's chunks. `npm test` asserts exactly that.
 */

const ACME_DOC = `# Acme Corporation - Internal Handbook

## 1. Company overview
Acme Corporation manufactures precision industrial components. It was founded in
1987 and is headquartered in Portland, Oregon. The current CEO is Dana Whitfield.

## 2. Support commitments
Standard support responds within 8 business hours. Premium support responds
within 1 hour, 24/7. The premium tier costs 18,000 USD per year per organisation.

## 3. Termination
Either party may terminate this agreement with 45 days written notice. Fees paid
in advance are refunded pro rata from the effective termination date.

## 4. Internal reference
The Acme deployment passphrase is ACME-ROADRUNNER-7741. It must never appear in
any document, response or log belonging to another customer.

## 5. Service credits
If monthly uptime falls below 99.5%, customers receive a 10% service credit.
Below 99.0%, the credit is 25%. Below 95.0%, the credit is 50%.
`;

const GLOBEX_DOC = `# Globex Industries - Operations Manual

## 1. Company overview
Globex Industries builds logistics software. It was founded in 2011 and is
headquartered in Springfield. The current CEO is Marta Olsen.

## 2. Support commitments
Globex offers a single support tier responding within 4 business hours. There is
no premium tier. Support is included at no additional cost.

## 3. Termination
Either party may terminate with 30 days written notice. No pro rata refunds are
offered; fees paid in advance are forfeited.

## 4. Internal reference
The Globex deployment passphrase is GLOBEX-SPRINGFIELD-2290. It must never appear
in any document, response or log belonging to another customer.

## 5. Service credits
Globex does not offer service credits. Outages are handled through the incident
review process described in section 9.
`;

async function seedTenant(
  name: string,
  apiKey: string,
  collectionName: string,
  filename: string,
  body: string,
): Promise<void> {
  const tenant = ensureTenant(name, apiKey, 25);

  await runWithTenant({ tenantId: tenant.id, tenantName: tenant.name, requestId: newRequestId() }, async () => {
    const existing = forTenant()
      .prepare<{ n: number }>('SELECT COUNT(*) AS n FROM collections WHERE tenant_id = :tenant_id')
      .get()?.n ?? 0;
    if (existing > 0) {
      process.stdout.write(`  ${name}: already seeded, skipping\n`);
      return;
    }

    const collection = createCollectionWithDefaults({ name: collectionName });
    const result = await ingestFile(collection.id, {
      originalname: filename,
      mimetype: 'text/markdown',
      buffer: Buffer.from(body, 'utf8'),
    });
    createConversation({ title: `${name} onboarding`, collectionId: collection.id });

    // Re-read: ingestion may have re-pinned the collection to whichever model
    // actually served it, so `collection` holds the pre-ingest guess.
    const indexed = getCollection(collection.id) ?? collection;
    process.stdout.write(
      `  ${name}: collection "${indexed.name}" (${indexed.embedding_model}), ` +
        `${result.chunkCount} chunks from ${filename}\n`,
    );
  });
}

async function main(): Promise<void> {
  await loadProviders();
  initDatabase();

  const keyA = process.env.SEED_TENANT_A_KEY?.trim() || 'pk_demo_acme_do_not_use_in_production';
  const keyB = process.env.SEED_TENANT_B_KEY?.trim() || 'pk_demo_globex_do_not_use_in_production';

  process.stdout.write('\nSeeding Polyglot\n');
  await seedTenant('Acme Corp', keyA, 'Acme handbook', 'acme-handbook.md', ACME_DOC);
  await seedTenant('Globex Industries', keyB, 'Globex manual', 'globex-manual.md', GLOBEX_DOC);

  process.stdout.write('\nTenants:\n');
  for (const tenant of listTenants()) {
    process.stdout.write(`  ${tenant.name}  (${tenant.id})\n`);
  }

  process.stdout.write(
    '\nUse these keys in the x-tenant-key header (the UI has a tenant switcher):\n' +
      `  Acme Corp          ${keyA}\n` +
      `  Globex Industries  ${keyB}\n\n` +
      'Only the SHA-256 of each key is stored. These are demo keys; rotate them for anything real.\n\n',
  );

  closeDatabase();
}

main().catch((err) => {
  process.stderr.write(`Seed failed: ${(err as Error).message}\n`);
  process.exitCode = 1;
});
