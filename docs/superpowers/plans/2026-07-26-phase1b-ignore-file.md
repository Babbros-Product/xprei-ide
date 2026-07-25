# Phase 1b: `.xpreiIDEignore` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a user-editable `.xpreiIDEignore` file (gitignore-lite
syntax) that adds project-specific exclusions on top of the RAG
indexer's built-in `EXCLUDED_DIRS` list.

**Architecture:** A new pure module (`packages/core/src/context/
ignoreFile.ts`) parses/matches a hand-rolled restricted glob subset.
`exclude.ts`'s `isExcludedPath()` gains an optional second parameter
(default `[]`, fully backward compatible). A new extension-layer loader
(`extensions/vscode/src/context/ignoreFile.ts`, mirroring
`projectRules.ts` exactly) reads the file fresh on every call, no
caching. `contextEngine.ts` threads the loaded patterns into every
existing `isExcludedPath()` call site.

**Tech Stack:** TypeScript, Node's built-in `node:test` +
`assert/strict`, VS Code extension API (`vscode.workspace.fs`).

## Global Constraints

- **Filename: `.xpreiIDEignore`** (workspace root only, no nested files).
- **Hand-rolled subset, no new dependency.** Supported: comments (`#`),
  blank lines, no-slash patterns (match at any depth, by segment),
  slash-containing patterns (anchored to the workspace root), `*`
  (within one segment), `**` (across segments). **Not supported:** `!`
  negation, backslash escaping — documented gap.
- **Additive, not a replacement.** Built-in `EXCLUDED_DIRS` always
  applies; `.xpreiIDEignore` patterns add to it.
- **No caching, no file watcher.** Read and parsed fresh on every
  access, matching `.xpreiIDErules`/`projectRules.ts`'s existing
  behavior exactly.
