import 'dotenv/config';
import { octokit, jiraClient, repoIssues } from './helpers.js';
import { findJiraIssue } from './findJiraIssue.js';
import { createJiraIssue } from './createJiraIssue.js';
import { updateJiraIssue } from './updateJiraIssue.js';
import { transitionJiraIssue } from './transitionJiraIssue.js';
import { handleUnprocessedJiraIssues } from './handleUnprocessedJiraIssues.js';

async function syncIssues() {
  try {
    // Fetch all Jira issues for the specific repo/component
    const { data: jiraIssues } = await jiraClient.get('/rest/api/2/search', {
      params: {
        jql: `project = ${process.env.JIRA_PROJECT_KEY} AND component = "${process.env.GITHUB_REPO}"`,
        maxResults: 1000,
        fields: 'key,id,description,status',
      },
    });

    // Get GitHub issues from GraphQL response
    const githubApiResponse = await repoIssues;
    const githubIssues = githubApiResponse.repository.issues.nodes;

    console.log(
      `Found ${jiraIssues.issues.length} Jira issues for repo ${process.env.GITHUB_REPO} and ${githubIssues.length} GitHub issues`
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

      // Find the corresponding Jira issue
      const jiraIssue = await findJiraIssue(issue.id, issue.url);

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
    const unprocessedJiraIssues = jiraIssues.issues.filter(
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

/* SUBTASKS FOR EPICS
  let subtasks = [];
  if (sub_issues_summary.total > 0) {
    // get subissues from api at `${url}/sub_issues`
    // and add them to the subtasks array
    const { data: subIssues } = await octokit.issues.listForRepo({
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
      issue_number: id,
    });
    for (const subIssue of subIssues) {
      const subtask = {
        fields: {
          project: {
            key: process.env.JIRA_PROJECT_KEY,
          },
          summary: subIssue.title,
          description: `GitHub Issue ${subIssue.number}: ${subIssue.html_url}`,
          issuetype: {
            name: 'Sub-task',
          },
          parent: {
            key: jiraIssue.key, // Assuming you have the parent issue key
          },
        },
      };
      subtasks.push(subtask);
    }
  }
  console.log({ githubIssue, subtasks });
  END SUBTASKS FOR EPICS */
