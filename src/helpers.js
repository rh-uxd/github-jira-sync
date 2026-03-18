import { Octokit } from '@octokit/rest';
import axios from 'axios';
import { errorCollector } from './index.js';
import j2m from 'jira2md';

// Initialize Octokit with GraphQL support
// @deprecated Use getOctokitForOwner() instead for multi-org support
export const octokit = new Octokit({
  auth: process.env.GH_TOKEN,
  baseUrl: 'https://api.github.com',
});

// Cache for Octokit instances by owner
const octokitInstances = new Map();

/**
 * Get an Octokit instance for the specified owner
 * @param {string} owner - Repository owner (e.g., 'patternfly', 'rh-uxd')
 * @returns {Octokit} Cached Octokit instance with appropriate token
 */
export function getOctokitForOwner(owner) {
  // Return cached instance if available
  if (octokitInstances.has(owner)) {
    return octokitInstances.get(owner);
  }

  // Determine which token to use based on owner
  let token;
  if (owner === 'rh-uxd') {
    token = process.env.GH_JIRA_SYNC_RHUXD_PAT;
  } else {
    // Default to patternfly token for 'patternfly' and any other owners
    token = process.env.GH_TOKEN;
  }

  if (!token) {
    throw new Error(`Missing GitHub token for owner: ${owner}`);
  }

  // Create and cache new instance
  const instance = new Octokit({
    auth: token,
    baseUrl: 'https://api.github.com',
  });

  octokitInstances.set(owner, instance);
  return instance;
}

// Jira Cloud REST API uses Basic auth: base64(email:api_token).
// See https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/
const jiraEmail = process.env.JIRA_EMAIL;
const jiraApiToken = process.env.JIRA_API_TOKEN || process.env.JIRA_PAT;
const jiraAuthHeader =
  jiraEmail && jiraApiToken
    ? `Basic ${Buffer.from(`${jiraEmail}:${jiraApiToken}`, 'utf8').toString('base64')}`
    : null;

export const jiraClient = axios.create({
  baseURL: 'https://redhat.atlassian.net/',
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(jiraAuthHeader && { Authorization: jiraAuthHeader }),
  },
});

