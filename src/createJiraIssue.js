import { buildJiraIssueData, jiraClient, getJiraComponent } from './helpers.js';
import { updateSubTasks } from './updateJiraIssue.js';

export async function createSubTasks(parentJiraKey, subIssue) {
  try {
    // Each sub-issue is a Jira sub-task
    // Extract repo name from the repository object
    const [repoOwner, repoName] = subIssue.repository.nameWithOwner.split('/');

    // Create sub-task in Jira
    const subtask = {
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
          name: 'Story',
        },
        parent: {
          key: parentJiraKey,
        },
        components: [
          {
            name: getJiraComponent(repoName),
          },
        ],
      },
    };

    const response = await jiraClient.post('/rest/api/2/issue', subtask);
    console.log(
      `Created sub-task ${response.data.key} for GitHub issue ${repoOwner}/${repoName}#${subIssue.number}`
    );
    // Add remote link to GitHub issue
    await jiraClient.post(`/rest/api/2/issue/${response.data.key}/remotelink`, {
      globalId: `github-${subIssue.id}`,
      application: {
        type: 'com.github',
        name: 'GitHub',
      },
      relationship: 'clones',
      object: {
        url: subIssue.url,
        title: subIssue.url,
      },
    });
    return response.data.key;
  } catch (error) {
    console.error('Error creating sub-tasks:', error.message, { error });
  }
}

export async function createJiraIssue(githubIssue, jiraIssues) {
  try {
    // Create the new issue
    const jiraIssue = buildJiraIssueData(githubIssue);
    const response = await jiraClient.post('/rest/api/2/issue', jiraIssue);
    console.log(
      `Created Jira issue ${response.data.key} for GitHub issue #${githubIssue.number}`
    );

    // Add remote link back to original GitHub issue
    await jiraClient.post(`/rest/api/2/issue/${response.data.key}/remotelink`, {
      globalId: `github-${githubIssue.id}`,
      application: {
        type: 'com.github',
        name: 'GitHub',
      },
      relationship: 'clones',
      object: {
        url: githubIssue.url,
        title: githubIssue.url,
      },
    });
    if (githubIssue.subIssues.totalCount > 0) {
      // Create "incorporates" remotelinks for any sub-issues
      await updateSubTasks(response.data.key, githubIssue, jiraIssues);
    }

    return response.data;
  } catch (error) {
    console.error(
      'Error creating Jira issue:',
      error.message,
      error.response.data
    );
  }
}
