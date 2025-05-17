import { Octokit } from '@octokit/rest';
import axios from 'axios';

// Initialize GitHub client
export const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

// Initialize Jira client
export const jiraClient = axios.create({
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

export const buildJiraIssueData = (githubIssue) => {
  const {
    type,
    assignees,
    title,
    html_url,
    labels,
    body = '',
    id,
    repository_url,
    number,
    user,
    milestone, // custom field?
    sub_issues_summary,
  } = githubIssue;

  // Manual mapping of GitHub data to Jira fields
  const jiraIssueType = issueTypeMappings[type?.name] || 'Story';
  const jiraComponent = repository_url.split('/').pop();
  const jiraLabels = labels.map((label) => label.name.split(' ').join('-'));
  const jiraAssignee = userMappings[assignees?.[0]?.login] || null;

  // build the Jira issue object to create/update Jira with
  const jiraIssue = {
    fields: {
      project: {
        key: process.env.JIRA_PROJECT_KEY,
      },
      summary: title,
      description: `GH Issue ${number}\nGH ID ${id}\nUpstream URL: ${html_url}\nAssignees: ${assignees
        .map((a) => a.login)
        .join(', ')}\n\nDescription:\n${body ? body : ''}`,
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