export async function addRemoteLinkToJiraIssue(jiraIssueKey, githubIssue) {
  await delay();
  // Add remote link to GitHub issue
  await jiraClient.post(`/rest/api/3/issue/${jiraIssueKey}/remotelink`, {
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
    .post('/rest/api/3/issue', jiraIssueData)
    .then(
      async (response) =>
        await addRemoteLinkToJiraIssue(response.data.key, githubIssue)
    );
  return jiraKey;
}

export async function editJiraIssue(jiraIssueKey, jiraIssueData) {
  await delay();
  await jiraClient.put(`/rest/api/3/issue/${jiraIssueKey}`, jiraIssueData);
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
  nicolethoen: '5a7c82614b03dd57b01a7d1f',
  dlabaj: '70121:0257d5a7-ed2a-4a93-8770-519ea6531bd9',
  rebeccaalpert: '5b198d32daa2e712a6d35d9d',
  mcoker: '712020:d39a5f00-3a18-4e95-99bc-8ec6d7dec132',
  'wise-king-sullyman': '712020:5e90db8d-7d0b-4a09-a599-e81aa8b9ff00',
  thatblindgeye: '712020:6f63713c-d61e-49de-8f52-be48015241ed',
  kmcfaul: '712020:b46e5c4b-c4b6-4c9c-a998-7811631e4f8',
  srambach: '557058:a502f956-47d6-4de9-85b0-75424d4014d0'
};

const enablementTeamUsers = {
  mattnolting: '5cbf54a2ca2840100ac3a486',
  jpuzz0: '712020:d7d2b2c2-1d08-433b-a378-02e40cfc6a20',
  'jeff-phillips-18': '557058:959d113b-8eaa-40c5-b6ca-1e8cad1fbaf1',
  jschuler: '712020:37bed675-6d4b-4aaa-a77d-9499a16186a0',
  evwilkin: '70121:79440ca3-fdff-4e44-801e-068960525c94',
  cdcabrera: '557058:9090aaf5-5518-4b42-9c75-5c697f0e160f',
  dlabrecq: '557058:5a005fc4-4d65-4827-aab6-2951dd0e1ea2',
  'jenny-s51': '712020:69f7f253-8749-4041-aa24-3d0cf0d3ac4f',
  mfrances17: '70121:27f6ac3e-11da-496d-bb66-69e2295a4dae',
  gitdallas: '712020:054edcb5-ddde-4a0c-8538-fe08fce094fb',
  tlabaj: '712020:3ec38cb1-dbfe-40c9-933a-d390460d4b05',
};

const designTeamUsers = {
  'andrew-ronaldson': '6307af17663a6ba49bd7a934',
  lboehling: '70121:58c6e8a7-41e0-4d11-bc6c-a043327eae90',
  kaylachumley: '712020:826e077b-27bf-4cec-abbd-33404f07359c',
  edonehoo: '628677200dae78006808ea80',
  'bekah-stephens': '5defd0548998970e5b43364a',
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
    id: '10016',
  },
  Epic: {
    jiraName: 'Epic',
    id: '10000',
  },
  Task: {
    jiraName: 'Task',
    id: '10014',
  },
  Feature: {
    jiraName: 'Story',
    id: '10009',
  },
  DevX: {
    jiraName: 'Task',
    id: '10014',
  },
  Documentation: {
    jiraName: 'Story',
    id: '10009',
  },
  Demo: {
    jiraName: 'Story',
    id: '10009',
  },
  'Tech debt': {
    jiraName: 'Task',
    id: '10014',
  },
  Initiative: {
    jiraName: 'Feature',
    id: '10142',
  },
  SubTask: {
    jiraName: 'Sub-task',
    id: '10015',
  },
  default: {
    jiraName: 'Story',
    id: '10009',
  },
};

export const getJiraIssueType = (ghIssueType) =>
  issueTypeMappings[ghIssueType?.name] || issueTypeMappings.default;

export const availableComponents = [
  /*{
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
  },*/
  {
    name: 'icons',
    owner: 'patternfly',
  },/*
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
    name: 'patternfly-ai-coding',
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
  },
  {
    name: 'jira-weekly-report',
    owner: 'rh-uxd'
  }*/
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
  // Jira v3 expects assignee as { accountId: "..." }, not { name: "..." }
  const jiraIssue = {
    fields: {
      summary: title,
      description: buildDescriptionADF(body, {
        number,
        url,
        reporter: author?.login || '',
        assignees: assigneeLogins.join(', '),
      }),
      labels: ['GitHub', ...jiraLabels],
      ...(jiraAssignee && { assignee: { accountId: jiraAssignee } }),
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
export async function executeGraphQLQuery(query, variables, owner = null) {
  try {
    // Extract owner from variables if not provided directly
    const ownerToUse = owner || variables?.owner || 'patternfly';
    const octokitInstance = getOctokitForOwner(ownerToUse);
    const response = await octokitInstance.graphql(query, variables);
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
        body
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
      }, ghOwner);

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

// Extract plain text from Jira Cloud v3 Atlassian Document Format (ADF)
// In v3, fields.description is an ADF object instead of a plain string
export function extractTextFromADF(adf) {
  if (!adf) return '';
  if (typeof adf === 'string') return adf;
  if (adf.type === 'text') return adf.text || '';
  if (adf.content) {
    return adf.content.map(extractTextFromADF).join('');
  }
  return '';
}

// Extract GitHub URL from Jira description
export function extractUpstreamUrl(jiraDescription) {
  const text = extractTextFromADF(jiraDescription);
  const match = text.match(/Upstream URL: (.*?)(?:\n|$)/);
  return match ? match[1].trim() : null;
}

// Check if Jira issue has GitHub link
export function hasUpstreamUrl(jiraDescription) {
  return extractUpstreamUrl(jiraDescription) !== null;
}

// Convert ADF inline content (text, marks, hardBreak, status) to Markdown string
function adfInlineToMarkdown(content) {
  if (!content || !Array.isArray(content)) return '';
  return content
    .map((node) => {
      if (!node) return '';
      if (node.type === 'text') {
        let text = node.text ?? '';
        const marks = node.marks || [];
        for (const mark of marks) {
          if (mark.type === 'strong') text = `**${text}**`;
          else if (mark.type === 'em') text = `*${text}*`;
          else if (mark.type === 'code') text = `\`${text}\``;
          else if (mark.type === 'link' && mark.attrs?.href) text = `[${text}](${mark.attrs.href})`;
          else if (mark.type === 'strike') text = `~~${text}~~`;
        }
        return text;
      }
      if (node.type === 'hardBreak') return '\n';
      if (node.type === 'paragraph' && node.content) return adfInlineToMarkdown(node.content);
      // Jira inline status (e.g. checkbox / status pill) -> GitHub task checkbox
      if (node.type === 'status') {
        const t = (node.attrs?.text || '').toLowerCase();
        return t === 'done' || t === 'complete' ? '[x] ' : '[ ] ';
      }
      return '';
    })
    .join('');
}

// Normalize ADF node type for matching (Jira may use camelCase or snake_case)
function adfNodeType(node) {
  const t = node && node.type;
  return t ? String(t).replace(/_/g, '').toLowerCase() : '';
}

// Jira taskItem can have content as paragraph(s) or inline nodes (text) directly
function taskItemContentToMarkdown(content) {
  if (!content || !Array.isArray(content) || content.length === 0) return null;
  const first = content[0];
  if (first.type === 'paragraph' && first.content) {
    return adfInlineToMarkdown(first.content);
  }
  return adfInlineToMarkdown(content);
}

// Convert ADF block(s) to Markdown (used for list items and doc content)
function adfBlocksToMarkdown(blocks, options = {}) {
  if (!blocks || !Array.isArray(blocks)) return '';
  const { orderedIndex } = options;
  let ord = orderedIndex != null ? orderedIndex : 1;
  const out = [];
  for (const node of blocks) {
    if (!node) continue;
    const nType = adfNodeType(node);
    switch (nType) {
      case 'paragraph': {
        const line = adfInlineToMarkdown(node.content || []);
        if (orderedIndex != null) {
          out.push(`${ord}. ${line}`);
          ord++;
        } else {
          out.push(line);
        }
        break;
      }
      case 'heading': {
        const level = node.attrs?.level ?? 1;
        const line = adfInlineToMarkdown(node.content || []);
        out.push(`${'#'.repeat(level)} ${line}`);
        break;
      }
      case 'rule':
        out.push('---');
        break;
      case 'codeblock': {
        const lang = node.attrs?.language ?? '';
        const text = adfInlineToMarkdown(node.content || []);
        out.push('```' + (lang ? lang + '\n' : '\n') + text + '\n```');
        break;
      }
      case 'bulletlist': {
        const items = node.content || [];
        for (const item of items) {
          const itemContent = item.content || [];
          const itemType = adfNodeType(item);
          const isTaskItem = itemType === 'blocktaskitem' || itemType === 'taskitem' || item.attrs?.state != null;
          if (isTaskItem) {
            const state = item.attrs?.state ?? 'TODO';
            const checked = state === 'DONE' ? 'x' : ' ';
            for (const block of itemContent) {
              if (block.type === 'paragraph') {
                const line = adfInlineToMarkdown(block.content || []);
                out.push(`- [${checked}] ${line}`);
              }
            }
          } else if (itemType === 'listitem') {
            for (const block of itemContent) {
              if (block.type === 'paragraph') {
                const line = adfInlineToMarkdown(block.content || []);
                out.push('- ' + line);
              } else {
                out.push(adfBlocksToMarkdown([block], {}));
              }
            }
          }
        }
        break;
      }
      case 'orderedlist': {
        const items = node.content || [];
        for (const item of items) {
          if (adfNodeType(item) !== 'listitem') continue;
          const itemContent = item.content || [];
          for (const block of itemContent) {
            if (block.type === 'paragraph') {
              out.push(`${ord}. ` + adfInlineToMarkdown(block.content || []));
              ord++;
            } else {
              out.push(adfBlocksToMarkdown([block], {}));
            }
          }
        }
        break;
      }
      case 'listitem': {
        const itemContent = node.content || [];
        for (const block of itemContent) {
          if (block.type === 'paragraph') {
            const line = adfInlineToMarkdown(block.content || []);
            out.push(orderedIndex != null ? `${ord++}. ${line}` : `- ${line}`);
          }
        }
        break;
      }
      case 'blocktaskitem':
      case 'taskitem': {
        const state = node.attrs?.state ?? 'TODO';
        const checked = state === 'DONE' ? 'x' : ' ';
        const itemContent = node.content || [];
        const line = taskItemContentToMarkdown(itemContent);
        if (line !== null) out.push(`- [${checked}] ${line}`);
        break;
      }
      case 'tasklist': {
        const items = node.content || [];
        for (const item of items) {
          const it = adfNodeType(item);
          if (it === 'blocktaskitem' || it === 'taskitem') {
            const state = item.attrs?.state ?? 'TODO';
            const checked = state === 'DONE' ? 'x' : ' ';
            const itemContent = item.content || [];
            const line = taskItemContentToMarkdown(itemContent);
            if (line !== null) out.push(`- [${checked}] ${line}`);
          } else if (item.content) {
            out.push(adfBlocksToMarkdown([item], {}));
          }
        }
        break;
      }
      case 'panel':
        if (node.content) out.push(adfBlocksToMarkdown(node.content, orderedIndex != null ? { orderedIndex: ord } : {}));
        break;
      case 'blockquote': {
        const inner = adfBlocksToMarkdown(node.content || [], {});
        out.push(inner.split('\n').map((l) => '> ' + l).join('\n'));
        break;
      }
      default:
        if (node.content) {
          out.push(adfBlocksToMarkdown(node.content, orderedIndex != null ? { orderedIndex: ord } : {}));
        }
        break;
    }
  }
  return out.join('\n\n');
}

// Whether a block is the metadata footer (rule or paragraph containing sync metadata we strip)
function isMetadataBlock(node) {
  if (node.type === 'rule') return true;
  if (node.type === 'paragraph' && node.content) {
    const text = adfInlineToMarkdown(node.content);
    return (
      /Upstream URL:|GH Issue \d+/i.test(text) ||
      /Jira Issue:/i.test(text) // strip any "Jira Issue:" paragraph (bold/link etc.) so we don't duplicate when syncing back to GitHub
    );
  }
  return false;
}

// Convert Jira Cloud v3 ADF description to GitHub Markdown (preserves bold, italic, lists, links)
export function adfToMarkdown(adf, options = {}) {
  const { stripMetadata = true } = options;
  if (!adf) return '';
  if (typeof adf === 'string') return adf;
  if (adf.type !== 'doc' || !Array.isArray(adf.content)) {
    return extractTextFromADF(adf);
  }
  let content = adf.content;
  if (stripMetadata) {
    let cut = content.length;
    for (let i = content.length - 1; i >= 0; i--) {
      if (isMetadataBlock(content[i])) {
        cut = i;
      } else {
        break;
      }
    }
    content = content.slice(0, cut);
  }
  return adfBlocksToMarkdown(content).replace(/\n{3,}/g, '\n\n').trim();
}

// --- ADF Write Helpers ---

// Parse inline Markdown text into ADF inline content nodes
function parseMarkdownInline(text) {
  const nodes = [];
  const pattern = /(\*\*(.+?)\*\*)|(\*(.+?)\*)|(_(.+?)_)|(`(.+?)`)|(\[([^\]]+)\]\(([^)]+)\))/g;
  let lastIndex = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push({ type: 'text', text: text.slice(lastIndex, match.index) });
    }
    if (match[1]) { // **bold**
      nodes.push({ type: 'text', text: match[2], marks: [{ type: 'strong' }] });
    } else if (match[3]) { // *italic*
      nodes.push({ type: 'text', text: match[4], marks: [{ type: 'em' }] });
    } else if (match[5]) { // _italic_
      nodes.push({ type: 'text', text: match[6], marks: [{ type: 'em' }] });
    } else if (match[7]) { // `code`
      nodes.push({ type: 'text', text: match[8], marks: [{ type: 'code' }] });
    } else if (match[9]) { // [text](url)
      nodes.push({ type: 'text', text: match[10], marks: [{ type: 'link', attrs: { href: match[11] } }] });
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) {
    nodes.push({ type: 'text', text: text.slice(lastIndex) });
  }
  return nodes.length ? nodes : [{ type: 'text', text: '' }];
}

// Convert Markdown text to an array of ADF block nodes
function markdownToADFBlocks(markdown) {
  if (!markdown) return [];
  const blocks = [];
  const lines = markdown.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Heading: # text
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        attrs: { level: headingMatch[1].length },
        content: parseMarkdownInline(headingMatch[2]),
      });
      i++;
      continue;
    }

    // Horizontal rule: ---, ***, ___
    if (line.match(/^(\s*[-*_]){3,}\s*$/)) {
      blocks.push({ type: 'rule' });
      i++;
      continue;
    }

    // Fenced code block: ```
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push({
        type: 'codeBlock',
        attrs: lang ? { language: lang } : {},
        content: [{ type: 'text', text: codeLines.join('\n') }],
      });
      i++; // skip closing ```
      continue;
    }

    // Task list: - [ ] or - [x] / - [X] (GitHub action items → Jira taskList/taskItem)
    // Jira accepts taskList when taskItem has attrs.localId (empty or any value) and taskList has attrs.localId
    const taskItemMatch = line.match(/^[-*] \[([ xX])\]\s+(.*)$/);
    if (taskItemMatch) {
      const items = [];
      let idx = 0;
      while (i < lines.length) {
        const m = lines[i].match(/^[-*] \[([ xX])\]\s+(.*)$/);
        if (!m) break;
        const state = m[1].toLowerCase() === 'x' ? 'DONE' : 'TODO';
        const text = m[2];
        const inlineContent = parseMarkdownInline(text);
        items.push({
          type: 'taskItem',
          attrs: { localId: String(idx), state },
          content: inlineContent.length ? inlineContent : [{ type: 'text', text: '' }],
        });
        idx++;
        i++;
      }
      blocks.push({
        type: 'taskList',
        attrs: { localId: '' },
        content: items,
      });
      continue;
    }

    // Bullet list: - item or * item (must come after task list so we don't treat - [ ] as bullet)
    if (line.match(/^[-*] /)) {
      const items = [];
      while (i < lines.length && lines[i].match(/^[-*] /)) {
        items.push({
          type: 'listItem',
          content: [{ type: 'paragraph', content: parseMarkdownInline(lines[i].replace(/^[-*] /, '')) }],
        });
        i++;
      }
      blocks.push({ type: 'bulletList', content: items });
      continue;
    }

    // Ordered list: 1. item
    if (line.match(/^\d+\. /)) {
      const items = [];
      while (i < lines.length && lines[i].match(/^\d+\. /)) {
        items.push({
          type: 'listItem',
          content: [{ type: 'paragraph', content: parseMarkdownInline(lines[i].replace(/^\d+\. /, '')) }],
        });
        i++;
      }
      blocks.push({ type: 'orderedList', content: items });
      continue;
    }

    // Blockquote: > text (GitHub markdown; becomes ADF blockquote so Jira renders as quote)
    if (line.match(/^>\s?/)) {
      const quoteLines = [];
      while (i < lines.length && lines[i].match(/^>\s?/)) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      const content = [];
      quoteLines.forEach((qLine, idx) => {
        content.push(...parseMarkdownInline(qLine));
        if (idx < quoteLines.length - 1) {
          content.push({ type: 'hardBreak' });
        }
      });
      blocks.push({
        type: 'blockquote',
        content: [{ type: 'paragraph', content: content.length ? content : [{ type: 'text', text: '' }] }],
      });
      continue;
    }

    // Blank line: skip
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Regular paragraph: collect consecutive content lines
    const paraLines = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].match(/^#{1,6}\s/) &&
      !lines[i].match(/^(\s*[-*_]){3,}\s*$/) &&
      !lines[i].startsWith('```') &&
      !lines[i].match(/^[-*] /) &&
      !lines[i].match(/^\d+\. /) &&
      !lines[i].match(/^>\s?/)
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      const content = [];
      paraLines.forEach((pLine, idx) => {
        content.push(...parseMarkdownInline(pLine));
        if (idx < paraLines.length - 1) {
          content.push({ type: 'hardBreak' });
        }
      });
      blocks.push({ type: 'paragraph', content });
    }
  }
  return blocks;
}

