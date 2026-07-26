// Glob-scoped project rules: tiny frontmatter parser + applicability
// check for .xpreiIDE/rules/*.md files. Glob grammar is the same
// documented glob-lite subset .xpreiIDEignore uses (one grammar
// everywhere). Pure module — no vscode, no file I/O.

import { matchesIgnorePattern } from "./ignoreFile";

export interface RuleFile {
  globs?: string[];
  body: string;
}

// Frontmatter: a leading "---" line, lines until the next "---". Only a
// "globs:" line (comma-separated patterns) is recognized; other keys
// are ignored. No frontmatter — or an unterminated fence — means the
// whole content is the body and the rule always applies.
export function parseRuleFile(content: string): RuleFile {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { body: content };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return { body: content };
  let globs: string[] | undefined;
  for (const line of lines.slice(1, end)) {
    const m = line.match(/^globs:\s*(.+)$/i);
    if (m) {
      globs = m[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return { globs, body: lines.slice(end + 1).join("\n") };
}

// No globs → global rule, always applies. Globs but no active file →
// nothing to match against, doesn't apply. Otherwise any-glob-matches.
export function ruleApplies(globs: string[] | undefined, activePath: string | undefined): boolean {
  if (!globs || globs.length === 0) return true;
  if (!activePath) return false;
  return globs.some((g) => matchesIgnorePattern(activePath, g));
}
