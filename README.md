# PatternFly GitHub to Jira Issue Sync

This Node.js application automatically synchronizes GitHub issues across all PatternFly repositories to a centralized Jira instance. It creates new Jira issues for GitHub issues that don't exist in Jira, updates existing Jira issues when their corresponding GitHub issues are modified, and maintains comprehensive synchronization including comments, child issues, and user assignments.

## Prerequisites

- Node.js (v14 or higher)
- A GitHub Personal Access Token with `repo` scope
- A Jira Personal Access Token (PAT)
- Access to a Jira instance with appropriate permissions
- Access to PatternFly organization repositories on GitHub

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
   GH_TOKEN=your_GH_personal_access_token

   # Jira Configuration
   JIRA_PAT=your_jira_personal_access_token
   ```
   
## Usage

Run the sync with default date (hardcoded fallback is 7 days prior to current date):
```bash
npm run sync
```

Run the sync with a custom date:
```bash
npm run sync --since 2025-01-01T00:00:00Z
```

Or use the convenience script:
```bash
npm run sync:since 01-01-2025
```

**Date Format**: Use ISO 8601 format (YYYY-MM-DDTHH:mm:ssZ) for the `--since` parameter, or use MM-DD-YYYY which will be converted to ISO 8601 format.

The application will automatically process all 27 PatternFly repositories:
1. For each repository, fetch all open GitHub issues updated since the specified date
2. For each GitHub issue:
   - Check if it already exists in Jira (by matching GitHub URL in Jira description)
   - Create a new Jira issue if it doesn't exist
   - Update the existing Jira issue if it does exist
   - Sync all GitHub comments to Jira
   - Handle parent/child issue relationships
   - Keep issue states synchronized between GitHub and Jira

## Features

### Core Synchronization
- **Multi-Repository Processing**: Automatically syncs all 27 PatternFly repositories in a single run
- **State Sync**: Keeps GitHub and Jira issue states synchronized (open/closed)
- **Smart Issue Matching**: Links GitHub issues to Jira issues using GitHub URL references in Jira descriptions
- **Duplicate Prevention**: Detects and handles cases where multiple Jira issues point to the same GitHub issue

### Comment & Content Syncing
- **Complete Comment Sync**: Transfers all GitHub issue comments to corresponding Jira issues
- **Markdown Conversion**: Converts GitHub Markdown to Jira markup format automatically
- **Large Comment Handling**: Automatically truncates oversized comments with reference links
- **Content Updates**: Syncs issue titles, descriptions, labels, and assignees

### Issue Hierarchy Management
- **Parent/Child Relationships**: Handles GitHub sub-issues as Jira child issues or Epic children
- **Epic Support**: Creates Jira Epics for GitHub Epic-type issues with proper Epic linking
- **Sub-task Flagging**: Alerts when issues need to be converted to sub-tasks (requires manual updates in Jira UI due to API limitations)
- **Dynamic Hierarchy Updates**: Maintains parent-child relationships as they change in GitHub

### Team Integration
- **User Mapping**: Maps GitHub usernames to Jira usernames for Platform, Enablement, and Design teams
- **Issue Type Mapping**: Intelligently maps GitHub issue types (Bug, Epic, Task, Feature, etc.) to appropriate Jira issue types
- **Component Assignment**: Automatically assigns Jira components based on repository names
- **Remote Linking**: Creates remote links between GitHub issues and Jira issues

### Reliability & Performance
- **Rate Limiting Protection**: Built-in delays and retry logic to avoid API rate limits
- **Comprehensive Error Handling**: Collects and reports errors with full context for debugging
- **Batch Processing**: Efficiently processes multiple repositories and issues
- **Date Filtering**: Only processes issues updated since a specified date for performance

## Error Handling & Known Limitations

The application includes comprehensive error handling with detailed logging and context. All errors are collected and reported at the end of each repository sync for easy debugging.

### Error Collection System
- **Contextual Error Reporting**: Each error includes the operation context, error message, and API response details
- **Per-Repository Error Summary**: Errors are grouped by repository and displayed at the end of processing
- **Graceful Degradation**: Individual issue failures don't stop the overall sync process

### Known Limitations
- **Epic Hierarchy**: In Jira, Epics cannot be children of other Epics. These require manual attention and updates
- **Sub-task Conversion**: Cannot convert existing Jira issues to sub-tasks via API - must be done manually through Jira UI
- **Issue Migration**: When GitHub issues are moved between repositories, the old Jira issue will error but a new one will be created during the destination repository sync
- **GitHub Initiatives**: GitHub Initiative-type issues are skipped as they don't map well to Jira issue types
- **API Rate Limits**: Built-in delays help prevent rate limiting, but occasional retries may be needed for large syncs

### Troubleshooting
- Check console output for detailed error summaries at the end of each repository sync
- Review Jira permissions if seeing authentication or permission-related errors
- Verify environment variables are correctly set if seeing connection issues
- For GitHub API issues, check token permissions and rate limit status

## Supported PatternFly Repositories

The application automatically syncs issues from all 28 PatternFly repositories:

- AI-infra-ui-components
- chatbot
- design-tokens
- icons
- mission-control-dashboard
- patternfly
- patternfly-a11y
- patternfly-cli
- patternfly-design
- patternfly-design-kit
- patternfly-doc-core
- patternfly-extension-seed
- patternfly-infra-issues
- patternfly-mcp
- patternfly-org
- patternfly-quickstarts
- patternfly-react
- patternfly-react-seed
- pf-codemods
- pf-roadmap
- react-catalog-view
- react-component-groups
- react-console
- react-data-view
- react-log-viewer
- react-topology
- react-user-feedback
- react-virtualized-extension

Each repository is processed as a separate Jira component within the specified Jira project.

## Contributing

Feel free to submit issues and enhancement requests! 
