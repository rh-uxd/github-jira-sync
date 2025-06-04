import {
  buildJiraIssueData,
  getJiraIssueType,
  getJiraComponent,
  createNewJiraIssue,
  syncCommentsToJira,
  delay,
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
          id: jiraIssueType,
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
    } else {
      // If parent is not an epic, child can only be a sub-task
      childIssue.fields.issuetype = {
        id: 5,
      };
    }

    // Create new Jira issue & add remote link to GitHub issue
    const newJiraKey = await createNewJiraIssue(childIssue, subIssue);
    console.log(
      ` - Created child issue ${newJiraKey} for GitHub issue ${repoOwner}/${repoName}#${subIssue.number}`
    );

    // Sync comments for the child issue
    if (subIssue.comments?.totalCount > 0) {
      console.log(
        ` - Found ${subIssue.comments.totalCount} total comments for child issue ${newJiraKey}...`
      );
      await syncCommentsToJira(newJiraKey, subIssue.comments);
    }

    return newJiraKey;
  } catch (error) {
    console.error('Error creating child issues:', error.message, { error });
  }
}

export async function createJiraIssue(githubIssue) {
  try {
    const jiraIssue = buildJiraIssueData(githubIssue);
    await delay(1000);
    const newJiraKey = await createNewJiraIssue(jiraIssue, githubIssue);

    // Sync comments for new issue
    if (githubIssue.comments.totalCount > 0) {
      console.log(
        ` - Found ${githubIssue.comments.totalCount} total comments for new issue ${newJiraKey}...`
      );
      await delay(1000);
      await syncCommentsToJira(newJiraKey, githubIssue.comments);
    }

    // Create child issues for any sub-issues
    if (githubIssue.subIssues.totalCount > 0) {
      const isEpic = jiraIssue.fields.issuetype.id === 16;
      await updateChildIssues(newJiraKey, githubIssue, isEpic);
    }

    console.log(
      `Created Jira issue ${newJiraKey} for GitHub issue #${githubIssue.number}\n`
    );
  } catch (error) {
    console.error(
      'Error creating Jira issue:',
      error.message,
      error.response.data
    );
  }
}
