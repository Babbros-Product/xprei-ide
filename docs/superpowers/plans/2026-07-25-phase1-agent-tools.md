# Phase 1 Agent Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three additive agent tools — `read_file_range`, `glob_search`,
`view_diff` — to the agent's tool set, per
`docs/superpowers/specs/2026-07-25-phase1-agent-tools-design.md`.

**Architecture:** All three tools are entries in the `TOOLS` array in
`packages/core/src/agent/tools.ts`, following the existing `Tool` shape
(`ToolSpec` + `run(args, host)`). `read_file_range` and `view_diff` need no
`AgentHost` changes. `glob_search` adds one new `AgentHost` method
(`glob(pattern, path?)`) backed by a new pure, dependency-free glob-match
module shared by all three host implementations (`NodeAgentHost`,
`VscodeAgentHost`, `FakeHost`).

**Tech Stack:** TypeScript, Node's built-in `node:test` + `node:assert/strict`
(no test framework dependency, matching the rest of `@xprei/core`).

## Global Constraints

- No new runtime dependencies — the glob matcher is hand-written, matching
  the project's dependency-free philosophy already seen in
  `packages/core/src/context/exclude.ts`.
- `packages/core` is source-only; no separate build step for these changes.
- Every new test file must be added to the `test` script list in
  `packages/core/package.json` (existing repo convention).
- Tools call `AgentHost`, never `vscode`/`node:fs` directly (existing
  convention, restated in `CLAUDE.md`).
- Extension-layer code (`extensions/vscode/**`) has no unit tests by
  existing convention — verified by typecheck + compile + manual smoke only.
- Observation truncation uses the existing `MAX_OBS = 8000` constant and
  `truncate()` helper in `tools.ts` — no new truncation mechanism.
