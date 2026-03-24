import {
  buildJiraIssueData,
  jiraClient,
  editJiraIssue,
  delay,
  shortDelay,
  syncCommentsToJira,
  shouldSyncFromGitHub,
  extractTextFromADF,
  adfToMarkdown,
  executeGraphQLQuery,
} from './helpers.js';
import { transitionJiraIssue } from './transitionJiraIssue.js';
import { createChildIssues } from './createJiraIssue.js';
import { findJiraIssue } from './findJiraIssue.js';
import { errorCollector } from './index.js';
import { syncAssigneeToGitHub, addJiraLinkToGitHub, syncTitleAndDescriptionToGitHub, closeGitHubIssueIfJiraClosed, reopenGitHubIssueIfJiraReopened, parseGitHubUrl, buildBatchedIssueStateQuery } from './syncJiraToGitHub.js';

async function findChildIssues(jiraIssueKey) {
  try {
    await shortDelay();
    const response = await jiraClient.get('/rest/api/3/search/jql', {
      params: {
        jql: `parent = ${jiraIssueKey}`,
        maxResults: 250,
        fields: 'key,description,updated,status',
      },
    });
    return response.data.issues;
  } catch (error) {
    errorCollector.addError(
      `UPDATEJIRA: Error finding child issues for ${jiraIssueKey}`,
      error
    );
    return [];
  }
}

export async function updateChildIssues(parentJiraKey, githubIssue, isEpic) {
  try {
    // Get existing child issues
    const existingChildIssues = await findChildIssues(parentJiraKey);
    const existingChildIssuesMap = new Map(
      existingChildIssues
        .map((childIssue) => {
          const match =
            extractTextFromADF(childIssue.fields.description).match(/Upstream URL: (.*)/);
          return match ? [match[1], childIssue] : null;
        })
        .filter(Boolean)
    );

    // Check if there are subissues
    let skippedChildCount = 0;
    if (githubIssue?.subIssues?.totalCount > 0) {
      // Get sub-issues from the GraphQL response
      const subIssues = githubIssue.subIssues.nodes;

      // Update or create child issues
      for (const subIssue of subIssues) {
        const currentChildIssue = existingChildIssuesMap.get(subIssue.url);

        if (currentChildIssue) {
          // Already linked as a child — just sync comments if needed
          if (subIssue.comments?.totalCount > 0) {
            await syncCommentsToJira(currentChildIssue.key, subIssue.comments);
          }
          existingChildIssuesMap.delete(subIssue.url);
          skippedChildCount++;
        } else {
          // Not currently a child — check if the Jira issue exists
          const jiraIssue = await findJiraIssue(subIssue.url);

          if (!jiraIssue) {
            // Create new child issue
            console.log(
              ` - ChildIssue: Creating new Jira issue as child (GH #${subIssue.number})...`
            );
            const newJiraKey = await createChildIssues(
              parentJiraKey,
              subIssue,
              isEpic
            );
            console.log(
              newJiraKey
                ? ` - ChildIssue: Created ${newJiraKey} as child of ${parentJiraKey} (GH #${subIssue.number})`
                : ` !! - ChildIssue: Error creating child of ${parentJiraKey} (GH #${subIssue.number})`
            );
          } else {
            // Link existing Jira issue as a child of the parent
            const updatedData = { fields: {} };
            if (isEpic) {
              updatedData.fields['customfield_10014'] = parentJiraKey;
              delete updatedData.fields.parent;
            } else {
              updatedData.fields.parent = {
                key: parentJiraKey,
              };
              // TODO: this is throwing an error when trying to update the issuetype
              updatedData.fields.issuetype = {
                name: 'Sub-task',
                id: '10015',
              };
              console.log(
                `  ! - Trying to update ${jiraIssue.key} to be a sub-task of ${parentJiraKey} may need to be done manually`
              );
            }
            await editJiraIssue(jiraIssue.key, updatedData);

            if (subIssue.comments?.totalCount > 0) {
              await syncCommentsToJira(jiraIssue.key, subIssue.comments);
            }

            console.log(
              ` - ChildIssue: Linked ${jiraIssue.key} as child of ${parentJiraKey} (GH #${subIssue.number})`
            );
          }
        }
      }
    }

    if (skippedChildCount > 0) {
      console.log(
        ` - ChildIssues: ${skippedChildCount} already linked to ${parentJiraKey}, no changes needed`
      );
    }

    // Close Jira child issues whose corresponding GitHub issues are actually closed.
    // Important: Do NOT close Jira children just because they aren't sub-issues of
    // the parent GitHub issue — the Jira parent-child hierarchy can legitimately
    // differ from GitHub's sub-issue hierarchy.
    const fetchedCount = githubIssue?.subIssues?.nodes?.length ?? 0;
    const totalCount = githubIssue?.subIssues?.totalCount ?? 0;
    const allSubIssuesFetched = fetchedCount >= totalCount;

    if (allSubIssuesFetched && existingChildIssuesMap.size > 0) {
      // Filter to only open Jira children that need checking
      const unmatchedChildren = [...existingChildIssuesMap.entries()]
        .filter(([_, child]) => child.fields?.status?.name !== 'Closed');

      if (unmatchedChildren.length > 0) {
        // Parse URLs and prepare batch query
        const toCheck = unmatchedChildren
          .map(([url, child], i) => ({ url, child, parsed: parseGitHubUrl(url), alias: `child_${i}` }))
          .filter(item => item.parsed);

        if (toCheck.length > 0) {
          // Batch fetch GitHub issue states
          const issueRequests = toCheck.map(({ alias, parsed }) => ({
            alias,
            owner: parsed.owner,
            repo: parsed.repo,
            issueNumber: parsed.issueNumber,
          }));
          const query = buildBatchedIssueStateQuery(issueRequests);
          const batchOwner = issueRequests[0].owner;
          const response = await executeGraphQLQuery(query, {}, batchOwner);

          for (const item of toCheck) {
            const ghIssue = response?.[item.alias]?.issue;
            if (ghIssue?.state === 'CLOSED') {
              await transitionJiraIssue(item.child.key, 'Closed');
              console.log(
                ` - Closed child issue ${item.child.key} as its GitHub issue is closed`
              );
            } else {
              console.log(
                ` - Skipping close of child issue ${item.child.key}: GitHub issue is still open (not a sub-issue of parent)`
              );
            }
          }
        }
      }
    } else if (!allSubIssuesFetched && existingChildIssuesMap.size > 0) {
      console.log(
        ` - ⚠ Skipping cleanup of ${existingChildIssuesMap.size} unmatched Jira child issues: ` +
          `only ${fetchedCount} of ${totalCount} GitHub sub-issues were fetched (pagination limit). ` +
          `Increase numSubIssuesPerIssue to process all sub-issues.`
      );
    }
  } catch (error) {
    errorCollector.addError(
      `UPDATEJIRA: Error updating child issues for ${parentJiraKey} (GH #${githubIssue.number})`,
      error
    );
  }
}

