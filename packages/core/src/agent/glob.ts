// Pure glob-path matcher and recursive-walk collector shared by every
// AgentHost implementation, so glob_search behaves identically regardless
// of which host executes it. Deliberately minimal dialect: only the
// wildcards this repo's own tooling needs — no brace/bracket expansion.

const SPECIAL_CHARS = new Set([
  ".", "+", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\",
]);

function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      out += ".*";
      i++;
      if (pattern[i + 1] === "/") i++; // "**/foo" also matches "foo" at the root
    } else if (c === "*") {
      out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else if (SPECIAL_CHARS.has(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

// True if `relPath` (workspace-relative, '/'-separated) matches `pattern`.
export function matchGlob(pattern: string, relPath: string): boolean {
  return globToRegExp(pattern).test(relPath);
}

export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

// Generic recursive collector with no I/O of its own — callers adapt it to
// a concrete filesystem API (node:fs vs vscode.workspace.fs) via the
// readDir/toRel/join callbacks.
export async function collectGlobMatches(
  pattern: string,
  startAbs: string,
  readDir: (absDir: string) => Promise<DirEntry[]>,
  toRel: (abs: string) => string,
  join: (a: string, b: string) => string,
  isExcluded: (rel: string) => boolean,
  maxResults: number,
): Promise<string[]> {
  const out: string[] = [];

  async function walk(absDir: string): Promise<void> {
    if (out.length >= maxResults) return;
    let entries: DirEntry[];
    try {
      entries = await readDir(absDir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= maxResults) return;
      const abs = join(absDir, e.name);
      const rel = toRel(abs);
      if (isExcluded(rel)) continue;
      if (e.isDirectory) {
        await walk(abs);
        continue;
      }
      if (matchGlob(pattern, rel)) out.push(rel);
    }
  }

  await walk(startAbs);
  return out;
}
