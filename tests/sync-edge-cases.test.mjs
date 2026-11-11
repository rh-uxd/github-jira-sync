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
import { availableComponents, recordCreatedJiraIssue, getCreatedJiraKey, clearCreatedJiraIssues, createNewJiraIssue, extractTextFromADF, extractUpstreamUrl, buildJiraIssueData, paginatedJiraSearch, buildPrUrlsADF, getOctokitForOwner, extractJiraKeyFromText, isInvalidInputError, buildSafeDescriptionADF, UNSYNCABLE_DESCRIPTION_MARKER, shouldSyncFromGitHub, normalizeMarkdownForCompare, buildDescriptionADF, adfToMarkdown, editJiraIssue, syncCommentsToJira, stripRepoPrefix, jiraClient } from '../src/helpers.js';
import { syncStats, errorCollector, markRunFailedIfErrors, emitCiAnnotations, buildStepSummaryMarkdown, writeStepSummary, escapeWorkflowData } from '../src/logging.js';
import { updateChildIssues, isHierarchyError, getExistingParentKey, findChildIssues } from '../src/updateJiraIssue.js';
import { shouldWritePrLinks, getCurrentPrField } from '../src/syncPRLinksToJira.js';
import { parseArgs, selectComponents } from '../src/index.js';
import { findJiraIssue } from '../src/findJiraIssue.js';

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
  assertEqual(syncStats.hasErrors(), true, 'reports errors across repos');
  const fakeProcess = { exitCode: 0 };
  assertEqual(markRunFailedIfErrors(fakeProcess), true, 'marks run failed when errors were recorded');
  assertEqual(fakeProcess.exitCode, 1, 'sets a nonzero process exit code for errors');
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
  assertEqual(syncStats.hasErrors(), true, 'retains run failure after switching repos');

  // Clean up
  syncStats.repoStats.clear();
  syncStats.currentRepo = null;
  assertEqual(syncStats.hasErrors(), false, 'reports no errors after stats reset');
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

  // The collected error block must use the same stream as regular sync output
  // so GitHub Actions cannot visually move it into the next repository's log.
  const stdout = [];
  const stderr = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => stdout.push(args.join(' '));
  console.error = (...args) => stderr.push(args.join(' '));
  try {
    errorCollector.logErrors();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assertEqual(stdout.length, 4, 'writes all collected error lines to stdout');
  assertEqual(stderr.length, 0, 'does not split collected error block across streams');
  assert(stdout[0].includes('TEST: context1'), 'stdout error block includes first error');
  assert(stdout[2].includes('TEST: context2'), 'stdout error block includes second error');

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

// ─── A Jira description never overwrites a GitHub issue body ─────────────────
// Jira's copy of a description can be a lossy rendering of the GitHub body (issues created
// before the ADF writer went through Jira's wiki-markup conversion), and any Jira activity
// (sprint, rank, Team automation, status) makes Jira "newer". Pushing it back rewrote 346
// GitHub bodies and broke links, code names and tables. GitHub is the source of truth.

console.log('\n=== Jira descriptions never overwrite a GitHub body ===');

{
  const syncSrc = readFileSync(join(__dirname, '../src/syncJiraToGitHub.js'), 'utf-8');
  const updateSrc = readFileSync(join(__dirname, '../src/updateJiraIssue.js'), 'utf-8');

  // The functions that pushed a description to GitHub are gone
  assert(!/function syncTitleAndDescriptionToGitHub/.test(syncSrc), 'syncTitleAndDescriptionToGitHub no longer exists');
  assert(!/function syncDescriptionToGitHub/.test(syncSrc), 'syncDescriptionToGitHub no longer exists');
  assert(!/syncTitleAndDescriptionToGitHub|syncDescriptionToGitHub/.test(updateSrc), 'updateJiraIssue does not call a description push');

  // The only GitHub write that carries a body on the Jira->GitHub paths is the footer append
  // (addJiraLinkToGitHub) and creating a brand-new issue from a manual Jira issue.
  const fnSource = (name) => { const m = syncSrc.match(new RegExp(`(?:export )?(?:async )?function ${name}\\b[\\s\\S]*?\\n}\\n`)); return m ? m[0] : ''; };
  const bodyWrites = syncSrc.match(/updateGitHubIssue\([^)]*\{[^}]*\bbody\b[^}]*\}\s*\)/g) || [];
  const footerFn = fnSource('addJiraLinkToGitHub');
  assertEqual(bodyWrites.length, 1, 'exactly one updateGitHubIssue call writes a body');
  assert(bodyWrites.length === 1 && footerFn.includes(bodyWrites[0].split('\n')[0].trim().slice(0, 30)), 'the only body write is the footer append in addJiraLinkToGitHub');

  // The title sync writes only the title, never a body
  const titleFn = fnSource('syncTitleToGitHub');
  assert(titleFn.length > 0 && !/\bbody\b/.test(titleFn), 'syncTitleToGitHub never touches the body');
  assert(syncSrc.includes('syncTitleToGitHub(jiraIssue, githubIssue)') && updateSrc.includes('syncTitleToGitHub(jiraIssue, githubIssue)'),
    'both Jira->GitHub paths use the title-only sync');
}