// Build a full ADF comment body with metadata header/footer.
// Pass { truncated: true } to replace the body with a size-limit notice.
// All text/href must be strings or Jira returns "Operation value must be a string"
function buildCommentADF(comment, { truncated = false } = {}) {
  const urlStr = comment.url != null ? String(comment.url) : '';
  const authorStr = comment.author?.login != null ? String(comment.author.login) : '';
  const createdAtStr = comment.createdAt != null ? String(comment.createdAt) : '';
  const middleContent = truncated
    ? [{
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Comment was truncated due to size. Full comment available at: ' },
          { type: 'text', text: urlStr, marks: [{ type: 'link', attrs: { href: urlStr } }] },
        ],
      }]
    : markdownToADFBlocks(comment.body || '');
  return {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: `Comment Author: ${authorStr}` }],
      },
      { type: 'rule' },
      ...middleContent,
      { type: 'rule' },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: `Comment Created: ${createdAtStr}\nComment URL: ` },
          { type: 'text', text: urlStr, marks: [{ type: 'link', attrs: { href: urlStr } }] },
        ],
      },
    ],
  };
}

// Build the metadata footer paragraph as ADF nodes
// All text/href values must be strings or Jira returns "Operation value must be a string"
function buildMetadataNodes({ number, url, reporter, assignees }) {
  const urlStr = url != null ? String(url) : '';
  const numberStr = number != null ? String(number) : '';
  const reporterStr = reporter != null ? String(reporter) : '';
  const assigneesStr = assignees != null ? String(assignees) : '';
  return {
    type: 'paragraph',
    content: [
      { type: 'text', text: `GH Issue ${numberStr}\nUpstream URL: ` },
      { type: 'text', text: urlStr, marks: [{ type: 'link', attrs: { href: urlStr } }] },
      { type: 'text', text: `\nReporter: ${reporterStr}\nAssignees: ${assigneesStr}` },
    ],
  };
}

