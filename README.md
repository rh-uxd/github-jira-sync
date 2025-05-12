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
3. Copy `.env.example` to `.env` and fill in your configuration:
   ```bash
   cp .env.example .env
   ```

4. Edit the `.env` file with your credentials:
   ```
   # GitHub Configuration
   GITHUB_TOKEN=your_github_personal_access_token
   GITHUB_OWNER=your_github_username_or_org
   GITHUB_REPO=your_repository_name

   # Jira Configuration
   JIRA_URL=https://your-domain.atlassian.net
   JIRA_EMAIL=your-email@example.com
   JIRA_API_TOKEN=your_jira_api_token
   JIRA_PROJECT_KEY=PROJ
   ```

## Usage

Run the sync:
```bash
node src/index.js
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

## Contributing

Feel free to submit issues and enhancement requests! 
