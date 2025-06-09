# GitHub to Jira Issue Sync

This Node.js application synchronizes GitHub issues to a Jira instance. It creates new Jira issues for GitHub issues that don't exist in Jira and updates existing Jira issues when their corresponding GitHub issues are modified.

## Prerequisites

- Node.js (v14 or higher)
- A GitHub Personal Access Token with `repo` scope
- A Jira API Token
- Access to a Jira instance

## Setup

1. Clone this repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create a `.env` file at the root to hold your credentials:
   ```bash
   touch .env
   ```

4. Edit the `.env` file with your credentials:
   ```
   # GitHub Configuration
   GITHUB_TOKEN=your_github_personal_access_token
   GITHUB_OWNER=patternfly
   GITHUB_REPO=your_repository_name   // ex: patternfly-react

   # Jira Configuration
   JIRA_URL=https://issues.redhat.com/
   JIRA_PAT=your_jira_personal_accesss_token
   JIRA_PROJECT_KEY=PF
   ```

## Usage

Run the sync:
```bash
npm run sync
```

The application will:
1. Fetch all open GitHub issues from the specified repository
2. For each GitHub issue:
   - Check if it already exists in Jira
   - Create a new Jira issue if it doesn't exist
   - Update the existing Jira issue if it does exist

## Features

- Automatic issue creation in Jira from GitHub issues
- Updates existing Jira issues when GitHub issues are modified
- Maintains reference to original GitHub issue number
- Error handling and logging

## Error Handling

The application includes basic error handling and will log any issues that occur during the sync process. Check the console output for any error messages.
Known errors:
- In Jira, epics cannot be children of other epics.  These require individual attention and manual updates accordingly.
- Cannot change existing Jira issue to be a sub-task through the API, this must be done manually through the UI (case where a GH issue is a child of another GH issue, not epic).
- Error will be logged if original GitHub issue that a Jira is linked to has been moved to another repo.  A new Jira should be created for that new GitHub issue when that repo syncs, so the Jira throwing the error can be closed out as a duplicate.

## Contributing

Feel free to submit issues and enhancement requests! 
