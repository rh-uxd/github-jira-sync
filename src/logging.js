// Error collector to store errors with context
class ErrorCollector {
  constructor() {
    this.errors = [];
  }

  addError(context, error) {
    this.errors.push({
      context,
      message: error.message,
      response: error?.response?.data,
      stack: error.stack,
    });
  }

  hasErrors() {
    return this.errors.length > 0;
  }

  logErrors() {
    if (!this.hasErrors()) return;

    this.errors.forEach(({ context, message, response }) => {
      console.error(`  ${context}: ${message}`);
      if (response) {
        console.error(`  Response: ${JSON.stringify(response)}`);
      }
      console.error('  ==============================================');
    });
  }

  clear() {
    this.errors = [];
  }
}

export const errorCollector = new ErrorCollector();

// Sync stats tracker for end-of-run summary
class SyncStats {
  constructor() {
    this.repoStats = new Map();
  }

  _getRepo(repo) {
    if (!this.repoStats.has(repo)) {
      this.repoStats.set(repo, {
        jiraCreated: 0,
        jiraClosed: 0,
        githubCreated: 0,
        githubClosed: 0,
        githubReopened: 0,
        errors: 0,
        warnings: [],
      });
    }
    return this.repoStats.get(repo);
  }

  setCurrentRepo(repo) {
    this.currentRepo = repo;
  }

  track(event, detail) {
    const repo = this.currentRepo;
    if (!repo) return;
    const stats = this._getRepo(repo);
    if (event === 'warnings') {
      stats.warnings.push(detail);
    } else {
      stats[event] = (stats[event] || 0) + 1;
    }
  }

  printSummary() {
    const activeRepos = [...this.repoStats.entries()]
      .filter(([_, s]) => s.jiraCreated + s.jiraClosed + s.githubCreated + s.githubClosed + s.githubReopened + s.errors + s.warnings.length > 0);

    console.log('\n\n=== SYNC SUMMARY ===\n');

    if (activeRepos.length === 0) {
      console.log('No changes made.\n');
      return;
    }

    const cols = [
      { key: 'jiraCreated',    label: 'Jira Created', width: 12 },
      { key: 'jiraClosed',     label: 'Jira Closed',  width: 11 },
      { key: 'githubCreated',  label: 'GH Created',   width: 10 },
      { key: 'githubClosed',   label: 'GH Closed',    width: 9 },
      { key: 'githubReopened', label: 'GH Reopened',  width: 11 },
      { key: 'errors',         label: 'Errors',       width: 6 },
      { key: 'warnings',      label: 'Warnings',     width: 8 },
    ];

    const repoWidth = Math.max(4, ...activeRepos.map(([r]) => r.length));
    const header = 'Repo'.padEnd(repoWidth) + ' | ' + cols.map(c => c.label.padStart(c.width)).join(' | ');
    const separator = '-'.repeat(repoWidth) + '-|-' + cols.map(c => '-'.repeat(c.width)).join('-|-');

    console.log(header);
    console.log(separator);

    const totals = { jiraCreated: 0, jiraClosed: 0, githubCreated: 0, githubClosed: 0, githubReopened: 0, errors: 0, warnings: 0 };
    for (const [repo, stats] of activeRepos) {
      const vals = cols.map(c => {
        const v = c.key === 'warnings' ? stats.warnings.length : stats[c.key];
        if (c.key === 'warnings') totals.warnings += v;
        else totals[c.key] += v;
        return String(v).padStart(c.width);
      });
      console.log(`${repo.padEnd(repoWidth)} | ${vals.join(' | ')}`);
    }

    console.log(separator);
    const totalVals = cols.map(c => String(totals[c.key]).padStart(c.width));
    console.log(`${'Total'.padEnd(repoWidth)} | ${totalVals.join(' | ')}`);

    // Print warning details grouped by repo, then by message type
    const reposWithWarnings = activeRepos.filter(([_, s]) => s.warnings.length > 0);
    if (reposWithWarnings.length > 0) {
      console.log(`\nWarnings:`);
      for (const [repo, stats] of reposWithWarnings) {
        console.log(`\n  ${repo} (${stats.warnings.length}):`);
        // Group warnings by message
        const grouped = new Map();
        for (const w of stats.warnings) {
          if (typeof w === 'object' && w.message) {
            const keys = grouped.get(w.message) || [];
            keys.push(w.key);
            grouped.set(w.message, keys);
          } else {
            // Fallback for plain string warnings
            const keys = grouped.get(String(w)) || [];
            grouped.set(String(w), keys);
          }
        }
        for (const [message, keys] of grouped) {
          console.log(`    ${message}:`);
          if (keys.length > 0 && keys[0]) {
            console.log(`      ${keys.join(', ')}`);
          }
        }
      }
    }

    console.log('');
  }
}

export const syncStats = new SyncStats();
