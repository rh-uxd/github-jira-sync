#!/usr/bin/env node
/**
 * Log raw ADF of a Jira issue description (for debugging action items / task list structure or other Markdown translation issues).
 * Run: node scripts/debug-jira-description-adf.js PF-3697
 * Requires .env with JIRA_EMAIL and JIRA_API_TOKEN (or JIRA_PAT).
 */
import 'dotenv/config';
import axios from 'axios';

const key = process.argv[2] || 'PF-3697';
const baseURL = process.env.JIRA_BASE_URL || 'https://redhat.atlassian.net/';
const email = process.env.JIRA_EMAIL?.trim();
const token = (process.env.JIRA_API_TOKEN || process.env.JIRA_PAT)?.trim();
const authHeader =
  email && token ? `Basic ${Buffer.from(`${email}:${token}`, 'utf8').toString('base64')}` : null;

const client = axios.create({
  baseURL,
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(authHeader && { Authorization: authHeader }),
  },
});

function listTypes(node, depth = 0) {
  const indent = '  '.repeat(depth);
  const type = node?.type || '(unknown)';
  console.log(`${indent}${type}`);
  const content = node?.content;
  if (Array.isArray(content)) content.forEach((child) => listTypes(child, depth + 1));
}

async function main() {
  console.log(`Fetching Jira issue ${key} description (ADF)...\n`);
  try {
    const { data } = await client.get(`/rest/api/3/issue/${key}`, {
      params: { fields: 'description,summary' },
    });
    const desc = data.fields?.description;
    console.log('Summary:', data.fields?.summary);
    console.log('\nTop-level content node types:');
    if (desc?.content) desc.content.forEach((n) => listTypes(n));
    else console.log('  (no content or description is string)');
    console.log('\nFull description ADF (JSON):');
    console.log(JSON.stringify(desc, null, 2));
  } catch (err) {
    console.error(err.response?.data || err.message);
    process.exit(1);
  }
}

main();
