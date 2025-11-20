import {
  octokit,
  delay,
  executeGraphQLQuery,
  GET_ISSUE_DETAILS,
} from './helpers.js';
import { transitionJiraIssue } from './transitionJiraIssue.js';
import { errorCollector } from './index.js';

// Additional check only for unprocessed Jira issues
// Find their GH issue and see if Jira issue needs to be transitioned to match GH state
export async function handleUnprocessedJiraIssues(unprocessedJiraIssues, repo) {
  console.log(
    `Found ${unprocessedJiraIssues.length} Jira issues that weren't updated. Checking their GitHub status...`
  );

  for (const jiraIssue of unprocessedJiraIssues) {
    // Extract GitHub issue number from description
    console.log(jiraIssue.key);
    const githubIdMatch = jiraIssue.fields.description
      .match(/Upstream URL: (.+)/)?.[1]
      ?.split('/')
      ?.pop();

    if (githubIdMatch) {
      const githubNumber = parseInt(githubIdMatch);
      try {
        // Get issue details using GraphQL
        await delay();
        const response = await executeGraphQLQuery(GET_ISSUE_DETAILS, {
          owner: 'patternfly',
          repo,
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
          await delay();
          await transitionJiraIssue(jiraIssue.key, 'Closed');
          console.log(
            `Updated Jira issue ${jiraIssue.key} for GitHub issue #${githubNumber}`
          );
        } else {
          // GH issue found & open, likely duplicate Jira
          console.log(
            `  !! - Github issue #${githubNumber} found for unprocessed Jira ${jiraIssue.key}, check Jira for duplicate issue or sync GH/Jira issue status (Github Iniatives may be skipped).`
          );
        }
      } catch (error) {
        errorCollector.addError(
          `HANDLEUNPROCESSEDJIRAISSUES: Could not find GitHub issue #${githubNumber} for Jira issue ${jiraIssue.key}`,
          error
        );
        console.log(
          `  !! - Could not find GitHub issue #${githubNumber} for Jira issue ${jiraIssue.key}.
  !! - Did the original Github issue transfer to a different repo?`
        );
      }
    }
  }
}
