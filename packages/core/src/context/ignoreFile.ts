// Hand-rolled .gitignore-style pattern parsing/matching for the
// user-editable .xpreiIDEignore file. No dependency, no negation (!), no
// escaping — a documented v1 subset (see
// docs/superpowers/specs/2026-07-26-phase1b-ignore-file-design.md for
// why). Pure module — no vscode, no file I/O; callers read the file
// themselves and pass content in.

// Strips comments and blank lines; every remaining line (trimmed) is a
// pattern.
export function parseIgnorePatterns(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

// Converts one glob-lite pattern into a RegExp. "*" matches any run of
// non-"/" characters (one segment); "**" matches across segments
// (including zero segments). Every other character is escaped literally.
function patternToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "*" && pattern[i + 1] === "*") {
      out += ".*";
      i++; // consume both '*' of "**"
    } else if (pattern[i] === "*") {
      out += "[^/]*";
    } else {
      out += pattern[i].replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

// A pattern containing "/" is anchored to the workspace root and matched
// against the full relative path. A pattern with no "/" matches at any
// depth, checked against each path segment individually — the same
// semantics EXCLUDED_DIRS already uses. A trailing "/" is stripped
// before matching (this module only ever sees file paths, never bare
// directory paths, so file-vs-directory-only patterns collapse to the
// same check).
export function matchesIgnorePattern(rel: string, pattern: string): boolean {
  const clean = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
  if (clean.includes("/")) {
    return patternToRegExp(clean).test(rel);
  }
  const re = patternToRegExp(clean);
  return rel.split("/").some((seg) => re.test(seg));
}

// True if any pattern matches.
export function isIgnoredByPatterns(rel: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesIgnorePattern(rel, p));
}
