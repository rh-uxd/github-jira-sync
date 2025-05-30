import {
  buildJiraIssueData,
  jiraClient,
  editJiraIssue,
  delay,
} from './helpers.js';
import { transitionJiraIssue } from './transitionJiraIssue.js';
import { createChildIssues } from './createJiraIssue.js';
import { findJiraIssue } from './findJiraIssue.js';

async function findChildIssues(jiraIssueKey) {
  try {
    const response = await jiraClient.get('/rest/api/2/search', {
      params: {
        jql: `parent = ${jiraIssueKey}`,
        fields: 'key,description',
      },
    });
    return response.data.issues;
  } catch (error) {
    console.error('Error finding child issues:', error.message, { error });
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
            childIssue.fields.description.match(/Upstream URL: (.*)/);
          return match ? [match[1], childIssue] : null;
        })
        .filter(Boolean)
    );

    // Check if there are subissues
    if (githubIssue?.subIssues?.totalCount > 0) {
      // Get sub-issues from the GraphQL response
      const subIssues = githubIssue.subIssues.nodes;

      // Update or create child issues
      for (const subIssue of subIssues) {
        const currentChildIssue = existingChildIssuesMap.get(subIssue.url);

        if (currentChildIssue) {
          // No need to edit, that's captured through the updates to that issue
          existingChildIssuesMap.delete(subIssue.url);
        } else {
          // check if issue exists and needs to be flagged as child issue
          // Find the corresponding Jira issue
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
              ` - ChildIssue: Completed creating new Jira ${newJiraKey} as child of ${parentJiraKey} (GH #${subIssue.number})`
            );
          } else {
            // Update existing Jira issue to link it as a child of the parent Jira issue
            console.log(
              ` - ChildIssue: Updating existing Jira ${jiraIssue.key} to update as child (GH #${subIssue.number})...`
            );
            // Conditionally update issue based on if it's a child of an epic
            const updatedData = { fields: {} };
            if (isEpic) {
              // If child of epic, set customfield 12311140 used for required epic link
              updatedData.fields['customfield_12311140'] = parentJiraKey;
            } else {
              // If not child of epic, set parent field
              updatedData.fields.parent = {
                key: parentJiraKey,
              };
            }
            await editJiraIssue(jiraIssue.key, updatedData);
            console.log(
              ` - ChildIssue: Completed updating existing Jira ${jiraIssue.key} to child of ${parentJiraKey} (GH #${subIssue.number})`
            );
          }
        }
      }
    }

    // Close any remaining Jira child issues that no longer exist in GitHub
    for (const [_, child] of existingChildIssuesMap) {
      await transitionJiraIssue(child.key, 'Done');
      console.log(
        ` - Closed child issue ${child.key} as it's no longer open in GitHub`
      );
    }
  } catch (error) {
    console.error('Error updating child issues:', error.message, { error });
  }
}

export async function updateJiraIssue(jiraIssue, githubIssue) {
  try {
    const jiraIssueData = buildJiraIssueData(githubIssue, true);
    await editJiraIssue(jiraIssue.key, jiraIssueData);

    // Add remote link to GitHub issue
    await jiraClient.post(`/rest/api/2/issue/${jiraIssue.key}/remotelink`, {
      globalId: `github-${githubIssue.id}`,
      application: {
        type: 'com.github',
        name: 'GitHub',
      },
      relationship: 'clones',
      object: {
        url: githubIssue.url,
        title: githubIssue.title,
      },
    });

    // Check if Jira issue is closed, needs to be reopened
    if (jiraIssue.fields.status.name === 'Closed') {
      console.log(
        ` - GitHub issue #${githubIssue.number} is open but Jira issue ${jiraIssue.key} is closed, transitioning to New`
      );
      await transitionJiraIssue(jiraIssue.key, 'New');
      await delay(1000);
    }

    // Update child issues
    const isEpic = jiraIssueData.fields.issuetype.id === 16;
    await updateChildIssues(jiraIssue.key, githubIssue, isEpic);

    console.log(
      `Updated Jira issue ${jiraIssue.key} for GitHub issue #${githubIssue.number}\n`
    );
  } catch (error) {
    console.error(
      `Error updating Jira issue ${jiraIssue.key}:`,
      error.message,
      { error },
      error?.response?.headers,
      error?.response?.data
    );
  }
}