- **Scope: RAG indexer + `@open` + `@repomap` only.** `nodeHost.ts` (the
  agent's `grep`/`glob` tools) is explicitly untouched — out of scope for
  this phase.
- **Commits:** author `xpreiIDE <mbsajay1@gmail.com>` — pass it
  explicitly, e.g. `git -c user.name="xpreiIDE" -c
  user.email="mbsajay1@gmail.com" commit -m "..."`. **Do NOT add a
  `Co-Authored-By` footer or any other footer.** Conventional Commit
  prefixes (feat/docs/etc).
- **Current-state correction:** neither `extensions/vscode/README.md`
  nor root `README.md` currently document `.xpreiIDErules` in a way this
  phase can "add alongside" seamlessly — `extensions/vscode/README.md`
  has NO section mentioning it at all (confirmed by grep); root
  `README.md` has one bullet (`- **Project rules** — a
  \`.xpreiIDErules\` file...`, around line 187). Task 4 below accounts
  for this: it adds a new standalone section to
  `extensions/vscode/README.md` (there's nothing existing to piggyback
  on) and a new matching bullet to root `README.md` (alongside the
  existing "Project rules" bullet).

---

### Task 1: `ignoreFile.ts` — pure, fully unit tested

**Files:**
- Create: `packages/core/src/context/ignoreFile.ts`
- Create: `packages/core/src/context/ignoreFile.test.ts`
- Modify: `packages/core/src/context/exclude.ts`
- Modify: `packages/core/src/context/exclude.test.ts`
- Modify: `packages/core/package.json` (register the new test file)
- Modify: `packages/core/src/index.ts` (barrel-export the new module)

**Interfaces:**
- Produces: `parseIgnorePatterns(content: string): string[]`,
  `matchesIgnorePattern(rel: string, pattern: string): boolean`,
  `isIgnoredByPatterns(rel: string, patterns: string[]): boolean` — Task
  2 consumes `isIgnoredByPatterns` (via the widened `isExcludedPath`).
- Produces: widened `isExcludedPath(rel: string, extraPatterns: string[]
  = []): boolean` in `exclude.ts` — Task 2 consumes this.

- [ ] **Step 1: Write the failing `ignoreFile` tests**

Create `packages/core/src/context/ignoreFile.test.ts`:

```typescript
import assert from "node:assert/strict";
import { test } from "node:test";
import { isIgnoredByPatterns, matchesIgnorePattern, parseIgnorePatterns } from "./ignoreFile";

test("parseIgnorePatterns strips comments and blank lines", () => {
  const content = "# comment\n\nnode_modules\n  \ndist/\n*.log\n";
  assert.deepEqual(parseIgnorePatterns(content), ["node_modules", "dist/", "*.log"]);
});

test("parseIgnorePatterns trims trailing whitespace from each pattern", () => {
  assert.deepEqual(parseIgnorePatterns("build/  \n"), ["build/"]);
});

test("matchesIgnorePattern: no-slash pattern matches at any depth by segment", () => {
  assert.equal(matchesIgnorePattern("coverage/lcov.info", "coverage"), true);
  assert.equal(matchesIgnorePattern("src/deep/coverage/x.js", "coverage"), true);
  assert.equal(matchesIgnorePattern("src/coverage-report.js", "coverage"), false);
});

test("matchesIgnorePattern: slash-containing pattern is anchored to the root", () => {
  assert.equal(matchesIgnorePattern("build/output.js", "build/output.js"), true);
  assert.equal(matchesIgnorePattern("src/build/output.js", "build/output.js"), false);
});

test("matchesIgnorePattern: '*' matches within one segment only", () => {
  assert.equal(matchesIgnorePattern("a.log", "*.log"), true);
  assert.equal(matchesIgnorePattern("dir/a.log", "*.log"), true);
  assert.equal(matchesIgnorePattern("dir/a/b.log", "dir/*.log"), false);
});

test("matchesIgnorePattern: '**' matches across segments", () => {
  assert.equal(matchesIgnorePattern("build/a.js", "build/**"), true);
  assert.equal(matchesIgnorePattern("build/sub/a.js", "build/**"), true);
  assert.equal(matchesIgnorePattern("other/a.js", "build/**"), false);
});

test("matchesIgnorePattern: trailing slash is stripped before matching", () => {
  assert.equal(matchesIgnorePattern("vendor/lib.js", "vendor/"), true);
});

test("isIgnoredByPatterns is true if any pattern matches", () => {
  assert.equal(isIgnoredByPatterns("a.tmp", ["*.log", "*.tmp"]), true);
  assert.equal(isIgnoredByPatterns("a.ts", ["*.log", "*.tmp"]), false);
});

test("isIgnoredByPatterns is false for an empty patterns array", () => {
  assert.equal(isIgnoredByPatterns("anything.ts", []), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `packages/core`): `node --import tsx --test src/context/ignoreFile.test.ts`
Expected: FAIL — `./ignoreFile` doesn't exist yet.

- [ ] **Step 3: Implement `ignoreFile.ts`**

Create `packages/core/src/context/ignoreFile.ts`:

```typescript
// Hand-rolled .gitignore-style pattern parsing/matching for the
// user-editable .xpreiIDEignore file. No dependency, no negation (!), no
// escaping — a documented v1 subset (see
// docs/superpowers/specs/2026-07-26-phase1b-ignore-file-design.md).
// Pure module — no vscode, no file I/O; callers read the file
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `packages/core`): `node --import tsx --test src/context/ignoreFile.test.ts`
Expected: PASS — all 9 tests green.

- [ ] **Step 5: Write the failing `exclude.ts` widening test**

Add to `packages/core/src/context/exclude.test.ts` (append at the end):

```typescript
test("isExcludedPath is additive: built-in dirs always excluded regardless of extraPatterns", () => {
  assert.equal(isExcludedPath("node_modules/x.js", []), true);
  assert.equal(isExcludedPath("node_modules/x.js", ["*.md"]), true);
});

test("isExcludedPath excludes a path matching an extra pattern", () => {
  assert.equal(isExcludedPath("notes.md", ["*.md"]), true);
  assert.equal(isExcludedPath("notes.md"), false);
});

test("isExcludedPath's second parameter is optional and defaults to no extra patterns", () => {
  assert.equal(isExcludedPath("src/index.ts"), false);
});
```

