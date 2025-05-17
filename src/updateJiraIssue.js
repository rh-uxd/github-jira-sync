import { buildJiraIssueData, jiraClient } from './helpers.js';
import { transitionJiraIssue } from './transitionJiraIssue.js';

export async function updateJiraIssue(jiraIssue, githubIssue) {
  try {
    const jiraIssueData = buildJiraIssueData(githubIssue);

    await jiraClient.put(`/rest/api/2/issue/${jiraIssue.id}`, jiraIssueData);

    // Add remote link to GitHub issue
    await jiraClient.post(`/rest/api/2/issue/${jiraIssue.key}/remotelink`, {
      globalId: `github-${githubIssue.id}`,
      application: {
        type: 'com.github',
        name: 'GitHub',
      },
      relationship: 'relates to',
      object: {
        url: githubIssue.html_url,
        title: githubIssue.html_url,
      },
    });

    // Check if Jira issue is closed, needs to be reopened
    if (jiraIssue.fields.status.name === 'Closed') {
      console.log(
        ` - GitHub issue #${githubIssue.number} is open but Jira issue ${jiraIssue.key} is closed, transitioning to New`
      );
      await transitionJiraIssue(jiraIssue.key, 'New');
    }

    console.log(
      `Updated Jira issue ${jiraIssue.key} for GitHub issue #${githubIssue.number}`
    );
  } catch (error) {
    console.error('Error updating Jira issue:', error.message, { error });
  }
}
