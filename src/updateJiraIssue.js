import {
  buildJiraIssueData,
  jiraClient,
  editJiraIssue,
  delay,
  syncCommentsToJira,
  addRemoteLinkToJiraIssue,
} from './helpers.js';
import { transitionJiraIssue } from './transitionJiraIssue.js';
import { createChildIssues } from './createJiraIssue.js';
import { findJiraIssue } from './findJiraIssue.js';
import { errorCollector } from './index.js';

async function findChildIssues(jiraIssueKey) {
  try {
    delay();
    const response = await jiraClient.get('/rest/api/2/search', {
      params: {
        jql: `parent = ${jiraIssueKey}`,
        fields: 'key,description',
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
          // Sync comments for the existing child issue
          if (subIssue.comments?.totalCount > 0) {
            await syncCommentsToJira(currentChildIssue.key, subIssue.comments);
          }

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
              newJiraKey
                ? ` - ChildIssue: Completed creating new Jira ${newJiraKey} as child of ${parentJiraKey} (GH #${subIssue.number})`
                : ` !! - ChildIssue: Error creating new Jira issue as child of as child of ${parentJiraKey} (GH #${subIssue.number})`
            );
          } else {
            // Update existing Jira issue to link it as a child of the parent Jira issue
            console.log(
              ` - ChildIssue: Updating existing Jira ${jiraIssue.key} to update as child (GH #${subIssue.number})...`
            );
            // Conditionally update issue based on if it's a child of an epic
            const updatedData = { fields: {} };
            if (isEpic) {
              // If parent is epic, set child's customfield 12311140 required for epic link
              updatedData.fields['customfield_12311140'] = parentJiraKey;
              // Remove parent field if it exists
              delete updatedData.fields.parent;
            } else {
              // If not child of epic, set parent field
              updatedData.fields.parent = {
                key: parentJiraKey,
              };
              // and set issue type to sub-task
              // TODO: this is throwing an error when trying to update the issuetype
              updatedData.fields.issuetype = {
                name: 'Sub-task',
                id: '5',
              };
              console.log(
                `  ! - Trying to update ${jiraIssue.key} to be a sub-task of ${parentJiraKey} may need to be done manually`
              );
            }
            await editJiraIssue(jiraIssue.key, updatedData);

            // Sync comments for the existing issue being converted to a child
            if (subIssue.comments?.totalCount > 0) {
              await syncCommentsToJira(jiraIssue.key, subIssue.comments);
            }

            console.log(
              ` - ChildIssue: Completed updating existing Jira ${jiraIssue.key} to child of ${parentJiraKey} (GH #${subIssue.number})`
            );
          }
        }
      }
    }

    // Close any remaining Jira child issues that no longer exist in GitHub
    for (const [_, child] of existingChildIssuesMap) {
      await transitionJiraIssue(child.key, 'Closed');
      console.log(
        ` - Closed child issue ${child.key} as it's no longer open in GitHub`
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
    const jiraIssueData = buildJiraIssueData(githubIssue, true);
    // If issue is a sub-task, keep issue type as sub-task
    // Avoids next GH sync resetting sub-task issuetype
    if (jiraIssue.fields.issuetype.id === '5') {
      jiraIssueData.fields.issuetype = {
        id: '5',
      };
    }
    await editJiraIssue(jiraIssue.key, jiraIssueData);

    addRemoteLinkToJiraIssue(jiraIssue.key, githubIssue);

    // Sync comments
    if (githubIssue.comments.totalCount > 0) {
      await syncCommentsToJira(jiraIssue.key, githubIssue.comments);
    }

    // Check if Jira issue is closed, needs to be reopened
    if (githubIssue.state === 'OPEN' && jiraIssue.fields.status.name === 'Closed') {
      console.log(
        ` - GitHub issue #${githubIssue.number} is open but Jira issue ${jiraIssue.key} is closed, transitioning to New`
      );
      await delay();
      await transitionJiraIssue(jiraIssue.key, 'New');
    }

    // Check if GitHub issue is closed, needs to close Jira issue
    if (githubIssue.state === 'CLOSED' && jiraIssue.fields.status.name !== 'Closed') {
      console.log(
        ` - GitHub issue #${githubIssue.number} is closed but Jira issue ${jiraIssue.key} is open, transitioning to Done`
      );
      await delay();
      await transitionJiraIssue(jiraIssue.key, 'Closed');
    }

    // Update child issues
    const isEpic = jiraIssueData.fields.issuetype.id === '16';
    await updateChildIssues(jiraIssue.key, githubIssue, isEpic);

    console.log(
      `Updated Jira issue ${jiraIssue.key} for GitHub issue #${githubIssue.number}\n`
    );
  } catch (error) {
    errorCollector.addError(
      `UPDATEJIRA: Error updating Jira issue ${jiraIssue.key} (GH #${githubIssue.number})`,
      error
    );
  }
}