{
  // Behaviour: Jira is newer and its description differs, but the titles match -> nothing is written
  // (syncTitleToGitHub returns false before any network call).
  const { syncTitleToGitHub } = await import('../src/syncJiraToGitHub.js');
  const jiraIssue = { key: 'FELT-1', fields: { summary: 'Same title', updated: '2026-11-04T15:30:00.000+0000', description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Jira-side rendering that differs from GitHub' }] }] } } };
  const githubIssue = { number: 1, url: 'https://github.com/patternfly/patternfly/issues/1', title: 'Same title', body: 'The original GitHub body', updatedAt: '2026-11-01T00:00:00Z' };
  assertEqual(await syncTitleToGitHub(jiraIssue, githubIssue), false, 'Jira newer + different description + same title -> no write');
}

{
  // The state right after a GitHub->Jira write must not trigger anything either direction:
  // Jira was just updated (T0) and GitHub was last touched within 60s of it (footer append) or earlier.
  const T0 = '2026-11-04T10:00:00.000+0000';
  const jira = { fields: { updated: T0 } };
  assertEqual(shouldSyncFromGitHub({ updatedAt: '2026-11-04T10:00:05Z' }, jira), false, 'GitHub 5s after the Jira write is a tie -> GitHub->Jira description compare is skipped');
  assertEqual(shouldSyncFromGitHub({ updatedAt: '2026-11-04T09:00:00Z' }, jira), false, 'GitHub older than Jira -> GitHub->Jira is skipped');
  // ...and a real, later GitHub change (>= 60s after Jira) is the only thing that rewrites Jira again
  assertEqual(shouldSyncFromGitHub({ updatedAt: '2026-11-04T10:02:00Z' }, jira), true, 'a genuinely newer GitHub update still syncs GitHub->Jira');
}

// ─── Paginated Jira search ────────────────────────────────────────────────────

console.log('\n=== Paginated Jira search ===');

{
  const indexSrc = readFileSync(join(__dirname, '../src/index.js'), 'utf-8');
  const helpersSrc = readFileSync(join(__dirname, '../src/helpers.js'), 'utf-8');

  assert(helpersSrc.includes('export async function paginatedJiraSearch'), 'paginatedJiraSearch is exported from helpers');
  // /search/jql pages by nextPageToken and returns no `total`; paging by startAt/total stopped after page 1
  assert(helpersSrc.includes('nextPageToken') && helpersSrc.includes('isLast'), 'paginatedJiraSearch pages by nextPageToken until isLast');
  assert(!/startAt|data\.total/.test(helpersSrc.slice(helpersSrc.indexOf('export async function paginatedJiraSearch'), helpersSrc.indexOf('export async function addRemoteLinkToJiraIssue'))), 'paginatedJiraSearch no longer relies on startAt/total');

  // Verify all three fetch functions in index.js use paginatedJiraSearch
  assert(indexSrc.includes('paginatedJiraSearch') && /import \{[^}]*paginatedJiraSearch[^}]*\} from '\.\/helpers\.js'/.test(indexSrc),
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

// ─── paginatedJiraSearch follows nextPageToken (was capped at the first 100 results) ───

console.log('\n=== paginatedJiraSearch pages by nextPageToken ===');

{
  const realGet = jiraClient.get;
  const mkIssues = (from, count) => Array.from({ length: count }, (_, i) => ({ key: `FELT-${from + i}` }));
  try {
    // The real endpoint's shape: issues + nextPageToken + isLast, no `total`, `startAt` ignored.
    // 237 results across 3 pages. The old startAt/total loop read total as 0 and returned only page 1.
    const calls = [];
    const pages = {
      first: { issues: mkIssues(1, 100), nextPageToken: 'tok-1', isLast: false },
      'tok-1': { issues: mkIssues(101, 100), nextPageToken: 'tok-2', isLast: false },
      'tok-2': { issues: mkIssues(201, 37), isLast: true },
    };
    jiraClient.get = async (u, config) => {
      calls.push({ u, params: config.params });
      return { data: pages[config.params.nextPageToken || 'first'] };
    };
    const all = await paginatedJiraSearch('project = FELT', 'key');
    assertEqual(all.length, 237, 'every page is collected (237 issues over 3 pages, not just the first 100)');
    assertEqual(all[0].key, 'FELT-1', 'in order: first issue');
    assertEqual(all[236].key, 'FELT-237', 'in order: last issue');
    assertEqual(calls.length, 3, 'one request per page');
    assert(calls.every((c) => c.u === '/rest/api/3/search/jql'), 'all requests go to the search endpoint');
    assert(calls[0].params.nextPageToken === undefined, 'the first request carries no page token');
    assertEqual(calls[1].params.nextPageToken, 'tok-1', 'the second request sends the first page token');
    assertEqual(calls[2].params.nextPageToken, 'tok-2', 'the third request sends the second page token');
    assert(calls.every((c) => !('startAt' in c.params)), 'startAt is never sent (the endpoint ignores it)');
    assert(calls.every((c) => c.params.maxResults === 100 && c.params.jql === 'project = FELT' && c.params.fields === 'key'), 'jql, fields and the page size are sent on every request');

    // a single page that is the last one: exactly one request
    calls.length = 0;
    jiraClient.get = async (u, config) => { calls.push(config.params); return { data: { issues: mkIssues(1, 5), isLast: true } }; };
    assertEqual((await paginatedJiraSearch('q', 'key')).length, 5, 'a single last page returns its issues');
    assertEqual(calls.length, 1, 'and makes one request');

    // no isLast and no token at all (older shape / a mock): treated as one page, no loop
    calls.length = 0;
    jiraClient.get = async (u, config) => { calls.push(config.params); return { data: { issues: mkIssues(1, 3) } }; };
    assertEqual((await paginatedJiraSearch('q', 'key')).length, 3, 'a response without isLast or a token is one page');
    assertEqual(calls.length, 1, 'and does not loop');

    // zero results
    jiraClient.get = async () => ({ data: { issues: [], isLast: true } });
    assertEqual((await paginatedJiraSearch('q', 'key')).length, 0, 'no results returns an empty list');

    // guards against an endless loop: an empty page that still offers a token, and a token that never changes
    calls.length = 0;
    jiraClient.get = async (u, config) => { calls.push(config.params); return { data: { issues: [], nextPageToken: 'again', isLast: false } }; };
    assertEqual((await paginatedJiraSearch('q', 'key')).length, 0, 'an empty page with a token ends the search');
    assertEqual(calls.length, 1, 'after one request');

    calls.length = 0;
    jiraClient.get = async (u, config) => { calls.push(config.params); return { data: { issues: mkIssues(calls.length, 2), nextPageToken: 'same', isLast: false } }; };
    const stuck = await paginatedJiraSearch('q', 'key');
    assertEqual(calls.length, 2, 'a token Jira returns unchanged stops after the repeat');
    assertEqual(stuck.length, 4, 'keeping the issues already read');

    // an error propagates to the caller (the index.js fetchers rely on their own try/catch)
    jiraClient.get = async () => { throw new Error('jira down'); };
    let threw = false;
    try { await paginatedJiraSearch('q', 'key'); } catch { threw = true; }
    assert(threw, 'a failing request is not swallowed');
  } finally {
    jiraClient.get = realGet;
  }
}

// ─── findChildIssues returns every child, not the first 100 ──────────────────

console.log('\n=== findChildIssues pages through all children ===');

{
  const realGet = jiraClient.get;
  try {
    const seen = [];
    jiraClient.get = async (u, config) => {
      seen.push(config.params);
      // 120 children: Jira returns 100, then 20. The old single request (maxResults 250) got only the first 100.
      if (!config.params.nextPageToken) {
        return { data: { issues: Array.from({ length: 100 }, (_, i) => ({ key: `FELT-${i + 1}` })), nextPageToken: 'p2', isLast: false } };
      }
      return { data: { issues: Array.from({ length: 20 }, (_, i) => ({ key: `FELT-${i + 101}` })), isLast: true } };
    };
    const children = await findChildIssues('FELT-5563');
    assertEqual(children.length, 120, 'a parent with 120 children returns all 120');
    assertEqual(seen.length, 2, 'in two requests');
    assertEqual(seen[0].jql, 'parent = FELT-5563', 'the query is the parent lookup');
    assert(String(seen[0].fields).includes('description'), 'children come back with their description (used to match Upstream URL)');

    // a failure still returns [] and is recorded, as before
    errorCollector.clear();
    jiraClient.get = async () => { throw new Error('boom'); };
    const none = await findChildIssues('FELT-5563');
    assertEqual(none.length, 0, 'a failed lookup returns no children');
    assert(errorCollector.hasErrors(), 'and the error is recorded');
    errorCollector.clear();
  } finally {
    jiraClient.get = realGet;
  }
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

  const fetchJiraMatch = indexSrc.match(/paginatedJiraSearch\(\s*`project = FELT AND component.*?status not in.*?`,\s*'([^']*)'/s);
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

// ─── Unassignable Jira user: assignee retry logic ───────────────────────────

console.log('\n=== Unassignable Jira user: assignee retry logic ===');

{
  // Verify updateJiraIssue.js wraps editJiraIssue in a try-catch that handles assignee errors
  const updateSrc = readFileSync(join(__dirname, '../src/updateJiraIssue.js'), 'utf-8');

  assert(updateSrc.includes("editError.response?.data?.errors?.assignee"),
    'editJiraIssue catch checks for assignee field error');
  assert(updateSrc.includes("delete jiraIssueData.fields.assignee"),
    'assignee is removed from payload on retry');
  assert(updateSrc.includes("Retrying without assignee"),
    'logs a warning about unassignable user before retrying');
}

{
  // Verify assignee error detection logic correctly identifies assignee 400 errors
  const mockErrorResponse = {
    status: 400,
    data: {
      errorMessages: [],
      errors: { assignee: "User '557058:a502f956-47d6-4de9-85b0-75424d4014d0' cannot be assigned issues." }
    }
  };

  const isAssigneeError =
    mockErrorResponse.status === 400 &&
    mockErrorResponse.data?.errors?.assignee;

  assert(isAssigneeError, 'detects assignee error from Jira 400 response');
}

{
  // Non-assignee 400 error should NOT match
  const mockOtherError = {
    status: 400,
    data: {
      errorMessages: ['Field "summary" is required'],
      errors: { summary: 'You must specify a summary of the issue.' }
    }
  };

  const isAssigneeError =
    mockOtherError.status === 400 &&
    mockOtherError.data?.errors?.assignee;

  assert(!isAssigneeError, 'non-assignee 400 error is NOT treated as assignee error');
}

{
  // Verify retry removes assignee from payload but preserves other fields
  const payload = {
    fields: {
      summary: 'Test issue',
      description: { type: 'doc', content: [] },
      assignee: { accountId: '557058:a502f956-47d6-4de9-85b0-75424d4014d0' },
    }
  };

  delete payload.fields.assignee;
  assertEqual(payload.fields.assignee, undefined, 'assignee removed from payload for retry');
  assertEqual(payload.fields.summary, 'Test issue', 'summary preserved after assignee removal');
  assertEqual(payload.fields.description.type, 'doc', 'description preserved after assignee removal');
}

{
  // Verify transition logic (transitionJiraIssue) is still reachable after editJiraIssue error handling
  // The editJiraIssue try-catch should be INSIDE the changes.length block,
  // and transitionJiraIssue should be OUTSIDE it (later in the same else branch)
  const updateSrc = readFileSync(join(__dirname, '../src/updateJiraIssue.js'), 'utf-8');

  const editTryCatchIdx = updateSrc.indexOf("} catch (editError) {");
  const transitionIdx = updateSrc.indexOf("transitionJiraIssue(jiraIssue.key, 'Closed')");

  assert(editTryCatchIdx > -1, 'editJiraIssue has inner try-catch');
  assert(transitionIdx > -1, 'transitionJiraIssue Closed call exists');
  assert(editTryCatchIdx < transitionIdx,
    'editJiraIssue error handling occurs before transition logic (transition is still reachable)');
}

{
  // When assignee is the ONLY change, retry should be skipped and no false success logged
  const changes = ['assignee'];
  const assigneeIdx = changes.indexOf('assignee');
  if (assigneeIdx > -1) changes.splice(assigneeIdx, 1);
  assertEqual(changes.length, 0, 'changes is empty when assignee was the only change — retry skipped');
}

{
  // When assignee + other fields changed, retry should proceed with remaining changes
  const changes = ['title', 'assignee', 'description'];
  const assigneeIdx = changes.indexOf('assignee');
  if (assigneeIdx > -1) changes.splice(assigneeIdx, 1);
  assertEqual(changes.length, 2, 'two changes remain after removing assignee');
  assert(!changes.includes('assignee'), 'assignee removed from changes list');
  assert(changes.includes('title') && changes.includes('description'), 'title and description preserved in changes');
}

{
  // Verify success logging is gated on changes.length > 0 after the catch block
  // This prevents false success when assignee was the only change
  const updateSrc = readFileSync(join(__dirname, '../src/updateJiraIssue.js'), 'utf-8');

  const catchBlockEnd = updateSrc.indexOf('throw editError');
  const successGuard = updateSrc.indexOf('if (changes.length > 0) {\n          syncSummary.githubToJira', catchBlockEnd);
  assert(successGuard > catchBlockEnd,
    'syncSummary.githubToJira is gated on changes.length > 0 after catch block');
}

// ─── Child issue skip-close log message ─────────────────────────────────────

console.log('\n=== Child issue skip-close log message ===');

{
  const updateSrc = readFileSync(join(__dirname, '../src/updateJiraIssue.js'), 'utf-8');

  assert(updateSrc.includes('linked GitHub issue is still open'),
    'skip-close log message says "linked GitHub issue is still open"');
  assert(!updateSrc.includes('not a sub-issue of parent'),
    'old misleading "not a sub-issue of parent" message is removed');
  assert(!updateSrc.includes("track('warnings'") || !updateSrc.substring(
    updateSrc.indexOf('linked GitHub issue is still open') - 200,
    updateSrc.indexOf('linked GitHub issue is still open') + 200
  ).includes("track('warnings'"),
    'skip-close does not track a warning for open GitHub issues');
}

// ─── PR link sync (customfield_10875) ───────────────────────────────────────

console.log('\n=== PR link sync (customfield_10875) ===');

const baseIssue = {
  title: 'Test issue',
  url: 'https://github.com/patternfly/patternfly-react/issues/100',
  body: 'Test body',
  number: 100,
  labels: { nodes: [] },
  assignees: { nodes: [] },
  author: { login: 'testuser' },
  issueType: null,
};

{
  // With PRs on update — field is ADF doc with URLs as text nodes separated by hardBreaks
  const issue = {
    ...baseIssue,
    closedByPullRequestsReferences: {
      nodes: [
        { url: 'https://github.com/patternfly/patternfly-react/pull/200' },
        { url: 'https://github.com/patternfly/patternfly-react/pull/201' },
      ],
    },
  };
  const result = buildJiraIssueData(issue, true);
  const field = result.fields['customfield_10875'];
  assertEqual(field?.type, 'doc', 'customfield_10875 is ADF doc');
  const text = extractTextFromADF(field).trim();
  assert(text.includes('pull/200'), 'ADF contains first PR URL');
  assert(text.includes('pull/201'), 'ADF contains second PR URL');

  // On create the field is omitted: FELT has it on the edit screen but not the create
  // screen, so setting it there would be rejected. It is written on the next update.
  const createResult = buildJiraIssueData(issue, false);
  assert(!('customfield_10875' in createResult.fields),
    'customfield_10875 omitted on create even when PRs are present');
}

{
  // No PRs — field not set
  const issue = {
    ...baseIssue,
    closedByPullRequestsReferences: { nodes: [] },
  };
  const result = buildJiraIssueData(issue, true);
  assert(!('customfield_10875' in result.fields), 'customfield_10875 not set when no PRs');
}

{
  // Missing closedByPullRequestsReferences — no crash, field not set
  const result = buildJiraIssueData(baseIssue, true);
  assert(!('customfield_10875' in result.fields), 'customfield_10875 not set when field missing from response');
}

{
  // Single PR — ADF with single inlineCard node, no hardBreak
  const issue = {
    ...baseIssue,
    closedByPullRequestsReferences: {
      nodes: [{ url: 'https://github.com/patternfly/patternfly-react/pull/300' }],
    },
  };
  const result = buildJiraIssueData(issue, true);
  const field = result.fields['customfield_10875'];
  assertEqual(field?.type, 'doc', 'single PR customfield_10875 is ADF doc');
  const para = field.content[0];
  assertEqual(para.content.length, 1, 'single PR paragraph has 1 node (no hardBreak)');
  assertEqual(para.content[0].type, 'inlineCard', 'single PR node is inlineCard');
  assertEqual(para.content[0].attrs.url, 'https://github.com/patternfly/patternfly-react/pull/300', 'single PR inlineCard url is correct');
}

{
  // buildPrUrlsADF: inlineCard nodes with hardBreak between them
  const adf = buildPrUrlsADF(['https://example.com/pull/1', 'https://example.com/pull/2']);
  const para = adf.content[0];
  assertEqual(para.content.length, 3, 'two PRs produce 3 nodes: inlineCard, hardBreak, inlineCard');
  assertEqual(para.content[0].type, 'inlineCard', 'first node is inlineCard');
  assertEqual(para.content[0].attrs.url, 'https://example.com/pull/1', 'first inlineCard url correct');
  assertEqual(para.content[1].type, 'hardBreak', 'middle node is hardBreak');
  assertEqual(para.content[2].type, 'inlineCard', 'last node is inlineCard');
}

{
  // extractTextFromADF handles inlineCard nodes — returns the url attr
  const adf = {
    type: 'doc',
    version: 1,
    content: [{
      type: 'paragraph',
      content: [
        { type: 'inlineCard', attrs: { url: 'https://example.com/pull/1' } },
        { type: 'hardBreak' },
        { type: 'inlineCard', attrs: { url: 'https://example.com/pull/2' } },
      ],
    }],
  };
  const text = extractTextFromADF(adf);
  assertEqual(text, 'https://example.com/pull/1\nhttps://example.com/pull/2', 'extractTextFromADF extracts URLs from inlineCard nodes');
}

{
  // extractTextFromADF: inlineCard with no attrs.url returns empty string
  const text = extractTextFromADF({ type: 'inlineCard', attrs: {} });
  assertEqual(text, '', 'inlineCard with no url attr returns empty string');
}

{
  // GraphQL queries include closedByPullRequestsReferences
  const helpersSrc = readFileSync(join(__dirname, '../src/helpers.js'), 'utf-8');
  const occurrences = (helpersSrc.match(/closedByPullRequestsReferences/g) || []).length;
  assert(occurrences >= 4, `closedByPullRequestsReferences appears in at least 4 query locations (found ${occurrences})`);
}

// ─── PR link sync via recently-updated PRs ───────────────────────────────────

console.log('\n=== PR link sync via recently-updated PRs ===');

{
  // helpers.js exports getRepoPRsSince and getIssuePRLinks
  const helpersSrc = readFileSync(join(__dirname, '../src/helpers.js'), 'utf-8');
  assert(helpersSrc.includes('export async function getRepoPRsSince'), 'getRepoPRsSince is exported');
  assert(helpersSrc.includes('export async function getIssuePRLinks'), 'getIssuePRLinks is exported');
  assert(helpersSrc.includes('GET_RECENT_PRS'), 'GET_RECENT_PRS query defined');
  assert(helpersSrc.includes('closingIssuesReferences'), 'GET_RECENT_PRS fetches closingIssuesReferences');
  assert(helpersSrc.includes('GET_ISSUE_PR_LINKS'), 'GET_ISSUE_PR_LINKS query defined');
}

{
  // getRepoPRsSince stops paginating when it hits a PR older than since
  const helpersSrc = readFileSync(join(__dirname, '../src/helpers.js'), 'utf-8');
  assert(helpersSrc.includes('new Date(pr.updatedAt) < sinceDate'), 'getRepoPRsSince stops at PRs older than since');
}

{
  // syncPRLinksToJira.js exists and has expected structure
  const syncSrc = readFileSync(join(__dirname, '../src/syncPRLinksToJira.js'), 'utf-8');
  assert(syncSrc.includes('export async function syncPRLinksToJira'), 'syncPRLinksToJira is exported');
  assert(syncSrc.includes('getRepoPRsSince'), 'calls getRepoPRsSince');
  assert(syncSrc.includes('getIssuePRLinks'), 'calls getIssuePRLinks');
  assert(syncSrc.includes('findJiraIssue'), 'calls findJiraIssue');
  assert(syncSrc.includes('editJiraIssue'), 'calls editJiraIssue');
  assert(syncSrc.includes('buildPrUrlsADF'), 'uses buildPrUrlsADF for ADF format');
}

{
  // index.js imports and calls syncPRLinksToJira
  const indexSrc = readFileSync(join(__dirname, '../src/index.js'), 'utf-8');
  assert(indexSrc.includes("import { syncPRLinksToJira }"), 'index.js imports syncPRLinksToJira');
  assert(indexSrc.includes('await syncPRLinksToJira(owner, repo, since)'), 'index.js calls syncPRLinksToJira');
}

{
  // parseIssueUrl correctly parses GitHub issue URLs (inline function in syncPRLinksToJira)
  const syncSrc = readFileSync(join(__dirname, '../src/syncPRLinksToJira.js'), 'utf-8');
  assert(syncSrc.includes('issueNumber: parseInt'), 'parseIssueUrl extracts issue number as integer');
}

// ─── INVALID_INPUT description fallback (Renovate Dependency Dashboard) ───────

console.log('\n=== INVALID_INPUT description fallback ===');

{
  // isInvalidInputError only matches the 400 INVALID_INPUT shape
  assert(isInvalidInputError({ response: { status: 400, data: { errorMessages: ['INVALID_INPUT'], errors: {} } } }),
    'detects 400 INVALID_INPUT');
  assert(!isInvalidInputError({ response: { status: 400, data: { errorMessages: [], errors: { assignee: 'x' } } } }),
    'assignee 400 is not INVALID_INPUT');
  assert(!isInvalidInputError({ response: { status: 404, data: { errorMessages: ['INVALID_INPUT'] } } }),
    'non-400 is not INVALID_INPUT');
  assert(!isInvalidInputError(new Error('boom')), 'plain error is not INVALID_INPUT');
}

{
  // Helper: assert an ADF tree contains no empty text nodes (the bug that triggers INVALID_INPUT)
  const hasEmptyTextNode = (node) => {
    if (Array.isArray(node)) return node.some(hasEmptyTextNode);
    if (!node || typeof node !== 'object') return false;
    if (node.type === 'text' && (node.text === '' || node.text == null)) return true;
    return node.content ? hasEmptyTextNode(node.content) : false;
  };

  const url = 'https://github.com/patternfly/patternfly/issues/4339';
  const originalDescription = {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'GH Issue 4339\nUpstream URL: ' },
          { type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url } }] },
        ],
      },
    ],
  };

  const fallback = buildSafeDescriptionADF(originalDescription);
  assertEqual(fallback.type, 'doc', 'fallback is an ADF doc');
  assert(!hasEmptyTextNode(fallback), 'fallback contains no empty text nodes');
  assertEqual(extractUpstreamUrl(fallback), url, 'fallback preserves the Upstream URL marker for link matching');
  assert(extractTextFromADF(fallback).includes('could not be synced'), 'fallback includes the explanatory notice');
  assert(extractTextFromADF(fallback).includes(UNSYNCABLE_DESCRIPTION_MARKER), 'fallback contains the marker that identifies it as a placeholder');

  // No Upstream URL present → still valid, just the notice (no footer)
  const noUrl = buildSafeDescriptionADF({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'nothing here' }] }] });
  assert(!hasEmptyTextNode(noUrl), 'fallback without URL has no empty text nodes');
  assertEqual(extractUpstreamUrl(noUrl), null, 'fallback without URL has no Upstream URL');
}

