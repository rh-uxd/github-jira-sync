import { getRepoPRsSince, getIssuePRLinks, editJiraIssue, buildPrUrlsADF, delay } from './helpers.js';
import { findJiraIssue } from './findJiraIssue.js';
import { errorCollector, syncStats } from './logging.js';

function parseIssueUrl(url) {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], issueNumber: parseInt(match[3], 10) };
}

// Sync PR links to Jira for issues referenced by recently-updated PRs.
// Runs in addition to the main issue sync to catch cases where GitHub issues
// are not marked as updated when a PR is linked.
export async function syncPRLinksToJira(owner, repo, since) {
  try {
    const issueUrls = await getRepoPRsSince(owner, repo, since);
    if (issueUrls.length === 0) return;

    console.log(` - Found ${issueUrls.length} GitHub issue${issueUrls.length === 1 ? '' : 's'} with recently-updated PR links`);

    for (const issueUrl of issueUrls) {
      const parsed = parseIssueUrl(issueUrl);
      if (!parsed) continue;

      const prUrls = await getIssuePRLinks(parsed.owner, parsed.repo, parsed.issueNumber);
      if (prUrls.length === 0) continue;

      const jiraIssue = await findJiraIssue(issueUrl);
      if (!jiraIssue) continue;

      await delay();
      await editJiraIssue(jiraIssue.key, {
        fields: { customfield_10875: buildPrUrlsADF(prUrls) },
      });
      console.log(` - Updated PR link${prUrls.length === 1 ? '' : 's'} on ${jiraIssue.key}: ${prUrls.join(', ')}`);
      syncStats.track('jiraUpdated');
    }
  } catch (error) {
    errorCollector.addError(`SYNCPRLINKSTOJIRA: Error syncing PR links for ${owner}/${repo}`, error);
  }
}
