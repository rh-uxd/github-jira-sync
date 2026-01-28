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

// Reverse user mapping: Jira username -> GitHub username
// Create inverse mapping for syncing assignees from Jira back to GitHub
export const jiraToGitHubUserMapping = {};
for (const [githubUser, jiraUser] of Object.entries(userMappings)) {
  // Only add mapping if Jira user doesn't already exist (to handle duplicates)
  if (!jiraToGitHubUserMapping[jiraUser]) {
    jiraToGitHubUserMapping[jiraUser] = githubUser;
  }
}
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
  {
    name: 'AI-infra-ui-components',
    owner: 'patternfly',
  },
  {
    name: 'chatbot',
    owner: 'patternfly',
  },
  {
    name: 'design-tokens',
    owner: 'patternfly',
  },
  {
    name: 'icons',
    owner: 'patternfly',
  },
  {
    name: 'mission-control-dashboard',
    owner: 'patternfly',
  },
  {
    name: 'patternfly',
    owner: 'patternfly',
  },
  {
    name: 'patternfly-a11y',
    owner: 'patternfly',
  },
  {
    name: 'patternfly-cli',
    owner: 'patternfly',
  },
  {
    name: 'patternfly-design',
    owner: 'patternfly',
  },
  {
    name: 'patternfly-design-kit',
    owner: 'patternfly',
  },
  {
    name: 'patternfly-doc-core',
    owner: 'patternfly',
  },
  {
    name: 'patternfly-extension-seed',
    owner: 'patternfly',
  },
  {
    name: 'patternfly-infra-issues',
    owner: 'patternfly',
  },
  {
    name: 'patternfly-mcp',
    owner: 'patternfly',
  },
  {
    name: 'patternfly-org',
    owner: 'patternfly',
  },
  {
    name: 'patternfly-quickstarts',
    owner: 'patternfly',
  },
  {
    name: 'patternfly-react',
    owner: 'patternfly',
  },
  {
    name: 'patternfly-react-seed',
    owner: 'patternfly',
  },
  {
    name: 'pf-codemods',
    owner: 'patternfly',
  },
  {
    name: 'pf-roadmap',
    owner: 'patternfly',
  },
  {
    name: 'react-catalog-view',
    owner: 'patternfly',
  },
  {
    name: 'react-component-groups',
    owner: 'patternfly',
  },
  {
    name: 'react-console',
    owner: 'patternfly',
  },
  {
    name: 'react-data-view',
    owner: 'patternfly',
  },
  {
    name: 'react-log-viewer',
    owner: 'patternfly',
  },
  {
    name: 'react-topology',
    owner: 'patternfly',
  },
  {
    name: 'react-user-feedback',
    owner: 'patternfly',
  },
  {
    name: 'react-virtualized-extension',
    owner: 'patternfly',
  },
  {
    name: 'github-jira-sync',
    owner: 'rh-uxd'
  }
];

export const getJiraComponent = (repoName) =>
  availableComponents.some((component) => component.name === repoName)
    ? repoName
    : null;

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
          updatedAt
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
        updatedAt
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

