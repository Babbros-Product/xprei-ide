// Shared index-exclusion rules. Kept in its own vscode-free module so both the
// full-scan glob (rebuild) and the per-path guard (incremental file-watcher
// updates) derive from ONE list — otherwise a save inside e.g. node_modules
// would add chunks a full rebuild never would. Pure module — unit-testable.

export const EXCLUDED_DIRS = [
  "node_modules",
  ".git",
  "dist",
  "out",
  "build",
  ".next",
  ".turbo",
  "coverage",
  "vendor",
  ".venv",
  "__pycache__",
];

// findFiles exclude glob for the full workspace scan.
export const SCAN_EXCLUDE = `**/{${EXCLUDED_DIRS.join(",")}}/**`;

// True if a workspace-relative path lies under an excluded directory.
export function isExcludedPath(rel: string): boolean {
  return rel.split("/").some((seg) => EXCLUDED_DIRS.includes(seg));
}
