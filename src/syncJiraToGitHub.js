import {
  octokit,
  delay,
  jiraToGitHubUserMapping,
  extractUpstreamUrl,
  updateGitHubIssue,
  addGitHubIssueComment,
  createGitHubIssue,
  closeGitHubIssue,
  jiraClient,
  editJiraIssue,
  convertMarkdownToJira,
  availableComponents,
} from './helpers.js';
import { errorCollector } from './index.js';
import j2m from 'jira2md';

// Convert Jira markup to Markdown
const convertJiraToMarkdown = (jiraText) => {
  if (!jiraText) return '';
  // jira2md library converts markdown to jira with to_jira()
  // For reverse conversion, we'll use a simple approach or the library's method
  // Note: jira2md may not have reverse conversion, so we'll do basic conversion
  try {
    // Try camelCase method first
    if (typeof j2m.toMarkdown === 'function') {
      return j2m.toMarkdown(jiraText);
    }
    // Try snake_case method
    if (typeof j2m.to_markdown === 'function') {
      return j2m.to_markdown(jiraText);
    }
  } catch (error) {
    // If conversion fails, return the text as-is (Jira markup is mostly readable)
    console.log(`  - Warning: Could not convert Jira markup to Markdown, using as-is`);
  }
  return jiraText;
};

// Parse GitHub URL to extract owner, repo, and issue number
function parseGitHubUrl(githubUrl) {
  if (!githubUrl) return null;
  const match = githubUrl.match(/https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (!match) return null;
  return {
    owner: match[1],
    repo: match[2],
    issueNumber: parseInt(match[3]),
  };
}

// Sync assignee from Jira to GitHub
export async function syncAssigneeToGitHub(jiraIssue, githubIssue) {
  try {
    if (!jiraIssue.fields.assignee || !jiraIssue.fields.assignee.name) {
      return; // No assignee in Jira
    }

    const jiraAssignee = jiraIssue.fields.assignee.name;
    const githubAssignee = jiraToGitHubUserMapping[jiraAssignee];

    if (!githubAssignee) {
      console.log(
        `  - No GitHub mapping found for Jira assignee ${jiraAssignee}, skipping assignee sync`
      );
      return;
    }

    // Get current GitHub assignees
    const currentAssignees = githubIssue.assignees?.nodes?.map((a) => a.login) || [];
    const isAlreadyAssigned = currentAssignees.includes(githubAssignee);

    if (isAlreadyAssigned) {
      return; // Already assigned, no change needed
    }

    // Remove existing assignees and add the Jira assignee
    if (currentAssignees.length > 0) {
      await octokit.rest.issues.removeAssignees({
        owner: parseGitHubUrl(githubIssue.url).owner,
        repo: parseGitHubUrl(githubIssue.url).repo,
        issue_number: parseGitHubUrl(githubIssue.url).issueNumber,
        assignees: currentAssignees,
      });
    }

    await octokit.rest.issues.addAssignees({
      owner: parseGitHubUrl(githubIssue.url).owner,
      repo: parseGitHubUrl(githubIssue.url).repo,
      issue_number: parseGitHubUrl(githubIssue.url).issueNumber,
      assignees: [githubAssignee],
    });

    console.log(
      `  - Synced assignee ${githubAssignee} from Jira ${jiraIssue.key} to GitHub issue #${githubIssue.number}`
    );
  } catch (error) {
    errorCollector.addError(
      `SYNCJIRATOGITHUB: Error syncing assignee from Jira ${jiraIssue.key} to GitHub`,
      error
    );
  }
}

// Add Jira link to GitHub issue body and comment
export async function addJiraLinkToGitHub(jiraIssueKey, githubIssue) {
  try {
    const jiraLink = `https://issues.redhat.com/browse/${jiraIssueKey}`;
    const jiraLinkMarkdown = `**Jira Issue:** [${jiraIssueKey}](${jiraLink})`;
    const parsed = parseGitHubUrl(githubIssue.url);
    if (!parsed) {
      console.log(`  - Could not parse GitHub URL: ${githubIssue.url}`);
      return;
    }

    const { owner, repo, issueNumber } = parsed;

    // Check if Jira link already exists in body
    const bodyHasLink = githubIssue.body?.includes(jiraIssueKey) || false;

    // Add to body if not present
    if (!bodyHasLink && githubIssue.body) {
      const updatedBody = `${githubIssue.body}\n\n---\n\n${jiraLinkMarkdown}`;
      await updateGitHubIssue(owner, repo, issueNumber, {
        body: updatedBody,
      });
      console.log(`  - Added Jira link ${jiraIssueKey} to GitHub issue #${issueNumber} body`);
    }

    // Check if comment with Jira link already exists
    await delay();
    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
    });

    const hasJiraLinkComment = comments.some(
      (comment) => comment.body.includes(jiraIssueKey) || comment.body.includes(jiraLink)
    );

    // Add comment if not present
    if (!hasJiraLinkComment) {
      await addGitHubIssueComment(owner, repo, issueNumber, jiraLinkMarkdown);
      console.log(`  - Added Jira link ${jiraIssueKey} as comment to GitHub issue #${issueNumber}`);
    }
  } catch (error) {
    errorCollector.addError(
      `SYNCJIRATOGITHUB: Error adding Jira link ${jiraIssueKey} to GitHub issue`,
      error
    );
  }
}