// Build a full ADF description from a GitHub Markdown body + metadata footer
export function buildDescriptionADF(markdownBody, { number, url, reporter, assignees }) {
  const content = markdownToADFBlocks(markdownBody);
  content.push({ type: 'rule' });
  content.push(buildMetadataNodes({ number, url, reporter, assignees }));
  return { type: 'doc', version: 1, content };
}

// Append metadata footer to an existing ADF description (preserves original content/formatting)
export function appendMetadataToADF(existingADF, { number, url, reporter, assignees }) {
  const existingContent = existingADF?.content || [];
  return {
    type: 'doc',
    version: 1,
    content: [
      ...existingContent,
      { type: 'rule' },
      buildMetadataNodes({ number, url, reporter, assignees }),
    ],
  };
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
    const response = await jiraClient.get(`/rest/api/3/issue/${issueKey}`, {
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
    const octokitInstance = getOctokitForOwner(owner);
    const response = await octokitInstance.rest.issues.update({
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
    const octokitInstance = getOctokitForOwner(owner);
    const response = await octokitInstance.rest.issues.createComment({
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
    const octokitInstance = getOctokitForOwner(owner);
    const response = await octokitInstance.rest.issues.create({
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
    const octokitInstance = getOctokitForOwner(owner);
    const response = await octokitInstance.rest.issues.update({
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
      `/rest/api/3/issue/${jiraIssueKey}/comment`
    );

    // Create a map of existing comments by their GitHub URL
    // comment.body is ADF in v3, so extract plain text before matching
    const existingComments = new Map(
      jiraComments.comments
        .map((comment) => {
          const bodyText = extractTextFromADF(comment.body);
          // Match either "Comment URL: " or "Full comment available at: " plus the comment link (for truncated comments)
          const githubUrlMatch =
            bodyText.match(/Comment URL: (.*)/) ||
            bodyText.match(/Full comment available at: (.*)/);
          return githubUrlMatch ? [githubUrlMatch[1].trim(), comment] : null;
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

      // Build ADF comment body with GitHub metadata header/footer
      let commentBody = buildCommentADF(comment);

      // Check if comment is too large (Jira has a limit of ~32KB)
      // Ex: https://github.com/patternfly/patternfly-doc-core/issues/52#issuecomment-2922965458
      if (JSON.stringify(commentBody).length > 30000) {
        console.log(
          ` - Comment from ${comment.author.login} is too large. Truncating...`
        );
        commentBody = buildCommentADF(comment, { truncated: true });
      }
      // Add the comment to Jira
      await delay();
      await jiraClient.post(`/rest/api/3/issue/${jiraIssueKey}/comment`, {
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

