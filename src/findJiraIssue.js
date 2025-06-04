import { jiraClient, delay } from './helpers.js';

export async function findJiraIssue(githubIssueLink) {
  await delay(1000);
  try {
    const response = await jiraClient.get('/rest/api/2/search', {
      params: {
        jql: `project = ${process.env.JIRA_PROJECT_KEY} AND description ~ "Upstream URL: ${githubIssueLink}"`,
      },
    });
    let foundIssue = response.data.issues[0] || null;
    // Alert if multiple issues are found
    if (response.data.issues.length > 1) {
      console.log(
        ' - Multiple issues found for GitHub issue:',
        githubIssueLink
      );
      response.data.issues.forEach((issue) => {
        console.log(`  ! - ${issue.key}`);
      });
      foundIssue = response.data.issues.sort((a, b) =>
        a.key.localeCompare(b.key)
      )[0];
      console.log(` - Updating existing issue ${foundIssue.key}`);
    }
    return foundIssue;
  } catch (error) {
    console.error(
      'Error finding Jira issue:',
      error.message,
      error.response.data
    );
    return null;
  }
}
