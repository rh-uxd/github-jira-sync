import 'dotenv/config';
import { jiraClient, getRepoIssues } from './helpers.js';
import { findJiraIssue } from './findJiraIssue.js';
import { createJiraIssue } from './createJiraIssue.js';
import { updateJiraIssue } from './updateJiraIssue.js';
import { handleUnprocessedJiraIssues } from './handleUnprocessedJiraIssues.js';

export let jiraIssues = [];

async function syncIssues() {
  try {
    // Fetch all Jira issues for the specific repo/component
    const response = await jiraClient.get('/rest/api/2/search', {
      params: {
        jql: `project = ${process.env.JIRA_PROJECT_KEY} AND component = "${process.env.GITHUB_REPO}" AND status not in (Closed, Resolved) ORDER BY key ASC`,
        maxResults: 1000,
        fields: 'key,id,description,status, issuetype',
      },
    });

    // Assign the issues to our exported variable
    jiraIssues = response.data.issues;

    // Get GitHub issues from GraphQL response
    const githubApiResponse = await getRepoIssues();
    // Sort by number to ensure consistent order, enables easier debugging
    const githubIssues = githubApiResponse.repository.issues.nodes.sort(
      (a, b) => a.number - b.number
    );

    console.log(
      `** Found ${jiraIssues.length} open Jira issues for repo ${process.env.GITHUB_REPO} and ${githubIssues.length} open GitHub issues **\n`
    );

    // Keep track of which Jira issues we've processed
    const processedJiraIssues = new Set();

    // Process GitHub issues
    for (const issue of githubIssues) {
      // Skip if the issue is a pull request (GraphQL doesn't return pull requests)
      if (issue.pull_request) {
        console.log(`Skipping pull request #${issue.number}`);
        continue;
      }

      // Skip if the issue is an Initiative
      if (issue?.issueType?.name === 'Initiative') {
        console.log(`Skipping Initiative #${issue.number}\n`);
        continue;
      }

      // Find the corresponding Jira issue
      const jiraIssue = await findJiraIssue(issue.url);

      if (!jiraIssue) {
        // Create new Jira issue
        console.log(
          `Creating new Jira issue for GitHub issue #${issue.number}`
        );
        await createJiraIssue(issue);
      } else {
        // Update existing Jira issue
        console.log(`Updating existing Jira issue: ${jiraIssue.key}...`);
        await updateJiraIssue(jiraIssue, issue);
        processedJiraIssues.add(jiraIssue.key);
      }
    }

    // Check remaining Jira issues that weren't processed
    // This is to handle cases where Jira issues are not linked to any open GitHub issue
    const unprocessedJiraIssues = jiraIssues.filter(
      (issue) => !processedJiraIssues.has(issue.key)
    );

    if (unprocessedJiraIssues.length > 0) {
      handleUnprocessedJiraIssues(unprocessedJiraIssues);
    }
  } catch (error) {
    console.error('Error syncing issues:', error.message, { error });
  }
}

// Run the sync
syncIssues();
