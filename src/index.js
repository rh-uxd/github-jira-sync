import 'dotenv/config';
import { jiraClient, getRepoIssues, availableComponents, hasUpstreamUrl } from './helpers.js';
import { findJiraIssue } from './findJiraIssue.js';
import { createJiraIssue } from './createJiraIssue.js';
import { updateJiraIssue } from './updateJiraIssue.js';
import { handleUnprocessedJiraIssues } from './handleUnprocessedJiraIssues.js';
import {
  closeGitHubIssuesForClosedJira,
  createGitHubIssuesForManualJira,
  checkAndHandleArchivedJiraIssue,
} from './syncJiraToGitHub.js';

export let jiraIssues = [];

const isValidISOString = (str) => {
  if (typeof str !== 'string') {
    return false;
  }
  // Matches ISO 8601 format: YYYY-MM-DDTHH:MM:SS with optional milliseconds (.XXX) and timezone (Z or ±HH:MM)
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})?$/i.test(str);
};

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {};
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--since' && i + 1 < args.length) {
      const sinceValue = args[i + 1];

      if (isValidISOString(sinceValue)) {
        options.since = sinceValue;
      } else {
        // Check if the value is in MM-DD-YYYY format
        const mmddPattern = /^(\d{1,2})-(\d{1,2})-(\d{4})$/;
        const match = sinceValue.match(mmddPattern);
        
        if (match) {
          // Convert MM-DD-YYYY to ISO string
          const month = parseInt(match[1]) - 1; // Month is 0-indexed in Date constructor
          const day = parseInt(match[2]);
          const year = parseInt(match[3]);
          const date = new Date(year, month, day);
          options.since = date.toISOString();
        } else {
          // Default fallback: 7 days ago
          console.error(`** ERROR: Invalid date format: ${sinceValue}\nDefaulting to 7 days ago`);
          options.since = (() => {
            const date = new Date();
            date.setDate(date.getDate() - 7);
            return date.toISOString();
          })();
        }
      }
      
      // Skip the next argument since we consumed it
      i++;
    } else if (args[i] === '--direction' && i + 1 < args.length) {
      const directionValue = args[i + 1];
      const validDirections = ['github-to-jira', 'jira-to-github', 'both'];
      
      if (validDirections.includes(directionValue)) {
        options.direction = directionValue;
      } else {
        console.error(
          `** ERROR: Invalid direction: ${directionValue}\nValid values: ${validDirections.join(', ')}\nDefaulting to 'both'`
        );
        options.direction = 'both';
      }
      
      // Skip the next argument since we consumed it
      i++;
    }
  }
  
  // Default direction to 'both' if not provided
  if (!options.direction) {
    options.direction = 'both';
  }
  
  return options;
}

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

    this.errors.forEach(({ context, message, response }) => {
      console.error(`  ${context}: ${message}`);
      if (response) {
        console.error(`  Response: ${JSON.stringify(response)}`);
      }
      console.error('  ==============================================');
    });
  }

  clear() {
    this.errors = [];
  }
}

// Create global error collector instance
export const errorCollector = new ErrorCollector();

const fetchJiraIssues = async (owner, repo, since) => {
  console.log(' - fetching Jira...');
  const response = await jiraClient.get('/rest/api/2/search', {
    params: {
      jql: `project = PF AND component = "${repo}" AND status not in (Closed, Resolved) ORDER BY key ASC`,
      maxResults: 1000,
      fields: 'key,id,description,status,assignee,issuetype,updated,summary,components',
    },
  });
  const jiraIssues = response?.data?.issues || [];
  console.log(`    --> Found ${jiraIssues.length} open Jira issues for Jira component ${ repo }`); 
  return jiraIssues;
};

const fetchClosedJiraIssues = async (owner, repo, since) => {
  console.log(` - fetching closed Jira issues for component ${repo}...`);
  // Format since date for Jira JQL (Jira uses format: YYYY-MM-DD HH:mm)
  const jiraDate = new Date(since).toISOString().replace('T', ' ').substring(0, 16);
  const response = await jiraClient.get('/rest/api/2/search', {
    params: {
      jql: `project = PF AND component = "${repo}" AND status = Closed AND updatedDate >= "${jiraDate}" AND issuetype in (Epic, Story, Task, Bug, Sub-task) ORDER BY key ASC`,
      maxResults: 1000,
      fields: 'key,id,description,status,assignee,issuetype,updated',
    },
  });
  const closedIssues = response?.data?.issues || [];
  // Filter to only issues with Upstream URL
  const closedIssuesWithUpstream = closedIssues.filter((issue) =>
    hasUpstreamUrl(issue.fields.description)
  );
  console.log(`    --> Found ${closedIssuesWithUpstream.length} closed Jira issues with GitHub links for component ${repo} (updated since ${since})`);
  return closedIssuesWithUpstream;
};

const fetchManuallyCreatedJiraIssues = async (owner, repo, since) => {
  console.log(` - fetching manually created Jira issues for component ${repo}...`);
  // Format since date for Jira JQL
  const jiraDate = new Date(since).toISOString().replace('T', ' ').substring(0, 16);
  const response = await jiraClient.get('/rest/api/2/search', {
    params: {
      jql: `project = PF AND component = "${repo}" AND createdDate >= "${jiraDate}" AND issuetype in (Epic, Story, Task, Bug, Sub-task) ORDER BY key ASC`,
      maxResults: 1000,
      fields: 'key,id,summary,description,status,assignee,issuetype,reporter,components,updated',
    },
  });
  const allIssues = response?.data?.issues || [];
  // Filter to only issues without Upstream URL (manually created, not synced from GitHub)
  const manualIssues = allIssues.filter((issue) =>
    !hasUpstreamUrl(issue.fields.description)
  );
  console.log(`    --> Found ${manualIssues.length} manually created Jira issues for component ${repo} (created since ${since}, without Upstream URL)`);
  return manualIssues;
};

