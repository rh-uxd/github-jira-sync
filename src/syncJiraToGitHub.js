import {
  getOctokitForOwner,
  delay,
  shortDelay,
  jiraToGitHubUserMapping,
  extractUpstreamUrl,
  updateGitHubIssue,
  addGitHubIssueComment,
  createGitHubIssue,
  closeGitHubIssue,
  jiraClient,
  editJiraIssue,
  availableComponents,
  shouldSyncFromJira,
  extractJiraKeyFromText,
  fetchJiraIssueByKey,
  executeGraphQLQuery,
  extractTextFromADF,
  appendMetadataToADF,
  adfToMarkdown,
} from './helpers.js';
import { errorCollector, syncStats } from './logging.js';
import j2m from 'jira2md';

// Convert Jira description (ADF or legacy string) to GitHub Markdown, preserving formatting
function jiraDescriptionToMarkdown(description) {
  if (!description) return '';
  // Jira Cloud v3 API returns ADF object; convert to markdown and strip sync metadata
  if (typeof description === 'object' && description?.type === 'doc') {
    return adfToMarkdown(description, { stripMetadata: true });
  }
  // Legacy string (e.g. Jira markup): use jira2md if available
  const jiraText = typeof description === 'string' ? description : extractTextFromADF(description);
  if (!jiraText) return '';
  try {
    if (typeof j2m.toMarkdown === 'function') return j2m.toMarkdown(jiraText);
    if (typeof j2m.to_markdown === 'function') return j2m.to_markdown(jiraText);
  } catch (err) {
    console.log('  - Warning: Could not convert Jira markup to Markdown, using as-is');
  }
  return jiraText;
}

