import 'dotenv/config';
import { jiraClient, getRepoIssues, availableComponents } from './helpers.js';
import { findJiraIssue } from './findJiraIssue.js';
import { createJiraIssue } from './createJiraIssue.js';
import { updateJiraIssue } from './updateJiraIssue.js';
import { handleUnprocessedJiraIssues } from './handleUnprocessedJiraIssues.js';

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
    }
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
      fields: 'key,id,description,status, issuetype',
    },
  });
  const jiraIssues = response?.data?.issues || [];
  console.log(`    --> Found ${jiraIssues.length} open Jira issues for Jira component ${ repo }`); 
  return jiraIssues;
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

async function syncIssues(owner, repo, since) {
  console.log(`\n=== START Syncing issues for repo ${ owner }/${ repo } updated since ${since} ===\n`);
  try {
    // Clear any previous errors
    // errorCollector.clear();

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
        // Create new Jira issue
        console.log(`(${index + 1}/${ githubIssues.length }) Creating new Jira issue for GitHub issue #${issue.number}`);
        await createJiraIssue(issue);
      } else {
        // Update existing Jira issue
        console.log(`(${index + 1}/${githubIssues.length}) Updating existing Jira issue: ${jiraIssue.key}`);
        await updateJiraIssue(jiraIssue, issue);
        processedJiraIssues.add(jiraIssue.key);
      }
    }

    // Check remaining Jira issues that weren't processed
    // This is to handle cases where Jira issues are not linked to any open GitHub issue
    const unprocessedJiraIssues = jiraIssues.filter(
      (issue) => !processedJiraIssues.has(issue.key)
    );

    // Uncomment to process all open Jira issues regardless of GitHub status
    // if (unprocessedJiraIssues.length > 0) {
      // await handleUnprocessedJiraIssues(unprocessedJiraIssues, repo);
    // }
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
  }
}

// Parse command line arguments
const options = parseArgs();
const since = options.since || (() => {
  const date = new Date();
  date.setDate(date.getDate() - 7);
  return date.toISOString();
})();

console.log(`Syncing issues since: ${since}`);

// If syncing all, loop through availableComponents
for (const {name, owner} of availableComponents) {
  await syncIssues(owner, name, since);
}