export async function updateJiraIssue(jiraIssue, githubIssue) {
  try {
    // Track what was synced for logging
    const syncSummary = {
      githubToJira: false,
      jiraToGitHub: {
        title: false,
        assignee: false,
        link: false,
        description: false,
        closed: false,
        reopened: false,
      },
    };

    // Check if Jira is closed and close GitHub issue early (before any operations that update GitHub timestamp)
    const closedHandled = await closeGitHubIssueIfJiraClosed(jiraIssue, githubIssue);
    if (closedHandled) {
      syncSummary.jiraToGitHub.closed = true;
    }
    // Check if Jira is reopened and reopen GitHub issue early (before any operations that update GitHub timestamp)
    const reopenedHandled = await reopenGitHubIssueIfJiraReopened(jiraIssue, githubIssue);
    if (reopenedHandled) {
      syncSummary.jiraToGitHub.reopened = true;
    }
    // Check timestamps to determine if we should sync from GitHub to Jira
    const shouldSyncGitHubToJira = shouldSyncFromGitHub(githubIssue, jiraIssue);
    if (!shouldSyncGitHubToJira) {
      const githubUpdated = githubIssue.updatedAt || 'unknown';
      const jiraUpdated = jiraIssue.fields?.updated || 'unknown';
      console.log(
        `  - Skipping GitHub → Jira sync: Jira issue ${jiraIssue.key} was updated more recently (${jiraUpdated}) than GitHub issue #${githubIssue.number} (${githubUpdated}). Jira is source of truth.`
      );
    } else {
      // GitHub is newer, sync GitHub → Jira
      const jiraIssueData = buildJiraIssueData(githubIssue, true);
      // If issue is a sub-task, keep issue type as sub-task
      // Avoids next GH sync resetting sub-task issuetype
      if (jiraIssue.fields.issuetype.id === '10015') {
        jiraIssueData.fields.issuetype = {
          id: '10015',
        };
      }
      // Prevent syncing assignees from GitHub to Jira if Jira issue already has an assignee
      const hadAssignee = jiraIssue.fields.assignee && jiraIssue.fields.assignee !== null;
      if (hadAssignee) {
        delete jiraIssueData.fields.assignee;
      }

      // Compare description to avoid unnecessary writes and feedback loops.
      // Normalize both sides the same way to ignore ADF roundtrip whitespace artifacts
      // (e.g. blank lines added after headings, leading spaces stripped by Jira).
      const normalizeForCompare = (text) => String(text || '')
        .replace(/\r\n/g, '\n')
        .replace(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*\/?>/gi, '![image]($1)')  // normalize HTML img to markdown (ADF roundtrip)
        .replace(/[ \t]+$/gm, '')
        .replace(/^[ \t]+/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^(#{1,6} [^\n]+)\n(?!\n)/gm, '$1\n\n')
        .trim();
      const currentJiraMarkdown = adfToMarkdown(jiraIssue.fields.description, { stripMetadata: true });
      const githubBodyClean = (githubIssue.body || '')
        .replace(/\n{0,2}-{3,}\n{0,2}\*\*Jira Issue:\*\*[^\n]*/g, '').trim();
      const descriptionChanged =
        normalizeForCompare(currentJiraMarkdown) !== normalizeForCompare(githubBodyClean);
      if (!descriptionChanged) {
        delete jiraIssueData.fields.description;
      }

      // Check what changed (compare meaningful fields)
      const titleChanged = jiraIssue.fields.summary !== githubIssue.title;
      const hadGitHubAssignee = githubIssue.assignees?.nodes?.length > 0;
      const assigneeChanged = !hadAssignee && hadGitHubAssignee;

      const changes = [];
      if (titleChanged) changes.push('title');
      if (descriptionChanged) changes.push('description');
      if (assigneeChanged) changes.push('assignee');

      if (changes.length > 0) {
        await editJiraIssue(jiraIssue.key, jiraIssueData);
        syncSummary.githubToJira = true;
        console.log(
          `  ✓ Synced from GitHub → Jira: ${changes.join(', ')} (GitHub updated ${githubIssue.updatedAt || 'unknown'})`
        );
      }

      // Sync comments
      if (githubIssue.comments.totalCount > 0) {
        await syncCommentsToJira(jiraIssue.key, githubIssue.comments);
      }

      // Check if Jira issue is closed, needs to be reopened
      if (githubIssue.state === 'OPEN' && jiraIssue.fields.status.name === 'Closed') {
        console.log(
          `  - GitHub issue #${githubIssue.number} is open but Jira issue ${jiraIssue.key} is closed, transitioning to New`
        );
        await delay();
        await transitionJiraIssue(jiraIssue.key, 'New');
      }

      // Check if GitHub issue is closed, needs to close Jira issue
      if (githubIssue.state === 'CLOSED' && jiraIssue.fields.status.name !== 'Closed') {
        console.log(
          `  - GitHub issue #${githubIssue.number} is closed but Jira issue ${jiraIssue.key} is open, transitioning to Done`
        );
        await delay();
        await transitionJiraIssue(jiraIssue.key, 'Closed');
      }

      // Update child issues
      const isEpic = jiraIssueData.fields.issuetype.id === '10000';
      await updateChildIssues(jiraIssue.key, githubIssue, isEpic);
    }

    // Reverse sync: Always attempt to sync from Jira to GitHub
    // These functions check timestamps internally and will skip if GitHub is newer
    // Combined title+description into a single REST call; assignee uses a separate endpoint
    const [titleDescResult, assigneeResult] = await Promise.all([
      syncTitleAndDescriptionToGitHub(jiraIssue, githubIssue),
      syncAssigneeToGitHub(jiraIssue, githubIssue),
    ]);
    if (titleDescResult.title) syncSummary.jiraToGitHub.title = true;
    if (titleDescResult.description) syncSummary.jiraToGitHub.description = true;
    if (assigneeResult) syncSummary.jiraToGitHub.assignee = true;

    // Skip adding Jira link when description was just updated – the new body already includes the canonical footer
    if (!titleDescResult.description) {
      const linkResult = await addJiraLinkToGitHub(jiraIssue.key, githubIssue);
      if (linkResult) syncSummary.jiraToGitHub.link = true;
    }

    // Log summary
    const summaryParts = [];
    if (syncSummary.githubToJira) {
      summaryParts.push('GitHub → Jira');
    }
    const jiraToGitHubChanges = Object.entries(syncSummary.jiraToGitHub)
      .filter(([_, changed]) => changed)
      .map(([field, _]) => field);
    if (jiraToGitHubChanges.length > 0) {
      summaryParts.push(`Jira → GitHub (${jiraToGitHubChanges.join(', ')})`);
    }
    
    // If GitHub issue was closed or reopened, always include it in summary even if no other changes
    if (syncSummary.jiraToGitHub.closed && jiraToGitHubChanges.length === 0) {
      summaryParts.push(`Jira → GitHub (closed)`);
    }
    if (syncSummary.jiraToGitHub.reopened && jiraToGitHubChanges.length === 0 && !syncSummary.jiraToGitHub.closed) {
      summaryParts.push(`Jira → GitHub (reopened)`);
    }
    
    if (summaryParts.length > 0) {
      console.log(
        `  ✓ Sync completed: ${summaryParts.join(' | ')}`
      );
      console.log(
        `Updated Jira issue ${jiraIssue.key} for GitHub issue #${githubIssue.number}\n`
      );
    } else if (syncSummary.githubToJira) {
      // GitHub → Jira synced, but Jira → GitHub skipped (GitHub is newer)
      console.log(
        `  ✓ Sync completed: GitHub → Jira (Jira → GitHub skipped: GitHub is newer)`
      );
      console.log(
        `Updated Jira issue ${jiraIssue.key} for GitHub issue #${githubIssue.number}\n`
      );
    } else {
      // No sync in either direction
      console.log(
        `  - No sync needed: Both issues are up to date`
      );
    }
  } catch (error) {
    errorCollector.addError(
      `UPDATEJIRA: Error updating Jira issue ${jiraIssue.key} (GH #${githubIssue.number})`,
      error
    );
  }
}