{
  // Both write paths wire up the INVALID_INPUT retry with the safe fallback
  const helpersSrc = readFileSync(join(__dirname, '../src/helpers.js'), 'utf-8');
  assert(/export async function createNewJiraIssue[\s\S]*isInvalidInputError[\s\S]*buildSafeDescriptionADF/.test(helpersSrc),
    'createNewJiraIssue retries on INVALID_INPUT with a safe description');
  assert(/export async function editJiraIssue[\s\S]*isInvalidInputError[\s\S]*buildSafeDescriptionADF/.test(helpersSrc),
    'editJiraIssue retries on INVALID_INPUT with a safe description');
}

// ─── "Did the description change?" ignores layout, so a GitHub touch doesn't rewrite Jira ─────
// Jira's exporter lays lists out differently from GitHub (blank line between items, `-` bullets,
// `*italic*`, `![alt](src)` for <img>). Treating that as a change rewrote Jira's description on
// every GitHub update (89 of 342 unchanged real bodies were flagged "changed").

console.log('\n=== Description comparison ignores layout, not content ===');

{
  const same = (a, b) => normalizeMarkdownForCompare(a) === normalizeMarkdownForCompare(b);
  assert(same('- a\n- b', '- a\n\n- b'), 'blank lines between list items are ignored');
  assert(same('* a\n+ b', '- a\n- b'), '* and + bullets equal - bullets');
  assert(same('an _italic_ word', 'an *italic* word'), '_italic_ equals *italic*');
  assert(same('<img width="10" alt="Shot" src="https://e.com/a.png" />', '![Shot](https://e.com/a.png)'), '<img> equals the markdown image with the same alt');
  assert(!same('<img alt="One" src="https://e.com/a.png">', '![Two](https://e.com/a.png)'), 'a different alt text is a real change');
  assert(same('  indented\r\ntext  ', 'indented\ntext'), 'indentation, trailing spaces and CRLF are ignored');
  // real edits are still seen
  assert(!same('Hello world', 'Hello there world'), 'a reworded sentence is a change');
  assert(!same('- a\n- b', '- a\n- b\n- c'), 'an added list item is a change');
  assert(!same('```\na\nb\n```', '```\na b\n```'), 'merging two code lines is a change');
  assert(!same('snake_case_word', 'snake*case*word'), 'underscores inside a word are not treated as italics');
  // end to end: a typical GitHub body compares equal to what Jira's copy exports back
  const body = '## Steps\n\n* open the page\n* click the _button_\n\n<img width="10" alt="Screenshot" src="https://e.com/s.png" />\n\nUse `foo_bar` here.';
  const exported = adfToMarkdown(buildDescriptionADF(body, { number: 1, url: 'u', reporter: 'x', assignees: '' }), { stripMetadata: true });
  assert(same(body, exported), 'a body compares equal to its own Jira round trip (no needless rewrite)');
}

