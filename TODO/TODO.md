# TODO

- Check [sync2jira](https://github.com/release-engineering/Sync2Jira/tree/main/sync2jira) code for what's pulled from GH & how it's mapped to Jira
- Duplicate below for PRs in addition to issues

- [ ] Grab more data from Github
  - [x] title for Jira title
  - [x] html_url from Github for link
  - [x] user.login for issue creator
  - [x] labels for Github labels
  - [x] state for Github state
    - [x] Close Jira when GH issue closed
    - [x] Update issue on Github reopen?
  - [x] assignee for Github assignee (or assignees array?)
  - [ ] milestone for Github milestone
  - [x] created_at for date (n/a)
  - [x] type for Github type
  - [ ] sub_issues_summary for Epics?
  - [x] body for Github issue text (confirm)
- [x] Add component to map to in Jira
- [ ] Update findJiraIssue to search by component && github linked issue, assuming this exists for all current tickets
  - Can we use this for one call instead of multiple instances?
- [x] Add a way to link the Jira issue to the GitHub issue still moving forward
  - Make this a linked issue in Jira?  Yes.
- [ ] Pull assignee from Github, map to Jira assignees
- [x] Does update know what has changed?
  - YES - and only updates if something has changed.  Pass same data from issue creation. 
- [ ] Figure out webhook or use Github Actions?

jiraIssue:
- fields.issuetype.name = "Bug"
  - Set to github.type
- fields.issuetype.subtask
  - Use for child issues?
- fields.labels
  - Array to use for labels
- issueLinks:
  - Array to link Github issues?
- assignee
  - Set assignee from Github or leave null
- components:
  - array with id (can we see these in Jira for existing components?) & name set to Github repo name
- description
  - Copy Github body here
- summary
  - ?  has "[patternfly/patternfly-infra-issues] 6.2.0 patch release"
- creator
  - Set to original Github user.login or set to sync tool? May need to match Jira user.  See creator.name, .key, and .emailAddress
- subtasks
  - empty array, how does this overlap with issuetype.field.subtask?
- reportor
  - Same as creator, unless we want one to be GH issue creator and one to be synctool?
- aggregaterogress
- progress


Document:
- Jira issue types: https://issues.redhat.com/plugins/servlet/project-config/PF/issuetypes
- Github types: https://github.com/organizations/patternfly/settings/issue-types

- Jira issue API: https://developer.atlassian.com/cloud/jira/platform/jira-expressions-type-reference/#user
- Github issue API: https://docs.github.com/en/rest/issues/issues?apiVersion=2022-11-28#get-an-issue


## Working:
- Issue creation & updating
  - summary
  - description
    - upstream ID,
    - URL
    - assignees
    - description
  - labels: ['GitHub', ...jiraLabels],
  - components
    - mapped to PF repo source
  - close issues
    - and reopen issues

## Working with note:
  - issuetype: see custom mapping from GH types to Jira types
  - assignee: see custom mapping
  - reporter: tied to auth for API call, so always me right now but could create PF login

## TODO:
  - sub issues - possible to get sub issues from Github & pass to Jira
  - comments - pull updated comments from Github into Jira
    - Insert into description or as Jira comments? 
  - map custom fields
    - milestone
    - map all PF assignees between GH & Jira usernames
  - pass repo/component into function to easily run against different repos
    - pass array of repos/components to loop through
    - create CLI interface to select repo/component to execute against

## WISH LIST:
  - Split out functionality for open/closed issues separately in case we want to run this to "right up" issues?



## sub-issues (createSubTasks)
1. Will code only find sub-issues within the same repo, or can it find all sub-issues for a given issue regardless of the repo?
2. Is getting the github issues by label `parent:${githubIssue.number}` correct using linked parent issues or does that rely on manual labelling?
3. Is component correct for sub-issue?  Looks like it references the parent issue's GITHUB_REPO

## sub-issues (updateSubTasks)
1. Update existingSubTaskMap to match by Upstream URL or GH ID rather than GH Issue number - needed for pre-existing Jira issues not yet updated with GH info
2. Get sub-issues from Github again points to specific repo of parent issue, doesn't look for children issues from another repo?
3. Create sub-task in Jira assigns current PF repo as component, should read from repo sub-issue belongs to
4. Forget the above
5. On createIssue there are no links
   1. check for subIssuesfrom GH
   2. Find or create new issues for each subissue - make sure not to update description if issue already exists and 
   3. create remotelinks "incorporates" for each subIssue in parent issue
   4. create remotelinks "incorporated by" (?) for parent issue in each subissue
6. On updateIssue there could be links
   1. check "issuelinks" array for existing remotelinks - https://developer.atlassian.com/cloud/jira/platform/rest/v2/api-group-issue-remote-links/#api-rest-api-2-issue-issueidorkey-remotelink-get
   2. if issuelink.url doesn't exist for subIssue, add link
