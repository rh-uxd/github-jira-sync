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
  normalizeMarkdownForCompare,
  stripRepoPrefix,
  executeGraphQLQuery,
  paginatedJiraSearch,
} from './helpers.js';
import { transitionJiraIssue } from './transitionJiraIssue.js';
import { createChildIssues } from './createJiraIssue.js';
import { findJiraIssue } from './findJiraIssue.js';
import { errorCollector, syncStats } from './logging.js';
import { syncAssigneeToGitHub, addJiraLinkToGitHub, syncTitleToGitHub, closeGitHubIssueIfJiraClosed, reopenGitHubIssueIfJiraReopened, parseGitHubUrl, buildBatchedIssueStateQuery } from './syncJiraToGitHub.js';

// Jira refuses a parent link that breaks its issue hierarchy (e.g. a Story under a Story). That is a
// known limitation of syncing GitHub sub-issues, not a failure, so it is reported as a warning.
export function isHierarchyError(error) {
  if (error?.response?.status !== 400) return false;
  return /hierarchy/i.test(JSON.stringify(error.response.data ?? ''));
}

// The parent (or epic link) a Jira issue already has, or null. A person may have placed it there on purpose,
// so the sync must not move it to match GitHub's sub-issue tree.
export async function getExistingParentKey(jiraIssueKey) {
  try {
    await shortDelay();
    const { data } = await jiraClient.get(`/rest/api/3/issue/${jiraIssueKey}`, {
      params: { fields: 'parent,customfield_10014' },
    });
    return data.fields?.parent?.key || data.fields?.customfield_10014 || null;
  } catch {
    return null;
  }
}

// Every child of a Jira issue. Paged: a single request returns at most 100 issues when `description`
// is requested, so a parent with more children would look like it had fewer and get duplicates.
export async function findChildIssues(jiraIssueKey) {
  try {
    await shortDelay();
    return await paginatedJiraSearch(
      `parent = ${jiraIssueKey}`,
      'key,description,updated,status'
    );
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
            // Link existing Jira issue as a child of the parent, unless it already has a different parent
            const existingParent = await getExistingParentKey(jiraIssue.key);
            if (existingParent && existingParent !== parentJiraKey) {
              console.log(
                `  ! - Skipping ${jiraIssue.key}: already a child of ${existingParent} in Jira, not moving it to ${parentJiraKey} (GH #${subIssue.number})`
              );
              syncStats.track('warnings', { key: jiraIssue.key, message: `Kept existing parent ${existingParent}; GitHub sub-issue of ${parentJiraKey} not applied` });
              if (subIssue.comments?.totalCount > 0) {
                await syncCommentsToJira(jiraIssue.key, subIssue.comments);
              }
              continue;
            }
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
            try {
              await editJiraIssue(jiraIssue.key, updatedData);
            } catch (linkError) {
              if (!isHierarchyError(linkError)) throw linkError;
              console.log(
                `  ! - Skipping ${jiraIssue.key}: Jira's hierarchy does not allow it under ${parentJiraKey} (GH #${subIssue.number}); needs a manual change`
              );
              syncStats.track('warnings', { key: jiraIssue.key, message: `Jira hierarchy does not allow it under ${parentJiraKey}` });
              continue;
            }

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
                ` - Skipping close of child issue ${item.child.key}: linked GitHub issue is still open`
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
      // If the Jira description is already truncated and the new one is also truncated,
      // skip the update to avoid rewriting the same truncation notice every sync.
      const currentJiraMarkdown = adfToMarkdown(jiraIssue.fields.description, { stripMetadata: true });
      const isTruncated = currentJiraMarkdown.includes('Issue description was truncated due to size');
      const newDescIsTruncated = !jiraIssueData.fields.description ||
        extractTextFromADF(jiraIssueData.fields.description).includes('Issue description was truncated due to size');

      let descriptionChanged;
      if (isTruncated && newDescIsTruncated) {
        // Both truncated — no meaningful change
        descriptionChanged = false;
      } else {
        // Normalize both sides the same way so ADF roundtrip artifacts (blank lines, indentation,
        // bullet and italic spellings, <img> vs ![alt](src)) don't count as a change.
        const githubBodyClean = (githubIssue.body || '')
          .replace(/\n{0,2}-{3,}\n{0,2}\*\*Jira Issue:\*\*[^\n]*/g, '').trim();
        descriptionChanged =
          normalizeMarkdownForCompare(currentJiraMarkdown) !== normalizeMarkdownForCompare(githubBodyClean);
      }
      if (!descriptionChanged) {
        delete jiraIssueData.fields.description;
      }

      // Check what changed (compare meaningful fields)
      const parsedForTitle = parseGitHubUrl(githubIssue.url);
      const titleChanged = (parsedForTitle
        ? stripRepoPrefix(jiraIssue.fields.summary, parsedForTitle.owner, parsedForTitle.repo)
        : jiraIssue.fields.summary) !== githubIssue.title;
      const hadGitHubAssignee = githubIssue.assignees?.nodes?.length > 0;
      const assigneeChanged = !hadAssignee && hadGitHubAssignee;

      const newPrUrls = githubIssue.closedByPullRequestsReferences?.nodes
        ?.map((pr) => pr.url)
        .filter(Boolean) || [];
      const currentPrField = extractTextFromADF(jiraIssue.fields.customfield_10875).trim();
      const newPrField = newPrUrls.join('\n');
      const prLinksChanged = currentPrField !== newPrField;
      if (!prLinksChanged) {
        delete jiraIssueData.fields['customfield_10875'];
      }

      const changes = [];
      if (titleChanged) changes.push('title');
      if (descriptionChanged) changes.push('description');
      if (assigneeChanged) changes.push('assignee');
      if (prLinksChanged) changes.push('prLinks');

      if (changes.length > 0) {
        try {
          await editJiraIssue(jiraIssue.key, jiraIssueData);
        } catch (editError) {
          const isAssigneeError =
            editError.response?.status === 400 &&
            editError.response?.data?.errors?.assignee;

          if (isAssigneeError && jiraIssueData.fields.assignee) {
            console.log(
              `  ⚠ Assignee ${jiraIssueData.fields.assignee.accountId} cannot be assigned in Jira. Retrying without assignee...`
            );
            delete jiraIssueData.fields.assignee;
            const assigneeIdx = changes.indexOf('assignee');
            if (assigneeIdx > -1) changes.splice(assigneeIdx, 1);

            if (changes.length > 0) {
              await editJiraIssue(jiraIssue.key, jiraIssueData);
            }
          } else {
            throw editError;
          }
        }
        if (changes.length > 0) {
          syncSummary.githubToJira = true;
          console.log(
            `  ✓ Synced from GitHub → Jira: ${changes.join(', ')} (GitHub updated ${githubIssue.updatedAt || 'unknown'})`
          );
        }
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
    // These functions check timestamps internally and will skip if GitHub is newer.
    // The description is intentionally NOT synced back: GitHub is the source of truth for the
    // body, and Jira's copy can be a lossy rendering of it (see README).
    const [titleResult, assigneeResult] = await Promise.all([
      syncTitleToGitHub(jiraIssue, githubIssue),
      syncAssigneeToGitHub(jiraIssue, githubIssue),
    ]);
    if (titleResult) syncSummary.jiraToGitHub.title = true;
    if (assigneeResult) syncSummary.jiraToGitHub.assignee = true;

    const linkResult = await addJiraLinkToGitHub(jiraIssue.key, githubIssue);
    if (linkResult) syncSummary.jiraToGitHub.link = true;

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
