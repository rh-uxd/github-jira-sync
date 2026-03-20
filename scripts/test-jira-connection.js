#!/usr/bin/env node
/**
 * Test script for Jira Cloud API connection (Basic auth).
 * Run from repo root: node scripts/test-jira-connection.js
 * Requires .env with JIRA_EMAIL and JIRA_API_TOKEN (or JIRA_PAT).
 *
 * Self-contained: does not import helpers.js (which would pull in index.js).
 */
import 'dotenv/config';
import axios from 'axios';

const baseURL = process.env.JIRA_BASE_URL || 'https://redhat.atlassian.net/';
const email = process.env.JIRA_EMAIL?.trim();
const token = (process.env.JIRA_API_TOKEN || process.env.JIRA_PAT)?.trim();
const authHeader =
  email && token
    ? `Basic ${Buffer.from(`${email}:${token}`, 'utf8').toString('base64')}`
    : null;

const client = axios.create({
  baseURL,
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(authHeader && { Authorization: authHeader }),
    // Authorization: `Bearer ${process.env.JIRA_PAT}`,
  },
});

async function main() {
  console.log('Testing Jira API connection...');
  console.log('  Base URL: %s', baseURL);
  console.log('  Auth: %s', authHeader ? 'Basic (set)' : 'MISSING – set JIRA_EMAIL and JIRA_API_TOKEN in .env');
  console.log('');

  try {
    // const { data } = await client.get('/rest/api/2/issue/PF-2674');
    const { data } = await client.get('/rest/api/3/issue/PF-2967');
    console.log('✓ Connected successfully');
    console.log('  User: %s (%s)', data.displayName, data.emailAddress);
    console.log('  AccountId: %s', data.accountId);
    console.log({data});
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    console.error('✗ Request failed');
    if (status) console.error('  Status: %s', status);
    if (body && typeof body === 'object') console.error('  Response: %s', JSON.stringify(body, null, 2));
    else if (body) console.error('  Response: %s', body);
    if (err.message) console.error('  Error: %s', err.message);
    if (status === 401) {
      console.error('\n  401 usually means:');
      console.error('  • JIRA_EMAIL must be your Atlassian account email (you use to log in at atlassian.net)');
      console.error('  • JIRA_API_TOKEN must be from https://id.atlassian.com/manage-profile/security/api-tokens');
      console.error('  • No extra spaces/newlines in .env; values are now trimmed');
    }
    process.exit(1);
  }
}

main();
