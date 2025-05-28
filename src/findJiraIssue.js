import { jiraClient } from './helpers.js';

export function findJiraIssue(githubIssueLink, jiraIssues) {
  try {
    const jiraIssue = jiraIssues.find((iss) =>
      iss.fields.description.includes(`Upstream URL: ${githubIssueLink}`)
    );
    return jiraIssue;
  } catch (error) {
    console.error('Error finding Jira issue:', error.message);
    return null;
  }
}

export async function fetchJiraIssue(githubIssueLink) {
  try {
    const response = await jiraClient.get('/rest/api/2/search', {
      params: {
        jql: `project = ${process.env.JIRA_PROJECT_KEY} AND description ~ "Upstream URL: ${githubIssueLink}"`,
      },
    });

    // If the search returns no issues, return null
    if (response.data.issues.length === 0) {
      return null;
    }

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
