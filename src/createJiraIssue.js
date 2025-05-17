import { buildJiraIssueData, jiraClient } from './helpers.js';

export async function createJiraIssue(githubIssue) {
  try {
    // Create a new Jira issue
    const jiraIssueData = buildJiraIssueData(githubIssue);
    const response = await jiraClient.post('/rest/api/2/issue', jiraIssueData);

    // Add remote link to GitHub issue
    await jiraClient.post(`/rest/api/2/issue/${response.data.key}/remotelink`, {
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

    console.log(
      `Created Jira issue ${response.data.key} for GitHub issue #${githubIssue.number}`
    );

    return response.data;
  } catch (error) {
    console.error(
      'Error creating Jira issue:',
      error.message,
      error.response.data
    );
  }
}
