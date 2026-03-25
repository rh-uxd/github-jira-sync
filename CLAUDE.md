# CLAUDE.md

## Project overview

GitHub ↔ Jira bi-directional sync tool for PatternFly repositories. Syncs issues, comments, statuses, and child issues between GitHub (GraphQL API) and Jira Cloud (REST API v3 with ADF format).

## Commands

- `npm test` — run all tests (adf-conversion + sync-edge-cases)
- `node src/index.js` — run the sync

## Test files

- `tests/adf-conversion.test.mjs` — Markdown ↔ ADF conversion tests (uses `buildRunner` pattern to extract private functions)
- `tests/sync-edge-cases.test.mjs` — sync logic tests (uses direct imports for exported functions, source reading for internal patterns)

## Rules

### Bug fixes and error handling must include tests

Every time a change is made to fix a bug, handle an error, or address an edge case, a corresponding test case **must** be added. This is not optional. The test should:

1. Reproduce the scenario that caused the bug (e.g., oversized input, missing field, malformed data)
2. Verify the fix produces the correct behavior
3. Be added to the appropriate test file based on what's being tested:
   - ADF/markdown conversion issues → `tests/adf-conversion.test.mjs`
   - Sync logic, field mapping, guard conditions → `tests/sync-edge-cases.test.mjs`

If the user doesn't explicitly ask for tests, add them anyway and mention what was added.
