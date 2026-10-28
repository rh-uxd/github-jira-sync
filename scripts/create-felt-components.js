#!/usr/bin/env node
/**
 * Batch-create Jira components in the FELT project — one per repo listed in
 * `availableComponents` (src/helpers.js). The sync filters issues per repo with
 * `component = "<repo>"`, so FELT needs a component for every repo name before
 * issues are moved into it.
 *
 * Idempotent: lists existing FELT components first and only creates missing ones.
 *
 * Run from repo root:
 *   node scripts/create-felt-components.js --dry-run   # preview, no writes
 *   node scripts/create-felt-components.js             # create missing components
 *
 * Requires .env with JIRA_EMAIL + JIRA_API_TOKEN (or JIRA_PAT). The account must
 * have project-admin on FELT to create components.
 *
 * `import 'dotenv/config'` must come before the helpers import so the Jira client
 * picks up credentials at module-load time.
 */
import 'dotenv/config';
import { jiraClient, availableComponents } from '../src/helpers.js';

const PROJECT_KEY = process.env.FELT_PROJECT_KEY || 'FELT';
const dryRun = process.argv.includes('--dry-run');

// Fetch all existing component names for the project (paginated endpoint).
async function getExistingComponentNames(projectKey) {
  const existing = new Set();
  let startAt = 0;
  const maxResults = 100;
  while (true) {
    const { data } = await jiraClient.get(
      `/rest/api/3/project/${projectKey}/component`,
      { params: { startAt, maxResults } }
    );
    const values = data.values || [];
    values.forEach((c) => existing.add(c.name));
    if (data.isLast || values.length === 0) break;
    startAt += values.length;
  }
  return existing;
}

async function main() {
  const names = [...new Set(availableComponents.map((c) => c.name))].sort();
  console.log(`Target project: ${PROJECT_KEY}`);
  console.log(`Components in config: ${names.length}`);
  console.log(dryRun ? 'Mode: DRY RUN (no writes)\n' : 'Mode: LIVE\n');

  let existing;
  try {
    existing = await getExistingComponentNames(PROJECT_KEY);
  } catch (err) {
    console.error(
      'Failed to list existing components:',
      err.response?.status,
      err.response?.data || err.message
    );
    process.exit(1);
  }

  const toCreate = names.filter((n) => !existing.has(n));
  const skipped = names.filter((n) => existing.has(n));

  if (skipped.length) {
    console.log(`Already exist (${skipped.length}): ${skipped.join(', ')}\n`);
  }
  if (!toCreate.length) {
    console.log('Nothing to create — all components already present.');
    return;
  }
  console.log(`To create (${toCreate.length}): ${toCreate.join(', ')}\n`);

  if (dryRun) {
    console.log('Dry run complete. Re-run without --dry-run to create.');
    return;
  }

  let created = 0;
  const errors = [];
  for (const name of toCreate) {
    try {
      await jiraClient.post('/rest/api/3/component', {
        name,
        project: PROJECT_KEY,
      });
      created += 1;
      console.log(`  ✓ created: ${name}`);
    } catch (err) {
      const status = err.response?.status;
      const body = err.response?.data;
      errors.push({ name, status, body });
      console.error(
        `  ✗ failed: ${name} (${status}) ${body ? JSON.stringify(body) : err.message}`
      );
    }
  }

  console.log(`\nDone. Created ${created}/${toCreate.length}.`);
  if (errors.length) {
    console.error(`${errors.length} failed — see above.`);
    process.exit(1);
  }
}

main();