// ─── Jira edits made by the sync don't email people ──────────────────────────
// The sync mirrors changes that already happened on GitHub, so each Jira edit used to email the
// reporter, watchers and assignee. Edits now send notifyUsers=false (needs Administer Projects).

console.log('\n=== Jira edits suppress notification emails ===');

{
  const realPut = jiraClient.put;
  const calls = [];
  const stub = (impl) => { calls.length = 0; jiraClient.put = async (url, data, config) => { calls.push({ url, data, config }); return impl(calls.length); }; };
  const httpError = (status, data = {}) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });
  const attempt = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
  try {
    // a normal edit asks Jira not to send the notification
    stub(() => ({ status: 204 }));
    await editJiraIssue('FELT-1', { fields: { summary: 'x' } });
    assertEqual(calls.length, 1, 'a normal edit makes one PUT');
    assertEqual(calls[0].url, '/rest/api/3/issue/FELT-1', 'the PUT targets the issue');
    assertEqual(calls[0].config?.params?.notifyUsers, false, 'the edit sends notifyUsers=false');
    assertEqual(calls[0].data.fields.summary, 'x', 'the body is passed through unchanged');

    // the INVALID_INPUT fallback retry is silent too
    stub((n) => { if (n === 1) throw httpError(400, { errorMessages: ['INVALID_INPUT'], errors: {} }); return { status: 204 }; });
    const adf = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Upstream URL: https://github.com/patternfly/patternfly/issues/1' }] }] };
    await editJiraIssue('FELT-2', { fields: { description: adf } });
    assertEqual(calls.length, 2, 'INVALID_INPUT triggers exactly one retry');
    assert(calls.every((c) => c.config?.params?.notifyUsers === false), 'both the first attempt and the fallback retry send notifyUsers=false');
    assert(JSON.stringify(calls[1].data).includes(UNSYNCABLE_DESCRIPTION_MARKER), 'the retry carries the safe fallback description');

    // if Jira rejects the flag (403), the edit is retried once without it so it still lands
    stub((n) => { if (n === 1) throw httpError(403); return { status: 204 }; });
    const rejected = await attempt(() => editJiraIssue('FELT-3', { fields: { summary: 'y' } }));
    assertEqual(rejected, null, 'a 403 on the flag does not fail the edit');
    assertEqual(calls.length, 2, 'the rejected flag costs exactly one extra PUT');
    assertEqual(calls[1].config, undefined, 'the retry is sent without notifyUsers');

    // a genuine 403 (retry also refused) still surfaces
    stub(() => { throw httpError(403); });
    const denied = await attempt(() => editJiraIssue('FELT-4', { fields: { summary: 'z' } }));
    assertEqual(denied?.response?.status, 403, 'a real permission failure still throws');
    assertEqual(calls.length, 2, 'it is not retried more than once');

    // other errors pass through untouched on the first attempt (updateJiraIssue's assignee retry relies on this)
    const assigneeErr = httpError(400, { errorMessages: [], errors: { assignee: 'cannot be assigned' } });
    stub(() => { throw assigneeErr; });
    const passed = await attempt(() => editJiraIssue('FELT-5', { fields: { assignee: { accountId: 'a' } } }));
    assertEqual(passed, assigneeErr, 'a non-403 error is rethrown as is');
    assertEqual(calls.length, 1, 'and is not retried');
  } finally {
    jiraClient.put = realPut;
  }

  // no other code path writes to Jira's issue-edit endpoint, so none can skip the flag
  const helpersSrc = readFileSync(join(__dirname, '../src/helpers.js'), 'utf-8');
  const putCalls = [...helpersSrc.matchAll(/jiraClient\.put\(/g)].length;
  assertEqual(putCalls, 2, 'jiraClient.put appears only inside putJiraIssue (flag + 403 fallback)');
}