- [ ] **Step 6: Run the tests to verify they fail**

Run (from `packages/core`): `node --import tsx --test src/context/exclude.test.ts`
Expected: FAIL — `isExcludedPath` doesn't accept a second parameter yet
(TypeScript compile error under `tsx`, surfaced as a test run failure).

- [ ] **Step 7: Widen `isExcludedPath` in `exclude.ts`**

In `packages/core/src/context/exclude.ts`, add an import and widen the
function signature:

```typescript
import { isIgnoredByPatterns } from "./ignoreFile";
```

```typescript
// True if a workspace-relative path lies under an excluded directory, OR
// matches one of the caller-supplied extraPatterns (from a parsed
// .xpreiIDEignore file). extraPatterns defaults to [] so every existing
// call site keeps compiling and behaving identically.
export function isExcludedPath(rel: string, extraPatterns: string[] = []): boolean {
  if (rel.split("/").some((seg) => EXCLUDED_DIRS.includes(seg))) return true;
  return extraPatterns.length > 0 ? isIgnoredByPatterns(rel, extraPatterns) : false;
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run (from `packages/core`): `node --import tsx --test src/context/exclude.test.ts`
Expected: PASS — all tests green (3 pre-existing + 3 new = 6).

- [ ] **Step 9: Register the test file and barrel-export the module**

In `packages/core/package.json`, add `src/context/ignoreFile.test.ts` to
the `test` script's file list, immediately after
`src/context/repomap.test.ts`.

In `packages/core/src/index.ts`, add immediately after
`export * from "./context/repomap";`:

```typescript
export * from "./context/ignoreFile";
```

- [ ] **Step 10: Run the full core suite to confirm nothing broke**

Run (from `packages/core`): `npm test`
Expected: PASS — 220 tests total (208 before this plan + 9 new
`ignoreFile.test.ts` + 3 new `exclude.test.ts` tests).

- [ ] **Step 11: Commit**

```bash
git add packages/core/src/context/ignoreFile.ts packages/core/src/context/ignoreFile.test.ts packages/core/src/context/exclude.ts packages/core/src/context/exclude.test.ts packages/core/package.json packages/core/src/index.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(core): add .xpreiIDEignore pattern parsing, widen isExcludedPath"
```

---

### Task 2: Extension-layer loader (`extensions/vscode/src/context/ignoreFile.ts`)

**Files:**
- Create: `extensions/vscode/src/context/ignoreFile.ts`

**Interfaces:**
- Consumes: `parseIgnorePatterns` from `@xprei/core` (Task 1).
- Produces: `loadIgnorePatterns(): Promise<string[]>` — Task 3 consumes
  this.

- [ ] **Step 1: Create the loader**

Create `extensions/vscode/src/context/ignoreFile.ts`:

```typescript
// User-editable ignore file for the RAG indexer, .gitignore-lite syntax
// (see docs/superpowers/specs/2026-07-26-phase1b-ignore-file-design.md
// for the supported subset). Mirrors projectRules.ts exactly: no
// caching, read fresh on every call.

import * as vscode from "vscode";
import { parseIgnorePatterns } from "@xprei/core";

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

- [ ] **Step 2: Typecheck the extension**

