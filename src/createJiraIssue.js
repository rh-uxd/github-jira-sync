import { buildJiraIssueData, jiraClient, octokit } from './helpers.js';

async function createSubTasks(parentJiraKey, githubIssue) {
  try {
    // Get linked issues from GitHub using the timeline API
    const { data: timeline } = await octokit.issues.listEventsForTimeline({
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
      issue_number: githubIssue.number,
    });

    // Filter for cross-referenced events that indicate sub-issues
    const subIssueEvents = timeline.filter(
      (event) =>
        event.event === 'cross-referenced' &&
        event.source?.issue &&
        event.source.issue.repository_url !== githubIssue.repository_url
    );

    for (const event of subIssueEvents) {
      const subIssue = event.source.issue;

      // Extract repo name from the sub-issue's repository_url
      const repoUrlParts = subIssue.repository_url.split('/');
      const repoOwner = repoUrlParts[repoUrlParts.length - 2];
      const repoName = repoUrlParts[repoUrlParts.length - 1];

      // Create sub-task in Jira
      const subtask = {
        fields: {
          project: {
            key: process.env.JIRA_PROJECT_KEY,
          },
          summary: subIssue.title,
          description: `GH Issue ${subIssue.number}\nGH ID ${
            subIssue.id
          }\nUpstream URL: ${
            subIssue.html_url
          }\nRepo: ${repoOwner}/${repoName}\n\nDescription:\n${
            subIssue.body || ''
          }`,
          issuetype: {
            name: 'Sub-task',
          },
          parent: {
            key: parentJiraKey,
          },
          components: [
            {
              name: repoName,
            },
          ],
        },
      };

      const response = await jiraClient.post('/rest/api/2/issue', subtask);
      console.log(
        `Created sub-task ${response.data.key} for GitHub issue ${repoOwner}/${repoName}#${subIssue.number}`
      );

      // Add remote link to GitHub issue
      await jiraClient.post(
        `/rest/api/2/issue/${response.data.key}/remotelink`,
        {
          globalId: `github-${subIssue.id}`,
          application: {
            type: 'com.github',
            name: 'GitHub',
          },
          relationship: 'relates to',
          object: {
            url: subIssue.html_url,
            title: subIssue.html_url,
          },
        }
      );

      // Recursively handle sub-issues of this sub-issue
      // Use the sub-issue's repo for the next level of recursion
      const originalRepo = process.env.GITHUB_REPO;
      const originalOwner = process.env.GITHUB_OWNER;
      process.env.GITHUB_REPO = repoName;
      process.env.GITHUB_OWNER = repoOwner;
      await createSubTasks(response.data.key, subIssue);
      process.env.GITHUB_REPO = originalRepo;
      process.env.GITHUB_OWNER = originalOwner;
    }
  } catch (error) {
    console.error('Error creating sub-tasks:', error.message, { error });
  }
}

export async function createJiraIssue(githubIssue) {
  try {
    const jiraIssue = buildJiraIssueData(githubIssue);
    const response = await jiraClient.post('/rest/api/2/issue', jiraIssue);
    console.log(
      `Created Jira issue ${response.data.key} for GitHub issue #${githubIssue.number}`
    );

    // Add remote link to GitHub issue
    await jiraClient.post(`/rest/api/2/issue/${response.data.key}/remotelink`, {
      globalId: `github-${githubIssue.id}`,
      application: {
        type: 'com.github',
        name: 'GitHub',
      },
      relationship: 'relates to',
      object: {
        url: githubIssue.html_url,
        title: githubIssue.html_url,
      },
    });

    // Create sub-tasks for any sub-issues
    await createSubTasks(response.data.key, githubIssue);

    return response.data;
  } catch (error) {
    console.error(
      'Error creating Jira issue:',
      error.message,
      error.response.data
    );
  }
}