// ─── Jira project routing (everything syncs to FELT) ─────────────────────────

console.log('\n=== Jira project routing ===');

{
  // buildJiraIssueData creates every repo's issues in the FELT project
  const rhdsIssue = {
    title: 'RHDS issue',
    url: 'https://github.com/RedHat-UX/red-hat-design-system/issues/42',
    body: 'An RHDS issue.',
    number: 42,
    labels: { nodes: [] },
    assignees: { nodes: [] },
    author: { login: 'testuser' },
    issueType: null,
  };
  const rhdsResult = buildJiraIssueData(rhdsIssue, false);
  assertEqual(rhdsResult.fields.project.key, 'FELT', 'RHDS issue creates in FELT project');

  const pfIssue = {
    title: 'PF issue',
    url: 'https://github.com/patternfly/patternfly-react/issues/42',
    body: 'A PF issue.',
    number: 42,
    labels: { nodes: [] },
    assignees: { nodes: [] },
    author: { login: 'testuser' },
    issueType: null,
  };
  const pfResult = buildJiraIssueData(pfIssue, false);
  assertEqual(pfResult.fields.project.key, 'FELT', 'PF repo issue creates in FELT project');

  // Updates must never set the project field (project is immutable on update)
  const updateResult = buildJiraIssueData(rhdsIssue, true);
  assert(updateResult.fields.project === undefined, 'update does not set project field');
}

