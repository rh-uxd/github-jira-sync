import 'dotenv/config';
import { Octokit } from '@octokit/rest';
import axios from 'axios';

// Initialize GitHub client
const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

// Initialize Jira client
const jiraClient = axios.create({
  baseURL: process.env.JIRA_URL,
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.JIRA_PAT}`,
  },
});

async function syncIssues() {
  try {
    // Fetch GitHub issues
    const { data: githubIssues } = await octokit.issues.listForRepo({
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
      state: 'open',
    });

    console.log(`Found ${githubIssues.length} open GitHub issues`);

    // Process each GitHub issue
    for (const issue of githubIssues) {
      // Check if issue already exists in Jira
      const jiraIssue = await findJiraIssue(issue.number);
      if (process.argv.includes('--test')) {
        console.log('Test mode: skipping issue sync');
        debugger;
      } else if (!jiraIssue) {
        // Create new Jira issue
        // await createJiraIssue(issue);
        console.log(
          `Creating new Jira issue for GitHub issue #${issue.number}`
        );
      } else {
        // Update existing Jira issue
        // await updateJiraIssue(jiraIssue.id, issue);
        console.log(`Updating existing Jira issue: ${jiraIssue.id}`);
      }
    }
  } catch (error) {
    console.error('Error syncing issues:', error.message);
  }
}

async function findJiraIssue(githubIssueNumber) {
  try {
    const response = await jiraClient.get('/rest/api/2/search', {
      params: {
        jql: `project = ${process.env.JIRA_PROJECT_KEY} AND description ~ "GitHub Issue #${githubIssueNumber}"`,
      },
    });

    return response.data.issues[0] || null;
  } catch (error) {
    console.error('Error finding Jira issue:', error.message);
    return null;
  }
}

async function createJiraIssue(githubIssue) {
  try {
    const jiraIssue = {
      fields: {
        project: {
          key: process.env.JIRA_PROJECT_KEY,
        },
        summary: githubIssue.title,
        description: `GitHub Issue #${githubIssue.number}\n\n${githubIssue.body}`,
        issuetype: {
          name: 'Task',
        },
      },
    };

    const response = await jiraClient.post('/rest/api/2/issue', jiraIssue);
    console.log(
      `Created Jira issue ${response.data.key} for GitHub issue #${githubIssue.number}`
    );
    return response.data;
  } catch (error) {
    console.error('Error creating Jira issue:', error.message);
  }
}

async function updateJiraIssue(jiraIssueId, githubIssue) {
  try {
    const jiraIssue = {
      fields: {
        summary: githubIssue.title,
        description: `GitHub Issue #${githubIssue.number}\n\n${githubIssue.body}`,
      },
    };

    await jiraClient.put(`/rest/api/2/issue/${jiraIssueId}`, jiraIssue);
    console.log(
      `Updated Jira issue ${jiraIssueId} for GitHub issue #${githubIssue.number}`
    );
  } catch (error) {
    console.error('Error updating Jira issue:', error.message);
  }
}

// Run the sync
syncIssues();
