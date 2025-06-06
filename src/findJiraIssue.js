import { jiraClient, delay } from './helpers.js';
import { jiraIssues } from './index.js';

const isUpstreamUrlMatch = (jiraDescription, ghIssueLink) => {
  const ghIssueNumber = ghIssueLink.split('/').pop();
  // Regex pattern to match the exact issue number with no trailing numbers
  // Prevents substring matching - ex: 39 matching 391
  const regexPattern = `Upstream URL: https:\/\/github\.com\/patternfly\/patternfly-quickstarts\/issues\/${ghIssueNumber}(?![0-9])(?:$|\r?\n)`;
  // Create a RegExp object from the dynamically constructed string
  const regex = new RegExp(regexPattern);

  // Test the regex against the input string
  return regex.test(jiraDescription);
};

export async function findJiraIssue(githubIssueLink) {
  // First check if the issue is already in jiraIssues from index.js
  const jiraIssue = jiraIssues.find((issue) =>
    isUpstreamUrlMatch(issue.fields.description, githubIssueLink)
  );
  if (jiraIssue) {
    return jiraIssue;
  }

  // If not, fetch the issue from Jira
  return await fetchJiraIssue(githubIssueLink);
}

const fetchJiraIssue = async (githubIssueLink) => {
  // Note: Jira API requires escaped quotes in JQL query for exact match
  // https://support.atlassian.com/jira-software-cloud/docs/search-for-issues-using-the-text-field/#Exact-searches--phrases-
  const jql = `project = ${process.env.JIRA_PROJECT_KEY} AND description ~ "\\"Upstream URL: ${githubIssueLink}\\""`;
  try {
    await delay();
    const response = await jiraClient.get('/rest/api/2/search', {
      params: {
        jql,
      },
    });
    // Check against regex to filter out any substring matches
    let foundIssues =
      response.data.issues.filter((issue) =>
        isUpstreamUrlMatch(issue.fields.description, githubIssueLink)
      ) || null;
    let foundIssue = null;

    if (!foundIssues) {
      // No Jira match found
      console.log('No Jira issue found for GitHub issue:', githubIssueLink);
      return null;
    } else if (foundIssues.length > 1) {
      // Multiple Jira matches found
      console.log(
        ' - Multiple issues found for GitHub issue:',
        githubIssueLink
      );
      foundIssues.forEach((issue) => {
        console.log(`  ! - ${issue.key}`);
      });
      // Compare issue keys, update the lowest number issue - ex: PF-680 not PF-1907
      foundIssue = foundIssues.sort(
        (a, b) => a.key.split('-')[1] - b.key.split('-')[1]
      )[0];
      console.log(` - Updating existing issue ${foundIssue.key}`);
    } else {
      // One Jira match found
      foundIssue = foundIssues[0];
    }

    return foundIssue;
  } catch (error) {
    console.error(
      'Error finding Jira issue:',
      error.message,
      error.response.data
    );
    return null;
  }
};