Run: `npm run typecheck -w xpreiIDE-ai`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add extensions/vscode/src/context/ignoreFile.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(vscode): load .xpreiIDEignore patterns"
```

---

### Task 3: Wire patterns into `contextEngine.ts`

**Files:**
- Modify: `extensions/vscode/src/context/contextEngine.ts`

**Interfaces:**
- Consumes: `loadIgnorePatterns()` from `./ignoreFile` (Task 2).

**Note for the implementer:** read the current file before editing —
line numbers shift as this file has grown across prior phases this
session (it's now well over 600 lines). Locate each call site by the
exact code shown below (grep for `isExcludedPath(` and `SCAN_EXCLUDE`),
not by the line numbers quoted in the design spec (which were accurate
when the spec was written but are not load-bearing here). **Confirmed
by reading the current file:** `rebuild()` (the full index scan, around
line 97) currently has NO `isExcludedPath` call at all — it relies
purely on `SCAN_EXCLUDE`'s coarse glob, so this task adds a NEW check
there, not a widen-an-existing-call step. The two existing
`isExcludedPath(path)` calls live in `updateFile()` (~line 141) and
`removeFile()` (~line 158) — the incremental file-watcher handlers, one
call each.

- [ ] **Step 1: Import the loader**

Add to the import list in `extensions/vscode/src/context/
contextEngine.ts`:

```typescript
import { loadIgnorePatterns } from "./ignoreFile";
```

- [ ] **Step 2: Add a pattern check to the full-index rebuild path (`rebuild()`)**

`rebuild()` currently has no `isExcludedPath` call — `SCAN_EXCLUDE`'s
coarse glob is the only filter today. Add one. Immediately after `const
uris = await vscode.workspace.findFiles("**/*", SCAN_EXCLUDE);`, add:

```typescript
const ignorePatterns = await loadIgnorePatterns();
```

Then, inside the `for (const uri of uris) { ... }` loop, as the very
first line of the loop body (before `if (token?.isCancellationRequested)
break;`), add:

```typescript
if (isExcludedPath(this.rel(uri), ignorePatterns)) continue;
```

(Placing the ignore check before the cancellation check is fine either
order — both are cheap; this ordering just means a cancelled run doesn't
bother checking an already-skipped file, which is a marginal
optimization, not a correctness requirement.)

- [ ] **Step 3: Thread patterns into `updateFile()` and `removeFile()` (the incremental file-watcher handlers)**

In `updateFile(uri: vscode.Uri)`, add before its existing
`isExcludedPath(path)` call:

```typescript
const ignorePatterns = await loadIgnorePatterns();
```

and change `if (isExcludedPath(path)) return;` to `if
(isExcludedPath(path, ignorePatterns)) return;`.

Do the same in `removeFile(uri: vscode.Uri)`: add the `const
ignorePatterns = await loadIgnorePatterns();` line before its
`isExcludedPath(path)` call, and widen that call to `isExcludedPath(path,
ignorePatterns)`.

- [ ] **Step 5: Thread patterns into `readOpenFiles()` (backs `@open`)**

In `readOpenFiles(excludePaths: Set<string>)`, add at the top of the
method:

```typescript
const ignorePatterns = await loadIgnorePatterns();
```

Change its `isExcludedPath(path)` call to `isExcludedPath(path,
ignorePatterns)`.

- [ ] **Step 6: Thread patterns into `buildRepoMap()` (backs `@repomap`)**

In `buildRepoMap()`, add at the top:

```typescript
const ignorePatterns = await loadIgnorePatterns();
```

This method currently filters via `SCAN_EXCLUDE` (in the `findFiles`
call) only, with no `isExcludedPath` post-filter. Add one: inside the
`for (const uri of uris)` loop, right after entering the loop (before the
`try`), add:

```typescript
const rel = this.rel(uri);
if (isExcludedPath(rel, ignorePatterns)) continue;
```

and use `rel` (instead of a fresh `this.rel(uri)` call) in the
`extractSymbols(rel, ...)` call later in the same loop iteration.

- [ ] **Step 7: Confirm no `isExcludedPath(` call remains single-argument**

Run: `grep -n "isExcludedPath(" extensions/vscode/src/context/contextEngine.ts`
(from the repo root)
Expected: every match passes two arguments (`isExcludedPath(<path>,
ignorePatterns)`) — if any single-argument call remains, it was missed
in Steps 2-6; go back and fix it.

- [ ] **Step 8: Typecheck the extension**

Run: `npm run typecheck -w xpreiIDE-ai`
Expected: PASS.

- [ ] **Step 9: Compile the extension**

Run: `npm run compile -w xpreiIDE-ai`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add extensions/vscode/src/context/contextEngine.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(vscode): respect .xpreiIDEignore in indexing, @open, and @repomap"
```

---

### Task 4: User-facing docs

**Files:**
- Modify: `extensions/vscode/README.md`
- Modify: `README.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Add a new section to `extensions/vscode/README.md`**

There is currently no section documenting `.xpreiIDErules` in this file
at all (confirmed by search) — this task adds a new standalone section
covering both dotfiles together, rather than "adding alongside" a
section that doesn't exist. Insert a new section after the "Codebase
context (@mentions)" section (search for `## Inline edit (Cmd-K)`, the
section that immediately follows it, and insert before that heading):

```markdown
## Project instructions & ignore file

Two optional dotfiles at your workspace root, both read fresh every
time they're needed (no caching, no reload required):

- **`.xpreiIDErules`** — plain text, injected into every chat/edit/agent
  system prompt as extra project-specific instructions.
- **`.xpreiIDEignore`** — one pattern per line, `.gitignore`-lite syntax
  (`#` comments, blank lines ignored, `*` within a path segment, `**`
  across segments, a pattern containing `/` anchors to the workspace
  root, a pattern without `/` matches at any depth). Adds to, not
  replaces, the indexer's built-in exclusions (`node_modules`, `.git`,
  `dist`, and similar are always excluded regardless of this file).
  Affects the codebase index, `@open`, and `@repomap` — **not** the
  agent's `grep`/`glob` tools. Not a full `.gitignore` implementation:
  `!` negation and backslash escaping aren't supported.

