# Phase 1b: `.xpreiIDEignore` user-editable ignore file — design

Date: 2026-07-26

## Context

Phase 1b of `docs/feature-roadmap.md`. A user-editable, `.gitignore`-style
ignore file for the RAG indexer, replacing the hardcoded `EXCLUDED_DIRS`
list in `packages/core/src/context/exclude.ts` as the *primary* exclusion
mechanism (the hardcoded list remains as a safety floor — see "Additive
baseline" below). Fixes an already-logged `CLAUDE.md` gap: "Indexer uses
an exclude-glob, not true `.gitignore` parsing."

## Decisions

- **Filename: `.xpreiIDEignore`.** Matches the existing `.xpreiIDErules`
  convention (same `xpreiIDE` prefix). Chosen over `.xpreiignore` (breaks
  the convention, awkward doubled "i").
- **Hand-rolled glob subset, no new dependency.** Consistent with every
  prior Phase 4 provider's dependency-free philosophy. Supports comments
  (`#`), blank lines, no-slash patterns (match at any depth, by segment —
  same style as today's `EXCLUDED_DIRS` check), slash-containing patterns
  (anchored to the workspace root), `*` (any chars within one segment),
  and `**` (across segments). **Not supported:** `!` negation, backslash
  escaping. This is a documented v1 gap, not a bug — full `.gitignore`
  fidelity would require either a dependency or materially more parsing
  code than this feature's scope justifies.
- **Additive baseline, not a replacement.** The built-in `EXCLUDED_DIRS`
  list (`node_modules`, `.git`, `dist`, etc.) always applies —
  `.xpreiIDEignore` adds project-specific patterns on top. A typo'd or
  overly broad ignore file can't accidentally cause `node_modules` to get
  indexed.
- **No caching, no file watcher.** The file is read and parsed fresh on
  every operation that needs it — mirrors exactly how `.xpreiIDErules` /
  `projectRules.ts` already works (`loadProjectRules()`, no cache, called
  fresh per turn). This directly resolves the roadmap's own "cache
  invalidation" concern: there's no cache to invalidate.
- **Hybrid glob strategy for `vscode.workspace.findFiles()`.** The
  `exclude` glob argument passed to `findFiles()` stays exactly
  `SCAN_EXCLUDE` (the existing coarse, `EXCLUDED_DIRS`-only glob) —
  unchanged, still the fast path. User-defined patterns from
  `.xpreiIDEignore` are applied as a second, precise filter pass over the
  returned URIs via the widened `isExcludedPath()`. This mirrors the
  hybrid the roadmap itself proposed, and several call sites already do a
  post-`findFiles` `isExcludedPath` check today (e.g. the incremental
  file-watcher path) — this phase extends that existing pattern rather
  than inventing a new one.
- **Scope: RAG indexer + `@open` + `@repomap` only.** Every place
  `contextEngine.ts` already calls `isExcludedPath()` or uses
  `SCAN_EXCLUDE` gets the widened, patterns-aware check. The agent's
  `grep`/`glob` tools (`packages/core/src/host/nodeHost.ts`, the sidecar
  side) are explicitly **out of scope** — a possible future follow-on,
  not part of this phase. Matches the roadmap's own framing: "ignore
  file for the RAG indexer."

## Architecture

### `packages/core/src/context/ignoreFile.ts` (new, pure)

```typescript
// Hand-rolled .gitignore-style pattern parsing/matching for the
// user-editable .xpreiIDEignore file. No dependency, no negation (!), no
// escaping — a documented v1 subset (see design doc). Pure module — no
// vscode, no file I/O; callers read the file themselves and pass content
// in.

// Strips comments and blank lines; every remaining line is a pattern.
export function parseIgnorePatterns(content: string): string[]

// A pattern containing "/" is anchored to the workspace root and matched
// against the full relative path (with "*" matching within one segment,
// "**" matching across segments). A pattern with no "/" matches at any
// depth, checked against each path segment individually — the same
// semantics EXCLUDED_DIRS already uses. A trailing "/" is stripped before
// matching (this module only ever sees file paths, never bare directory
// paths, so file-vs-directory-only patterns collapse to the same check).
export function matchesIgnorePattern(rel: string, pattern: string): boolean

// True if any pattern matches.
export function isIgnoredByPatterns(rel: string, patterns: string[]): boolean
```

### `packages/core/src/context/exclude.ts` (modified)

```typescript
export function isExcludedPath(rel: string, extraPatterns: string[] = []): boolean {
  if (rel.split("/").some((seg) => EXCLUDED_DIRS.includes(seg))) return true;
  return extraPatterns.length > 0 ? isIgnoredByPatterns(rel, extraPatterns) : false;
}
```

Default parameter means every existing call (in `nodeHost.ts` and
`contextEngine.ts`) keeps compiling and behaving identically without any
change at the call site, until a call site is deliberately updated to
pass patterns.

### `extensions/vscode/src/context/ignoreFile.ts` (new)

Mirrors `projectRules.ts` exactly:

```typescript
const IGNORE_FILENAME = ".xpreiIDEignore";

export async function loadIgnorePatterns(): Promise<string[]> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return [];
  const uri = vscode.Uri.joinPath(folder.uri, IGNORE_FILENAME);
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return parseIgnorePatterns(Buffer.from(bytes).toString("utf8"));
  } catch {
    return [];
  }
}
```

### `extensions/vscode/src/context/contextEngine.ts` (modified)

Every method that currently calls `isExcludedPath(path)` or relies on
`SCAN_EXCLUDE` via `findFiles()` loads patterns via `loadIgnorePatterns()`
at the top of the operation and threads them into the widened
`isExcludedPath(path, patterns)` calls: the full index rebuild, the
incremental file-watcher add/change handlers, `readOpenFiles()` (backs
`@open`), and `buildRepoMap()` (backs `@repomap`). `findFiles()`'s
`exclude` argument itself is untouched (`SCAN_EXCLUDE`, unchanged).

## Out of scope

- `!` negation, backslash escaping, and other full-`.gitignore` edge
  cases — hand-rolled subset only.
- Nested `.xpreiIDEignore` files (subdirectory-scoped rules) — one file
  at the workspace root only, same as `.xpreiIDErules`.
- Any change to `nodeHost.ts` / the agent's `grep`/`glob` tools — RAG
  indexer scope only, per the roadmap's own framing.
- Caching, invalidation, or file-watcher-driven reload — deliberately
  read-fresh-every-time, matching `.xpreiIDErules`.

## Testing

- `ignoreFile.ts` (new, pure): full unit tests — comment stripping,
  blank-line stripping, no-slash pattern matching at any depth, a
  slash-containing pattern anchored to the root, `*` within a segment,
  `**` across segments, trailing-slash handling, and a combined
  `isExcludedPath()` test confirming the additive baseline (a path under
  a built-in `EXCLUDED_DIRS` name is excluded even with an empty patterns
  array; a path matching only a custom pattern is excluded only when that
  pattern is passed).
- `exclude.ts`: extend `exclude.test.ts` to confirm `isExcludedPath()`'s
  widened signature is backward compatible (existing calls with no second
  argument behave exactly as before).
- `extensions/vscode/src/context/ignoreFile.ts`'s VS Code I/O: no unit
  test (matches `projectRules.ts`'s convention) — verified by
  `npm run typecheck -w xpreiIDE-ai` + `npm run compile -w xpreiIDE-ai`,
  plus a manual smoke test: create a `.xpreiIDEignore` with a custom
  pattern in this real repo, confirm a full re-index skips matching
  files, confirm `node_modules` is still excluded even with an empty or
  missing `.xpreiIDEignore`, confirm `@open`/`@repomap` also respect it.

## User-facing docs

This is a user-editable dotfile users create themselves — needs a mention
in `extensions/vscode/README.md` (alongside the existing `.xpreiIDErules`
documentation) and, if the root `README.md` currently mentions
`.xpreiIDErules` in its Features list, a matching addition there too.