{
  // Every JQL lookup and child-issue create targets FELT; no stale PF project literals remain
  for (const file of ['index.js', 'findJiraIssue.js', 'syncJiraToGitHub.js', 'createJiraIssue.js', 'helpers.js']) {
    const src = readFileSync(join(__dirname, `../src/${file}`), 'utf-8');
    assert(!/project = PF\b/.test(src) && !/key: 'PF'/.test(src), `${file} has no hardcoded PF project reference`);
  }
  const findSrc = readFileSync(join(__dirname, '../src/findJiraIssue.js'), 'utf-8');
  assert(findSrc.includes('project = FELT AND description'), 'findJiraIssue looks up existing issues in FELT');
  const childSrc = readFileSync(join(__dirname, '../src/createJiraIssue.js'), 'utf-8');
  assert(/project:\s*\{\s*key: 'FELT'/.test(childSrc), 'child issues are created in FELT');
}

{
  // extractJiraKeyFromText matches current (FELT) and legacy (PF) keys.
  assertEqual(extractJiraKeyFromText('tracked in FELT-1234 now'), 'FELT-1234', 'matches FELT key');
  assertEqual(extractJiraKeyFromText('**Jira Issue:** [PF-680](url)'), 'PF-680', 'matches legacy PF key');
  assertEqual(extractJiraKeyFromText('no key here'), null, 'returns null when no key present');
}

// ─── index.js guards sync execution behind an entry-point check ──────────────

console.log('\n=== index.js execution guard ===');

{
  // index.js is imported (via findJiraIssue.js) for the shared jiraIssues cache.
  // Its top-level sync run must be guarded so an import never triggers a live sync.
  const indexSrc = readFileSync(join(__dirname, '../src/index.js'), 'utf-8');
  assert(indexSrc.includes('import.meta.url') && indexSrc.includes('process.argv[1]'),
    'index.js guards the run with an import.meta.url / process.argv[1] entry check');
  assert(/if\s*\(entryHref && import\.meta\.url === entryHref\)/.test(indexSrc),
    'the syncIssues loop + printSummary run only when executed as the entry point');
}

// ─── RedHat-UX bot token selection (getOctokitForOwner) ──────────────────────

console.log('\n=== RedHat-UX bot token selection ===');

{
  const savedToken = process.env.GH_JIRA_SYNC_RHDS_PAT;

  // Missing token for the RedHat-UX org should throw
  delete process.env.GH_JIRA_SYNC_RHDS_PAT;
  let threw = false;
  try {
    getOctokitForOwner('RedHat-UX');
  } catch (e) {
    threw = true;
    assert(e.message.includes('RedHat-UX'), 'error names the RedHat-UX owner when token missing');
  }
  assert(threw, 'getOctokitForOwner throws when RedHat-UX token is missing');

  // With the token set, an Octokit instance is returned (and cached)
  process.env.GH_JIRA_SYNC_RHDS_PAT = 'test-rhds-token';
  const instance = getOctokitForOwner('RedHat-UX');
  assert(!!instance, 'getOctokitForOwner returns an instance when RedHat-UX token is set');

  // Restore original env state
  if (savedToken === undefined) {
    delete process.env.GH_JIRA_SYNC_RHDS_PAT;
  } else {
    process.env.GH_JIRA_SYNC_RHDS_PAT = savedToken;
  }
}

// ─── Comment dedupe (other upstream-sync integration + paging) ─────────────

// ants-engineering copied GitHub comments into Jira as "[<comment id>] Upstream, <author> wrote ...:"
// with no "Comment URL:" line, so our URL-only dedupe would post every one of them a second time.
// Jira also pages the comment list, so comments beyond the first page looked missing.

console.log('\n=== Comment sync dedupe ===');

{
  const realGet = jiraClient.get;
  const realPost = jiraClient.post;
  const adfText = (text) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
  const url = (id) => `https://github.com/RedHat-UX/red-hat-design-system/issues/3335#issuecomment-${id}`;
  const gh = (id, body = 'hello') => ({ url: url(id), body, author: { login: 'someone' }, createdAt: '2026-10-30T00:00:00Z' });
  const posted = [];
  const run = async (jiraPages, ghComments) => {
    posted.length = 0;
    const getParams = [];
    jiraClient.get = async (u, config) => {
      getParams.push(config?.params);
      const { startAt = 0, maxResults = 50 } = config?.params || {};
      const all = jiraPages;
      return { data: { startAt, maxResults, total: all.length, comments: all.slice(startAt, startAt + maxResults) } };
    };
    jiraClient.post = async (u, data) => { posted.push(data); return { status: 201 }; };
    await syncCommentsToJira('FELT-1', { nodes: [...ghComments].reverse() });
    return getParams;
  };
  try {
    // other tool's comment suppresses the matching GitHub comment; an unmatched one still posts
    await run([{ body: adfText('[6530628024] Upstream, Adam Johnson wrote [Fri Oct 30]:> text') }], [gh(6530628024), gh(111)]);
    assertEqual(posted.length, 1, 'only the GitHub comment the other tool has not copied is posted');
    assert(JSON.stringify(posted[0]).includes(url(111)), 'the posted comment is the unmatched one');

    // our own format still dedupes
    await run([{ body: adfText(`Comment Author: x\nComment URL: ${url(222)}`) }], [gh(222)]);
    assertEqual(posted.length, 0, 'a comment with our Comment URL line is not posted again');

    // "Upstream issue closed" style messages (no id) neither match nor break anything
    await run([{ body: adfText('Upstream issue closed. Attempting transition to Closed.') }], [gh(333)]);
    assertEqual(posted.length, 1, 'a message without a comment id does not suppress real comments');

    // id match is exact, not a prefix: [60] must not hide #issuecomment-6030
    await run([{ body: adfText('[60] Upstream, A wrote [x]:y') }], [gh(6030)]);
    assertEqual(posted.length, 1, 'the comment id must match exactly');

    // comments beyond Jira's first page are still seen
    const many = Array.from({ length: 130 }, (_, i) => ({ body: adfText(`[${1000 + i}] Upstream, A wrote [x]:y`) }));
    const params = await run(many, [gh(1000), gh(1129)]);
    assertEqual(posted.length, 0, 'comments on later pages still suppress duplicates');
    assertEqual(params.length, 2, 'the comment list is read page by page (130 comments, 100 per page)');
  } finally {
    jiraClient.get = realGet;
    jiraClient.post = realPost;
  }
}

// ─── Repo prefix in Jira summaries ──────────────────────────────────────────

// Another integration created ~950 Jira summaries as "[owner/repo] <title>". GitHub titles never
// carry that prefix, so copying the Jira summary onto GitHub prefixed real GitHub titles
// (RedHat-UX/red-hat-design-system#3334, #3336).

console.log('\n=== Repo prefix in Jira summaries ===');

{
  assertEqual(stripRepoPrefix('[RedHat-UX/red-hat-design-system] [focus] rh-x: y', 'RedHat-UX', 'red-hat-design-system'), '[focus] rh-x: y', 'the current repo prefix is removed');
  assertEqual(stripRepoPrefix('[patternfly/patternfly-react] Fix it', 'patternfly', 'patternfly-react'), 'Fix it', 'works for patternfly repos too');
  assertEqual(stripRepoPrefix('[patternfly/patternfly] Fix it', 'patternfly', 'patternfly-react'), '[patternfly/patternfly] Fix it', "another repo's prefix is left alone");
  assertEqual(stripRepoPrefix('Fix [RedHat-UX/red-hat-design-system] later', 'RedHat-UX', 'red-hat-design-system'), 'Fix [RedHat-UX/red-hat-design-system] later', 'only a leading prefix is removed');
  assertEqual(stripRepoPrefix('[RedHat-UX/red-hat-design-system]no space', 'RedHat-UX', 'red-hat-design-system'), '[RedHat-UX/red-hat-design-system]no space', 'the prefix needs its trailing space');
  assertEqual(stripRepoPrefix(undefined, 'a', 'b'), undefined, 'a missing summary passes through');

  // Jira newer, summary only differs by the prefix -> nothing is written (returns before any network call)
  const { syncTitleToGitHub } = await import('../src/syncJiraToGitHub.js');
  const jiraIssue = { key: 'FELT-4835', fields: { summary: '[RedHat-UX/red-hat-design-system] [focus] rh-video-embed: use :focus-visible', updated: '2026-11-05T15:03:50.800+0000' } };
  const githubIssue = { number: 3334, url: 'https://github.com/RedHat-UX/red-hat-design-system/issues/3334', title: '[focus] rh-video-embed: use :focus-visible', updatedAt: '2026-11-04T19:56:37Z' };
  assertEqual(await syncTitleToGitHub(jiraIssue, githubIssue), false, 'Jira newer + prefix-only difference -> GitHub title is not rewritten');

  // the compare and the written value both go through stripRepoPrefix
  const syncSrc = readFileSync(join(__dirname, '../src/syncJiraToGitHub.js'), 'utf-8');
  const titleFn = syncSrc.slice(syncSrc.indexOf('export async function syncTitleToGitHub'));
  assert(/const jiraSummary = stripRepoPrefix\(rawSummary, owner, repo\)/.test(titleFn) && /title: jiraSummary,/.test(titleFn), 'a real title change is written without the prefix');
  const updateSrc = readFileSync(join(__dirname, '../src/updateJiraIssue.js'), 'utf-8');
  assert(/stripRepoPrefix\(jiraIssue\.fields\.summary, parsedForTitle\.owner, parsedForTitle\.repo\)/.test(updateSrc), 'the GitHub->Jira title-changed check ignores the prefix too');
}

// ─── Linking existing Jira issues as children ───────────────────────────────

// GitHub sub-issue #868 of #3349 maps to FELT-5179, which people had already put under FELT-4799.
// The sync tried to re-parent it under FELT-5225 (a Story), Jira answered 400 "hierarchy", and the run
// ended with an error. It must keep a person's parent and treat a hierarchy refusal as a warning.

console.log('\n=== Child linking keeps existing parents ===');

{
  const hierarchy400 = Object.assign(new Error('400'), { response: { status: 400, data: { errorMessages: ['Given parent work item does not belong to appropriate hierarchy.'], errors: { pid: 'must be created in the same project as the parent' } } } });
  assert(isHierarchyError(hierarchy400), 'Jira hierarchy 400 is recognised');
  assert(!isHierarchyError(Object.assign(new Error('x'), { response: { status: 400, data: { errors: { assignee: 'bad' } } } })), 'another 400 is not a hierarchy error');
  assert(!isHierarchyError(Object.assign(new Error('x'), { response: { status: 500, data: 'hierarchy' } })), 'a 500 is not a hierarchy error');
  assert(!isHierarchyError(new Error('network')), 'an error with no response is not a hierarchy error');

  const realGet = jiraClient.get;
  const realPut = jiraClient.put;
  const puts = [];
  const adf = (t) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });
  const SUB = 'https://github.com/RedHat-UX/red-hat-design-system/issues/868';
  const child = { key: 'FELT-5179', fields: { description: adf(`Upstream URL: ${SUB}`), status: { name: 'Refinement' }, updated: '2026-11-05T00:00:00.000+0000' } };
  const stubJira = (parentFields, putImpl) => {
    puts.length = 0;
    jiraClient.get = async (url, config) => {
      if (url.includes('/search/jql')) {
        const jql = config?.params?.jql || '';
        return { data: { issues: jql.startsWith('parent =') ? [] : [child] } };
      }
      if (/\/issue\/FELT-5179$/.test(url)) return { data: { fields: parentFields } };
      return { data: { issues: [], comments: [], total: 0 } };
    };
    jiraClient.put = async (url, data, config) => { puts.push({ url, data }); return putImpl(); };
  };
  const gh = { number: 3349, subIssues: { totalCount: 1, nodes: [{ url: SUB, number: 868, comments: { totalCount: 0 } }] } };
  try {
    stubJira({ parent: { key: 'FELT-4799' } }, () => ({ status: 204 }));
    assertEqual(await getExistingParentKey('FELT-5179'), 'FELT-4799', 'the existing parent is read');
    stubJira({ customfield_10014: 'FELT-100' }, () => ({ status: 204 }));
    assertEqual(await getExistingParentKey('FELT-5179'), 'FELT-100', 'an epic link counts as a parent');
    stubJira({}, () => ({ status: 204 }));
    assertEqual(await getExistingParentKey('FELT-5179'), null, 'no parent -> null');

    // already under a different parent: nothing is written, no error is recorded
    errorCollector.clear?.();
    const before = errorCollector.errors.length;
    stubJira({ parent: { key: 'FELT-4799' } }, () => ({ status: 204 }));
    await updateChildIssues('FELT-5225', gh, false);
    assertEqual(puts.length, 0, 'a child that already has another parent is not re-parented');
    assertEqual(errorCollector.errors.length, before, 'and that is not an error');

    // no parent yet and Jira refuses on hierarchy: a warning, not an error
    stubJira({}, () => { throw hierarchy400; });
    await updateChildIssues('FELT-5225', gh, false);
    assertEqual(puts.length >= 1, true, 'the link is attempted when there is no existing parent');
    assertEqual(errorCollector.errors.length, before, 'a hierarchy refusal is not recorded as an error');

    // no parent and Jira accepts: it is linked as before
    stubJira({}, () => ({ status: 204 }));
    await updateChildIssues('FELT-5225', gh, false);
    assertEqual(puts.length, 1, 'a child with no parent is linked');
    assertEqual(puts[0].data.fields.parent?.key, 'FELT-5225', 'under the GitHub parent');
  } finally {
    jiraClient.get = realGet;
    jiraClient.put = realPut;
  }
}

