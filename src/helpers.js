import { Octokit } from '@octokit/rest';
import axios from 'axios';
import { errorCollector } from './index.js';
import j2m from 'jira2md';

// Initialize Octokit with GraphQL support
export const octokit = new Octokit({
  auth: process.env.GH_TOKEN,
  baseUrl: 'https://api.github.com',
});

// Initialize Jira client
export const jiraClient = axios.create({
  baseURL: 'https://issues.redhat.com/',
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.JIRA_PAT}`,
  },
});

export async function addRemoteLinkToJiraIssue(jiraIssueKey, githubIssue) {
  await delay();
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
  await delay();
  const jiraKey = await jiraClient
    .post('/rest/api/2/issue', jiraIssueData)
    .then(
      async (response) =>
        await addRemoteLinkToJiraIssue(response.data.key, githubIssue)
    );
  return jiraKey;
}

export async function editJiraIssue(jiraIssueKey, jiraIssueData) {
  await delay();
  await jiraClient.put(`/rest/api/2/issue/${jiraIssueKey}`, jiraIssueData);
}

export const delay = (ms = 1000) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const convertMarkdownToJira = (str) => {
  // Custom image fix - extracts img src and wraps in ! 
  let jiraMd = str.replaceAll(
    /<img\b[^>]*src="([^"]+)"[^>]*\/>/gi,   // ← matches <img … src="…" … />
    '!$1|width=30%!'                        // ← wrap the captured URL in ! & set width to 30%
  );
  jiraMd = j2m.to_jira(jiraMd); // default replacements
  return jiraMd;
};
  
const platformTeamUsers = {
  nicolethoen: 'nthoen',
  dlabaj: 'dlabaj',
  rebeccaalpert: 'ralpert@redhat.com',
  mcoker: 'michaelcoker',
  'wise-king-sullyman': 'ausulliv@redhat.com',
  sg00dwin: 'sgoodwin_redhat',
  thatblindgeye: 'eolkowsk@redhat.com',
  kmcfaul: 'knmcfaul',
  srambach: 'srambach',
  parthivrh: 'parthivk',
};

const enablementTeamUsers = {
  mattnolting: 'rhn-support-mnolting',
  jpuzz0: 'jpuzzo@redhat.com',
  'jeff-phillips-18': 'jephilli@redhat.com',
  jschuler: 'jschuler_kafka_devexp',
  evwilkin: 'ewilkins@redhat.com',
  cdcabrera: 'cdcabrera',
  dlabrecq: 'dlabrecq@redhat.com',
  'jenny-s51': 'eug3nia',
  mfrances17: 'mfrances',
  gitdallas: 'dnicol@redhat.com',
  tlabaj: 'tlabaj@redhat.com',
};

const designTeamUsers = {
  'andrew-ronaldson': 'aronaldson',
  lboehling: 'lboehlin',
  kaylachumley: 'rh-ee-kchumley',
  edonehoo: 'rh-ee-edonehoo',
  'bekah-stephens': 'bdiring@redhat.com',
};

const userMappings = {
  ...platformTeamUsers,
  ...enablementTeamUsers,
  ...designTeamUsers,
};
// Map GitHub issue type to Jira issue type
const issueTypeMappings = {
  Bug: {
    jiraName: 'Bug',
    id: '1',
  },
  Epic: {
    jiraName: 'Epic',
    id: '16',
  },
  Task: {
    jiraName: 'Task',
    id: '3',
  },
  Feature: {
    jiraName: 'Story',
    id: '17',
  },
  DevX: {
    jiraName: 'Task',
    id: '3',
  },
  Documentation: {
    jiraName: 'Story',
    id: '17',
  },
  Demo: {
    jiraName: 'Story',
    id: '17',
  },
  'Tech debt': {
    jiraName: 'Task',
    id: '3',
  },
  Initiative: {
    jiraName: 'Feature',
    id: '10700',
  },
  SubTask: {
    jiraName: 'Sub-task',
    id: '5',
  },
  default: {
    jiraName: 'Story',
    id: '17',
  },
};

export const getJiraIssueType = (ghIssueType) =>
  issueTypeMappings[ghIssueType?.name] || issueTypeMappings.default;

export const availableComponents = [
  'AI-infra-ui-components',
  'chatbot',
  'design-tokens',
  'icons',
  'mission-control-dashboard',
  'patternfly',
  'patternfly-a11y',
  'patternfly-cli',
  'patternfly-design',
  'patternfly-design-kit',
  'patternfly-doc-core',
  'patternfly-extension-seed',
  'patternfly-infra-issues',
  'patternfly-mcp',
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
];

export const getJiraComponent = (repoName) =>
  availableComponents.includes(repoName) ? repoName : null;

export const buildJiraIssueData = (githubIssue, isUpdateIssue = false) => {
  const {
    title,
    url,
    body = '',
    number,
    labels,
    assignees,
    issueType,
    author,
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
      description: `${
        body ? convertMarkdownToJira(body) : ''
      }\n\n----\n\nGH Issue ${number}\nUpstream URL: ${url}\nReporter: ${
        author?.login || ''
      }\nAssignees: ${assigneeLogins.join(', ')}`,
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

  // Add required extra fields for new issue creation
  if (!isUpdateIssue) {
    jiraIssue.fields.project = {
      key: 'PF',
    };
    // Epic name field is required on Epic creation
    if (jiraIssueType.jiraName === 'Epic') {
      jiraIssue.fields['customfield_12311141'] = title;
    }
  }

  return jiraIssue;
};

// Helper function to execute GraphQL queries
export async function executeGraphQLQuery(query, variables) {
  try {
    const response = await octokit.graphql(query, variables);
    return response;
  } catch (error) {
    errorCollector.addError('HELPERS: GraphQL query execution', error);
    return null;
  }
}

// GraphQL queries
export const GET_ALL_REPO_ISSUES = `
  query GetAllRepoIssues(
    $owner: String!
    $repo: String!
    $numIssuesToFetch: Int = 100
    $issuesCursor: String
    $issueStates: [IssueState!] = [OPEN, CLOSED]
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
          author {
            login
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
        author {
          login
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

export async function getRepoIssues(repo, since) {
  // Validate environment variables
  if (!repo) {
    throw new Error(
      'Missing required argument: repo'
    );
  }

  let allIssues = [];
  let hasNextPage = true;
  // cursor is graphql response pointing to last returned issue, used for pagination
  let cursor = null;
  let retryCount = 0;
  const MAX_RETRIES = 3;
  const ghOwner = 'patternfly';

  while (hasNextPage) {
    try {
      const response = await executeGraphQLQuery(GET_ALL_REPO_ISSUES, {
        owner: ghOwner,
        repo,
        issuesCursor: cursor,
        since,
      });

      // Validate response structure
      if (!response?.repository?.issues) {
        debugger;
        throw new Error('Invalid response structure from GitHub API');
      }

      const { nodes, pageInfo } = response.repository.issues;

      // Handle empty repository or no issues
      if (!nodes || nodes.length === 0) {
        console.log(
          `No issues found in repository patternfly/${
            repo
          }`
        );
        break;
      }

      allIssues = [...allIssues, ...nodes];

      hasNextPage = pageInfo.hasNextPage;
      cursor = pageInfo.endCursor;

      // Add a delay between requests to avoid rate limiting
      if (hasNextPage) {
        await delay(1000);
      }

      // Reset retry count on successful request
      retryCount = 0;
    } catch (error) {
      errorCollector.addError(
        `HELPERS: Error fetching GitHub issues (repo: ${
          repo
        })`,
        error
      );

      // Handle rate limiting
      if (
        error.message.includes('rate limit') ||
        error.message.includes('429')
      ) {
        if (retryCount < MAX_RETRIES) {
          retryCount++;
          console.log(`Rate limited. Retrying in ${retryCount * 2} seconds...`);
          await delay(retryCount * 2000); // Exponential backoff
          continue;
        } else {
          throw new Error('Max retries exceeded for rate limiting');
        }
      }

      // Handle other errors
      throw new Error(`Failed to fetch GitHub issues: ${error.message}`);
    }
  }

  // Return empty structure if no issues found
  if (allIssues.length === 0) {
    return {
      repository: {
        issues: {
          nodes: [],
          totalCount: 0,
        },
      },
    };
  }

  return {
    repository: {
      issues: {
        nodes: allIssues,
        totalCount: allIssues.length,
      },
    },
  };
}

export async function syncCommentsToJira(jiraIssueKey, githubComments) {
  try {
    // Get existing comments from Jira
    await delay();
    const { data: jiraComments } = await jiraClient.get(
      `/rest/api/2/issue/${jiraIssueKey}/comment`
    );

    // Create a map of existing comments by their GitHub URL
    const existingComments = new Map(
      jiraComments.comments
        .map((comment) => {
          // Match either "Comment URL: " or "Full comment available at: " plus the comment link (for truncated comments)
          const githubUrlMatch =
            comment.body.match(/Comment URL: (.*)/) ||
            comment.body.match(/Full comment available at: (.*)/);
          return githubUrlMatch ? [githubUrlMatch[1], comment] : null;
        })
        .filter(Boolean)
    );

    // Reverse comments to add oldest first to match Jira comment order (oldest at bottom, newest at top)
    const githubCommentsAscending = githubComments.nodes.reverse();
    let addedCommentCount = 0;
    // Process each GitHub comment
    for (const comment of githubCommentsAscending) {
      // Skip if comment already exists in Jira
      if (existingComments.has(comment.url)) {
        existingComments.delete(comment.url);
        continue;
      }

      // Format the comment body with GitHub metadata
      let commentBody =
        `Comment Author: ${comment.author.login}\n` +
        `\n----\n\n${comment.body}\n\n----\n\n` +
        `Comment Created: ${comment.createdAt}\n` +
        `Comment URL: ${comment.url}\n`;

      // Check if comment is too large (Jira has a limit of ~32KB)
      // Ex: https://github.com/patternfly/patternfly-doc-core/issues/52#issuecomment-2922965458
      if (commentBody.length > 30000) {
        console.log(
          ` - Comment from ${comment.author.login} is too large (${commentBody.length} chars). Truncating...`
        );
        // Truncate the comment and add a note
        commentBody =
          commentBody.substring(0, 5000) +
          `\n\nComment was truncated due to size. Full comment available at: ${comment.url}`;
      }
      // Add the comment to Jira
      await delay();
      await jiraClient.post(`/rest/api/2/issue/${jiraIssueKey}/comment`, {
        body: commentBody,
      });
      addedCommentCount++;
      // Log only if any comments are added
      console.log(
        ` - Added comment from ${comment.author.login} to Jira issue ${jiraIssueKey}`
      );
    }

    // Remove any comments that no longer exist in GitHub
    // Ignore - we add comments directly in Jira intentionally
    /*
    for (const [_, comment] of existingComments) {
      await delay();
      await jiraClient.delete(
        `/rest/api/2/issue/${jiraIssueKey}/comment/${comment.id}`
      );
      console.log(
        ` - Removed outdated comment from Jira issue ${jiraIssueKey}`
      );
    }
    */

    if (addedCommentCount > 0) {
      console.log(` - Completed syncing ${addedCommentCount} new comments.`);
    }
  } catch (error) {
    errorCollector.addError(
      `HELPERS: Error syncing comments for Jira issue ${jiraIssueKey}`,
      error
    );
  }
}