const fetchGitHubIssues = async (owner, repo, since) => {
  console.log(' - fetching GitHub...');
  const githubApiResponse = await getRepoIssues(repo, owner, since);
  // Sort by number to ensure consistent order, enables easier debugging
  const githubIssues = githubApiResponse.repository.issues.nodes.sort(
    (a, b) => a.number - b.number
  );

  console.log(`    --> Found ${githubIssues.length} updated GitHub issue${githubIssues.length === 1 ? '' : 's'} in ${ owner }/${ repo }\n`);
  return githubIssues;
};

async function syncIssues(owner, repo, since, direction = 'both') {
  console.log(`\n\n=== START Syncing issues for repo ${ owner }/${ repo } updated since ${since} (direction: ${direction}) ===\n\n`);
  try {
    // Clear any previous errors
    // errorCollector.clear();

    // GitHub → Jira sync
    if (direction === 'github-to-jira' || direction === 'both') {
      console.log(`\n= GitHub → Jira sync: existing GitHub issues updated since ${since} =\n`);
      // Fetch all open Jira issues for the specific repo/component, save to exported variable
      jiraIssues = await fetchJiraIssues(owner, repo, since);

      // Fetch all updated GitHub issues from GraphQL response
      const githubIssues = await fetchGitHubIssues(owner, repo, since);

      // Keep track of which Jira issues we've processed
      const processedJiraIssues = new Set();

      // Process GitHub issues
      for (const [index, issue] of githubIssues.entries()) {
        // Skip if the issue is a pull request (GraphQL doesn't return pull requests) or an Initiative
        if (issue.pull_request || issue?.issueType?.name === 'Initiative') {
          console.log(`(${index + 1}/${githubIssues.length}) Skipping ${issue.pull_request ? 'pull request' : 'Initiative'} #${ issue.number}`);
          continue;
        }

        // Find the corresponding Jira issue
        const jiraIssue = await findJiraIssue(issue.url);

        if (!jiraIssue) {
          // Check if the GitHub issue references an archived Jira issue
          const archivedHandled = await checkAndHandleArchivedJiraIssue(issue);
          if (archivedHandled) {
            // Archived issue was handled (GitHub issue closed), skip creating duplicate
            console.log(`(${index + 1}/${githubIssues.length}) Skipping GitHub issue #${issue.number} - referenced Jira issue is archived`);
            continue;
          }
          // Create new Jira issue
          console.log(`(${index + 1}/${ githubIssues.length }) Creating new Jira issue for GitHub issue #${issue.number}`);
          await createJiraIssue(issue);
        } else {
          // Update existing Jira issue
          console.log(`\n(${index + 1}/${githubIssues.length}) Updating existing Jira issue: ${jiraIssue.key}`);
          await updateJiraIssue(jiraIssue, issue);
          processedJiraIssues.add(jiraIssue.key);
        }
      }

      // Check remaining Jira issues that weren't processed
      // This is to handle cases where Jira issues are not linked to any open GitHub issue
      // Uncomment to process all open Jira issues regardless of GitHub status
      // const unprocessedJiraIssues = jiraIssues.filter(
      //   (issue) => !processedJiraIssues.has(issue.key)
      // );

      // if (unprocessedJiraIssues.length > 0) {
        // await handleUnprocessedJiraIssues(unprocessedJiraIssues, repo);
      // }
    }

    // Jira → GitHub sync
    if (direction === 'jira-to-github' || direction === 'both') {
      // Fetch recently closed Jira issues for this component and close corresponding GitHub issues
      console.log(`\n= Jira → GitHub sync: closed Jira issues since ${since} =\n`);
      const closedJiraIssues = await fetchClosedJiraIssues(owner, repo, since);
      if (closedJiraIssues.length > 0) {
        await closeGitHubIssuesForClosedJira(closedJiraIssues);
      }

      // Fetch manually created Jira issues for this component and create GitHub issues
      console.log(`\n= Jira → GitHub sync: manually created Jira issues since ${since} =\n`);
      const manualJiraIssues = await fetchManuallyCreatedJiraIssues(owner, repo, since);
      if (manualJiraIssues.length > 0) {
        await createGitHubIssuesForManualJira(manualJiraIssues);
      }
    }
  } catch (error) {
    errorCollector.addError('INDEX: Sync process', error);
  } finally {
    if (errorCollector.hasErrors()) {
      // Log any collected errors at the end
      console.log(`\n=== ${repo.toUpperCase()} ERRORS ===\n`);
      errorCollector.logErrors();
      console.log(`\n=== END ${repo.toUpperCase()} ERRORS ===\n`);
      errorCollector.clear();
    }
    console.log(`\n\n=== COMPLETED Syncing issues for repo ${ owner }/${ repo } ===\n\n`);
  }
}

// Parse command line arguments
const options = parseArgs();
const since = options.since || (() => {
  const date = new Date();
  date.setDate(date.getDate() - 7);
  return date.toISOString();
})();
const direction = options.direction || 'both';

console.log(`Syncing issues since: ${since}`);
console.log(`Sync direction: ${direction}`);

// If syncing all, loop through availableComponents
for (const {name, owner} of availableComponents) {
  await syncIssues(owner, name, since, direction);
}
