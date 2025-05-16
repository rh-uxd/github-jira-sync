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

const userMappings = {
  evwilkin: 'ewilkins@redhat.com',
};
// Map GitHub issue type to Jira issue type
const issueTypeMappings = {
  Bug: 'Bug',
  Epic: 'Epic',
  Task: 'Task',
  Feature: 'Story',
  DevX: 'Task',
  Documentation: 'Story',
  Demo: 'Story',
  Support: 'Story',
  'Tech debt': 'Task',
  Initiative: 'Feature',
};

const buildJiraIssueData = (githubIssue) => {
  const {
    type, // issueType.name (need to match list from Jira project)
    assignees, // replaces assignee but is it supported in Jira?
    title,
    html_url,
    labels,
    body = '',
    id,
    repository_url,
    user,
    state, // open or closed - status?
    milestone, // custom field?
    url, // used for follow-up API calls
    sub_issues_summary,
  } = githubIssue;
  // Manual mapping of GitHub data to Jira fields
  const jiraIssueType = issueTypeMappings[type?.name] || 'Story'; // Default to Story if not found
  const jiraComponent = repository_url.split('/').pop();
  const jiraLabels = labels.map((label) => label.name.split(' ').join('-'));
  const jiraAssignee = userMappings[assignees?.[0]?.login] || null;

  // build the Jira issue object
  const jiraIssue = {
    fields: {
      project: {
        key: process.env.JIRA_PROJECT_KEY,
      },
      summary: title,
      description: `GitHub Issue ${id}\nUpstream URL: ${html_url}\nAssignees: ${assignees.join(
        ', '
      )}\n\nDescription:\n${body}`,
      issuetype: {
        name: jiraIssueType,
      },
      // reporter: { name: user.login },
      labels: ['GitHub', ...jiraLabels],
      assignee: { name: jiraAssignee },
      components: [
        {
          name: jiraComponent,
        },
      ],
    },
  };

  return jiraIssue;
};

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
      const jiraIssue = await findJiraIssue(issue.id, issue.html_url);
      if (process.argv.includes('--test')) {
        console.log('Test mode: skipping issue sync');
        debugger;
      } else if (!jiraIssue) {
        // Create new Jira issue
        console.log(
          `Creating new Jira issue for GitHub issue #${issue.number}`
        );
        // console.log({ issue });
        await createJiraIssue(issue);
      } else {
        // Update existing Jira issue
        console.log(`Updating existing Jira issue: ${jiraIssue.key}...`);
        // console.log({ jiraIssue });
        await updateJiraIssue(jiraIssue.id, issue, jiraIssue.key);
      }
    }
  } catch (error) {
    console.error('Error syncing issues:', error.message);
  }
}

async function findJiraIssue(githubIssueId, githubIssueLink) {
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

async function createJiraIssue(githubIssue) {
  try {
    const jiraIssue = buildJiraIssueData(githubIssue);
    const response = await jiraClient.post('/rest/api/2/issue', jiraIssue);
    console.log(
      `Created Jira issue ${response.data.key} for GitHub issue #${githubIssue.number}`
    );
    return response.data;
  } catch (error) {
    console.error(
      'Error creating Jira issue:',
      error.message,
      error.response.data
    );
  }
}

async function updateJiraIssue(jiraIssueId, githubIssue, jiraIssueKey) {
  try {
    const jiraIssue = buildJiraIssueData(githubIssue);

    await jiraClient.put(`/rest/api/2/issue/${jiraIssueId}`, jiraIssue);
    console.log(
      `Updated Jira issue ${jiraIssueKey} for GitHub issue #${githubIssue.number}`
    );
  } catch (error) {
    console.error(
      'Error updating Jira issue:',
      error.message,
      error.response.data
    );
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