```

- [ ] **Step 2: Add a matching bullet to the root `README.md`**

The existing bullet (search for `**Project rules**`) currently reads:

```markdown
- **Project rules** — a `.xpreiIDErules` file at your workspace root is injected
  into every prompt.
```

Replace it with:

```markdown
- **Project rules** — a `.xpreiIDErules` file at your workspace root is injected
  into every prompt.
- **Ignore file** — a `.xpreiIDEignore` file (`.gitignore`-lite syntax)
  excludes extra paths from the codebase index, on top of the built-in
  exclusions.
```

- [ ] **Step 3: Proofread both files**

Read both changed files back in full and confirm: no broken Markdown, the
new content reads naturally in place, and the `@open`/`@repomap`-but-not-
`grep`/`glob` scope note is clear.

- [ ] **Step 4: Commit**

```bash
git add extensions/vscode/README.md README.md
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "docs: document .xpreiIDEignore in both user-facing READMEs"
```

---

### Task 5: Final verification

**Files:** none (verification only).

**Interfaces:** none — consumes everything built in Tasks 1-4.

- [ ] **Step 1: Run the full core test suite**

Run: `npm test -w @xprei/core`
Expected: PASS — 220 tests total (208 before this plan + 9 new
`ignoreFile.test.ts` + 3 new `exclude.test.ts` tests).

- [ ] **Step 2: Typecheck core**

Run: `npm run typecheck -w @xprei/core`
Expected: PASS.

- [ ] **Step 3: Typecheck the extension**

Run: `npm run typecheck -w xpreiIDE-ai`
Expected: PASS.

- [ ] **Step 4: Compile the extension**

Run: `npm run compile -w xpreiIDE-ai`
Expected: PASS.

- [ ] **Step 5: Manual smoke test**

Launch the Extension Development Host (F5 in VS Code against
`extensions/vscode`):

1. Create a `.xpreiIDEignore` at this real repo's root containing
   `*.md`. Trigger a full re-index (e.g. the "xpreiIDE: Rebuild Index"
   command, if one exists, or reopen the workspace). Confirm `@codebase`
   queries no longer surface any `.md` file content.
2. Confirm `node_modules`/`.git`/`dist` are still excluded even with an
   empty or missing `.xpreiIDEignore`.
3. Open a `.md` file in an editor tab and send `@open`; confirm its
   content is NOT inlined (respecting the ignore pattern).
4. Send `@repomap`; confirm no `.md`-derived entries appear (repomap
   wouldn't have listed them anyway, being non-TS/JS/Python, but confirm
   no regression/crash from the new filter).
5. Delete the `.xpreiIDEignore` file and confirm indexing/`@open`/
   `@repomap` return to their pre-this-phase behavior (proves the
   additive-only, no-file-means-no-change property).

This step requires a real Extension Development Host and is not
something that can be driven from an automated test — run it manually
and report any discrepancy.