- Commits: author `xpreiIDE <mbsajay1@gmail.com>`, footer
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`, Conventional
  Commit prefixes (`feat`/`test`/etc).

---

### Task 1: Shared glob matcher + walk helper

**Files:**
- Create: `packages/core/src/agent/glob.ts`
- Create: `packages/core/src/agent/glob.test.ts`
- Modify: `packages/core/package.json` (add `glob.test.ts` to the `test` script)

**Interfaces:**
- Produces: `matchGlob(pattern: string, relPath: string): boolean` — true if
  `relPath` (a `/`-separated, workspace-relative path) matches `pattern`.
  Supports `*` (wildcard within one path segment), `**` (wildcard across any
  depth, optionally swallowing a following `/`), `?` (exactly one
  character, not `/`). All other characters are treated literally
  (regex-escaped).
- Produces: `interface DirEntry { name: string; isDirectory: boolean }`
- Produces: `collectGlobMatches(pattern, startAbs, readDir, toRel, join, isExcluded, maxResults): Promise<string[]>`
  — a generic recursive collector with no I/O of its own; callers supply
  `readDir(absDir): Promise<DirEntry[]>`, `toRel(abs): string`,
  `join(a, b): string`, and `isExcluded(rel): boolean` to adapt it to a
  concrete filesystem API. Stops once `out.length >= maxResults`.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/core/src/agent/glob.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { matchGlob, collectGlobMatches, DirEntry } from "./glob";

test("matchGlob: * matches within one path segment only", () => {
  assert.equal(matchGlob("src/*.ts", "src/a.ts"), true);
  assert.equal(matchGlob("src/*.ts", "src/sub/a.ts"), false);
});

test("matchGlob: ** matches across any depth", () => {
  assert.equal(matchGlob("src/**/*.ts", "src/a.ts"), true);
  assert.equal(matchGlob("src/**/*.ts", "src/sub/deep/a.ts"), true);
  assert.equal(matchGlob("**/*.ts", "a.ts"), true);
});

test("matchGlob: ? matches exactly one character", () => {
  assert.equal(matchGlob("a?.ts", "ab.ts"), true);
  assert.equal(matchGlob("a?.ts", "abc.ts"), false);
});

test("matchGlob: literal dots and other regex-special chars are literal", () => {
  assert.equal(matchGlob("a.ts", "aXts"), false);
  assert.equal(matchGlob("a.ts", "a.ts"), true);
});

test("matchGlob: no match returns false", () => {
  assert.equal(matchGlob("*.ts", "a.js"), false);
});

function fakeFs(tree: Record<string, string[]>): {
  readDir: (dir: string) => Promise<DirEntry[]>;
} {
  // `tree` maps an absolute dir path to its child names; a name ending in
  // '/' is a directory, otherwise a file.
  return {
    async readDir(dir: string): Promise<DirEntry[]> {
      const children = tree[dir] ?? [];
      return children.map((name) =>
        name.endsWith("/")
          ? { name: name.slice(0, -1), isDirectory: true }
          : { name, isDirectory: false },
      );
    },
  };
}

test("collectGlobMatches walks recursively and matches by pattern", async () => {
  const { readDir } = fakeFs({
    "/root": ["src/", "top.ts"],
    "/root/src": ["a.ts", "b.js"],
  });
  const out = await collectGlobMatches(
    "**/*.ts",
    "/root",
    readDir,
    (abs) => abs.replace("/root/", "").replace("/root", ""),
    (a, b) => `${a}/${b}`,
    () => false,
    200,
  );
  assert.deepEqual(out.sort(), ["src/a.ts", "top.ts"]);
});

test("collectGlobMatches skips excluded paths", async () => {
  const { readDir } = fakeFs({
    "/root": ["node_modules/", "src/"],
    "/root/node_modules": ["pkg.ts"],
    "/root/src": ["a.ts"],
  });
  const out = await collectGlobMatches(
    "**/*.ts",
    "/root",
    readDir,
    (abs) => abs.replace("/root/", "").replace("/root", ""),
    (a, b) => `${a}/${b}`,
    (rel) => rel.split("/").includes("node_modules"),
    200,
  );
  assert.deepEqual(out, ["src/a.ts"]);
});

test("collectGlobMatches stops at maxResults", async () => {
  const { readDir } = fakeFs({
    "/root": ["a.ts", "b.ts", "c.ts"],
  });
  const out = await collectGlobMatches(
    "*.ts",
    "/root",
    readDir,
    (abs) => abs.replace("/root/", "").replace("/root", ""),
    (a, b) => `${a}/${b}`,
    () => false,
    2,
  );
  assert.equal(out.length, 2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @xprei/core -- src/agent/glob.test.ts` (or, if that
doesn't scope to a single file on this repo's test runner, temporarily add
`glob.test.ts` to the `test` script — see Step 5 — then run
`npm test -w @xprei/core`)
Expected: FAIL — `Cannot find module './glob'` (file doesn't exist yet).

- [ ] **Step 3: Implement the matcher and walk helper**

```typescript
// packages/core/src/agent/glob.ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @xprei/core -- src/agent/glob.test.ts` (see Step 5 for
making this file part of the regular `test` run)
Expected: all 8 tests PASS.

- [ ] **Step 5: Register the new test file**

Edit `packages/core/package.json`'s `test` script, adding
`src/agent/glob.test.ts` to the list (put it next to `src/agent/tools.test.ts`
for readability). Then run the full suite to confirm nothing else broke:

Run: `npm test -w @xprei/core`
Expected: all tests PASS (existing count + 8 new).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/agent/glob.ts packages/core/src/agent/glob.test.ts packages/core/package.json
git commit -m "feat(core): add shared glob matcher for glob_search tool"
```

---

### Task 2: `AgentHost.glob()` + `FakeHost` implementation

**Files:**
- Modify: `packages/core/src/agent/host.ts`
- Modify: `packages/core/src/agent/_fakehost.ts`

**Interfaces:**
- Consumes: `matchGlob` from `./glob` (Task 1).
- Produces: `AgentHost.glob(pattern: string, path?: string): Promise<string[]>`
  — every `AgentHost` implementation must provide this from here on.
  `FakeHost.glob()` is the reference implementation used by `tools.test.ts`
  in Task 6.

- [ ] **Step 1: Add the method to the `AgentHost` interface**

```typescript
// packages/core/src/agent/host.ts — add to the AgentHost interface, after grep():
  glob(pattern: string, path?: string): Promise<string[]>;
```

- [ ] **Step 2: Run typecheck to confirm the break**

Run: `npm run typecheck -w @xprei/core`
Expected: FAIL — `NodeAgentHost` and `FakeHost` (via structural typing,
wherever they're asserted as `AgentHost`) are missing `glob`. (If TypeScript
doesn't yet flag `FakeHost` because nothing currently type-asserts it
against `AgentHost` at this point, that's fine — Task 3 will surface
`NodeAgentHost`'s gap regardless; proceed to Step 3.)

- [ ] **Step 3: Implement `FakeHost.glob()`**

```typescript
// packages/core/src/agent/_fakehost.ts — add import and method:
import { matchGlob } from "./glob";
// ... inside class FakeHost, after grep():
  async glob(pattern: string, path?: string): Promise<string[]> {
    const out: string[] = [];
    for (const file of this.files.keys()) {
      if (path && !file.startsWith(path)) continue;
      if (matchGlob(pattern, file)) out.push(file);
    }
    return out;
  }
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck -w @xprei/core`
Expected: FAIL only on `NodeAgentHost` missing `glob` (fixed in Task 3) —
`FakeHost` no longer flagged.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent/host.ts packages/core/src/agent/_fakehost.ts
git commit -m "feat(core): add glob() to the AgentHost interface, implement for FakeHost"
```

---

### Task 3: `NodeAgentHost.glob()`

**Files:**
- Modify: `packages/core/src/host/nodeHost.ts`
- Modify: `packages/core/src/host/nodeHost.test.ts`

**Interfaces:**
- Consumes: `collectGlobMatches`, `DirEntry` from `../agent/glob` (Task 1);
  `AgentHost.glob()` signature from Task 2; `isExcludedPath` from
  `../context/exclude` (already imported in this file).
- Produces: `NodeAgentHost.glob(pattern, path?): Promise<string[]>`.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/core/src/host/nodeHost.test.ts — append:
test("glob finds files by pattern and skips excluded dirs", async () => {
  const root = await tmpRoot();
  const host = new NodeAgentHost(root);
  await host.writeFile("src/a.ts", "x");
  await host.writeFile("src/sub/b.ts", "x");
  await host.writeFile("src/c.js", "x");
  await host.writeFile("node_modules/pkg/index.ts", "x");
  const out = (await host.glob("**/*.ts")).sort();
  assert.deepEqual(out, ["src/a.ts", "src/sub/b.ts"]);
});

test("glob scopes to an optional path prefix", async () => {
  const root = await tmpRoot();
  const host = new NodeAgentHost(root);
  await host.writeFile("src/a.ts", "x");
  await host.writeFile("test/b.ts", "x");
  const out = await host.glob("**/*.ts", "src");
  assert.deepEqual(out, ["src/a.ts"]);
});

test("glob with no matches returns an empty array", async () => {
  const root = await tmpRoot();
  const host = new NodeAgentHost(root);
  await host.writeFile("a.ts", "x");
  const out = await host.glob("*.md");
  assert.deepEqual(out, []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @xprei/core`
Expected: FAIL — `host.glob is not a function`.

- [ ] **Step 3: Implement `NodeAgentHost.glob()`**

```typescript
// packages/core/src/host/nodeHost.ts
// Add to imports at top:
import { collectGlobMatches, DirEntry } from "../agent/glob";

const MAX_GLOB_RESULTS = 200;

// Add as a method on NodeAgentHost, after grep()/walk():
  async glob(pattern: string, p?: string): Promise<string[]> {
    const start = this.resolve(p || ".");
    return collectGlobMatches(
      pattern,
      start,
      async (dir) => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        return entries.map(
          (e): DirEntry => ({ name: e.name, isDirectory: e.isDirectory() }),
        );
      },
      (abs) => this.toRel(abs),
      (a, b) => path.join(a, b),
      (rel) => isExcludedPath(rel),
      MAX_GLOB_RESULTS,
    );
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @xprei/core`
Expected: all tests PASS.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck -w @xprei/core`
Expected: PASS (no more `AgentHost` implementation gaps in core).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/host/nodeHost.ts packages/core/src/host/nodeHost.test.ts
git commit -m "feat(core): implement AgentHost.glob() for NodeAgentHost"
```

---

### Task 4: `VscodeAgentHost.glob()`

**Files:**
- Modify: `extensions/vscode/src/agent/host.ts`

**Interfaces:**
- Consumes: `collectGlobMatches`, `DirEntry` exported from `@xprei/core`
  (need to confirm/add the barrel export — see Step 1); `AgentHost.glob()`
  signature from Task 2.
- Produces: `VscodeAgentHost.glob(pattern, path?): Promise<string[]>`. No
  test file — this layer has no unit tests by existing convention; verified
  by typecheck + compile.

- [ ] **Step 1: Export `glob.ts` from the core barrel**

`packages/core/src/index.ts` re-exports every agent module via `export *`
(e.g. `export * from "./agent/host";`, line 25) but has no line yet for the
new `glob.ts` from Task 1. Add one, next to the other `./agent/*` lines
(after `export * from "./agent/host";`):

```typescript
export * from "./agent/glob";
```

`isExcludedPath` needs no new export — `export * from "./context/exclude";`
(already at line 19) covers it.

- [ ] **Step 2: Implement `VscodeAgentHost.glob()`**

```typescript
// extensions/vscode/src/agent/host.ts
// Add to the existing @xprei/core import (already imports AgentHost,
// ExecResult, GrepHit, resolveWorkspacePath):
import {
  AgentHost,
  ExecResult,
  GrepHit,
  resolveWorkspacePath,
  collectGlobMatches,
  DirEntry,
  isExcludedPath,
} from "@xprei/core";

const MAX_GLOB_RESULTS = 200;

// Add as a method on VscodeAgentHost, after grep():
  async glob(pattern: string, p?: string): Promise<string[]> {
    const start = this.resolve(p || ".");
    return collectGlobMatches(
      pattern,
      start.fsPath,
      async (dir) => {
        const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
        return entries.map(
          ([name, kind]): DirEntry => ({
            name,
            isDirectory: kind === vscode.FileType.Directory,
          }),
        );
      },
      (abs) => vscode.workspace.asRelativePath(vscode.Uri.file(abs), false),
      (a, b) => vscode.Uri.joinPath(vscode.Uri.file(a), b).fsPath,
      (rel) => isExcludedPath(rel),
      MAX_GLOB_RESULTS,
    );
  }
```

Note: `isExcludedPath` lives in `packages/core/src/context/exclude.ts`. Check
`packages/core/src/index.ts` for whether it's already exported from the
barrel; if not, add `export { isExcludedPath } from "./context/exclude";`
there (same file touched in Step 1) instead of adding a second import
statement in `host.ts` — merge it into the single `@xprei/core` import.

- [ ] **Step 3: Typecheck the extension**

Run: `npm run typecheck -w xpreiIDE-ai`
Expected: PASS.

- [ ] **Step 4: Compile the extension**

Run: `npm run compile -w xpreiIDE-ai`
Expected: PASS, `dist/extension.js` rebuilt.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/index.ts extensions/vscode/src/agent/host.ts
git commit -m "feat(vscode): implement AgentHost.glob() for VscodeAgentHost"
```

---

### Task 5: `read_file_range` tool

**Files:**
- Modify: `packages/core/src/agent/tools.ts`
- Modify: `packages/core/src/agent/tools.test.ts`

**Interfaces:**
- Consumes: `AgentHost.readFile()` (existing), `truncate()`/`str()`/`errText()`
  helpers already in `tools.ts`.
- Produces: a `"read_file_range"` entry in the `TOOLS` array, reachable via
  `toolByName("read_file_range")`.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/core/src/agent/tools.test.ts — append:
test("read_file_range returns only the requested lines, 1-indexed", async () => {
  const host = new FakeHost({ "a.ts": "one\ntwo\nthree\nfour\nfive" });
  const r = await tool("read_file_range").run({ path: "a.ts", startLine: 2, endLine: 4 }, host);
  assert.match(r.observation, /2\ttwo/);
  assert.match(r.observation, /3\tthree/);
  assert.match(r.observation, /4\tfour/);
  assert.doesNotMatch(r.observation, /one/);
  assert.doesNotMatch(r.observation, /five/);
});

test("read_file_range clamps startLine below 1 and endLine past the file end", async () => {
  const host = new FakeHost({ "a.ts": "one\ntwo\nthree" });
  const r = await tool("read_file_range").run({ path: "a.ts", startLine: -5, endLine: 999 }, host);
  assert.match(r.observation, /1\tone/);
  assert.match(r.observation, /3\tthree/);
});

test("read_file_range errors when startLine > endLine after clamping", async () => {
  const host = new FakeHost({ "a.ts": "one\ntwo\nthree" });
  const r = await tool("read_file_range").run({ path: "a.ts", startLine: 3, endLine: 1 }, host);
  assert.match(r.observation, /Error/);
});

test("read_file_range errors on missing args", async () => {
  const host = new FakeHost({ "a.ts": "one" });
  const r = await tool("read_file_range").run({ path: "a.ts" }, host);
  assert.match(r.observation, /Error/);
});

test("read_file_range reports a missing file", async () => {
  const r = await tool("read_file_range").run({ path: "nope.ts", startLine: 1, endLine: 2 }, new FakeHost());
  assert.match(r.observation, /Error/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @xprei/core`
Expected: FAIL — `tool("read_file_range")` is `undefined` (assert.ok in the
`tool()` helper throws first).

- [ ] **Step 3: Implement the tool**

```typescript
// packages/core/src/agent/tools.ts
// Add a num() helper next to str(), near the top of the file:
function num(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

// Add to the TOOLS array, after "read_file":
  {
    name: "read_file_range",
    description:
      "Read a 1-indexed, inclusive line range from a UTF-8 text file. " +
      "Out-of-range lines clamp to the file's bounds. Returns numbered lines.",
    args: '{ "path": string, "startLine": number, "endLine": number }',
    mutating: false,
    async run(args, host) {
      const path = str(args, "path");
      const startLine = num(args, "startLine");
      const endLine = num(args, "endLine");
      if (!path || startLine === undefined || endLine === undefined) {
        return { observation: "Error: 'path', 'startLine', and 'endLine' are required." };
      }
      let content: string;
      try {
        content = await host.readFile(path);
      } catch (err) {
        return { observation: `Error: cannot read ${path}. ${errText(err)}` };
      }
      const lines = content.split(/\r?\n/);
      const start = Math.max(1, Math.floor(startLine));
      const end = Math.min(lines.length, Math.floor(endLine));
      if (start > end) {
        return { observation: `Error: startLine (${start}) is after endLine (${end}) in ${path}.` };
      }
      const numbered = lines
        .slice(start - 1, end)
        .map((l, i) => `${start + i}\t${l}`)
        .join("\n");
      return { observation: truncate(numbered) };
    },
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @xprei/core`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent/tools.ts packages/core/src/agent/tools.test.ts
git commit -m "feat(core): add read_file_range agent tool"
```

---

### Task 6: `glob_search` tool

**Files:**
- Modify: `packages/core/src/agent/tools.ts`
- Modify: `packages/core/src/agent/tools.test.ts`

**Interfaces:**
- Consumes: `AgentHost.glob()` (Task 2's `FakeHost` implementation exercises
  this in tests), `str()`/`truncate()` helpers.
- Produces: a `"glob_search"` entry in the `TOOLS` array.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/core/src/agent/tools.test.ts — append:
test("glob_search returns matching paths", async () => {
  const host = new FakeHost({ "src/a.ts": "x", "src/b.js": "x", "test/c.ts": "x" });
  const r = await tool("glob_search").run({ pattern: "**/*.ts" }, host);
  assert.match(r.observation, /src\/a\.ts/);
  assert.match(r.observation, /test\/c\.ts/);
  assert.doesNotMatch(r.observation, /b\.js/);
});

test("glob_search scopes to an optional path", async () => {
  const host = new FakeHost({ "src/a.ts": "x", "test/b.ts": "x" });
  const r = await tool("glob_search").run({ pattern: "**/*.ts", path: "src" }, host);
  assert.match(r.observation, /src\/a\.ts/);
  assert.doesNotMatch(r.observation, /test\/b\.ts/);
});

test("glob_search reports no matches", async () => {
  const host = new FakeHost({ "a.ts": "x" });
  const r = await tool("glob_search").run({ pattern: "*.md" }, host);
  assert.match(r.observation, /No files match/);
});

test("glob_search errors on missing pattern", async () => {
  const r = await tool("glob_search").run({}, new FakeHost());
  assert.match(r.observation, /Error/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @xprei/core`
Expected: FAIL — `tool("glob_search")` is `undefined`.

- [ ] **Step 3: Implement the tool**

```typescript
// packages/core/src/agent/tools.ts — add to the TOOLS array, after "grep":
  {
    name: "glob_search",
    description:
      "Find files by glob pattern (supports *, **, ?). Optionally scope to a path.",
    args: '{ "pattern": string, "path"?: string }',
    mutating: false,
    async run(args, host) {
      const pattern = str(args, "pattern");
      if (!pattern) return { observation: "Error: 'pattern' is required." };
      const matches = await host.glob(pattern, str(args, "path"));
      if (!matches.length) return { observation: `No files match "${pattern}".` };
      return { observation: truncate(matches.join("\n")) };
    },
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @xprei/core`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent/tools.ts packages/core/src/agent/tools.test.ts
git commit -m "feat(core): add glob_search agent tool"
```

---

### Task 7: `view_diff` tool

**Files:**
- Modify: `packages/core/src/agent/tools.ts`
- Modify: `packages/core/src/agent/tools.test.ts`

**Interfaces:**
- Consumes: `AgentHost.exec()` (existing), `truncate()` helper.
- Produces: a `"view_diff"` entry in the `TOOLS` array.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/core/src/agent/tools.test.ts — append:
test("view_diff runs git diff HEAD and returns its stdout", async () => {
  const host = new FakeHost();
  host.execResult = { stdout: "diff --git a/x.ts b/x.ts\n+added line\n", stderr: "", code: 0 };
  const r = await tool("view_diff").run({}, host);
  assert.deepEqual(host.execCalls, ["git diff HEAD"]);
  assert.match(r.observation, /added line/);
});

test("view_diff reports no changes on empty stdout", async () => {
  const host = new FakeHost();
  host.execResult = { stdout: "", stderr: "", code: 0 };
  const r = await tool("view_diff").run({}, host);
  assert.match(r.observation, /No changes/);
});

test("view_diff surfaces stderr on a nonzero exit code", async () => {
  const host = new FakeHost();
  host.execResult = { stdout: "", stderr: "fatal: not a git repository", code: 128 };
  const r = await tool("view_diff").run({}, host);
  assert.match(r.observation, /not a git repository/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @xprei/core`
Expected: FAIL — `tool("view_diff")` is `undefined`.

- [ ] **Step 3: Implement the tool**

```typescript
// packages/core/src/agent/tools.ts — add to the TOOLS array, after "run_terminal":
  {
    name: "view_diff",
    description: "Show the current git diff (working tree + staged changes vs HEAD).",
    args: "{}",
    mutating: false,
    async run(_args, host) {
      const r = await host.exec("git diff HEAD");
      if (!r.stdout.trim() && !r.stderr.trim()) return { observation: "No changes." };
      const parts: string[] = [];
      if (r.stdout.trim()) parts.push(r.stdout.trim());
      if (r.stderr.trim()) parts.push(`stderr:\n${r.stderr.trim()}`);
      return { observation: truncate(parts.join("\n")) };
    },
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @xprei/core`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent/tools.ts packages/core/src/agent/tools.test.ts
git commit -m "feat(core): add view_diff agent tool"
```

---

### Task 8: Full verification pass

**Files:** none (verification only).

**Interfaces:** none — this task consumes everything built in Tasks 1–7 and
confirms it holds together as a whole.

- [ ] **Step 1: Run the full core test suite**

Run: `npm test -w @xprei/core`
Expected: PASS — original count (97) plus all new tests from Tasks 1, 3, 5,
6, 7 (8 + 3 + 5 + 4 + 3 = 23 new tests, 120 total).

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
`extensions/vscode`), open the agent chat, and in a real workspace ask the
agent to:
1. Use `read_file_range` to read lines 1–5 of any file.
2. Use `glob_search` for `**/*.ts` and confirm results look right and
   `node_modules`/`dist` are absent.
3. Make an edit, then use `view_diff` and confirm the diff appears in the
   agent's context.

If all three tools behave as expected, no further action needed — this task
has no commit of its own (nothing new is written, Task 5–7 commits already
cover the code).
