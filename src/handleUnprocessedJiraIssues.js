import { octokit } from './helpers.js';
import { transitionJiraIssue } from './transitionJiraIssue.js';

// Additional check only for unprocessed Jira issues
// Find their GH issue and see if Jira issue needs to be transitioned to match GH state
export async function handleUnprocessedJiraIssues(unprocessedJiraIssues) {
  console.log(
    `Found ${unprocessedJiraIssues.length} Jira issues that weren't updated. Checking their GitHub status...`
  );

  for (const jiraIssue of unprocessedJiraIssues) {
    // Extract GitHub issue number from description
    const githubIdMatch = jiraIssue.fields.description.match(/GH Issue (\d+)/);
    if (githubIdMatch) {
      const githubNumber = parseInt(githubIdMatch[1]);
      try {
        // Get issue details using GraphQL
        const response = await octokit.graphql(GET_ISSUE_DETAILS, {
          owner: process.env.GITHUB_OWNER,
          repo: process.env.GITHUB_REPO,
          issueNumber: githubNumber,
        });

        const githubIssue = response.repository.issue;

        // If GH is closed and Jira is not, transition Jira to Closed
        if (
          githubIssue.state === 'CLOSED' &&
          jiraIssue.fields.status.name !== 'Closed'
        ) {
          console.log(
            ` - GitHub issue #${githubNumber} is closed but Jira issue ${jiraIssue.key} is not, transitioning to Closed`
          );
          await transitionJiraIssue(jiraIssue.key, 'Closed');
          console.log(
            `Updated Jira issue ${jiraIssue.key} for GitHub issue #${githubNumber}`
          );
        }
      } catch (error) {
        console.log(
          `Could not find GitHub issue #${githubNumber} for Jira issue ${jiraIssue.key}`
        );
      }
    }
  }
}
