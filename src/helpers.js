import { Octokit } from '@octokit/rest';
import axios from 'axios';

// Initialize Octokit with GraphQL support
export const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
  baseUrl: 'https://api.github.com',
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

export async function addRemoteLinkToJiraIssue(jiraIssueKey, githubIssue) {
  await delay(1000);
  // Add remote link to GitHub issue
  await jiraClient.post(`/rest/api/2/issue/${jiraIssueKey}/remotelink`, {
    globalId: `github-${githubIssue.id}`,
    application: {
      type: 'com.github',
      name: 'GitHub',
    },
    relationship: 'clones',
    object: {
      url: githubIssue.url,
      title: githubIssue.title,
    },
  });
  return jiraIssueKey;
}

export async function createNewJiraIssue(jiraIssueData, githubIssue) {
  await delay(1000);
  const jiraKey = await jiraClient
    .post('/rest/api/2/issue', jiraIssueData)
    .then(
      async (response) =>
        await addRemoteLinkToJiraIssue(response.data.key, githubIssue)
    );
  return jiraKey;
}

export async function editJiraIssue(jiraIssueKey, jiraIssueData) {
  await delay(1000);
  await jiraClient.put(`/rest/api/2/issue/${jiraIssueKey}`, jiraIssueData);
}

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const userMappings = {
  evwilkin: 'ewilkins@redhat.com',
};
// Map GitHub issue type to Jira issue type
const issueTypeMappings = {
  Bug: {
    jiraName: 'Bug',
    id: 1,
  },
  Epic: {
    jiraName: 'Epic',
    id: 16,
  },
  Task: {
    jiraName: 'Task',
    id: 3,
  },
  Feature: {
    jiraName: 'Story',
    id: 17,
  },
  DevX: {
    jiraName: 'Task',
    id: 3,
  },
  Documentation: {
    jiraName: 'Story',
    id: 17,
  },
  Demo: {
    jiraName: 'Story',
    id: 17,
  },
  'Tech debt': {
    jiraName: 'Task',
    id: 3,
  },
  Initiative: {
    jiraName: 'Epic',
    id: 16,
  },
  SubTask: {
    jiraName: 'Sub-task',
    id: 5,
  },
  default: {
    jiraName: 'Story',
    id: 17,
  },
};

export const getJiraIssueType = (ghIssueType) =>
  issueTypeMappings[ghIssueType?.name] || issueTypeMappings.default;

const availableComponents = [
  'AI-infra-ui-components',
  'chatbot',
  'design-tokens',
  'icons',
  'mission-control-dashboard',
  'patternfly',
  'patternfly-a11y',
  'patternfly-design',
  'patternfly-design-kit',
  'patternfly-extension-seed',
  'patternfly-infra-issues',
  'patternfly-org',
  'patternfly-quickstarts',
  'patternfly-react',
  'patternfly-react-seed',
  'pf-codemods',
  'pf-roadmap',
  'react-catalog-view',
  'react-component-groups',
  'react-console',
  'react-data-view',
  'react-log-viewer',
  'react-topology',
  'react-user-feedback',
  'react-virtualized-extension',
  'virtual-assistant',
];

export const getJiraComponent = (repoName) =>
  availableComponents.includes(repoName) ? repoName : null;

export const buildJiraIssueData = (githubIssue, isUpdateIssue = false) => {
  const {
    title,
    url,
    body = '',
    id,
    number,
    labels,
    assignees,
    state,
    issueType,
  } = githubIssue;

  // Extract repository name from the repository object
  const jiraComponent = getJiraComponent(url.split('/')[4]);

  // Map labels from GraphQL structure
  const jiraLabels = labels.nodes.map((label) =>
    label.name.split(' ').join('-')
  );

  // Map assignees from GraphQL structure
  const assigneeLogins = assignees.nodes.map((a) => a.login);
  const jiraAssignee = userMappings[assigneeLogins[0]] || '';
  const jiraIssueType = getJiraIssueType(issueType);

  // build the Jira issue object to create/update Jira with
  // Updating an issue allows fewer fields than creating new issue
  const jiraIssue = {
    fields: {
      summary: title,
      description: `GH Issue ${number}\nGH ID ${id}\nUpstream URL: ${url}\nAssignees: ${assigneeLogins.join(
        ', '
      )}\n\n----\n\n*Description:*\n${body || ''}`,
      labels: ['GitHub', ...jiraLabels],
      assignee: { name: jiraAssignee },
      issuetype: {
        id: jiraIssueType.id,
      },
      components: [
        {
          name: jiraComponent,
        },
      ],
    },
  };

  // Epic name field is required if issue type is Epic
  if (jiraIssueType.jiraName === 'Epic') {
    jiraIssue.fields['customfield_12311141'] = title;
  }

  // Add extra fields for new issues
  if (!isUpdateIssue) {
    jiraIssue.fields.project = {
      key: process.env.JIRA_PROJECT_KEY,
    };
  }

  return jiraIssue;
};

// Helper function to execute GraphQL queries
export async function executeGraphQLQuery(query, variables) {
  try {
    const response = await octokit.graphql(query, variables);
    return response;
  } catch (error) {
    console.error('GraphQL query error:', error);
    throw error;
  }
}

