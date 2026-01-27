# Implementation Steps Summary

This document summarizes the major enhancements made to the GitHub-Jira sync tool, including bidirectional sync capabilities and timestamp-based conflict resolution.

## Overview

The sync tool was extended from a one-way GitHub → Jira sync to a bidirectional sync system with intelligent conflict resolution based on update timestamps. Jira is treated as the source of truth for planning and assignment, while GitHub remains the primary location for issue creation.

---

## Phase 1: Reverse Sync - Jira to GitHub

### Objective
Add bidirectional sync capabilities to sync data from Jira back to GitHub, enabling Jira to be the source of truth for assignment and planning while maintaining GitHub as the primary issue creation platform.

### Key Features Implemented

#### 1. Assignee Sync from Jira to GitHub
- **Location**: `src/syncJiraToGitHub.js` → `syncAssigneeToGitHub()`
- **Behavior**: Syncs assignees from Jira to GitHub issues
- **Rules**: 
  - Only syncs first assignee (matching existing behavior)
  - Uses reverse user mapping (`jiraToGitHubUserMapping`) to convert Jira usernames to GitHub usernames
  - Skips if assignee is already set correctly in GitHub
  - Prevents syncing assignees from GitHub to Jira if Jira already has an assignee

#### 2. Jira Link Addition to GitHub Issues
- **Location**: `src/syncJiraToGitHub.js` → `addJiraLinkToGitHub()`
- **Behavior**: Adds Jira issue links to GitHub issues in both body and comments
- **Implementation**:
  - Checks if link already exists in GitHub issue body (searches for Jira key pattern)
  - Appends link to body if not present: `**Jira Issue:** [PF-1234](https://issues.redhat.com/browse/PF-1234)`
  - Creates comment with Jira link if comment doesn't already exist
  - Idempotent operation (safe to run multiple times)

#### 3. Auto-Close GitHub Issues When Jira Closes
- **Location**: `src/syncJiraToGitHub.js` → `closeGitHubIssuesForClosedJira()`
- **Behavior**: Closes GitHub issues when their corresponding Jira issues are closed
- **Implementation**:
  - Fetches recently closed Jira issues (within `--since` timeframe)
  - Filters to only issues with Upstream URL (linked GitHub issues)
  - Filters to Epic and below issue types only
  - Filters by component (only processes issues for repos in `availableComponents`)
  - Adds comment marker: "Closed via Jira sync - Jira issue PF-XXX was closed."

#### 4. Create GitHub Issues for Manual Jira Issues
- **Location**: `src/syncJiraToGitHub.js` → `createGitHubIssuesForManualJira()`
- **Behavior**: Creates GitHub issues in the appropriate repository for manually created Jira issues
- **Implementation**:
  - Fetches Jira issues without Upstream URL (manually created)
  - Filters to Epic and below issue types (excludes Outcome and Feature)
  - Filters by component (only processes issues for repos in `availableComponents`)
  - Creates GitHub issue in repository matching the Jira component (not hardcoded to pf-roadmap)
  - Converts Jira markup to Markdown using `jira2md` library
  - Maps Jira assignee to GitHub username
  - **Does NOT sync labels** (labels only flow GitHub → Jira)
  - Updates Jira issue description with Upstream URL after creation

### New Helper Functions (`src/helpers.js`)

- `jiraToGitHubUserMapping` - Reverse user mapping (Jira username → GitHub username)
- `extractUpstreamUrl()` - Parses GitHub URL from Jira description
- `hasUpstreamUrl()` - Checks if Jira issue has GitHub link
- `updateGitHubIssue()` - Wrapper for updating GitHub issues
- `addGitHubIssueComment()` - Wrapper for adding comments to GitHub issues
- `createGitHubIssue()` - Wrapper for creating GitHub issues
- `closeGitHubIssue()` - Wrapper for closing GitHub issues

### Direction Flag Support

- **CLI Flag**: `--direction` with values: `github-to-jira`, `jira-to-github`, `both` (default: `both`)
- **Location**: `src/index.js` → `parseArgs()` and `syncIssues()`
- **Behavior**: Allows running sync in one direction only or both directions
- **Usage**: 
  ```bash
  npm run sync -- --direction github-to-jira
  npm run sync -- --direction jira-to-github
  npm run sync -- --direction both  # default
  ```

### Component-Based Filtering

- All Jira → GitHub sync operations filter by component
- Only processes Jira issues that belong to components in `availableComponents`
- Matches the behavior of GitHub → Jira sync (processes each repo/component individually)

---

## Phase 2: Timestamp-Based Conflict Resolution

### Objective
Prevent circular updates where changes in one system overwrite newer changes in the other by comparing update timestamps and only syncing from the more recently updated source.

### Key Features Implemented

#### 1. Timestamp Comparison Logic
- **Location**: `src/helpers.js` → `compareTimestamps()`
- **Behavior**: Compares GitHub and Jira update timestamps
- **Returns**: `'github'` if GitHub is newer, `'jira'` if Jira is newer or equal
- **Default Behavior**: Jira is source of truth for equal/missing timestamps
- **Threshold**: Treats timestamps within 60 seconds as equal (defaults to Jira)

