// Regex-based, per-language top-level symbol extraction. No AST, no
// dependency, no cross-file reference graph or ranking — a deliberately
// simplified v1 (see docs/superpowers/specs/2026-07-26-phase4e-repomap-provider-design.md
// for why). Pure module — no vscode.

export interface FileSymbols {
  path: string;
  symbols: string[];
}

const TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const PY_EXTENSIONS = new Set([".py"]);

// Matches top-level `export function|class|interface|type|const|let
// <Name>` (optionally `async` before `function`). Anchored per-line (`m`
// flag) so it only fires on lines that actually start with "export" —
// misses re-exports, aliasing, and unusual syntax, which is an accepted
// v1 limitation, not a bug.
const TS_EXPORT_RE =
  /^export\s+(?:async\s+)?(?:function|class|interface|type|const|let)\s+([A-Za-z_$][\w$]*)/gm;

// Matches `def`/`class <Name>` only when the line starts at column 0 (no
// leading whitespace before "def"/"class") — this is what naturally
// excludes methods nested inside a class body without any extra
// indentation-tracking logic.
const PY_DEF_RE = /^(?:def|class)\s+([A-Za-z_]\w*)/gm;

function extension(path: string): string {
  const idx = path.lastIndexOf(".");
  return idx === -1 ? "" : path.slice(idx).toLowerCase();
}

function matchNames(content: string, re: RegExp): string[] {
  return Array.from(content.matchAll(re), (m) => m[1]);
}

// Returns undefined for unrecognized extensions or files with zero
// extracted symbols — callers should skip such files entirely, not list
// them with an empty symbol list.
export function extractSymbols(path: string, content: string): FileSymbols | undefined {
  const ext = extension(path);
  let symbols: string[];

  if (TS_EXTENSIONS.has(ext)) {
    symbols = matchNames(content, TS_EXPORT_RE);
  } else if (PY_EXTENSIONS.has(ext)) {
    symbols = matchNames(content, PY_DEF_RE).filter((name) => !name.startsWith("_"));
  } else {
    return undefined;
  }

  return symbols.length > 0 ? { path, symbols } : undefined;
}