// Close GitHub issues for closed Jira issues
export async function closeGitHubIssuesForClosedJira(closedJiraIssues) {
  try {
    for (const jiraIssue of closedJiraIssues) {
      const githubUrl = extractUpstreamUrl(jiraIssue.fields.description);
      if (!githubUrl) {
        continue; // Skip if no GitHub URL
      }

      const parsed = parseGitHubUrl(githubUrl);
      if (!parsed) {
        console.log(`  - Could not parse GitHub URL from Jira ${jiraIssue.key}: ${githubUrl}`);
        continue;
      }

      const { owner, repo, issueNumber } = parsed;

      try {
        // Get GitHub issue to check if it's already closed
        await delay();
        const { data: ghIssue } = await octokit.rest.issues.get({
          owner,
          repo,
          issue_number: issueNumber,
        });

        if (ghIssue.state === 'closed') {
          console.log(`  - GitHub issue ${owner}/${repo}#${issueNumber} is already closed`);
          continue;
        }

        // Close the issue with a comment marker
        await closeGitHubIssue(owner, repo, issueNumber);
        await addGitHubIssueComment(
          owner,
          repo,
          issueNumber,
          `Closed via Jira sync - Jira issue ${jiraIssue.key} was closed.`
        );
        console.log(
          `  - Closed GitHub issue ${owner}/${repo}#${issueNumber} (Jira ${jiraIssue.key} was closed)`
        );
      } catch (error) {
        if (error.status === 404) {
          console.log(`  - GitHub issue ${owner}/${repo}#${issueNumber} not found, skipping`);
        } else {
          errorCollector.addError(
            `SYNCJIRATOGITHUB: Error closing GitHub issue ${owner}/${repo}#${issueNumber} for Jira ${jiraIssue.key}`,
            error
          );
        }
      }
    }
  } catch (error) {
    errorCollector.addError(
      'SYNCJIRATOGITHUB: Error processing closed Jira issues',
      error
    );
  }
}

// Create GitHub issues for manually created Jira issues
export async function createGitHubIssuesForManualJira(manualJiraIssues) {
  try {
    for (const jiraIssue of manualJiraIssues) {
      try {
        // Extract component from Jira issue to determine target repository
        const jiraComponent = jiraIssue.fields.components?.[0]?.name;
        if (!jiraComponent) {
          console.log(`  - Skipping Jira ${jiraIssue.key}: No component assigned`);
          continue;
        }

        // Find matching repository from availableComponents
        const componentMapping = availableComponents.find(
          (comp) => comp.name === jiraComponent
        );

        if (!componentMapping) {
          console.log(
            `  - Skipping Jira ${jiraIssue.key}: Component "${jiraComponent}" not found in availableComponents`
          );
          continue;
        }

        const owner = componentMapping.owner;
        const repo = componentMapping.name;

        // Extract issue details from Jira
        const title = jiraIssue.fields.summary || 'Untitled Issue';
        const description = jiraIssue.fields.description || '';
        const jiraAssignee = jiraIssue.fields.assignee?.name;
        const githubAssignee = jiraAssignee ? jiraToGitHubUserMapping[jiraAssignee] : null;

        // Convert Jira markup to Markdown
        const markdownDescription = convertJiraToMarkdown(description);

        // Build GitHub issue body with Jira reference
        const githubBody = `${markdownDescription}\n\n---\n\n**Jira Issue:** [${jiraIssue.key}](https://issues.redhat.com/browse/${jiraIssue.key})`;

        // Create GitHub issue
        const issueData = {
          title,
          body: githubBody,
        };

        if (githubAssignee) {
          issueData.assignees = [githubAssignee];
        }

        await delay();
        const createdIssue = await createGitHubIssue(owner, repo, issueData);

        console.log(
          `  - Created GitHub issue ${owner}/${repo}#${createdIssue.number} for Jira ${jiraIssue.key} (component: ${jiraComponent})`
        );

        // Update Jira issue description to include Upstream URL
        const upstreamUrl = createdIssue.html_url;
        const updatedDescription = `${description}\n\n----\n\nGH Issue ${createdIssue.number}\nUpstream URL: ${upstreamUrl}\nReporter: ${jiraIssue.fields.reporter?.displayName || ''}\nAssignees: ${githubAssignee || ''}`;

        await delay();
        await editJiraIssue(jiraIssue.key, {
          fields: {
            description: updatedDescription,
          },
        });

        console.log(`  - Updated Jira ${jiraIssue.key} with Upstream URL: ${upstreamUrl}`);
      } catch (error) {
        errorCollector.addError(
          `SYNCJIRATOGITHUB: Error creating GitHub issue for Jira ${jiraIssue.key}`,
          error
        );
      }
    }
  } catch (error) {
    errorCollector.addError(
      'SYNCJIRATOGITHUB: Error processing manual Jira issues',
      error
    );
  }
}
