import {
  getOctokitForOwner,
  delay,
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
  GET_ISSUE_DETAILS,
  extractTextFromADF,
  appendMetadataToADF,
  adfToMarkdown,
} from './helpers.js';
import { errorCollector } from './index.js';
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
function parseGitHubUrl(githubUrl) {
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

    if (!bodyHasKey && body) {
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

    // Parse GitHub URL to get owner, repo, issueNumber
    const parsed = parseGitHubUrl(githubIssue.url);
    if (!parsed) {
      console.log(`  - Could not parse GitHub URL: ${githubIssue.url}`);
      return false;
    }

    const { owner, repo, issueNumber } = parsed;

    try {
      // Get current GitHub issue state (to verify it's still closed and get updated timestamp)
      await delay();
      const octokitInstance = getOctokitForOwner(owner);
      const { data: ghIssue } = await octokitInstance.rest.issues.get({
        owner,
        repo,
        issue_number: issueNumber,
      });

      if (ghIssue.state === 'open') {
        return false; // Already open, no action needed
      }

      // Check timestamps to determine if we should sync from Jira
      // GitHub REST API returns updated_at, convert to updatedAt for consistency
      const githubUpdated = ghIssue.updated_at;
      const jiraUpdated = jiraIssue.fields?.updated;

      // Create a minimal GitHub issue object for comparison (using updatedAt field name)
      const githubIssueForComparison = { updatedAt: githubUpdated };

      if (!shouldSyncFromJira(githubIssueForComparison, jiraIssue)) {
        // GitHub is newer, don't reopen (respect timestamps)
        return false;
      }

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

    // Parse GitHub URL to get owner, repo, issueNumber
    const parsed = parseGitHubUrl(githubIssue.url);
    if (!parsed) {
      console.log(`  - Could not parse GitHub URL: ${githubIssue.url}`);
      return false;
    }

    const { owner, repo, issueNumber } = parsed;

    try {
      // Get current GitHub issue state (to verify it's still open and get updated timestamp)
      await delay();
      const octokitInstance = getOctokitForOwner(owner);
      const { data: ghIssue } = await octokitInstance.rest.issues.get({
        owner,
        repo,
        issue_number: issueNumber,
      });

      if (ghIssue.state === 'closed') {
        return false; // Already closed, no action needed
      }

      // Check timestamps to determine if we should sync from Jira
      // GitHub REST API returns updated_at, convert to updatedAt for consistency
      const githubUpdated = ghIssue.updated_at;
      const jiraUpdated = jiraIssue.fields?.updated;

      // Create a minimal GitHub issue object for comparison (using updatedAt field name)
      const githubIssueForComparison = { updatedAt: githubUpdated };

      if (!shouldSyncFromJira(githubIssueForComparison, jiraIssue)) {
        // GitHub is newer, don't close (respect timestamps)
        return false;
      }

      // Jira is newer or equal - close the GitHub issue
      await closeGitHubIssue(owner, repo, issueNumber);
      await addGitHubIssueComment(
        owner,
        repo,
        issueNumber,
        `Closed via Jira sync - Jira issue ${jiraIssue.key} is closed.`
      );
      // Add Jira link to GitHub issue body if not already present
      const githubIssueForLink = {
        url: githubIssue.url,
        body: ghIssue.body || '',
      };
      await addJiraLinkToGitHub(jiraIssue.key, githubIssueForLink);
      console.log(
        `  - Closed GitHub issue ${owner}/${repo}#${issueNumber} (Jira ${jiraIssue.key} is closed)`
      );
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

    try {
      // Get GitHub issue to check if it's already closed
      await delay();
      const octokitInstance = getOctokitForOwner(owner);
      const { data: ghIssue } = await octokitInstance.rest.issues.get({
        owner,
        repo,
        issue_number: issueNumber,
      });

      if (ghIssue.state === 'closed') {
        console.log(`  - GitHub issue ${owner}/${repo}#${issueNumber} is already closed (Jira ${jiraKey} is archived)`);
        return true; // Already handled
      }

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
        body: ghIssue.body || '',
      };
      await addJiraLinkToGitHub(jiraKey, githubIssueForLink);
      console.log(
        `  - Closed GitHub issue ${owner}/${repo}#${issueNumber} (Jira ${jiraKey} is archived)`
      );
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

// Close GitHub issues for closed Jira issues
export async function closeGitHubIssuesForClosedJira(closedJiraIssues) {
  try {
    for (const jiraIssue of closedJiraIssues) {
      const githubUrl = extractUpstreamUrl(jiraIssue.fields.description);
      if (!githubUrl) {
        continue; // Skip if no GitHub URL
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
        await delay();
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
          continue;
        }
      } catch (err) {
        // On error, skip the close to avoid false closures
        console.log(
          `  - Warning: Could not verify open Jira links for ${githubUrl}, skipping close to be safe`
        );
        continue;
      }

      try {
        // Get GitHub issue to check if it's already closed
        await delay();
        const octokitInstance = getOctokitForOwner(owner);
        const { data: ghIssue } = await octokitInstance.rest.issues.get({
          owner,
          repo,
          issue_number: issueNumber,
        });

        if (ghIssue.state === 'closed') {
          console.log(`  - GitHub issue ${owner}/${repo}#${issueNumber} is already closed`);
          continue;
        }

        // Check timestamps to determine if we should sync from Jira
        // GitHub REST API returns updated_at, convert to updatedAt for consistency
        const githubUpdated = ghIssue.updated_at;
        const jiraUpdated = jiraIssue.fields?.updated;

        // Create a minimal GitHub issue object for comparison (using updatedAt field name)
        const githubIssueForComparison = { updatedAt: githubUpdated };

        if (!shouldSyncFromJira(githubIssueForComparison, jiraIssue)) {
          console.log(
            `  - Skipping close: GitHub issue ${owner}/${repo}#${issueNumber} was updated more recently (${githubUpdated}) than Jira issue ${jiraIssue.key} (${jiraUpdated})`
          );
          continue;
        }

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

// Sync recently-updated Jira issues to GitHub
// Handles Jira issues that were updated within the `since` window but whose
// corresponding GitHub issues were NOT fetched in the GitHub-driven loop
// (e.g., the GitHub issue wasn't updated recently enough to appear in the fetch).
export async function syncUpdatedJiraIssuesToGitHub(recentlyUpdatedJiraIssues, repo, owner) {
  try {
    console.log(
      `  Found ${recentlyUpdatedJiraIssues.length} recently-updated Jira issue(s) not already processed. Syncing to GitHub...`
    );

    for (const jiraIssue of recentlyUpdatedJiraIssues) {
      try {
        // Extract GitHub URL from the Jira description
        const githubUrl = extractUpstreamUrl(jiraIssue.fields.description);
        if (!githubUrl) {
          // No Upstream URL means this issue was manually created (handled elsewhere)
          continue;
        }

        const parsed = parseGitHubUrl(githubUrl);
        if (!parsed) {
          console.log(`  - Could not parse GitHub URL from Jira ${jiraIssue.key}: ${githubUrl}`);
          continue;
        }

        const { owner: ghOwner, repo: ghRepo, issueNumber } = parsed;

        // Fetch the GitHub issue details via GraphQL
        await delay();
        const response = await executeGraphQLQuery(GET_ISSUE_DETAILS, {
          owner: ghOwner,
          repo: ghRepo,
          issueNumber,
        }, ghOwner);

        const githubIssue = response?.repository?.issue;
        if (!githubIssue) {
          console.log(`  - Could not fetch GitHub issue ${ghOwner}/${ghRepo}#${issueNumber} for Jira ${jiraIssue.key}`);
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

        // Sync title from Jira to GitHub
        const titleResult = await syncTitleToGitHub(jiraIssue, githubIssue);
        if (titleResult) syncResults.push('title');

        // Sync assignee from Jira to GitHub
        const assigneeResult = await syncAssigneeToGitHub(jiraIssue, githubIssue);
        if (assigneeResult) syncResults.push('assignee');

        // Add Jira link to GitHub issue body
        const linkResult = await addJiraLinkToGitHub(jiraIssue.key, githubIssue);
        if (linkResult) syncResults.push('link');

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
  } catch (error) {
    errorCollector.addError(
      'SYNCJIRATOGITHUB: Error processing recently-updated Jira issues',
      error
    );
  }
}

// Create GitHub issues for manually created Jira issues
export async function createGitHubIssuesForManualJira(manualJiraIssues) {
  try {
    for (const jiraIssue of manualJiraIssues) {
      try {
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
