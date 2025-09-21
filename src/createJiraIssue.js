import {
  buildJiraIssueData,
  getJiraIssueType,
  getJiraComponent,
  createNewJiraIssue,
  syncCommentsToJira,
  convertMarkdownToJira,
} from './helpers.js';
import { updateChildIssues } from './updateJiraIssue.js';
import { transitionJiraIssue } from './transitionJiraIssue.js';
import { errorCollector } from './index.js';

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
    const jiraIssueType = getJiraIssueType(subIssue.issueType);
    const assignees = subIssue?.assignees?.nodes
      ?.map((a) => a.login)
      .join(', ');
    const childIssue = {
      fields: {
        project: {
          key: process.env.JIRA_PROJECT_KEY,
        },
        summary: subIssue.title,
        description: `${subIssue?.body ? convertMarkdownToJira(subIssue.body) : ''}\n\n----\n\nGH Issue ${
          subIssue.number
        }\nUpstream URL: ${subIssue.url}\nReporter: ${
          subIssue?.author?.login || ''
        }\nAssignees: ${assignees}`,
      },
    };

    if (jiraComponent) {
      // Only pass component if it exists
      childIssue.fields.components = [{ name: jiraComponent }];
    }

    if (isEpic) {
      // Parent epic cannot contain child epic
      if (jiraIssueType.id === 16) {
        console.error(' - !! - Epic child issue cannot be an Epic');
        return;
      }

      // For epic children, keep original issue type and use epic link field
      childIssue.fields.issuetype = {
        id: jiraIssueType.id,
      };
      childIssue.fields['customfield_12311140'] = parentJiraKey;
    } else {
      // For non-epic children, must be sub-tasks
      childIssue.fields.issuetype = {
        id: '5',
      };
      childIssue.fields.parent = {
        key: parentJiraKey,
      };
    }

    // Create new Jira issue & add remote link to GitHub issue
    const newJiraKey = await createNewJiraIssue(childIssue, subIssue);
    // If GH issue is closed, transition Jira issue to closed (cannot create a closed issue)
    if (subIssue.state === 'CLOSED') {
      await transitionJiraIssue(newJiraKey, 'Closed');
    }
    console.log(
      ` - Created child issue ${newJiraKey} for GitHub issue ${repoOwner}/${repoName}#${subIssue.number}`
    );

    // Sync comments for the child issue
    if (subIssue.comments?.totalCount > 0) {
      await syncCommentsToJira(newJiraKey, subIssue.comments);
    }

    return newJiraKey;
  } catch (error) {
    errorCollector.addError(
      `CREATEJIRAISSUE: Error creating child issues for parent ${parentJiraKey}`,
      error
    );
  }
}

export async function createJiraIssue(githubIssue) {
  try {
    const jiraIssue = buildJiraIssueData(githubIssue);
    const newJiraKey = await createNewJiraIssue(jiraIssue, githubIssue);

    // If GH issue is closed, transition Jira issue to closed
    if (githubIssue.state === 'CLOSED') {
      await transitionJiraIssue(newJiraKey, 'Closed');
    }

    // Sync comments for new issue
    if (githubIssue.comments.totalCount > 0) {
      await syncCommentsToJira(newJiraKey, githubIssue.comments);
    }

    // Create child issues for any sub-issues
    if (githubIssue.subIssues.totalCount > 0) {
      const isEpic = jiraIssue.fields.issuetype.id === '16';
      await updateChildIssues(newJiraKey, githubIssue, isEpic);
    }

    console.log(
      `Created Jira issue ${newJiraKey} for GitHub issue #${githubIssue.number}\n`
    );
  } catch (error) {
    errorCollector.addError(
      `CREATEJIRAISSUE: Error creating Jira issue for GitHub issue #${githubIssue.number}`,
      error
    );
  }
}
