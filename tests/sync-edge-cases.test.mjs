/**
 * Tests for sync edge cases: child issue closing logic, sub-issue pagination,
 * GitHub URL parsing, batched query building, Jira link addition, rate limit
 * handling, and sync stats tracking.
 *
 * Run: node tests/sync-edge-cases.test.mjs
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Import exported functions directly
import { parseGitHubUrl, buildBatchedIssueStateQuery } from '../src/syncJiraToGitHub.js';
import { extractTextFromADF, extractUpstreamUrl, buildJiraIssueData, paginatedJiraSearch } from '../src/helpers.js';
import { syncStats, errorCollector } from '../src/logging.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  if (actual === expected) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
    console.error(`    Expected: ${JSON.stringify(expected)}`);
    console.error(`    Actual:   ${JSON.stringify(actual)}`);
  }
}

// ─── parseGitHubUrl ──────────────────────────────────────────────────────────

console.log('\n=== parseGitHubUrl ===');

{
  const result = parseGitHubUrl('https://github.com/patternfly/patternfly-react/issues/12345');
  assertEqual(result.owner, 'patternfly', 'parses owner');
  assertEqual(result.repo, 'patternfly-react', 'parses repo');
  assertEqual(result.issueNumber, 12345, 'parses issue number as integer');
}

{
  const result = parseGitHubUrl('https://github.com/rh-uxd/github-jira-sync/issues/27');
  assertEqual(result.owner, 'rh-uxd', 'handles non-patternfly org');
  assertEqual(result.repo, 'github-jira-sync', 'parses repo for non-patternfly org');
}

{
  assertEqual(parseGitHubUrl(null), null, 'returns null for null input');
  assertEqual(parseGitHubUrl(undefined), null, 'returns null for undefined input');
  assertEqual(parseGitHubUrl(''), null, 'returns null for empty string');
  assertEqual(parseGitHubUrl('https://github.com/patternfly/patternfly-react/pulls/123'), null, 'returns null for pull request URL');
  assertEqual(parseGitHubUrl('not-a-url'), null, 'returns null for non-URL string');
}

// ─── buildBatchedIssueStateQuery ─────────────────────────────────────────────

console.log('\n=== buildBatchedIssueStateQuery ===');

{
  const query = buildBatchedIssueStateQuery([
    { alias: 'repo_0', owner: 'patternfly', repo: 'pf-roadmap', issueNumber: 282 },
    { alias: 'repo_1', owner: 'patternfly', repo: 'patternfly-react', issueNumber: 12345 },
  ]);

  assert(query.includes('query BatchedIssueState'), 'query has correct operation name');
  assert(query.includes('repo_0: repository(owner: "patternfly", name: "pf-roadmap")'), 'includes first alias with correct repo');
  assert(query.includes('issue(number: 282)'), 'includes first issue number');
  assert(query.includes('repo_1: repository(owner: "patternfly", name: "patternfly-react")'), 'includes second alias');
  assert(query.includes('issue(number: 12345)'), 'includes second issue number');
  assert(query.includes('state'), 'queries issue state');
  assert(query.includes('updatedAt'), 'queries updatedAt');
}

{
  const query = buildBatchedIssueStateQuery([
    { alias: 'single', owner: 'org', repo: 'repo', issueNumber: 1 },
  ]);
  assert(query.includes('single: repository'), 'works with single issue');
}

// ─── Child issue matching: Upstream URL extraction ───────────────────────────

console.log('\n=== Upstream URL extraction from ADF ===');

{
  const adf = {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Some description text' },
        ],
      },
      { type: 'rule' },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Upstream URL: https://github.com/patternfly/patternfly-design-kit/issues/927' },
        ],
      },
    ],
  };

  const text = extractTextFromADF(adf);
  assert(text.includes('Upstream URL: https://github.com/patternfly/patternfly-design-kit/issues/927'),
    'extractTextFromADF extracts upstream URL from ADF');

  const url = extractUpstreamUrl(adf);
  assertEqual(url, 'https://github.com/patternfly/patternfly-design-kit/issues/927',
    'extractUpstreamUrl finds URL in ADF description');
}

{
  const adfNoUrl = {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'No URL here' }] }],
  };
  const url = extractUpstreamUrl(adfNoUrl);
  assertEqual(url, null, 'extractUpstreamUrl returns null when no upstream URL');
}

// ─── Child issue closing: simulated matching logic ───────────────────────────

console.log('\n=== Child issue matching logic (simulated) ===');

{
  // Simulate the existingChildIssuesMap matching from updateChildIssues
  // This tests the core logic: Jira children matched by URL get removed from map,
  // unmatched ones remain and should NOT be auto-closed if GitHub is open.

  const existingChildIssuesMap = new Map([
    ['https://github.com/patternfly/pf-roadmap/issues/100', { key: 'PF-1001', fields: { status: { name: 'Open' } } }],
    ['https://github.com/patternfly/pf-roadmap/issues/101', { key: 'PF-1002', fields: { status: { name: 'Open' } } }],
    ['https://github.com/patternfly/patternfly/issues/8234', { key: 'PF-1003', fields: { status: { name: 'Open' } } }],
    ['https://github.com/patternfly/patternfly/issues/8235', { key: 'PF-1004', fields: { status: { name: 'Closed' } } }],
  ]);

  // Simulate GitHub sub-issues of the parent (only 2 of 4 match)
  const subIssues = [
    { url: 'https://github.com/patternfly/pf-roadmap/issues/100' },
    { url: 'https://github.com/patternfly/pf-roadmap/issues/101' },
  ];

  // Match and remove from map (as updateChildIssues does)
  for (const subIssue of subIssues) {
    existingChildIssuesMap.delete(subIssue.url);
  }

  assertEqual(existingChildIssuesMap.size, 2, 'two unmatched Jira children remain in map');
  assert(existingChildIssuesMap.has('https://github.com/patternfly/patternfly/issues/8234'),
    'cross-repo open issue remains unmatched');
  assert(existingChildIssuesMap.has('https://github.com/patternfly/patternfly/issues/8235'),
    'cross-repo closed issue remains unmatched');

  // Simulate the fix: filter out already-closed, then check GitHub state
  const unmatchedOpen = [...existingChildIssuesMap.entries()]
    .filter(([_, child]) => child.fields?.status?.name !== 'Closed');
  assertEqual(unmatchedOpen.length, 1, 'only 1 unmatched child is open in Jira');
  assertEqual(unmatchedOpen[0][1].key, 'PF-1003', 'PF-1003 is the open unmatched child');

  // PF-1003's GitHub issue (8234) is still OPEN → should NOT close
  // PF-1004 is already Closed in Jira → skipped entirely
  // This is the fix: we check GitHub state before closing, not just "unmatched = close"
}

// ─── Sub-issue pagination detection ──────────────────────────────────────────

console.log('\n=== Sub-issue pagination detection ===');

{
  // Simulate an issue with truncated sub-issues (totalCount > nodes.length)
  const issue = {
    number: 282,
    subIssues: {
      nodes: Array(10).fill({ url: 'https://example.com', title: 'test' }),
      totalCount: 35,
      pageInfo: { endCursor: 'cursor123', hasNextPage: true },
    },
  };

  const fetchedCount = issue.subIssues.nodes.length;
  const totalCount = issue.subIssues.totalCount;
  const allSubIssuesFetched = fetchedCount >= totalCount;

  assertEqual(allSubIssuesFetched, false, 'detects truncated sub-issues (10 of 35)');
  assert(issue.subIssues.pageInfo.hasNextPage, 'pageInfo indicates more pages');
  assertEqual(issue.subIssues.pageInfo.endCursor, 'cursor123', 'cursor available for pagination');
}

{
  // Issue with all sub-issues fetched
  const issue = {
    number: 281,
    subIssues: {
      nodes: Array(7).fill({ url: 'https://example.com' }),
      totalCount: 7,
      pageInfo: { endCursor: 'end', hasNextPage: false },
    },
  };

  const allFetched = issue.subIssues.nodes.length >= issue.subIssues.totalCount;
  assertEqual(allFetched, true, 'detects all sub-issues fetched (7 of 7)');
}

{
  // Issue with no sub-issues
  const issue = {
    number: 100,
    subIssues: { nodes: [], totalCount: 0 },
  };

  const needsPagination = issue.subIssues.totalCount > issue.subIssues.nodes.length;
  assertEqual(needsPagination, false, 'no pagination needed for zero sub-issues');
}

// ─── SyncStats tracking ─────────────────────────────────────────────────────

console.log('\n=== SyncStats tracking ===');

{
  // Reset syncStats for testing
  syncStats.repoStats.clear();
  syncStats.currentRepo = null;

  // Track without setting repo should be no-op
  syncStats.track('jiraCreated');
  assertEqual(syncStats.repoStats.size, 0, 'track without currentRepo is no-op');

  // Set repo and track events
  syncStats.setCurrentRepo('patternfly/pf-roadmap');
  syncStats.track('jiraCreated');
  syncStats.track('jiraCreated');
  syncStats.track('jiraClosed');
  syncStats.track('githubClosed');
  syncStats.track('githubClosed');
  syncStats.track('githubClosed');
  syncStats.track('githubReopened');
  syncStats.track('errors');

  const stats = syncStats.repoStats.get('patternfly/pf-roadmap');
  assertEqual(stats.jiraCreated, 2, 'tracks 2 jiraCreated');
  assertEqual(stats.jiraClosed, 1, 'tracks 1 jiraClosed');
  assertEqual(stats.githubClosed, 3, 'tracks 3 githubClosed');
  assertEqual(stats.githubReopened, 1, 'tracks 1 githubReopened');
  assertEqual(stats.errors, 1, 'tracks 1 error');
  assertEqual(stats.warnings.length, 0, 'no warnings tracked yet');

  // Track structured warnings
  syncStats.track('warnings', { key: 'PF-3748', message: 'GitHub issue is still open (not a sub-issue of parent)' });
  syncStats.track('warnings', { key: 'PF-3740', message: 'GitHub issue is still open (not a sub-issue of parent)' });
  syncStats.track('warnings', { key: 'GH #21', message: 'Skipped closing: open Jira also links (closed PF-3709 is duplicate)' });

  assertEqual(stats.warnings.length, 3, 'tracks 3 warnings');
  assertEqual(stats.warnings[0].key, 'PF-3748', 'warning has correct key');
  assertEqual(stats.warnings[0].message, 'GitHub issue is still open (not a sub-issue of parent)', 'warning has correct message');

  // Switch repo
  syncStats.setCurrentRepo('patternfly/patternfly-design-kit');
  syncStats.track('githubCreated');
  assertEqual(syncStats.repoStats.size, 2, 'tracks stats for 2 repos');
  assertEqual(syncStats.repoStats.get('patternfly/patternfly-design-kit').githubCreated, 1, 'second repo tracked independently');

  // Clean up
  syncStats.repoStats.clear();
  syncStats.currentRepo = null;
}

// ─── SyncStats printSummary grouping ─────────────────────────────────────────

console.log('\n=== SyncStats printSummary grouping ===');

{
  syncStats.repoStats.clear();
  syncStats.setCurrentRepo('patternfly/patternfly-design-kit');

  // Add many warnings of the same type
  for (let i = 3756; i <= 3796; i++) {
    syncStats.track('warnings', { key: `PF-${i}`, message: 'GitHub issue is still open (not a sub-issue of parent)' });
  }

  const stats = syncStats.repoStats.get('patternfly/patternfly-design-kit');
  assertEqual(stats.warnings.length, 41, 'all 41 warnings tracked');

  // Verify grouping logic (same as printSummary uses)
  const grouped = new Map();
  for (const w of stats.warnings) {
    const keys = grouped.get(w.message) || [];
    keys.push(w.key);
    grouped.set(w.message, keys);
  }

  assertEqual(grouped.size, 1, 'all warnings group into 1 message type');
  const keys = grouped.get('GitHub issue is still open (not a sub-issue of parent)');
  assertEqual(keys.length, 41, 'grouped message has all 41 keys');
  assert(keys.includes('PF-3756'), 'includes first key');
  assert(keys.includes('PF-3796'), 'includes last key');

  // Clean up
  syncStats.repoStats.clear();
  syncStats.currentRepo = null;
}

// ─── ErrorCollector ──────────────────────────────────────────────────────────

console.log('\n=== ErrorCollector ===');

{
  errorCollector.clear();
  assertEqual(errorCollector.hasErrors(), false, 'no errors initially');

  errorCollector.addError('TEST: context1', new Error('test error 1'));
  errorCollector.addError('TEST: context2', new Error('test error 2'));

  assertEqual(errorCollector.hasErrors(), true, 'hasErrors returns true after adding');
  assertEqual(errorCollector.errors.length, 2, 'tracks 2 errors');
  assertEqual(errorCollector.errors[0].context, 'TEST: context1', 'first error context');
  assertEqual(errorCollector.errors[0].message, 'test error 1', 'first error message');

  errorCollector.clear();
  assertEqual(errorCollector.hasErrors(), false, 'clear resets errors');
  assertEqual(errorCollector.errors.length, 0, 'clear empties array');
}

// ─── Rate limit retry logic (executeGraphQLQuery) ────────────────────────────

console.log('\n=== Rate limit constants ===');

{
  // Read the helpers source to verify rate limit constants
  const helpersSrc = readFileSync(join(__dirname, '../src/helpers.js'), 'utf-8');

  assert(helpersSrc.includes('RATE_LIMIT_MAX_RETRIES = 2'), 'max retries is 2');
  assert(helpersSrc.includes('RATE_LIMIT_MAX_WAIT_MS = 5 * 60 * 1000'), 'max wait is 5 minutes');
  assert(helpersSrc.includes('RATE_LIMIT_MIN_WAIT_MS = 60 * 1000'), 'min wait is 60 seconds');
  assert(helpersSrc.includes("e.type === 'RATE_LIMITED'"), 'detects RATE_LIMITED error type');
  assert(helpersSrc.includes("error?.response?.headers?.['retry-after']"), 'handles retry-after header for secondary rate limits');
}

// ─── Jira link footer guard: empty body handling ─────────────────────────────

console.log('\n=== addJiraLinkToGitHub: empty body guard ===');

{
  // Read the source to verify the fix
  const syncSrc = readFileSync(join(__dirname, '../src/syncJiraToGitHub.js'), 'utf-8');

  // Verify the fix: should be `if (!bodyHasKey)` not `if (!bodyHasKey && body)`
  assert(syncSrc.includes('if (!bodyHasKey) {'), 'addJiraLinkToGitHub uses !bodyHasKey without && body guard');
  assert(!syncSrc.includes('if (!bodyHasKey && body)'), 'old guard with && body is removed');
}

// ─── Sub-issue GraphQL queries include body field ────────────────────────────

console.log('\n=== Sub-issue GraphQL queries include body field ===');

{
  const helpersSrc = readFileSync(join(__dirname, '../src/helpers.js'), 'utf-8');

  // Check GET_ALL_REPO_ISSUES sub-issues include body
  const mainQueryMatch = helpersSrc.match(/subIssues\(first: \$numSubIssuesPerIssue\)\s*\{[\s\S]*?totalCount\s*\}/);
  assert(mainQueryMatch && mainQueryMatch[0].includes('body'), 'GET_ALL_REPO_ISSUES sub-issues query includes body field');

  // Check FETCH_SUB_ISSUES includes body
  const paginationQueryMatch = helpersSrc.match(/FETCH_SUB_ISSUES[\s\S]*?subIssues\(first: \$first[\s\S]*?totalCount\s*\}\s*\}/);
  assert(paginationQueryMatch && paginationQueryMatch[0].includes('body'), 'FETCH_SUB_ISSUES pagination query includes body field');
}

// ─── Sub-issue pagination: pageInfo in main query ────────────────────────────

console.log('\n=== Sub-issue pagination: pageInfo in main query ===');

{
  const helpersSrc = readFileSync(join(__dirname, '../src/helpers.js'), 'utf-8');

  // The subIssues field in GET_ALL_REPO_ISSUES should have pageInfo for cursor-based pagination
  // Match from subIssues opening to the closing that includes totalCount (greedy enough to get pageInfo)
  const subIssuesSection = helpersSrc.match(/subIssues\(first: \$numSubIssuesPerIssue\)\s*\{[\s\S]*?pageInfo[\s\S]*?totalCount/);
  assert(subIssuesSection, 'GET_ALL_REPO_ISSUES subIssues has pageInfo');
  assert(subIssuesSection && subIssuesSection[0].includes('endCursor'), 'pageInfo includes endCursor');
  assert(subIssuesSection && subIssuesSection[0].includes('hasNextPage'), 'pageInfo includes hasNextPage');
}

// ─── Default lookback is 2 days ──────────────────────────────────────────────

console.log('\n=== Default lookback is 2 days ===');

{
  const indexSrc = readFileSync(join(__dirname, '../src/index.js'), 'utf-8');
  const matches = indexSrc.match(/date\.getDate\(\) - (\d+)/g);
  assert(matches && matches.length > 0, 'found getDate subtraction in index.js');
  assert(matches.every(m => m.includes('- 2')), 'all default lookbacks are 2 days (not 7)');
}

// ─── Description truncation for oversized issues ─────────────────────────────

console.log('\n=== Description truncation for oversized issues ===');

{
  // Build a GitHub issue with a small body — should NOT be truncated
  const smallIssue = {
    title: 'Small issue',
    url: 'https://github.com/patternfly/patternfly-react/issues/100',
    body: 'This is a small issue body.',
    number: 100,
    labels: { nodes: [] },
    assignees: { nodes: [] },
    author: { login: 'testuser' },
    issueType: null,
  };

  const smallResult = buildJiraIssueData(smallIssue, false);
  const smallText = extractTextFromADF(smallResult.fields.description);
  assert(!smallText.includes('truncated due to size'), 'small issue is NOT truncated');
  assert(smallText.includes('small issue body'), 'small issue body is preserved');
}

{
  // Build a GitHub issue with an oversized body (>30KB when converted to ADF)
  // Simulate a Dependency Dashboard with hundreds of checkbox items
  const lines = [];
  for (let i = 0; i < 500; i++) {
    lines.push(`- [ ] chore(deps): update dependency @some-very-long-scoped/package-name-${i} to ^${i}.0.0`);
  }
  const largeBody = '## Dependency Dashboard\n\n' + lines.join('\n');

  const largeIssue = {
    title: 'Dependency Dashboard',
    url: 'https://github.com/patternfly/patternfly-react/issues/6246',
    body: largeBody,
    number: 6246,
    labels: { nodes: [{ name: 'Spike' }] },
    assignees: { nodes: [] },
    author: { login: 'renovate[bot]' },
    issueType: null,
  };

  const largeResult = buildJiraIssueData(largeIssue, false);
  const largeDescJson = JSON.stringify(largeResult.fields.description);
  assert(largeDescJson.length < 30000, 'truncated description is under 30KB: ' + largeDescJson.length + ' bytes');

  const largeText = extractTextFromADF(largeResult.fields.description);
  assert(largeText.includes('truncated due to size'), 'oversized issue contains truncation notice');
  assert(largeText.includes('6246'), 'truncation notice includes issue number');
  assert(largeText.includes('github.com/patternfly/patternfly-react/issues/6246'), 'truncation notice includes GitHub URL');

  // Verify the GitHub link is a proper ADF link node (not plain text)
  const descContent = largeResult.fields.description.content;
  const truncationParagraph = descContent.find(
    (block) => block.type === 'paragraph' && block.content?.some(
      (node) => node.text && node.text.includes('truncated due to size')
    )
  );
  assert(truncationParagraph, 'truncation notice is in a paragraph block');
  const linkNode = truncationParagraph.content.find(
    (node) => node.marks?.some((m) => m.type === 'link')
  );
  assert(linkNode, 'truncation notice contains an ADF link node');
  assert(
    linkNode.marks[0].attrs.href === 'https://github.com/patternfly/patternfly-react/issues/6246',
    'ADF link href points to GitHub issue'
  );
  assertEqual(linkNode.text, 'GitHub Issue #6246', 'ADF link text is correct');
}

{
  // Verify truncation works the same for updates (isUpdateIssue = true)
  const lines = [];
  for (let i = 0; i < 500; i++) {
    lines.push(`- [ ] fix(deps): update dependency package-${i} to ^${i}.0.0`);
  }

  const updateIssue = {
    title: 'Dependency Dashboard',
    url: 'https://github.com/patternfly/patternfly-react/issues/6246',
    body: '## Dashboard\n\n' + lines.join('\n'),
    number: 6246,
    labels: { nodes: [] },
    assignees: { nodes: [] },
    author: { login: 'renovate[bot]' },
    issueType: null,
  };

  const updateResult = buildJiraIssueData(updateIssue, true);
  const updateText = extractTextFromADF(updateResult.fields.description);
  assert(updateText.includes('truncated due to size'), 'update mode also truncates oversized descriptions');
}

// ─── Truncated descriptions don't sync back to GitHub ────────────────────────

console.log('\n=== Truncated descriptions never sync back to GitHub ===');

{
  const syncSrc = readFileSync(join(__dirname, '../src/syncJiraToGitHub.js'), 'utf-8');

  // Verify syncTitleAndDescriptionToGitHub checks for truncation before syncing description
  assert(
    syncSrc.includes("Issue description was truncated due to size"),
    'syncTitleAndDescriptionToGitHub checks for truncation notice'
  );

  // Verify the truncation check prevents updating the body
  // The guard should be before the `updates.body = newBody` assignment
  const truncationCheckIdx = syncSrc.indexOf('Issue description was truncated due to size');
  const updatesBodyIdx = syncSrc.indexOf('updates.body = newBody');
  assert(
    truncationCheckIdx < updatesBodyIdx,
    'truncation guard appears before body update assignment'
  );
}

// ─── Paginated Jira search ────────────────────────────────────────────────────

console.log('\n=== Paginated Jira search ===');

{
  const indexSrc = readFileSync(join(__dirname, '../src/index.js'), 'utf-8');
  const helpersSrc = readFileSync(join(__dirname, '../src/helpers.js'), 'utf-8');

  // Verify paginatedJiraSearch exists and uses startAt for pagination
  assert(helpersSrc.includes('export async function paginatedJiraSearch'), 'paginatedJiraSearch is exported from helpers');
  assert(helpersSrc.includes('startAt'), 'paginatedJiraSearch uses startAt for pagination');
  assert(helpersSrc.includes('data.total'), 'paginatedJiraSearch checks total for loop termination');

  // Verify all three fetch functions in index.js use paginatedJiraSearch
  assert(indexSrc.includes("import { jiraClient, getRepoIssues, availableComponents, hasUpstreamUrl, paginatedJiraSearch }"),
    'index.js imports paginatedJiraSearch');

  // Count occurrences of paginatedJiraSearch calls (should be 3: open, closed, manual)
  const calls = indexSrc.match(/paginatedJiraSearch\(/g);
  assertEqual(calls?.length, 3, 'index.js calls paginatedJiraSearch 3 times (open, closed, manual)');

  // Verify fetchJiraIssues uses updatedDate filter
  assert(indexSrc.includes('updatedDate >= ') && indexSrc.includes('status not in (Closed, Resolved)'),
    'fetchJiraIssues JQL includes updatedDate filter');

  // Verify no raw jiraClient.get search/jql calls remain in index.js
  const rawCalls = indexSrc.match(/jiraClient\.get\('\/rest\/api\/3\/search\/jql'/g);
  assertEqual(rawCalls, null, 'no raw jiraClient.get search/jql calls remain in index.js');
}

// ─── Old Jira issues without Upstream URL get GitHub issues created ──────────

console.log('\n=== Old Jira issues without Upstream URL get GitHub issues created ===');

{
  // Verify syncUpdatedJiraIssuesToGitHub collects issues without upstream URL
  const syncSrc = readFileSync(join(__dirname, '../src/syncJiraToGitHub.js'), 'utf-8');

  assert(syncSrc.includes('const issuesWithoutUpstream = []'),
    'syncUpdatedJiraIssuesToGitHub declares issuesWithoutUpstream array');
  assert(syncSrc.includes('issuesWithoutUpstream.push(jiraIssue)'),
    'syncUpdatedJiraIssuesToGitHub collects issues without upstream URL');
  assert(syncSrc.includes('return issuesWithoutUpstream'),
    'syncUpdatedJiraIssuesToGitHub returns issuesWithoutUpstream');

  // Verify issuesWithoutUpstream is declared outside the try block so catch can access it
  const declIdx = syncSrc.indexOf('const issuesWithoutUpstream = []');
  const tryIdx = syncSrc.indexOf('try {', declIdx > -1 ? declIdx : 0);
  assert(declIdx > -1 && tryIdx > -1 && declIdx < tryIdx,
    'issuesWithoutUpstream is declared before the try block');

  // Verify catch block returns issuesWithoutUpstream (not []) to preserve partial results
  const catchBlock = syncSrc.match(/catch \(error\) \{[\s\S]*?SYNCJIRATOGITHUB: Error processing recently-updated[\s\S]*?return (.*?);/);
  assert(catchBlock, 'catch block has a return statement');
  assertEqual(catchBlock[1], 'issuesWithoutUpstream',
    'catch block returns issuesWithoutUpstream (preserves partial results on error)');
}

{
  // Verify index.js captures the return value, merges with manual issues, and fetches needed fields
  const indexSrc = readFileSync(join(__dirname, '../src/index.js'), 'utf-8');

  assert(indexSrc.includes('jiraIssuesWithoutUpstream = await syncUpdatedJiraIssuesToGitHub'),
    'index.js captures return value of syncUpdatedJiraIssuesToGitHub');
  assert(indexSrc.includes("manualKeys"),
    'index.js deduplicates by Jira key');
  assert(indexSrc.includes('allManualJiraIssues'),
    'index.js combines manual and upstream-less issues');

  const fetchJiraMatch = indexSrc.match(/paginatedJiraSearch\(\s*`project = PF AND component.*?status not in.*?`,\s*'([^']*)'/s);
  assert(fetchJiraMatch, 'found fetchJiraIssues paginatedJiraSearch call');
  assert(fetchJiraMatch[1].includes('resolution'), 'fetchJiraIssues fields include resolution');
  assert(fetchJiraMatch[1].includes('reporter'), 'fetchJiraIssues fields include reporter');
}

{
  // Test deduplication logic: issues appearing in both lists should not be doubled
  const manualJiraIssues = [
    { key: 'PF-100', fields: { summary: 'Issue 100' } },
    { key: 'PF-101', fields: { summary: 'Issue 101' } },
  ];
  const jiraIssuesWithoutUpstream = [
    { key: 'PF-101', fields: { summary: 'Issue 101 (from updated)' } },
    { key: 'PF-102', fields: { summary: 'Issue 102' } },
  ];

  const manualKeys = new Set(manualJiraIssues.map(i => i.key));
  const additionalIssues = jiraIssuesWithoutUpstream.filter(i => !manualKeys.has(i.key));
  const allManualJiraIssues = [...manualJiraIssues, ...additionalIssues];

  assertEqual(allManualJiraIssues.length, 3, 'deduplication: 3 unique issues (not 4)');
  assertEqual(additionalIssues.length, 1, 'deduplication: only PF-102 is additional');
  assertEqual(additionalIssues[0].key, 'PF-102', 'deduplication: additional issue is PF-102');
  // Manual issues take priority (they have more fields like reporter, resolution)
  const pf101 = allManualJiraIssues.find(i => i.key === 'PF-101');
  assertEqual(pf101.fields.summary, 'Issue 101', 'deduplication: manual version of PF-101 takes priority');
}

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
