import { jiraClient } from './helpers.js';

export async function transitionJiraIssue(jiraIssueKey, targetState) {
  try {
    // First, get available transitions for the issue
    const { data: transitions } = await jiraClient.get(
      `/rest/api/2/issue/${jiraIssueKey}/transitions`
    );

    // Find the appropriate transition based on target state
    const transition = transitions.transitions.find(
      (t) => t.name.toLowerCase() === targetState.toLowerCase()
    );

    if (transition) {
      await jiraClient.post(`/rest/api/2/issue/${jiraIssueKey}/transitions`, {
        transition: {
          id: transition.id,
        },
      });
      console.log(
        ` - Transitioned Jira issue ${jiraIssueKey} to ${transition.name}`
      );
    } else {
      console.log(
        `No suitable transition found for issue ${jiraIssueKey} to state ${targetState}`
      );
    }
  } catch (error) {
    console.error(
      'Error transitioning Jira issue:',
      error.message,
      error.response?.data
    );
  }
}
