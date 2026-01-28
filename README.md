# PatternFly GitHub ↔ Jira Issue Sync

This Node.js application automatically synchronizes issues between GitHub and Jira in both directions. It keeps GitHub issues and Jira issues in sync across all PatternFly repositories, ensuring that changes in either system are reflected in the other. The sync handles issue creation, updates, comments, assignments, and status changes while respecting which system was updated most recently.

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
   
## How Sync Works

The sync tool operates in **two directions** with **timestamp-based conflict resolution** to ensure the most recently updated system takes priority:

### Sync Direction & Priority

**GitHub → Jira Sync** (Primary direction):
- Creates new Jira issues for GitHub issues that don't exist in Jira
- Syncs issue titles, descriptions, labels, and comments from GitHub to Jira
- Updates issue status (open/closed) based on GitHub state
- **Note**: Assignees are only synced from GitHub to Jira if the Jira issue doesn't already have an assignee

**Jira → GitHub Sync** (Reverse direction):
- Syncs assignees from Jira to GitHub (when Jira was updated more recently)
- Syncs issue titles from Jira to GitHub (when Jira was updated more recently)
- Adds Jira issue links to GitHub issue descriptions and comments
- Closes GitHub issues when their corresponding Jira issues are closed

### Conflict Resolution

The sync uses a **"last updated wins"** strategy:
- If GitHub was updated more recently → GitHub changes sync to Jira
- If Jira was updated more recently → Jira changes sync to GitHub
- If timestamps are equal or missing → Jira is treated as the source of truth

This ensures that manual updates in either system are preserved and synced correctly.

### Sync Order

For each repository, the sync processes in this order:
1. **GitHub → Jira**: All GitHub issues updated since the specified date
2. **Jira → GitHub**: 
   - Recently closed Jira issues (to close corresponding GitHub issues)
   - Manually created Jira issues (to create corresponding GitHub issues)

## Usage

Run the sync with default date (hardcoded fallback is 7 days prior to current date):
```bash
npm run sync
```

Run the sync with a custom date:
```bash
npm run sync --since 2025-01-01T00:00:00Z
```

Run sync in a specific direction:
```bash
npm run sync --direction github-to-jira    # Only sync GitHub → Jira
npm run sync --direction jira-to-github    # Only sync Jira → GitHub
npm run sync --direction both              # Sync both directions (default)
```

Or use the convenience script:
```bash
npm run sync:since 01-01-2025
```

**Date Format**: Use ISO 8601 format (YYYY-MM-DDTHH:mm:ssZ) for the `--since` parameter, or use MM-DD-YYYY which will be converted to ISO 8601 format.

**Direction Options**: `github-to-jira`, `jira-to-github`, or `both` (default)

## Features

### Core Synchronization
- **Bidirectional Sync**: Automatically syncs changes in both GitHub → Jira and Jira → GitHub directions
- **Multi-Repository Processing**: Automatically syncs all 27 PatternFly repositories in a single run
- **Timestamp-Based Conflict Resolution**: Uses "last updated wins" strategy to prevent overwriting recent changes
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
- **Assignee Sync**: Bidirectional assignee syncing (respects existing assignees to prevent overwrites)
- **Issue Type Mapping**: Intelligently maps GitHub issue types (Bug, Epic, Task, Feature, etc.) to appropriate Jira issue types
- **Component Assignment**: Automatically assigns Jira components based on repository names
- **Remote Linking**: Creates remote links between GitHub issues and Jira issues
- **Manual Jira Issue Creation**: Automatically creates GitHub issues for manually created Jira issues (Epic, Story, Task, Bug, Sub-task only)

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
