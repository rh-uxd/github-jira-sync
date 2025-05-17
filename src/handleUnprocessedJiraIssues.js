import { octokit } from './helpers.js';
import { transitionJiraIssue } from './transitionJiraIssue.js';

// Additional check only for unprocessed Jira issues
// Find their GH issue and see if Jira issue needs to be transitioned to match GH state
export async function handleUnprocessedJiraIssues(unprocessedJiraIssues) {
  console.log(
    `Found ${unprocessedJiraIssues.length} Jira issues that weren't updated. Checking their GitHub status...`
  );

  for (const jiraIssue of unprocessedJiraIssues) {
    // Extract GitHub issue ID from description
    const githubIdMatch = jiraIssue.fields.description.match(/GH Issue (\d+)/);
    if (githubIdMatch) {
      const githubId = githubIdMatch[1];
      try {
        // Check if the GitHub issue exists and is closed
        const { data: githubIssue } = await octokit.issues.get({
          owner: process.env.GITHUB_OWNER,
          repo: process.env.GITHUB_REPO,
          issue_number: parseInt(githubId),
        });

        // If GH is closed and Jira is not, transition Jira to Closed
        if (
          githubIssue.state === 'closed' &&
          jiraIssue.fields.status.name !== 'Closed'
        ) {
          console.log(
            ` - GitHub issue #${githubId} is closed but Jira issue ${jiraIssue.key} is not, transitioning to Closed`
          );
          await transitionJiraIssue(jiraIssue.key, 'Closed');
          console.log(
            `Updated Jira issue ${jiraIssue.key} for GitHub issue #${githubIssue.number}`
          );
        }
      } catch (error) {
        console.log(
          `Could not find GitHub issue #${githubId} for Jira issue ${jiraIssue.key}`
        );
      }
    }
  }
}
