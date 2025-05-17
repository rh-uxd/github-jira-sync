import { jiraClient } from './helpers.js';

export async function findJiraIssue(githubIssueId, githubIssueLink) {
  try {
    const response = await jiraClient.get('/rest/api/2/search', {
      params: {
        jql: `project = ${process.env.JIRA_PROJECT_KEY} AND description ~ "GitHub Issue ${githubIssueId}" OR description ~ "Upstream URL: ${githubIssueLink}"`,
      },
    });

    return response.data.issues[0] || null;
  } catch (error) {
    console.error(
      'Error finding Jira issue:',
      error.message,
      error.response.data
    );
    return null;
  }
}
