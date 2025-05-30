import {
  buildJiraIssueData,
  getJiraIssueType,
  getJiraComponent,
  createNewJiraIssue,
} from './helpers.js';
import { updateChildIssues } from './updateJiraIssue.js';

export async function createChildIssues(
  parentJiraKey,
  subIssue,
  isEpic = false
) {
  try {
    // Each sub-issue is a Jira child issue
    // Extract repo name from the repository object
    const [repoOwner, repoName] = subIssue.repository.nameWithOwner.split('/');
    const jiraComponent = getJiraComponent(repoName);
    const componentsArr = jiraComponent ? [jiraComponent] : null;
    const jiraIssueType = getJiraIssueType(subIssue.issueType).id;

    // Create child issue in Jira
    const childIssue = {
      fields: {
        project: {
          key: process.env.JIRA_PROJECT_KEY,
        },
        summary: subIssue.title,
        description: `GH Issue ${subIssue.number}\nGH ID ${
          subIssue?.id || ''
        }\nUpstream URL: ${
          subIssue.url
        }\nRepo: ${repoOwner}/${repoName}\n\n----\n\n*Description:*\n${
          subIssue?.body || ''
        }`,
        issuetype: {
          name: jiraIssueType,
        },
        parent: {
          key: parentJiraKey,
        },
      },
    };

    if (componentsArr) {
      // Only pass component if it exists
      childIssue.fields.components = componentsArr;
    }

    if (isEpic) {
      // Epic Link custom field is required for epic child issues
      childIssue.fields['customfield_12311140'] = parentJiraKey;
    }

    // Create new Jira issue & add remote link to GitHub issue
    const newJiraKey = await createNewJiraIssue(childIssue, subIssue);
    console.log(
      ` - Created child issue ${newJiraKey} for GitHub issue ${repoOwner}/${repoName}#${subIssue.number}`
    );
    return newJiraKey;
  } catch (error) {
    console.error('Error creating child issues:', error.message, { error });
  }
}

export async function createJiraIssue(githubIssue) {
  try {
    const jiraIssue = buildJiraIssueData(githubIssue);
    const newJiraKey = await createNewJiraIssue(jiraIssue, githubIssue);
    console.log(
      `Created Jira issue ${newJiraKey} for GitHub issue #${githubIssue.number}\n`
    );
    if (githubIssue.subIssues.totalCount > 0) {
      // Create child issues for any sub-issues
      const isEpic = jiraIssue.fields.issuetype.id === 16;
      await updateChildIssues(newJiraKey, githubIssue, isEpic);
    }
  } catch (error) {
    console.error(
      'Error creating Jira issue:',
      error.message,
      error.response.data
    );
  }
}
