// Shared index-exclusion rules. Kept in its own vscode-free module so both the
// full-scan glob (rebuild) and the per-path guard (incremental file-watcher
// updates) derive from ONE list — otherwise a save inside e.g. node_modules
// would add chunks a full rebuild never would. Pure module — unit-testable.

import { isIgnoredByPatterns } from "./ignoreFile";

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

// True if a workspace-relative path lies under an excluded directory, OR
// matches one of the caller-supplied extraPatterns (from a parsed
// .xpreiIDEignore file). extraPatterns defaults to [] so every existing
// call site keeps compiling and behaving identically.
export function isExcludedPath(rel: string, extraPatterns: string[] = []): boolean {
  if (rel.split("/").some((seg) => EXCLUDED_DIRS.includes(seg))) return true;
  return extraPatterns.length > 0 ? isIgnoredByPatterns(rel, extraPatterns) : false;
}