// Parse GitHub URL to extract owner, repo, and issue number
export function parseGitHubUrl(githubUrl) {
  if (!githubUrl) return null;
  const match = githubUrl.match(/https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (!match) return null;
  return {
    owner: match[1],
    repo: match[2],
    issueNumber: parseInt(match[3]),
  };
}

// Sync title from Jira to GitHub
export async function syncTitleToGitHub(jiraIssue, githubIssue) {
  try {
    // Check timestamps to determine if we should sync from Jira
    if (!shouldSyncFromJira(githubIssue, jiraIssue)) {
      // Don't log here - the main function will log a summary
      return false; // Skip syncing title from Jira to GitHub
    }

    const jiraSummary = jiraIssue.fields?.summary;
    if (!jiraSummary) {
      return false; // No summary in Jira
    }

    const githubTitle = githubIssue.title || '';
    
    // Only update if titles are different
    if (jiraSummary === githubTitle) {
      return false; // Titles match, no update needed
    }

    const parsed = parseGitHubUrl(githubIssue.url);
    if (!parsed) {
      console.log(`  - Could not parse GitHub URL: ${githubIssue.url}`);
      return false;
    }

    const { owner, repo, issueNumber } = parsed;

    await updateGitHubIssue(owner, repo, issueNumber, {
      title: jiraSummary,
    });

    console.log(
      `  ✓ Synced title "${jiraSummary}" from Jira ${jiraIssue.key} → GitHub issue #${githubIssue.number}`
    );
    return true;
  } catch (error) {
    errorCollector.addError(
      `SYNCJIRATOGITHUB: Error syncing title from Jira ${jiraIssue.key} to GitHub`,
      error
    );
    return false;
  }
}

// Normalize body for comparison — strips whitespace artifacts introduced by the ADF roundtrip
// so that semantically identical descriptions compare as equal.
function normalizeBody(body) {
  if (body == null) return '';
  return String(body)
    .replace(/\r\n/g, '\n')
    .replace(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*\/?>/gi, '![image]($1)')  // normalize HTML img to markdown (ADF roundtrip)
    .replace(/[ \t]+$/gm, '')     // strip trailing whitespace per line
    .replace(/^[ \t]+/gm, '')     // strip leading whitespace (Jira strips leading spaces from ADF text nodes)
    .replace(/\n{3,}/g, '\n\n')   // collapse excess blank lines to max one
    .replace(/^(#{1,6} [^\n]+)\n(?!\n)/gm, '$1\n\n')  // add blank line after headings (ADF roundtrip always produces this)
    .trim();
}

// Sync description/body from Jira to GitHub
export async function syncDescriptionToGitHub(jiraIssue, githubIssue) {
  try {
    if (!shouldSyncFromJira(githubIssue, jiraIssue)) {
      return false;
    }

    const markdownDescription = jiraDescriptionToMarkdown(jiraIssue.fields.description);
    // Remove trailing horizontal rule(s) that may have leaked from incomplete metadata stripping
    const cleanDescription = markdownDescription.replace(/(\n-{3,})+\s*$/, '').trim();
    const newBody = `${cleanDescription}${jiraLinkFooter(jiraIssue.key)}`;

    const currentBody = normalizeBody(githubIssue.body);
    const proposedBody = normalizeBody(newBody);
    if (currentBody === proposedBody) {
      return false;
    }

    const parsed = parseGitHubUrl(githubIssue.url);
    if (!parsed) {
      console.log(`  - Could not parse GitHub URL: ${githubIssue.url}`);
      return false;
    }

    const { owner, repo, issueNumber } = parsed;
    await updateGitHubIssue(owner, repo, issueNumber, { body: newBody });

    console.log(
      `  ✓ Synced description from Jira ${jiraIssue.key} → GitHub issue #${githubIssue.number}`
    );
    return true;
  } catch (error) {
    errorCollector.addError(
      `SYNCJIRATOGITHUB: Error syncing description from Jira ${jiraIssue.key} to GitHub`,
      error
    );
    return false;
  }
}

// Sync assignee from Jira to GitHub
export async function syncAssigneeToGitHub(jiraIssue, githubIssue) {
  try {
    // Note: No timestamp gate here. Jira is the source of truth for assignees.
    // The assignee sync is guarded by its own checks (no assignee, no mapping, already assigned)
    // and is non-destructive (additive). The previous shouldSyncFromJira check was blocking
    // assignee syncs whenever GitHub had any more recent activity (e.g. comments, labels),
    // even though the Jira assignee change was legitimate.

    // Jira v3 uses accountId; fallback to id for v2/legacy
    const jiraAssignee = jiraIssue.fields.assignee?.accountId ?? jiraIssue.fields.assignee?.id;
    if (!jiraIssue.fields.assignee || !jiraAssignee) {
      return false; // No assignee in Jira
    }
    const githubAssignee = jiraToGitHubUserMapping[jiraAssignee];

    if (!githubAssignee) {
      return false; // No mapping found
    }

    // Get current GitHub assignees
    const currentAssignees = githubIssue.assignees?.nodes?.map((a) => a.login) || [];
    const isAlreadyAssigned = currentAssignees.includes(githubAssignee);

    if (isAlreadyAssigned) {
      return false; // Already assigned, no change needed
    }

    // Remove existing assignees and add the Jira assignee
    const parsed = parseGitHubUrl(githubIssue.url);
    if (!parsed) {
      console.log(`  - Could not parse GitHub URL: ${githubIssue.url}`);
      return false;
    }
    const { owner, repo, issueNumber } = parsed;
    const octokitInstance = getOctokitForOwner(owner);

    // if (currentAssignees.length > 0) {
    //   await octokitInstance.rest.issues.removeAssignees({
    //     owner,
    //     repo,
    //     issue_number: issueNumber,
    //     assignees: currentAssignees,
    //   });
    // }

    await octokitInstance.rest.issues.addAssignees({
      owner,
      repo,
      issue_number: issueNumber,
      assignees: [githubAssignee],
    });

    console.log(
      `  ✓ Synced assignee ${githubAssignee} from Jira ${jiraIssue.key} → GitHub issue #${githubIssue.number}`
    );
    return true;
  } catch (error) {
    errorCollector.addError(
      `SYNCJIRATOGITHUB: Error syncing assignee from Jira ${jiraIssue.key} to GitHub`,
      error
    );
    return false;
  }
}

// Sync title + description from Jira to GitHub in a single REST call
// Returns an object with { title, description } booleans indicating what changed
export async function syncTitleAndDescriptionToGitHub(jiraIssue, githubIssue) {
  const result = { title: false, description: false };
  try {
    if (!shouldSyncFromJira(githubIssue, jiraIssue)) {
      return result;
    }

    const updates = {};

    // Check title
    const jiraSummary = jiraIssue.fields?.summary;
    if (jiraSummary && jiraSummary !== (githubIssue.title || '')) {
      updates.title = jiraSummary;
      result.title = true;
    }

    // Check description
    const markdownDescription = jiraDescriptionToMarkdown(jiraIssue.fields.description);
    const cleanDescription = markdownDescription.replace(/(\n-{3,})+\s*$/, '').trim();

    // Don't sync truncated Jira descriptions back to GitHub — GitHub has the full content
    if (!cleanDescription.includes('Issue description was truncated due to size')) {
      const newBody = `${cleanDescription}${jiraLinkFooter(jiraIssue.key)}`;

      const currentBody = normalizeBody(githubIssue.body);
      const proposedBody = normalizeBody(newBody);
      if (currentBody !== proposedBody) {
        updates.body = newBody;
        result.description = true;
      }
    }

    // Skip if nothing changed
    if (Object.keys(updates).length === 0) {
      return result;
    }

    const parsed = parseGitHubUrl(githubIssue.url);
    if (!parsed) {
      console.log(`  - Could not parse GitHub URL: ${githubIssue.url}`);
      return { title: false, description: false };
    }

    const { owner, repo, issueNumber } = parsed;
    await updateGitHubIssue(owner, repo, issueNumber, updates);

    const changed = [];
    if (result.title) changed.push('title');
    if (result.description) changed.push('description');
    console.log(
      `  ✓ Synced ${changed.join(' + ')} from Jira ${jiraIssue.key} → GitHub issue #${githubIssue.number}`
    );
    return result;
  } catch (error) {
    errorCollector.addError(
      `SYNCJIRATOGITHUB: Error syncing title/description from Jira ${jiraIssue.key} to GitHub`,
      error
    );
    return { title: false, description: false };
  }
}

// Footer we append when adding Jira link (must match syncDescriptionToGitHub so we don't duplicate)
function jiraLinkFooter(jiraIssueKey) {
  const jiraLink = `https://redhat.atlassian.net/browse/${jiraIssueKey}`;
  return `\n\n---\n\n**Jira Issue:** [${jiraIssueKey}](${jiraLink})`;
}

// Add Jira link to GitHub issue body (only if not already present; never appends if body ends with our footer)
export async function addJiraLinkToGitHub(jiraIssueKey, githubIssue) {
  try {
    const footer = jiraLinkFooter(jiraIssueKey);
    const parsed = parseGitHubUrl(githubIssue.url);
    if (!parsed) {
      console.log(`  - Could not parse GitHub URL: ${githubIssue.url}`);
      return false;
    }

    const { owner, repo, issueNumber } = parsed;
    let bodyUpdated = false;

    const body = githubIssue.body ?? '';
    const bodyHasKey = body.includes(jiraIssueKey);

    if (!bodyHasKey) {
      const updatedBody = `${body}${footer}`;
      await updateGitHubIssue(owner, repo, issueNumber, {
        body: updatedBody,
      });
      console.log(`  ✓ Added Jira link ${jiraIssueKey} to GitHub issue #${issueNumber} body`);
      bodyUpdated = true;
    }

    return bodyUpdated;
  } catch (error) {
    errorCollector.addError(
      `SYNCJIRATOGITHUB: Error adding Jira link ${jiraIssueKey} to GitHub issue`,
      error
    );
    return false;
  }
}

// Reopen GitHub issue if corresponding Jira issue is reopened (respects timestamps)
export async function reopenGitHubIssueIfJiraReopened(jiraIssue, githubIssue) {
  try {
    // Check if Jira issue is NOT closed (reopened) and GitHub issue is closed
    const jiraStatus = jiraIssue.fields?.status?.name;
    if (jiraStatus === 'Closed') {
      return false; // Jira still closed, no action needed
    }

    if (githubIssue.state !== 'CLOSED') {
      return false; // GitHub already open, no action needed
    }

    // Use timestamps from the existing GraphQL data instead of re-fetching via REST
    if (!shouldSyncFromJira(githubIssue, jiraIssue)) {
      return false;
    }

    // Parse GitHub URL to get owner, repo, issueNumber
    const parsed = parseGitHubUrl(githubIssue.url);
    if (!parsed) {
      console.log(`  - Could not parse GitHub URL: ${githubIssue.url}`);
      return false;
    }

    const { owner, repo, issueNumber } = parsed;

    try {
      // Jira is newer or equal - reopen the GitHub issue
      await updateGitHubIssue(owner, repo, issueNumber, {
        state: 'open',
      });
      await addGitHubIssueComment(
        owner,
        repo,
        issueNumber,
        `Reopened via Jira sync - Jira issue ${jiraIssue.key} was reopened.`
      );
      console.log(
        `  - Reopened GitHub issue ${owner}/${repo}#${issueNumber} (Jira ${jiraIssue.key} was reopened)`
      );
      syncStats.track('githubReopened');
      return true; // Handled
    } catch (error) {
      if (error.status === 404) {
        console.log(`  - GitHub issue ${owner}/${repo}#${issueNumber} not found, skipping`);
        return false;
      } else {
        errorCollector.addError(
          `SYNCJIRATOGITHUB: Error reopening GitHub issue ${owner}/${repo}#${issueNumber} for reopened Jira ${jiraIssue.key}`,
          error
        );
        return false;
      }
    }
  } catch (error) {
    errorCollector.addError(
      `SYNCJIRATOGITHUB: Error checking if Jira issue ${jiraIssue.key} is reopened for GitHub issue ${githubIssue.url}`,
      error
    );
    return false; // On error, proceed with normal flow
  }
}

// Close GitHub issue if corresponding Jira issue is closed (respects timestamps)
export async function closeGitHubIssueIfJiraClosed(jiraIssue, githubIssue) {
  try {
    // Check if Jira issue is closed and GitHub issue is open
    const jiraStatus = jiraIssue.fields?.status?.name;
    if (jiraStatus !== 'Closed') {
      return false; // Jira not closed, no action needed
    }

    if (githubIssue.state !== 'OPEN') {
      return false; // GitHub already closed, no action needed
    }

    // Use timestamps from the existing GraphQL data instead of re-fetching via REST
    if (!shouldSyncFromJira(githubIssue, jiraIssue)) {
      return false;
    }

    // Parse GitHub URL to get owner, repo, issueNumber
    const parsed = parseGitHubUrl(githubIssue.url);
    if (!parsed) {
      console.log(`  - Could not parse GitHub URL: ${githubIssue.url}`);
      return false;
    }

    const { owner, repo, issueNumber } = parsed;

    try {
      // Close the GitHub issue
      await closeGitHubIssue(owner, repo, issueNumber);
      await addGitHubIssueComment(
        owner,
        repo,
        issueNumber,
        `Closed via Jira sync - Jira issue ${jiraIssue.key} is closed.`
      );
      // Add Jira link to GitHub issue body if not already present
      await addJiraLinkToGitHub(jiraIssue.key, githubIssue);
      console.log(
        `  - Closed GitHub issue ${owner}/${repo}#${issueNumber} (Jira ${jiraIssue.key} is closed)`
      );
      syncStats.track('githubClosed');
      return true; // Handled
    } catch (error) {
      if (error.status === 404) {
        console.log(`  - GitHub issue ${owner}/${repo}#${issueNumber} not found, skipping`);
        return false;
      } else {
        errorCollector.addError(
          `SYNCJIRATOGITHUB: Error closing GitHub issue ${owner}/${repo}#${issueNumber} for closed Jira ${jiraIssue.key}`,
          error
        );
        return false;
      }
    }
  } catch (error) {
    errorCollector.addError(
      `SYNCJIRATOGITHUB: Error checking if Jira issue ${jiraIssue.key} is closed for GitHub issue ${githubIssue.url}`,
      error
    );
    return false; // On error, proceed with normal flow
  }
}

// Check if a GitHub issue references an archived Jira issue and handle it
export async function checkAndHandleArchivedJiraIssue(githubIssue) {
  try {
    // Extract Jira key from GitHub issue body
    const jiraKey = extractJiraKeyFromText(githubIssue.body || '');
    if (!jiraKey) {
      return false; // No Jira key found, no action needed
    }

    // Query the Jira issue directly by key (works even if archived)
    const jiraIssue = await fetchJiraIssueByKey(jiraKey);
    if (!jiraIssue) {
      return false; // Issue doesn't exist or couldn't be fetched, proceed with normal flow
    }

    // Check if the issue is archived
    const archivedDate = jiraIssue.fields?.archiveddate;
    if (!archivedDate || typeof archivedDate !== 'string') {
      return false; // Not archived, proceed with normal flow
    }

    // Issue is archived - close the GitHub issue
    const parsed = parseGitHubUrl(githubIssue.url);
    if (!parsed) {
      console.log(`  - Could not parse GitHub URL: ${githubIssue.url}`);
      return false;
    }

    const { owner, repo, issueNumber } = parsed;

    // Use the state from the already-fetched GraphQL data instead of a separate REST call
    if (githubIssue.state === 'CLOSED') {
      console.log(`  - GitHub issue ${owner}/${repo}#${issueNumber} is already closed (Jira ${jiraKey} is archived)`);
      return true; // Already handled
    }

    try {
      // Close the GitHub issue
      await closeGitHubIssue(owner, repo, issueNumber);
      await addGitHubIssueComment(
        owner,
        repo,
        issueNumber,
        `Closed via Jira sync - Jira issue ${jiraKey} was archived.`
      );
      // Add Jira link to GitHub issue body if not already present
      const githubIssueForLink = {
        url: githubIssue.url,
        body: githubIssue.body || '',
      };
      await addJiraLinkToGitHub(jiraKey, githubIssueForLink);
      console.log(
        `  - Closed GitHub issue ${owner}/${repo}#${issueNumber} (Jira ${jiraKey} is archived)`
      );
      syncStats.track('githubClosed');
      return true; // Handled
    } catch (error) {
      if (error.status === 404) {
        console.log(`  - GitHub issue ${owner}/${repo}#${issueNumber} not found, skipping`);
        return false;
      } else {
        errorCollector.addError(
          `SYNCJIRATOGITHUB: Error closing GitHub issue ${owner}/${repo}#${issueNumber} for archived Jira ${jiraKey}`,
          error
        );
        return false;
      }
    }
  } catch (error) {
    errorCollector.addError(
      `SYNCJIRATOGITHUB: Error checking archived Jira issue for GitHub issue ${githubIssue.url}`,
      error
    );
    return false; // On error, proceed with normal flow
  }
}

// Build a lightweight batched GraphQL query to check issue state and updatedAt
export function buildBatchedIssueStateQuery(issueRequests) {
  const fragments = issueRequests.map(({ alias, owner, repo, issueNumber }) => `
    ${alias}: repository(owner: "${owner}", name: "${repo}") {
      issue(number: ${issueNumber}) {
        number
        state
        url
        body
        updatedAt
      }
    }`);

  return `query BatchedIssueState { ${fragments.join('\n')} }`;
}

// Close GitHub issues for closed Jira issues
export async function closeGitHubIssuesForClosedJira(closedJiraIssues) {
  try {
    // Phase 1: Collect candidates and run Jira duplicate checks
    const candidates = []; // { jiraIssue, parsed, githubUrl, alias }

    for (const jiraIssue of closedJiraIssues) {
      const githubUrl = extractUpstreamUrl(jiraIssue.fields.description);
      if (!githubUrl) {
        continue;
      }

      const parsed = parseGitHubUrl(githubUrl);
      if (!parsed) {
        console.log(`  - Could not parse GitHub URL from Jira ${jiraIssue.key}: ${githubUrl}`);
        continue;
      }

      const { owner, repo, issueNumber } = parsed;

      // Before closing, check if an OPEN Jira issue also links to this GitHub issue.
      // This handles duplicate Jira issues: if the "real" Jira issue is still open,
      // we must not close the GitHub issue just because a duplicate was closed.
      try {
        await shortDelay();
        const openCheck = await jiraClient.get('/rest/api/3/search/jql', {
          params: {
            jql: `project = PF AND status not in (Closed, Resolved) AND description ~ "\\"Upstream URL: ${githubUrl}\\""`,
            maxResults: 1,
            fields: 'key',
          },
        });
        const openMatches = (openCheck?.data?.issues || []).filter(
          (issue) => issue.key !== jiraIssue.key
        );
        if (openMatches.length > 0) {
          console.log(
            `  - Skipping close for GitHub issue ${owner}/${repo}#${issueNumber}: ` +
            `open Jira issue ${openMatches[0].key} also links to this issue (closed ${jiraIssue.key} is likely a duplicate)`
          );
          syncStats.track('warnings', { key: `GH #${issueNumber}`, message: `Skipped closing: open Jira also links (closed ${jiraIssue.key} is duplicate)` });
          continue;
        }
      } catch (err) {
        // On error, skip the close to avoid false closures
        console.log(
          `  - Warning: Could not verify open Jira links for ${githubUrl}, skipping close to be safe`
        );
        syncStats.track('warnings', { key: jiraIssue.key, message: 'Could not verify open Jira links, skipped close' });
        continue;
      }

      const alias = `repo_${candidates.length}`;
      candidates.push({ jiraIssue, parsed, githubUrl, alias });
    }

    if (candidates.length === 0) {
      return;
    }

    // Phase 2: Batch fetch GitHub issue states via GraphQL
    const BATCH_SIZE = 50;
    const githubIssuesByAlias = new Map();

    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      const batch = candidates.slice(i, i + BATCH_SIZE);
      const issueRequests = batch.map(({ alias, parsed }) => ({
        alias,
        owner: parsed.owner,
        repo: parsed.repo,
        issueNumber: parsed.issueNumber,
      }));
      const query = buildBatchedIssueStateQuery(issueRequests);
      const batchOwner = issueRequests[0].owner;

      try {
        const response = await executeGraphQLQuery(query, {}, batchOwner);
        if (response) {
          for (const req of issueRequests) {
            const issue = response[req.alias]?.issue;
            if (issue) {
              githubIssuesByAlias.set(req.alias, issue);
            }
          }
        }
      } catch (error) {
        errorCollector.addError(
          `SYNCJIRATOGITHUB: Error batch-fetching GitHub issue states (batch ${Math.floor(i / BATCH_SIZE) + 1})`,
          error
        );
      }
    }

    console.log(`  Fetched ${githubIssuesByAlias.size}/${candidates.length} GitHub issue states in ${Math.ceil(candidates.length / BATCH_SIZE)} batch(es)`);

    // Phase 3: Process each candidate with its pre-fetched GitHub issue state
    for (const { jiraIssue, parsed, githubUrl, alias } of candidates) {
      const { owner, repo, issueNumber } = parsed;
      const ghIssue = githubIssuesByAlias.get(alias);

      if (!ghIssue) {
        console.log(`  - GitHub issue ${owner}/${repo}#${issueNumber} not found, skipping`);
        continue;
      }

      if (ghIssue.state === 'CLOSED') {
        console.log(`  - GitHub issue ${owner}/${repo}#${issueNumber} is already closed`);
        continue;
      }

      // Check timestamps to determine if we should sync from Jira
      const githubUpdated = ghIssue.updatedAt;
      const jiraUpdated = jiraIssue.fields?.updated;
      const githubIssueForComparison = { updatedAt: githubUpdated };

      if (!shouldSyncFromJira(githubIssueForComparison, jiraIssue)) {
        console.log(
          `  - Skipping close: GitHub issue ${owner}/${repo}#${issueNumber} was updated more recently (${githubUpdated}) than Jira issue ${jiraIssue.key} (${jiraUpdated})`
        );
        continue;
      }

      try {
        // Close the issue with a comment marker
        await closeGitHubIssue(owner, repo, issueNumber);
        await addGitHubIssueComment(
          owner,
          repo,
          issueNumber,
          `Closed via Jira sync - Jira issue ${jiraIssue.key} was closed.`
        );
        // Add Jira link to GitHub issue body if not already present
        const githubIssueForLink = {
          url: githubUrl,
          body: ghIssue.body || '',
        };
        await addJiraLinkToGitHub(jiraIssue.key, githubIssueForLink);
        console.log(
          `  - Closed GitHub issue ${owner}/${repo}#${issueNumber} (Jira ${jiraIssue.key} was closed)`
        );
        syncStats.track('githubClosed');
      } catch (error) {
        if (error.status === 404) {
          console.log(`  - GitHub issue ${owner}/${repo}#${issueNumber} not found, skipping`);
        } else {
          errorCollector.addError(
            `SYNCJIRATOGITHUB: Error closing GitHub issue ${owner}/${repo}#${issueNumber} for Jira ${jiraIssue.key}`,
            error
          );
        }
      }
    }
  } catch (error) {
    errorCollector.addError(
      'SYNCJIRATOGITHUB: Error processing closed Jira issues',
      error
    );
  }
}

// Build a batched GraphQL query to fetch multiple issue details at once using aliases
function buildBatchedIssueDetailsQuery(issueRequests) {
  const fragments = issueRequests.map(({ alias, owner, repo, issueNumber }) => `
    ${alias}: repository(owner: "${owner}", name: "${repo}") {
      issue(number: ${issueNumber}) {
        id
        number
        title
        url
        body
        bodyText
        state
        updatedAt
        issueType { name }
        labels(first: 10) { nodes { name } totalCount }
        assignees(first: 10) { nodes { login } totalCount }
        author { login }
        comments(first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) {
          nodes { author { login } bodyText createdAt updatedAt url }
          totalCount
        }
        parent { url }
        subIssues(first: 50) {
          nodes {
            state title url number
            issueType { name }
            repository { nameWithOwner }
            assignees(first: 3) { nodes { login } }
            labels(first: 10) { nodes { name } }
            comments(first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) {
              nodes { author { login } bodyText createdAt updatedAt url }
              totalCount
            }
          }
          totalCount
        }
      }
    }`);

  return `query BatchedIssueDetails { ${fragments.join('\n')} }`;
}

// Sync recently-updated Jira issues to GitHub
// Handles Jira issues that were updated within the `since` window but whose
// corresponding GitHub issues were NOT fetched in the GitHub-driven loop
// (e.g., the GitHub issue wasn't updated recently enough to appear in the fetch).
export async function syncUpdatedJiraIssuesToGitHub(recentlyUpdatedJiraIssues, repo, owner) {
  // Collect Jira issues that have no upstream URL — these need GitHub issues created
  const issuesWithoutUpstream = [];

  try {
    console.log(
      `  Found ${recentlyUpdatedJiraIssues.length} recently-updated Jira issue(s) not already processed. Syncing to GitHub...`
    );

    // Phase 1: Collect all GitHub issue URLs and batch-fetch them
    const issueRequests = [];
    const jiraIssuesByAlias = new Map();

    for (const jiraIssue of recentlyUpdatedJiraIssues) {
      const githubUrl = extractUpstreamUrl(jiraIssue.fields.description);
      if (!githubUrl) {
        issuesWithoutUpstream.push(jiraIssue);
        continue;
      }

      const parsed = parseGitHubUrl(githubUrl);
      if (!parsed) {
        console.log(`  - Could not parse GitHub URL from Jira ${jiraIssue.key}: ${githubUrl}`);
        continue;
      }

      const alias = `repo_${issueRequests.length}`;
      issueRequests.push({
        alias,
        owner: parsed.owner,
        repo: parsed.repo,
        issueNumber: parsed.issueNumber,
      });
      jiraIssuesByAlias.set(alias, jiraIssue);
    }

    if (issueRequests.length === 0) {
      console.log(`  No Jira issues with GitHub links to sync.`);
      return issuesWithoutUpstream;
    }

    // Batch fetch in groups of 20 to stay within GraphQL complexity limits
    const BATCH_SIZE = 20;
    const githubIssuesByAlias = new Map();

    for (let i = 0; i < issueRequests.length; i += BATCH_SIZE) {
      const batch = issueRequests.slice(i, i + BATCH_SIZE);
      const query = buildBatchedIssueDetailsQuery(batch);
      // Use the owner from the first request in the batch for auth
      const batchOwner = batch[0].owner;

      try {
        const response = await executeGraphQLQuery(query, {}, batchOwner);
        if (response) {
          for (const req of batch) {
            const issue = response[req.alias]?.issue;
            if (issue) {
              githubIssuesByAlias.set(req.alias, issue);
            }
          }
        }
      } catch (error) {
        errorCollector.addError(
          `SYNCJIRATOGITHUB: Error batch-fetching GitHub issues (batch ${Math.floor(i / BATCH_SIZE) + 1})`,
          error
        );
      }
    }

    console.log(`  Fetched ${githubIssuesByAlias.size}/${issueRequests.length} GitHub issues in ${Math.ceil(issueRequests.length / BATCH_SIZE)} batch(es)`);

    // Phase 2: Process each Jira issue with its pre-fetched GitHub issue
    for (const [alias, jiraIssue] of jiraIssuesByAlias) {
      try {
        const githubIssue = githubIssuesByAlias.get(alias);
        const req = issueRequests.find((r) => r.alias === alias);
        if (!githubIssue) {
          console.log(`  - Could not fetch GitHub issue ${req.owner}/${req.repo}#${req.issueNumber} for Jira ${jiraIssue.key}`);
          continue;
        }

        console.log(`\n  Syncing Jira ${jiraIssue.key} → GitHub #${githubIssue.number} (Jira-driven)`);

        // Track what was synced for logging
        const syncResults = [];

        // Sync status: close GitHub issue if Jira is closed
        const closedResult = await closeGitHubIssueIfJiraClosed(jiraIssue, githubIssue);
        if (closedResult) syncResults.push('closed');

        // Sync status: reopen GitHub issue if Jira is reopened
        const reopenedResult = await reopenGitHubIssueIfJiraReopened(jiraIssue, githubIssue);
        if (reopenedResult) syncResults.push('reopened');

        // Sync title + description + assignee from Jira to GitHub
        // Title and description are combined into a single REST call
        const [titleDescResult, assigneeResult] = await Promise.all([
          syncTitleAndDescriptionToGitHub(jiraIssue, githubIssue),
          syncAssigneeToGitHub(jiraIssue, githubIssue),
        ]);
        if (titleDescResult.title) syncResults.push('title');
        if (titleDescResult.description) syncResults.push('description');
        if (assigneeResult) syncResults.push('assignee');

        // Add Jira link to GitHub issue body (skip if description was just updated — it includes the footer)
        if (!titleDescResult.description) {
          const linkResult = await addJiraLinkToGitHub(jiraIssue.key, githubIssue);
          if (linkResult) syncResults.push('link');
        }

        if (syncResults.length > 0) {
          console.log(
            `  ✓ Jira-driven sync completed for ${jiraIssue.key} → GitHub #${githubIssue.number}: ${syncResults.join(', ')}`
          );
        } else {
          console.log(
            `  - No changes needed for ${jiraIssue.key} → GitHub #${githubIssue.number}`
          );
        }
      } catch (error) {
        errorCollector.addError(
          `SYNCJIRATOGITHUB: Error syncing updated Jira issue ${jiraIssue.key} to GitHub`,
          error
        );
      }
    }

    return issuesWithoutUpstream;
  } catch (error) {
    errorCollector.addError(
      'SYNCJIRATOGITHUB: Error processing recently-updated Jira issues',
      error
    );
    return issuesWithoutUpstream;
  }
}

// Create GitHub issues for manually created Jira issues
export async function createGitHubIssuesForManualJira(manualJiraIssues) {
  try {
    for (const jiraIssue of manualJiraIssues) {
      try {
        const jiraStatus = jiraIssue.fields?.status?.name;
        const jiraResolution = jiraIssue.fields?.resolution?.name;

        // Skip closed duplicates entirely — the real Jira issue already exists
        if (jiraStatus === 'Closed' && jiraResolution === 'Duplicate') {
          console.log(
            `  - Skipping Jira ${jiraIssue.key}: closed as Duplicate, no GitHub issue needed`
          );
          continue;
        }

        // Extract component from Jira issue to determine target repository
        const jiraComponent = jiraIssue.fields.components?.[0]?.name;
        if (!jiraComponent) {
          console.log(`  - Skipping Jira ${jiraIssue.key}: No component assigned`);
          continue;
        }

        // Find matching repository from availableComponents
        const componentMapping = availableComponents.find(
          (comp) => comp.name === jiraComponent
        );

        if (!componentMapping) {
          console.log(
            `  - Skipping Jira ${jiraIssue.key}: Component "${jiraComponent}" not found in availableComponents`
          );
          continue;
        }

        const owner = componentMapping.owner;
        const repo = componentMapping.name;

        // Extract issue details from Jira (v3 uses accountId; fallback to id)
        const title = jiraIssue.fields.summary || 'Untitled Issue';
        const jiraAssignee = jiraIssue.fields.assignee?.accountId ?? jiraIssue.fields.assignee?.id;
        const githubAssignee = jiraAssignee ? jiraToGitHubUserMapping[jiraAssignee] : null;

        // Convert Jira description (ADF or string) to Markdown so formatting is preserved on GitHub
        const markdownDescription = jiraDescriptionToMarkdown(jiraIssue.fields.description);

        // Build GitHub issue body with Jira reference
        const githubBody = `${markdownDescription}${jiraLinkFooter(jiraIssue.key)}`;

        // Create GitHub issue
        const issueData = {
          title,
          body: githubBody,
        };

        if (githubAssignee) {
          issueData.assignees = [githubAssignee];
        }

        await delay();
        const createdIssue = await createGitHubIssue(owner, repo, issueData);

        console.log(
          `  - Created GitHub issue ${owner}/${repo}#${createdIssue.number} for Jira ${jiraIssue.key} (component: ${jiraComponent})`
        );
        syncStats.track('githubCreated');

        // If the Jira issue is already closed, close the GitHub issue to match
        if (jiraStatus === 'Closed') {
          await closeGitHubIssue(owner, repo, createdIssue.number);
          await addGitHubIssueComment(
            owner,
            repo,
            createdIssue.number,
            `Closed via Jira sync - Jira issue ${jiraIssue.key} is already closed (resolution: ${jiraResolution || 'N/A'}).`
          );
          console.log(
            `  - Closed GitHub issue ${owner}/${repo}#${createdIssue.number} (Jira ${jiraIssue.key} is already closed)`
          );
          syncStats.track('githubClosed');
        }

        // Update Jira issue description to include Upstream URL
        // Use appendMetadataToADF to preserve the original ADF content/formatting
        const upstreamUrl = createdIssue.html_url;
        const updatedDescription = appendMetadataToADF(jiraIssue.fields.description, {
          number: createdIssue.number,
          url: upstreamUrl,
          reporter: jiraIssue.fields.reporter?.displayName ?? jiraIssue.fields.reporter?.accountId ?? '',
          assignees: githubAssignee || '',
        });

        await delay();
        await editJiraIssue(jiraIssue.key, {
          fields: {
            description: updatedDescription,
          },
        });

        console.log(`  - Updated Jira ${jiraIssue.key} with Upstream URL: ${upstreamUrl}`);
      } catch (error) {
        errorCollector.addError(
          `SYNCJIRATOGITHUB: Error creating GitHub issue for Jira ${jiraIssue.key}`,
          error
        );
      }
    }
  } catch (error) {
    errorCollector.addError(
      'SYNCJIRATOGITHUB: Error processing manual Jira issues',
      error
    );
  }
}