// ─── PR links are written only when they changed ────────────────────────────

// syncPRLinksToJira rewrote the Git Pull Request field on every run for every issue with a recently
// updated PR, even when the value was identical, bumping Jira's updated time each time.

console.log('\n=== PR link writes skip unchanged values ===');

{
  const A = 'https://github.com/patternfly/chatbot/pull/942';
  const B = 'https://github.com/patternfly/chatbot/pull/945';
  assertEqual(shouldWritePrLinks(A, [A]), false, 'same single link -> no write');
  assertEqual(shouldWritePrLinks(`${A}\n${B}`, [A, B]), false, 'same two links in the same order -> no write');
  assertEqual(shouldWritePrLinks('', [A]), true, 'empty field -> write');
  assertEqual(shouldWritePrLinks(A, [A, B]), true, 'a new link was added -> write');
  assertEqual(shouldWritePrLinks(`${A}\n${B}`, [A]), true, 'a link was removed -> write');
  assertEqual(shouldWritePrLinks(null, [A]), true, 'an unreadable field is written, as before');

  const realGet = jiraClient.get;
  try {
    jiraClient.get = async () => ({ data: { fields: { customfield_10875: buildPrUrlsADF([A, B]) } } });
    assertEqual(await getCurrentPrField('FELT-1'), `${A}\n${B}`, 'the current field is read back as newline-joined URLs');
    jiraClient.get = async () => ({ data: { fields: { customfield_10875: null } } });
    assertEqual(await getCurrentPrField('FELT-1'), '', 'a missing field reads as empty');
    jiraClient.get = async () => { throw new Error('network'); };
    assertEqual(await getCurrentPrField('FELT-1'), null, 'a read failure returns null');
  } finally {
    jiraClient.get = realGet;
  }
  const prSrc = readFileSync(join(__dirname, '../src/syncPRLinksToJira.js'), 'utf-8');
  assert(/shouldWritePrLinks\(current, prUrls\)\) continue;[\s\S]*editJiraIssue/.test(prSrc), 'the compare runs before the Jira write');
}

// ─── GitHub Actions warnings and job summary ────────────────────────────────

// A run can only be green or red; annotations and the job summary surface warnings without failing it.

console.log('\n=== CI annotations and job summary ===');

{
  syncStats.repoStats.clear();
  errorCollector.clear();
  syncStats.setCurrentRepo('RedHat-UX/red-hat-design-system');
  syncStats.track('warnings', { key: 'FELT-5179', message: 'Kept existing parent FELT-4799' });
  syncStats.track('warnings', { key: 'FELT-5180', message: 'Kept existing parent FELT-4799' });
  syncStats.track('warnings', { key: 'FELT-9', message: 'Other: 100% odd\nline' });
  syncStats.track('jiraCreated');

  const lines = [];
  assertEqual(emitCiAnnotations({ env: {}, log: (l) => lines.push(l) }), 0, 'no annotations outside GitHub Actions');
  assertEqual(lines.length, 0, 'and nothing is printed');

  const n = emitCiAnnotations({ env: { GITHUB_ACTIONS: 'true' }, log: (l) => lines.push(l) });
  assertEqual(n, 2, 'one warning per distinct message (3 warnings, 2 messages)');
  assertEqual(lines[0], '::warning title=RedHat-UX/red-hat-design-system::Kept existing parent FELT-4799: FELT-5179, FELT-5180', 'same-message warnings are grouped with their keys');
  assert(lines[1].includes('100%25 odd%0Aline'), 'percent signs and newlines are escaped');
  assertEqual(escapeWorkflowData('a%b\r\nc'), 'a%25b%0D%0Ac', 'escapeWorkflowData escapes %, CR and LF');

  const md = buildStepSummaryMarkdown();
  assert(md.includes('| RedHat-UX/red-hat-design-system | 1 | 0 | 0 | 0 | 0 | 0 | 3 |'), 'the summary table has the repo row with counts');
  assert(md.includes('- Kept existing parent FELT-4799: FELT-5179, FELT-5180'), 'the summary lists the grouped warnings');

  let written = null;
  assertEqual(writeStepSummary({ env: {}, append: () => { written = 'x'; } }), false, 'no summary file when GITHUB_STEP_SUMMARY is unset');
  assertEqual(written, null, 'and nothing is written');
  assertEqual(writeStepSummary({ env: { GITHUB_STEP_SUMMARY: '/tmp/s.md' }, append: (f, t) => { written = { f, t }; } }), true, 'the summary is appended when the file is set');
  assert(written.f === '/tmp/s.md' && written.t.includes('## GitHub ↔ Jira sync'), 'to the named file');

  errorCollector.addError('UPDATEJIRA: Error updating X', new Error('boom'));
  const errLines = [];
  emitCiAnnotations({ env: { GITHUB_ACTIONS: 'true' }, log: (l) => errLines.push(l) });
  assert(errLines.some((l) => l.startsWith('::error title=Sync error::UPDATEJIRA: Error updating X: boom')), 'errors become error annotations');
  assert(buildStepSummaryMarkdown().includes('- UPDATEJIRA: Error updating X: boom'), 'and are listed in the summary');
  assertEqual(markRunFailedIfErrors({}), false, 'warnings alone never fail the run');

  syncStats.repoStats.clear();
  errorCollector.clear();
  const indexSrc = readFileSync(join(__dirname, '../src/index.js'), 'utf-8');
  assert(/printSummary\(\);\s*emitCiAnnotations\(\);\s*writeStepSummary\(\);/.test(indexSrc), 'index.js reports after the summary and before the exit code');
  assert(/import \{[^}]*\bemitCiAnnotations\b[^}]*\bwriteStepSummary\b[^}]*\} from '\.\/logging\.js'/.test(indexSrc) || /import \{[^}]*\bwriteStepSummary\b[^}]*\bemitCiAnnotations\b[^}]*\} from '\.\/logging\.js'/.test(indexSrc), 'index.js imports the functions it calls');
}

// ─── --repo selection (run one repo from the CLI or the Action) ─────────────

console.log('\n=== --repo argument and repo selection ===');