export async function getRepoIssues(repo, ghOwner = 'patternfly', since) {
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
        throw new Error('Invalid response structure from GitHub API');
      }

      const { nodes, pageInfo } = response.repository.issues;

      // Handle empty repository or no matching issues
      if (!nodes || nodes.length === 0) {
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

// Extract GitHub URL from Jira description
export function extractUpstreamUrl(jiraDescription) {
  const match = jiraDescription?.match(/Upstream URL: (.*?)(?:\n|$)/);
  return match ? match[1].trim() : null;
}

// Check if Jira issue has GitHub link
export function hasUpstreamUrl(jiraDescription) {
  return extractUpstreamUrl(jiraDescription) !== null;
}

// Extract Jira key (PF-XXXX format) from text
export function extractJiraKeyFromText(text) {
  if (!text || typeof text !== 'string') {
    return null;
  }
  // Match PF- followed by one or more digits
  const match = text.match(/PF-\d+/);
  return match ? match[0] : null;
}

// Fetch a specific Jira issue by key (works even if archived)
export async function fetchJiraIssueByKey(issueKey) {
  try {
    await delay();
    const response = await jiraClient.get(`/rest/api/2/issue/${issueKey}`, {
      params: {
        fields: 'key,id,description,status,assignee,issuetype,updated,summary,components,archiveddate',
      },
    });
    return response.data;
  } catch (error) {
    // Handle 404 (issue doesn't exist) gracefully
    if (error.response?.status === 404) {
      return null;
    }
    // Handle 403 (permission denied) gracefully
    if (error.response?.status === 403) {
      errorCollector.addError(
        `HELPERS: Permission denied accessing Jira issue ${issueKey}`,
        error
      );
      return null;
    }
    // For other errors, log and return null
    errorCollector.addError(
      `HELPERS: Error fetching Jira issue ${issueKey}`,
      error
    );
    return null;
  }
}

// Compare timestamps and return which is newer ('github' or 'jira')
// Defaults to 'jira' for equal timestamps or missing data (Jira is source of truth)
export function compareTimestamps(githubUpdatedAt, jiraUpdated) {
  // If both are missing, default to Jira
  if (!githubUpdatedAt && !jiraUpdated) {
    return 'jira';
  }

  // If GitHub timestamp is missing, default to Jira
  if (!githubUpdatedAt) {
    return 'jira';
  }

  // If Jira timestamp is missing, default to Jira (Jira is source of truth)
  if (!jiraUpdated) {
    return 'jira';
  }

  try {
    // Parse timestamps to Date objects
    const githubDate = new Date(githubUpdatedAt);
    const jiraDate = new Date(jiraUpdated);

    // Check if dates are valid
    if (isNaN(githubDate.getTime()) || isNaN(jiraDate.getTime())) {
      return 'jira'; // Default to Jira if parsing fails
    }

    // Compare dates
    const diffMs = githubDate.getTime() - jiraDate.getTime();
    const diffSeconds = Math.abs(diffMs) / 1000;

    // If difference is less than threshold (60 seconds), treat as equal and default to Jira
    if (diffSeconds < 60) {
      return 'jira';
    }

    // Return which is newer
    return diffMs > 0 ? 'github' : 'jira';
  } catch (error) {
    // On any error, default to Jira
    return 'jira';
  }
}

// Determine if GitHub → Jira sync should proceed
// Returns true only if GitHub issue was updated more recently than Jira issue
export function shouldSyncFromGitHub(githubIssue, jiraIssue) {
  const githubUpdatedAt = githubIssue.updatedAt;
  const jiraUpdated = jiraIssue?.fields?.updated;

  const source = compareTimestamps(githubUpdatedAt, jiraUpdated);
  return source === 'github';
}

// Determine if Jira → GitHub sync should proceed
// Returns true if Jira is newer or equal (Jira is source of truth)
export function shouldSyncFromJira(githubIssue, jiraIssue) {
  const githubUpdatedAt = githubIssue?.updatedAt;
  const jiraUpdated = jiraIssue?.fields?.updated;

  const source = compareTimestamps(githubUpdatedAt, jiraUpdated);
  // Returns true for 'jira' (newer or equal) or if comparison defaults to Jira
  return source === 'jira';
}

// GitHub API wrapper functions
export async function updateGitHubIssue(owner, repo, issueNumber, updates) {
  await delay();
  try {
    const response = await octokit.rest.issues.update({
      owner,
      repo,
      issue_number: issueNumber,
      ...updates,
    });
    return response.data;
  } catch (error) {
    errorCollector.addError(
      `HELPERS: Error updating GitHub issue ${owner}/${repo}#${issueNumber}`,
      error
    );
    throw error;
  }
}

export async function addGitHubIssueComment(owner, repo, issueNumber, body) {
  await delay();
  try {
    const response = await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });
    return response.data;
  } catch (error) {
    errorCollector.addError(
      `HELPERS: Error adding comment to GitHub issue ${owner}/${repo}#${issueNumber}`,
      error
    );
    throw error;
  }
}

export async function createGitHubIssue(owner, repo, issueData) {
  await delay();
  try {
    const response = await octokit.rest.issues.create({
      owner,
      repo,
      ...issueData,
    });
    return response.data;
  } catch (error) {
    // Provide more helpful error message for permission issues
    if (error.status === 403) {
      const errorMsg = `HELPERS: Permission denied creating GitHub issue in ${owner}/${repo}. ` +
        `Ensure your GitHub token has 'repo' scope and write access to the repository. ` +
        `Error: ${error.message}`;
      errorCollector.addError(errorMsg, error);
    } else {
      errorCollector.addError(
        `HELPERS: Error creating GitHub issue in ${owner}/${repo}`,
        error
      );
    }
    throw error;
  }
}

export async function closeGitHubIssue(owner, repo, issueNumber) {
  await delay();
  try {
    const response = await octokit.rest.issues.update({
      owner,
      repo,
      issue_number: issueNumber,
      state: 'closed',
    });
    return response.data;
  } catch (error) {
    errorCollector.addError(
      `HELPERS: Error closing GitHub issue ${owner}/${repo}#${issueNumber}`,
      error
    );
    throw error;
  }
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
        `\n----\n\n${convertMarkdownToJira(comment.body)}\n\n----\n\n` +
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

