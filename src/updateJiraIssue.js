import { buildJiraIssueData, jiraClient } from './helpers.js';
import { transitionJiraIssue } from './transitionJiraIssue.js';
import { createSubTasks } from './createJiraIssue.js';
import { findJiraIssue, fetchJiraIssue } from './findJiraIssue.js';

export async function updateSubTasks(parentJiraKey, githubIssue, jiraIssues) {
  const subIssues = githubIssue.subIssues.nodes;

  for (const subIssue of subIssues) {
    // First check for existing Jira issue matched to GH subIssue from existing component jiraIssues
    let existingJiraIssue = findJiraIssue(subIssue.url, jiraIssues);
    console.log('existing issue 1 is: ', existingJiraIssue);

    // If no match found from component jiraIssues, try to fetch Jira issue across any components
    if (!existingJiraIssue) {
      existingJiraIssue = await fetchJiraIssue(subIssue.url);
      console.log('existing issue 2 is: ', existingJiraIssue);
    }
    // Create var to store Jira subissue to link back to parentJiraKey
    let subIssueKey;
    // If an existing Jira issue is found, link it to the parent Jira issue
    if (existingJiraIssue) {
      console.log(
        `Found existing Jira issue ${existingJiraIssue.key} for sub-issue ${subIssue.url}`
      );
      subIssueKey = existingJiraIssue.key;
    } else {
      // No existing match: create a new Jira issue for the github subIssue & link it back to parentJiraKey
      subIssueKey = await createSubTasks(parentJiraKey, subIssue);
    }
    // Create the issues link
    // inward = parent, outward = sub-issue
    await jiraClient.post(`/rest/api/2/issuelink`, {
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
  }
}

export async function updateJiraIssue(jiraIssue, githubIssue, jiraIssues) {
  try {
    const jiraIssueData = buildJiraIssueData(githubIssue, true);
    await jiraClient.put(`/rest/api/2/issue/${jiraIssue.key}`, jiraIssueData);

    // Add remote link to GitHub issue
    // TODO: confirm delete below code
    /* Should have been set up already when Jira issue was created
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
    */

    // Check if Jira issue is closed, needs to be reopened
    if (jiraIssue.fields.status.name === 'Closed') {
      console.log(
        ` - GitHub issue #${githubIssue.number} is open but Jira issue ${jiraIssue.key} is closed, transitioning to New`
      );
      await transitionJiraIssue(jiraIssue.key, 'New');
    }

    // Update sub-tasks
    await updateSubTasks(jiraIssue.key, githubIssue, jiraIssues);

    console.log(
      `Updated Jira issue ${jiraIssue.key} for GitHub issue #${githubIssue.number}`
    );
  } catch (error) {
    console.error('Error updating Jira issue:', error.message, { error });
  }
}
