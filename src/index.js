import 'dotenv/config';
import { jiraClient, getRepoIssues, availableComponents } from './helpers.js';
import { findJiraIssue } from './findJiraIssue.js';
import { createJiraIssue } from './createJiraIssue.js';
import { updateJiraIssue } from './updateJiraIssue.js';
import { handleUnprocessedJiraIssues } from './handleUnprocessedJiraIssues.js';

export let jiraIssues = [];

// Error collector to store errors with context
class ErrorCollector {
  constructor() {
    this.errors = [];
  }

  addError(context, error) {
    this.errors.push({
      context,
      message: error.message,
      response: error?.response?.data,
      stack: error.stack,
    });
  }

  hasErrors() {
    return this.errors.length > 0;
  }

  logErrors() {
    if (!this.hasErrors()) return;

    console.error('\n=== Sync Errors ===');
    this.errors.forEach(({ context, message, response }) => {
      console.error(`${context}: ${message}`);
      if (response) {
        console.error(`  Response: ${JSON.stringify(response)}`);
      }
    });
    console.error('==================\n');
  }

  clear() {
    this.errors = [];
  }
}

// Create global error collector instance
export const errorCollector = new ErrorCollector();

async function syncIssues(repo) {
  /* DEBUG
    debugger;
    return;
  */
  try {
    jiraIssues = [];
    // Clear any previous errors
    // errorCollector.clear();
    // Fetch all Jira issues for the specific repo/component
    console.log('fetching Jira');
    const response = await jiraClient.get('/rest/api/2/search', {
      params: {
        jql: `project = ${process.env.JIRA_PROJECT_KEY} AND component = "${repo}" AND status not in (Closed, Resolved) ORDER BY key ASC`,
        maxResults: 1000,
        fields: 'key,id,description,status, issuetype',
      },
    });
    // Assign the issues to our exported variable
    jiraIssues = response.data.issues;
    // Get GitHub issues from GraphQL response
    console.log('fetching GH');
    const githubApiResponse = await getRepoIssues(repo);
    // Sort by number to ensure consistent order, enables easier debugging
    const githubIssues = githubApiResponse.repository.issues.nodes.sort(
      (a, b) => a.number - b.number
    );

    console.log(
      `** Found ${jiraIssues.length} open Jira issues for repo ${
        /*process.env.GITHUB_REPO*/ repo
      } and ${githubIssues.length} open GitHub issues **\n`
    );

    // Keep track of which Jira issues we've processed
    const processedJiraIssues = new Set();

    // Process GitHub issues
    for (const [index, issue] of githubIssues.entries()) {
      // Skip if the issue is a pull request (GraphQL doesn't return pull requests)
      if (issue.pull_request) {
        console.log(
          `(${index + 1}/${githubIssues.length}) Skipping pull request #${
            issue.number
          }`
        );
        continue;
      }

      // Skip if the issue is an Initiative
      if (issue?.issueType?.name === 'Initiative') {
        console.log(
          `(${index + 1}/${githubIssues.length}) Skipping Initiative #${
            issue.number
          }\n`
        );
        continue;
      }

      // Find the corresponding Jira issue
      const jiraIssue = await findJiraIssue(issue.url);

      if (!jiraIssue) {
        // Create new Jira issue
        console.log(
          `(${index + 1}/${
            githubIssues.length
          }) Creating new Jira issue for GitHub issue #${issue.number}`
        );
        await createJiraIssue(issue);
      } else {
        // Update existing Jira issue
        console.log(
          `(${index + 1}/${
            githubIssues.length
          }) Updating existing Jira issue: ${jiraIssue.key}...`
        );
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
      // await handleUnprocessedJiraIssues(unprocessedJiraIssues);
    }

    // Log any collected errors at the end
    console.log(`\n=== ${repo.toUpperCase()} ERRORS ===\n`);
    errorCollector.logErrors();
    console.log(`\n=== END ${repo.toUpperCase()} ERRORS ===\n`);
  } catch (error) {
    errorCollector.addError('INDEX: Sync process', error);
    console.log(`\n=== ${repo.toUpperCase()} ERRORS ===\n`);
    errorCollector.logErrors();
    console.log(`\n=== END ${repo.toUpperCase()} ERRORS ===\n`);
  }
}

// if (syncAll) {
// If syncing all, loop through availableComponents
for (const repo of availableComponents) {
  await syncIssues(repo);
}
// } else {
// Run the sync
// syncIssues();
// }