{
  assertEqual(parseArgs(['--repo', 'patternfly-elements']).repo, 'patternfly-elements', '--repo takes a bare repo name');
  assertEqual(parseArgs(['--repo', 'patternfly/patternfly-elements']).repo, 'patternfly/patternfly-elements', '--repo takes owner/name');
  assertEqual(parseArgs([]).repo, undefined, 'no --repo means all repos');
  assertEqual(parseArgs(['--repo', 'all']).repo, undefined, '--repo all (the Action dropdown default) means all repos');
  assertEqual(parseArgs(['--repo', '']).repo, undefined, 'an empty --repo means all repos');
  assertEqual(parseArgs(['--repo', '  ']).repo, undefined, 'a blank --repo means all repos');

  const combined = parseArgs(['--repo', 'chatbot', '--since', '2026-01-01T00:00:00Z', '--direction', 'github-to-jira']);
  assertEqual(combined.repo, 'chatbot', '--repo combines with other flags (repo)');
  assertEqual(combined.since, '2026-01-01T00:00:00Z', '--repo combines with other flags (since)');
  assertEqual(combined.direction, 'github-to-jira', '--repo combines with other flags (direction)');

  const reordered = parseArgs(['--since', '2026-01-01T00:00:00Z', '--repo', 'chatbot']);
  assertEqual(reordered.repo, 'chatbot', '--repo is read when it follows --since');
  assertEqual(reordered.direction, 'both', 'direction still defaults to both');

  const all = selectComponents(undefined);
  assertEqual(all.components.length, availableComponents.length, 'no repo selects every configured repo');
  assertEqual(all.error, undefined, 'and is not an error');

  const byName = selectComponents('patternfly-elements');
  assertEqual(byName.components.length, 1, 'a bare name selects one repo');
  assertEqual(`${byName.components[0].owner}/${byName.components[0].name}`, 'patternfly/patternfly-elements', 'and it is the right one');

  const byFullName = selectComponents('patternfly/patternfly-elements');
  assertEqual(byFullName.components.length, 1, 'owner/name selects one repo');

  assertEqual(selectComponents('PatternFly-Elements').components?.length, 1, 'matching ignores case');
  assertEqual(selectComponents('.github').components?.[0].name, '.github', 'the .github repo can be selected');
  assertEqual(selectComponents('red-hat-design-system').components?.[0].owner, 'RedHat-UX', 'a RedHat-UX repo keeps its owner (so it uses its own token)');

  const unknown = selectComponents('patternfly-elemnts');
  assertEqual(unknown.components, undefined, 'a misspelled repo selects nothing');
  assert(unknown.error?.includes('Unknown repo "patternfly-elemnts"') && unknown.error.includes('patternfly/patternfly-elements'), 'and the error names the typo and lists valid repos');
  assert(selectComponents('rh-uxd/patternfly-elements').error, 'a real name under the wrong owner is an error, not a silent match');

  const dupes = [{ owner: 'a', name: 'x' }, { owner: 'b', name: 'x' }];
  assert(selectComponents('x', dupes).error?.includes('ambiguous'), 'a bare name shared by two owners is ambiguous');
  assertEqual(selectComponents('b/x', dupes).components?.[0].owner, 'b', 'owner/name resolves the ambiguity');

  // An unknown repo must stop the run before any sync starts
  const indexSrc = readFileSync(join(__dirname, '../src/index.js'), 'utf-8');
  assert(/selectComponents\(options\.repo\)/.test(indexSrc) && /process\.exitCode = 1/.test(indexSrc), 'index.js selects repos from --repo and sets a failing exit code on an unknown one');
  assert(/for \(const \{name, owner\} of components\)/.test(indexSrc), 'index.js loops over the selected repos, not all of availableComponents');
}

// ─── GitHub Action: repo dropdown ────────────────────────────────────────────

console.log('\n=== daily_run.yml repo input ===');

{
  const yml = readFileSync(join(__dirname, '../.github/workflows/daily_run.yml'), 'utf-8');
  const optionsBlock = yml.match(/^ {8}options:\n((?: {10}- .+\n)+)/m);
  const options = optionsBlock ? optionsBlock[1].trim().split('\n').map((l) => l.replace(/^\s*- /, '').trim()) : [];
  // If this fails, a repo was added to (or removed from) availableComponents: update the dropdown to match
  assertEqual(JSON.stringify(options), JSON.stringify(['all', ...availableComponents.map((c) => c.name)]), 'the Action repo dropdown is "all" plus every configured repo, in order');
  assert(/repo:\n(?: {8}.+\n)*? {8}type: choice/.test(yml), 'the repo input is a choice (dropdown)');
  assert(/^ {8}default: all$/m.test(yml), 'the dropdown defaults to all');

  const runBlock = yml.slice(yml.indexOf('run: |'));
  assert(!runBlock.includes('${{'), 'inputs reach the script through env, never interpolated into the shell');
  assert(/SYNC_REPO: \$\{\{ github\.event\.inputs\.repo \}\}/.test(yml) && /SINCE_DATE: \$\{\{ github\.event\.inputs\.since_date \}\}/.test(yml), 'both inputs are passed via env');
  assert(/"\$SYNC_REPO" != "all"/.test(runBlock) && /--repo "\$SYNC_REPO"/.test(runBlock), 'the script passes --repo only when a repo was chosen');
  assert(/node src\/index\.js "\$\{args\[@\]\}"/.test(runBlock), 'scheduled runs (no inputs) call index.js with no extra args');
  assert(/^concurrency:\n {2}group: github-jira-sync\n {2}cancel-in-progress: false$/m.test(yml), 'runs are serialized so a long manual run never overlaps a scheduled one');
}

// ─── Created-issue registry (Jira search-index lag) ─────────────────────────

console.log('\n=== created-issue registry ===');

{
  const realGet = jiraClient.get;
  const realPost = jiraClient.post;
  const URL1 = 'https://github.com/patternfly/patternfly-elements/issues/2986';
  const URL2 = 'https://github.com/patternfly/patternfly-elements/issues/2987';
  const gh = { id: 'I_1', url: URL1, title: 'child' };
  try {
    // registry basics
    clearCreatedJiraIssues();
    assertEqual(getCreatedJiraKey(URL1), null, 'an unknown URL has no registered key');
    recordCreatedJiraIssue(URL1, 'FELT-9');
    assertEqual(getCreatedJiraKey(URL1), 'FELT-9', 'a recorded URL returns its key');
    recordCreatedJiraIssue(undefined, 'FELT-1');
    recordCreatedJiraIssue(URL2, undefined);
    assertEqual(getCreatedJiraKey(URL2), null, 'a missing key is not recorded');
    clearCreatedJiraIssues();
    assertEqual(getCreatedJiraKey(URL1), null, 'clearing empties the registry');

    // creating an issue registers it
    const posts = [];
    jiraClient.post = async (u, data) => { posts.push(u); return { data: { key: 'FELT-9' } }; };
    const returned = await createNewJiraIssue({ fields: { summary: 's' } }, gh);
    assertEqual(returned, 'FELT-9', 'createNewJiraIssue still returns the new key');
    assertEqual(getCreatedJiraKey(URL1), 'FELT-9', 'createNewJiraIssue registers the new issue by GitHub URL');

    // a failed create registers nothing
    clearCreatedJiraIssues();
    jiraClient.post = async () => { throw new Error('boom'); };
    let threw = false;
    try { await createNewJiraIssue({ fields: { summary: 's' } }, gh); } catch { threw = true; }
    assert(threw, 'a failed create still throws');
    assertEqual(getCreatedJiraKey(URL1), null, 'and registers nothing');

    // index lag: JQL finds nothing, but the issue was created this run -> found by key, no search
    clearCreatedJiraIssues();
    recordCreatedJiraIssue(URL1, 'FELT-9');
    const calls = [];
    const issue = { key: 'FELT-9', fields: { description: null } };
    jiraClient.get = async (u, config) => {
      calls.push(u);
      if (u === '/rest/api/3/issue/FELT-9') return { data: issue };
      if (u === '/rest/api/3/search/jql') return { data: { issues: [] } };
      throw new Error(`unexpected GET ${u}`);
    };
    const found = await findJiraIssue(URL1);
    assertEqual(found?.key, 'FELT-9', 'a just-created issue is found even though the search index has not caught up');
    assert(!calls.includes('/rest/api/3/search/jql'), 'without needing the JQL search');

    // not in the registry -> JQL search as before (no duplicate-protecting shortcut for unknown issues)
    calls.length = 0;
    const missing = await findJiraIssue(URL2);
    assertEqual(missing, null, 'an unregistered issue the search cannot find is still "not found"');
    assertEqual(calls.filter((u) => u === '/rest/api/3/search/jql').length, 1, 'and is looked up with the search');
    assert(!calls.some((u) => u.startsWith('/rest/api/3/issue/')), 'with no by-key fetch');

    // registered but the by-key GET fails -> fall back to the search instead of failing the lookup
    calls.length = 0;
    const desc = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: `Upstream URL: ${URL1}` }] }] };
    jiraClient.get = async (u) => {
      calls.push(u);
      if (u === '/rest/api/3/issue/FELT-9') throw new Error('500');
      return { data: { issues: [{ key: 'FELT-9', fields: { description: desc } }] } };
    };
    const fallback = await findJiraIssue(URL1);
    assertEqual(fallback?.key, 'FELT-9', 'a failed by-key fetch falls back to the search');
  } finally {
    jiraClient.get = realGet;
    jiraClient.post = realPost;
    clearCreatedJiraIssues();
  }
}

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