// GraphQL queries
export const GET_ALL_REPO_ISSUES = `
  query GetAllRepoIssues(
    $owner: String!
    $repo: String!
    $numIssuesToFetch: Int = 30
    $issuesCursor: String = null
    $issueStates: [IssueState!] = [OPEN]
    $numLabelsPerIssue: Int = 10
    $numAssigneesPerIssue: Int = 10
    $numCommentsPerIssue: Int = 20
    $numSubIssuesPerIssue: Int = 30
    $since: DateTime
  ) {
    repository(owner: $owner, name: $repo) {
      issues(
        first: $numIssuesToFetch
        after: $issuesCursor
        states: $issueStates
        filterBy: {since: $since}
        orderBy: {field: CREATED_AT, direction: DESC}
      ) {
        nodes {
          id
          number
          title
          url
          body
          state
          issueType {
            name
          }
          labels(first: $numLabelsPerIssue) {
            nodes {
              name
            }
            totalCount
          }
          assignees(first: $numAssigneesPerIssue) {
            nodes {
              login
            }
            totalCount
          }
          comments(first: $numCommentsPerIssue, orderBy: {field: UPDATED_AT, direction: DESC}) {
            nodes {
              author {
                login
              }
              body
              createdAt
              updatedAt
              url
            }
            totalCount
          }
          parent {
            url
          }
          subIssues(first: $numSubIssuesPerIssue) {
            nodes {
              title
              url
              state
              number
              issueType {
                name
              }
              repository {
                nameWithOwner
              }
              assignees(first: 3) {
                nodes {
                  login
                }
              }
              labels(first: 3) {
                nodes {
                  name
                }
              }
              comments(first: $numCommentsPerIssue, orderBy: {field: UPDATED_AT, direction: DESC}) {
                nodes {
                  author {
                    login
                  }
                  body
                  createdAt
                  updatedAt
                  url
                }
                totalCount
              }
            }
            totalCount
          }
        }
        pageInfo {
          endCursor
          hasNextPage
        }
        totalCount
      }
    }
  }
`;

export const GET_ISSUE_DETAILS = `
  query GetIssueDetails(
    $owner: String!
    $repo: String!
    $issueNumber: Int!
  ) {
    repository(owner: $owner, name: $repo) {
      issue(number: $issueNumber) {
        id
        number
        title
        url
        bodyText
        state
        issueType {
          name
        }
        labels(first: 10) {
          nodes {
            name
          }
          totalCount
        }
        assignees(first: 10) {
          nodes {
            login
          }
          totalCount
        }
        comments(first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) {
          nodes {
            author {
              login
            }
            bodyText
            createdAt
            updatedAt
            url
          }
          totalCount
        }
        parent {
          url
        }
        subIssues(first: 50) {
          nodes {
            state
            title
            url
            number
            issueType {
              name
            }
            repository {
              nameWithOwner
            }
            assignees(first: 3) {
              nodes {
                login
              }
            }
            labels(first: 10) {
              nodes {
                name
              }
            }
            comments(first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) {
              nodes {
                author {
                  login
                }
                bodyText
                createdAt
                updatedAt
                url
              }
              totalCount
            }
          }
          totalCount
        }
      }
    }
  }
`;

export const repoIssues = executeGraphQLQuery(GET_ALL_REPO_ISSUES, {
  owner: process.env.GITHUB_OWNER,
  repo: process.env.GITHUB_REPO,
});

export async function syncCommentsToJira(jiraIssueKey, githubComments) {
  try {
    // Get existing comments from Jira
    await delay(1000);
    const { data: jiraComments } = await jiraClient.get(
      `/rest/api/2/issue/${jiraIssueKey}/comment`
    );

    // Create a map of existing comments by their GitHub URL
    const existingComments = new Map(
      jiraComments.comments
        .map((comment) => {
          const githubUrlMatch = comment.body.match(/Comment URL: (.*)/);
          return githubUrlMatch ? [githubUrlMatch[1], comment] : null;
        })
        .filter(Boolean)
    );

    // Process each GitHub comment
    let addedCommentCount = 0;
    for (const comment of githubComments.nodes) {
      // Skip if comment already exists in Jira
      if (existingComments.has(comment.url)) {
        existingComments.delete(comment.url);
        continue;
      }

      // Format the comment body with GitHub metadata
      const commentBody =
        `${comment.body}\n\n----\n\n` +
        `Author: ${comment.author.login}\n` +
        `Created: ${comment.createdAt}\n` +
        `Updated: ${comment.updatedAt}\n` +
        `Comment URL: ${comment.url}\n`;

      // Add the comment to Jira
      await delay(1000);
      await jiraClient.post(`/rest/api/2/issue/${jiraIssueKey}/comment`, {
        body: commentBody,
      });
      addedCommentCount++;
      console.log(
        ` - Added comment from ${comment.author.login} to Jira issue ${jiraIssueKey}`
      );
    }

    // Remove any comments that no longer exist in GitHub
    for (const [_, comment] of existingComments) {
      await delay(1000);
      await jiraClient.delete(
        `/rest/api/2/issue/${jiraIssueKey}/comment/${comment.id}`
      );
      console.log(
        ` - Removed outdated comment from Jira issue ${jiraIssueKey}`
      );
    }

    console.log(` - Completed syncing ${addedCommentCount} new comments.`);
  } catch (error) {
    console.error('Error syncing comments:', error.message, { error });
  }
}
