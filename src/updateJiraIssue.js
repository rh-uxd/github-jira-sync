import { buildJiraIssueData, jiraClient, delay } from './helpers.js';
import { transitionJiraIssue } from './transitionJiraIssue.js';
import { createSubTasks } from './createJiraIssue.js';
import { findJiraIssue, fetchJiraIssue } from './findJiraIssue.js';

export async function updateSubTasks(parentJiraKey, githubIssue, jiraIssues) {
  const subIssues = githubIssue.subIssues.nodes;
  // Three options for matching GH subIssue to Jira issue:
  // 1. Existing Jira issue matched to GH subIssue from existing component jiraIssues array
  // 2. Existing Jira issue matched to GH subIssue from different component via additional fetch call
  // 3. No existing Jira match; create a new Jira issue for the github subIssue

  for (const subIssue of subIssues) {
    // First check for existing Jira issue matched to GH subIssue from existing component jiraIssues
    let existingJiraIssue = findJiraIssue(subIssue.url, jiraIssues);

    if (existingJiraIssue) {
      // Log the existing Jira issue found
      console.log(
        `Found existing Jira issue ${existingJiraIssue.key} for sub-issue ${subIssue.url}`
      );
    } else {
      // If no match found from component jiraIssues, try to fetch Jira issue across any components
      existingJiraIssue = await fetchJiraIssue(subIssue.url);
      await delay(1000);
      if (existingJiraIssue) {
        // Log the existing Jira issue found
        console.log(
          `Fetched existing Jira issue ${existingJiraIssue.key} for sub-issue ${subIssue.url}`
        );
      }
    }
    // Create var to store Jira subissue to link back to parentJiraKey
    let subIssueKey;
    if (existingJiraIssue) {
      // If an existing Jira issue is found, link it to the parent Jira issue
      subIssueKey = existingJiraIssue.key;
    } else {
      // No existing match: create a new Jira issue for the github subIssue & link it back to parent Jira issue
      try {
        subIssueKey = await createSubTasks(parentJiraKey, subIssue);
        await delay(1000);
        console.log(
          `Created new Jira issue ${subIssueKey} for sub-issue ${subIssue.url}`
        );
      } catch (error) {
        console.error(
          `Error creating Jira sub-issue for GH sub-issue ${subIssue.url}:`,
          error.message,
          { error }
        );
        continue; // Skip to next sub-issue if creation fails
      }
    }
    // Create the issues link
    // inward = parent, outward = sub-issue
    await jiraClient.post(`/rest/api/3/issuelink`, {
      comment: {
        body: `Linking sub-issue ${subIssue.url} to parent Jira issue ${parentJiraKey}`,
      },
      inwardIssue: {
        key: parentJiraKey,
      },
      outwardIssue: {
        key: subIssueKey,
      },
      type: {
        name: 'Incorporates',
      },
    });
    await delay(1000);
  }
}

export async function updateJiraIssue(jiraIssue, githubIssue, jiraIssues) {
  try {
    const jiraIssueData = buildJiraIssueData(githubIssue, true);
    console.log(`Updating Jira issue ${jiraIssue.key}...`);
    await jiraClient.put(`/rest/api/2/issue/${jiraIssue.key}`, jiraIssueData);
    await delay(1000);

    // Check if Jira issue is closed, needs to be reopened
    if (jiraIssue.fields.status.name === 'Closed') {
      console.log(
        ` - GitHub issue #${githubIssue.number} is open but Jira issue ${jiraIssue.key} is closed, transitioning to New`
      );
      await transitionJiraIssue(jiraIssue.key, 'New');
      await delay(1000);
    }

    // Update sub-issues if they exist
    if (githubIssue.subIssues.totalCount > 0) {
      console.log('Updating sub-tasks for Jira issue:', jiraIssue.key);
      await updateSubTasks(jiraIssue.key, githubIssue, jiraIssues);
      await delay(1000);
    }

    console.log(
      `Updated Jira issue ${jiraIssue.key} for GitHub issue #${githubIssue.number}`
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