#### 2. Sync Decision Functions
- **Location**: `src/helpers.js`
- **Functions**:
  - `shouldSyncFromGitHub()` - Returns `true` only if GitHub was updated more recently
  - `shouldSyncFromJira()` - Returns `true` if Jira is newer or equal (Jira is source of truth)

#### 3. GitHub → Jira Sync Protection
- **Location**: `src/updateJiraIssue.js` → `updateJiraIssue()`
- **Behavior**: Checks timestamp before syncing from GitHub to Jira
- **Logic**:
  - If GitHub is newer: Proceeds with sync
  - If Jira is newer: Skips sync, logs reason
  - If equal or within threshold: Skips sync (Jira is source of truth)

#### 4. Jira → GitHub Sync Protection
- **Location**: `src/syncJiraToGitHub.js`
- **Functions Protected**:
  - `syncAssigneeToGitHub()` - Checks timestamp before syncing assignee
  - `closeGitHubIssuesForClosedJira()` - Checks timestamp before closing GitHub issue
- **Logic**:
  - If Jira is newer or equal: Proceeds with sync
  - If GitHub is newer: Skips sync, logs reason

### Timestamp Fields Added

**GitHub:**
- Added `updatedAt` field to GraphQL queries (`GET_ALL_REPO_ISSUES` and `GET_ISSUE_DETAILS`)

**Jira:**
- Added `updated` field to all Jira API calls:
  - `fetchJiraIssues()`
  - `fetchClosedJiraIssues()`
  - `fetchManuallyCreatedJiraIssues()`
  - `findJiraIssue()`
  - `findChildIssues()`

### Source of Truth Rules

- **Equal timestamps**: Jira wins (skip GitHub → Jira, proceed Jira → GitHub)
- **Missing GitHub timestamp**: Jira wins
- **Missing Jira timestamp**: Jira wins
- **Both missing**: Jira wins
- **Within 60 seconds**: Treated as equal, Jira wins

---

## Implementation Details

### Files Created
- `src/syncJiraToGitHub.js` - New module for all Jira → GitHub sync operations

### Files Modified
- `src/helpers.js` - Added helper functions, reverse user mapping, GitHub API wrappers, timestamp comparison functions
- `src/index.js` - Added direction flag parsing, component-filtered Jira fetch functions
- `src/updateJiraIssue.js` - Added timestamp check, assignee sync prevention, reverse sync calls
- `src/findJiraIssue.js` - Added `updated` field to Jira API calls
- `src/createJiraIssue.js` - No changes (uses existing helpers)

### Key Design Decisions

1. **Jira as Source of Truth**: When timestamps are equal or missing, Jira takes precedence
2. **Component-Based Processing**: All syncs filter by component to match GitHub → Jira behavior
3. **No Label Sync from Jira**: Labels only flow GitHub → Jira (one-way)
4. **Issue Type Filtering**: Only Epic and below types sync from Jira to GitHub (excludes Outcome and Feature)
5. **Assignee Protection**: Prevents overwriting Jira assignees with GitHub assignees
6. **Idempotent Operations**: Link addition and comment creation are safe to run multiple times

### Edge Cases Handled

- Missing timestamps (defaults to Jira)
- Equal timestamps (defaults to Jira)
- Concurrent updates within 60 seconds (treated as equal, defaults to Jira)
- Missing user mappings (gracefully skipped with log message)
- Non-existent GitHub issues (404 errors handled)
- Issues without components (skipped with log message)
- Components not in availableComponents list (skipped with log message)

### Logging & Visibility

- Clear log messages when sync is skipped due to timestamp comparison
- Includes timestamp information in skip messages for debugging
- Logs component information when creating GitHub issues
- Logs when assignee sync is skipped due to missing mappings

---

## Usage Examples

### Run bidirectional sync (default)
```bash
npm run sync
```

### Run only GitHub → Jira sync
```bash
npm run sync -- --direction github-to-jira
```

### Run only Jira → GitHub sync
```bash
npm run sync -- --direction jira-to-github
```

### Run sync with custom date
```bash
npm run sync -- --since 2025-01-01T00:00:00Z --direction both
```

---

## Testing Recommendations

1. **Timestamp Comparison**:
   - Test with issues where GitHub is newer
   - Test with issues where Jira is newer
   - Test with equal timestamps
   - Test with missing timestamps

2. **Direction Flag**:
   - Test all three direction values
   - Verify correct behavior with `--since` flag

3. **Component Filtering**:
   - Verify only issues from availableComponents are processed
   - Test with issues from components not in the list

4. **Issue Creation**:
   - Test creating GitHub issues for manual Jira issues
   - Verify correct repository selection based on component
   - Verify Upstream URL is added to Jira after creation

5. **Issue Closure**:
   - Test closing GitHub issues when Jira closes
   - Verify comment marker is added
   - Verify timestamp checks prevent overwriting newer GitHub data

---

## Notes

- The sync tool now supports full bidirectional synchronization with intelligent conflict resolution
- Jira is treated as the authoritative source for planning and assignment
- GitHub remains the primary location for issue creation
- All sync operations respect component boundaries and issue type filters
- Timestamp comparison prevents circular updates and data loss
