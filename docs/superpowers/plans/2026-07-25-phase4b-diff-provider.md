# Phase 4b Diff Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `@diff` (inline the current staged + unstaged git diff) as a
new chat context mention, per
`docs/superpowers/specs/2026-07-25-phase4b-diff-provider-design.md`.

**Architecture:** Extract `commitMessage.ts`'s existing `vscode.git`-API
lookup into a shared `gitApi.ts` module. `mentions.ts` gains a `diff` flag.
`retrieval.ts` gains `formatDiff` and a widened `buildContextMessage`.
`contextEngine.ts` gains a `readDiff()` method and a fifth `SegmentTier` in
`buildContext()`, consumed by Phase 4 Foundation's `budgetContext()`
exactly like the existing four tiers.

**Tech Stack:** TypeScript, the built-in `vscode.git` extension API. No
new dependencies, no `child_process`.

## Global Constraints

- **Reuse `vscode.git`'s API, never shell exec.** `ContextEngine` gets no
  `child_process`/`AgentHost` seam added — `readDiff()` goes through the
  same `Repository.diff(cached?: boolean)` call `commitMessage.ts`
  already uses.
- **Staged + unstaged combined**, via `repo.diff(false)` (unstaged) and
  `repo.diff(true)` (staged), concatenated — matching Phase 1's
  `view_diff` agent tool's `git diff HEAD` semantics.
- **One single segment, `"break"` strategy.** A diff is not split into
  multiple segments — the whole thing is one segment in the tier.
- **Tier priority is locked, extending Phase 4a's order:** `@file:`
  (`"break"`, highest) → `@problems` (`"skip"`) → `@diff` (`"break"`) →
  `@open` (`"break"`) → `@codebase` hits (`"skip"`, lowest). Do not
  reorder.
- **Every tier is built unconditionally** (empty segments array when its
  mention isn't present) — per Phase 4 Foundation's documented
  positional-alignment invariant on `budgetContext`'s return value. Never
  conditionally push a tier.
- **Silent-empty on every "nothing to show" case** — no git repo, clean
  working tree, `vscode.git` extension unavailable. No warning toast (that
  pattern belongs to `commitMessage.ts`'s one-shot command, not a chat
  mention).
- **`commitMessage.ts`'s own behavior is unchanged** — only its git-API
  lookup moves to the new shared module.
- `packages/core` is source-only; extended test files don't need
  re-registering (both `mentions.test.ts` and `retrieval.test.ts` are
  already in `packages/core/package.json`'s `test` script from Phase 4a).
- `extensions/vscode` has no unit tests by existing convention — its two
  tasks are verified by `npm run typecheck -w xpreiIDE-ai` +
  `npm run compile -w xpreiIDE-ai` + manual smoke.
- **User-facing docs stay current** (`CLAUDE.md` convention): `@diff` is
  a new chat mention users can type directly — both
  `extensions/vscode/README.md` and the root `README.md`'s Features list
  must be updated, per Task 4.
- **Commits:** author `xpreiIDE <mbsajay1@gmail.com>` — pass it explicitly,
  e.g. `git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "..."`.
  **Do NOT add a `Co-Authored-By` footer or any other footer.** Conventional
  Commit prefixes (feat/refactor/test/docs/etc).

---

### Task 1: Extract the shared `gitApi.ts` module

**Files:**
- Create: `extensions/vscode/src/git/gitApi.ts`
- Modify: `extensions/vscode/src/git/commitMessage.ts`

**Interfaces:**
- Produces: `interface GitRepository { inputBox: { value: string }; diff(cached?: boolean): Promise<string> }`,
  `interface GitAPI { repositories: GitRepository[] }`,
  `interface GitExtensionExports { getAPI(version: 1): GitAPI }`,
  `getGitApi(): Promise<GitAPI | undefined>` — Task 3 consumes
  `getGitApi()` and `GitAPI`/`GitRepository`.

- [ ] **Step 1: Create the new module**

Create `extensions/vscode/src/git/gitApi.ts` with exactly this content:

```typescript
// Ambient typing for the subset of the built-in "vscode.git" extension's
// API this codebase uses — that extension ships no public .d.ts. Shared
// by commitMessage.ts (SCM commit-message generation) and
// contextEngine.ts (the @diff chat mention).

import * as vscode from "vscode";

export interface GitRepository {
  inputBox: { value: string };
  diff(cached?: boolean): Promise<string>;
}
export interface GitAPI {
  repositories: GitRepository[];
}
export interface GitExtensionExports {
  getAPI(version: 1): GitAPI;
}

export async function getGitApi(): Promise<GitAPI | undefined> {
  const ext = vscode.extensions.getExtension<GitExtensionExports>("vscode.git");
  if (!ext) return undefined;
  const exports = ext.isActive ? ext.exports : await ext.activate();
  return exports.getAPI(1);
}
```

- [ ] **Step 2: Update `commitMessage.ts` to import from the new module**

In `extensions/vscode/src/git/commitMessage.ts`, the file currently opens
with (lines 1-26):

```typescript
// Generate a commit message from the staged diff via VS Code's built-in Git
// extension API and the active model, writing straight into the SCM input box.

import * as vscode from "vscode";
import { ProviderRegistry } from "../providers/registry";
import { stripCodeFences } from "@xprei/core";

// Minimal ambient typing for the subset of the built-in "vscode.git"
// extension's API this module uses — that extension ships no public .d.ts.
interface GitRepository {
  inputBox: { value: string };
  diff(cached?: boolean): Promise<string>;
}
interface GitAPI {
  repositories: GitRepository[];
}
interface GitExtensionExports {
  getAPI(version: 1): GitAPI;
}

async function getGitApi(): Promise<GitAPI | undefined> {
  const ext = vscode.extensions.getExtension<GitExtensionExports>("vscode.git");
  if (!ext) return undefined;
  const exports = ext.isActive ? ext.exports : await ext.activate();
  return exports.getAPI(1);
}
```

Replace all of that with:

```typescript
// Generate a commit message from the staged diff via VS Code's built-in Git
// extension API and the active model, writing straight into the SCM input box.

import * as vscode from "vscode";
import { ProviderRegistry } from "../providers/registry";
import { stripCodeFences } from "@xprei/core";
import { getGitApi } from "./gitApi";
```

Everything below that point in the file (the `SYSTEM_PROMPT` constant
onward) is unchanged — this step only removes the now-duplicated
ambient-typing block and the local `getGitApi` function, replacing them
with an import from the new module.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck -w xpreiIDE-ai`
Expected: PASS.

- [ ] **Step 4: Compile**

Run: `npm run compile -w xpreiIDE-ai`
Expected: PASS, `dist/extension.js` rebuilt.

- [ ] **Step 5: Commit**

```bash
git add extensions/vscode/src/git/gitApi.ts extensions/vscode/src/git/commitMessage.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "refactor(vscode): extract shared vscode.git API lookup into gitApi.ts"
```

---

### Task 2: `mentions.ts` — parse `@diff`; `retrieval.ts` — `formatDiff` + widened `buildContextMessage`

**Files:**
- Modify: `packages/core/src/context/mentions.ts`
- Modify: `packages/core/src/context/mentions.test.ts`
- Modify: `packages/core/src/context/retrieval.ts`
- Modify: `packages/core/src/context/retrieval.test.ts`

**Interfaces:**
- Produces: `interface Mentions { codebase: boolean; open: boolean; problems: boolean; diff: boolean; files: string[]; cleaned: string }`
  — `diff` is new; `hasContextRequest(m)` now also returns `true` when
  `m.diff` is set.
- Produces: `formatDiff(diff: string): string`,
  `buildContextMessage(parts: { retrieved?: string; files?: string; problems?: string; diff?: string }): string`
  — Task 3 consumes both.

- [ ] **Step 1: Write the failing mentions tests**

Append to `packages/core/src/context/mentions.test.ts`:

```typescript
test("@diff sets the flag and is stripped from the query", () => {
  const m = parseMentions("what changed @diff exactly");
  assert.equal(m.diff, true);
  assert.equal(m.cleaned, "what changed exactly");
  assert.ok(hasContextRequest(m));
});

test("@diff combines with @open, @problems, @codebase, and @file:", () => {
  const m = parseMentions("@diff @open @problems @codebase check @file:a.ts too");
  assert.equal(m.diff, true);
  assert.equal(m.open, true);
  assert.equal(m.problems, true);
  assert.equal(m.codebase, true);
  assert.deepEqual(m.files, ["a.ts"]);
  assert.equal(m.cleaned, "check too");
});

test("diff flag is false when absent", () => {
  const m = parseMentions("just a normal question");
  assert.equal(m.diff, false);
});
```

- [ ] **Step 2: Run mentions tests to verify they fail**

Run: `node --import tsx --test src/context/mentions.test.ts` (from
`packages/core`)
Expected: FAIL — `m.diff` is `undefined`, not `false`/`true` as asserted.

- [ ] **Step 3: Implement the `diff` flag**

In `packages/core/src/context/mentions.ts`, update the header comment,
interface, regexes, `parseMentions`, and `hasContextRequest`:

```typescript
// Parse @-mentions out of a chat message. Pure module — no vscode.
//   @codebase          → run semantic retrieval over the index
//   @file:src/a.ts     → inline that exact file
//   @path/to/file.ts   → shorthand for @file when it has an extension/slash
//   @open              → inline every currently-open editor tab
//   @problems          → inline error/warning diagnostics from open files
//   @diff              → inline the current staged + unstaged git diff
// The remaining prose (mentions stripped) is what we embed for retrieval.

export interface Mentions {
  codebase: boolean;
  open: boolean;
  problems: boolean;
  diff: boolean;
  files: string[];
  // Message with mention tokens removed, used as the retrieval query.
  cleaned: string;
}

const CODEBASE_RE = /(^|\s)@codebase\b/gi;
const OPEN_RE = /(^|\s)@open\b/gi;
const PROBLEMS_RE = /(^|\s)@problems\b/gi;
const DIFF_RE = /(^|\s)@diff\b/gi;
const FILE_RE = /(^|\s)@file:(\S+)/gi;
// Bare @path shorthand: token containing a slash or a dotted extension.
const BARE_PATH_RE = /(^|\s)@((?:[\w.\-]+\/)+[\w.\-]+|[\w.\-]+\.[\w]+)/g;

export function parseMentions(text: string): Mentions {
  const files: string[] = [];
  let codebase = false;
  let open = false;
  let problems = false;
  let diff = false;
  let cleaned = text;

  cleaned = cleaned.replace(CODEBASE_RE, (_m, pre) => {
    codebase = true;
    return pre;
  });

  cleaned = cleaned.replace(OPEN_RE, (_m, pre) => {
    open = true;
    return pre;
  });

  cleaned = cleaned.replace(PROBLEMS_RE, (_m, pre) => {
    problems = true;
    return pre;
  });

  cleaned = cleaned.replace(DIFF_RE, (_m, pre) => {
    diff = true;
    return pre;
  });

  cleaned = cleaned.replace(FILE_RE, (_m, pre: string, path: string) => {
    files.push(path);
    return pre;
  });

  cleaned = cleaned.replace(BARE_PATH_RE, (_m, pre: string, path: string) => {
    files.push(path);
    return pre;
  });

  return {
    codebase,
    open,
    problems,
    diff,
    files: [...new Set(files)],
    cleaned: cleaned.replace(/\s+/g, " ").trim(),
  };
}

export function hasContextRequest(m: Mentions): boolean {
  return m.codebase || m.open || m.problems || m.diff || m.files.length > 0;
}
```

- [ ] **Step 4: Run mentions tests to verify they pass**

Run: `node --import tsx --test src/context/mentions.test.ts` (from
`packages/core`)
Expected: all tests PASS (9 pre-existing + 3 new = 12).

- [ ] **Step 5: Write the failing retrieval tests**

Append to `packages/core/src/context/retrieval.test.ts`:

```typescript
test("formatDiff wraps the diff text with a header comment", () => {
  const out = formatDiff("diff --git a/x.ts b/x.ts\n+added line");
  assert.equal(out, "// Current git diff:\ndiff --git a/x.ts b/x.ts\n+added line");
});

test("buildContextMessage assembles files, problems, diff, and retrieved in that order", () => {
  const out = buildContextMessage({
    files: "// FILE: a.ts\ncontent",
    problems: "// a.ts:1 (error) bad",
    diff: "// Current git diff:\ndiff --git a/x.ts b/x.ts",
    retrieved: "// a.ts:1-2 (score 0.90)\ncode",
  });
  assert.equal(
    out,
    "The user referenced workspace context. Use it to answer.\n\n" +
      "// FILE: a.ts\ncontent\n\n" +
      "// a.ts:1 (error) bad\n\n" +
      "// Current git diff:\ndiff --git a/x.ts b/x.ts\n\n" +
      "// Relevant code from the workspace:\n// a.ts:1-2 (score 0.90)\ncode",
  );
});

test("buildContextMessage with only diff present produces just the diff section", () => {
  const out = buildContextMessage({ diff: "// Current git diff:\nsome diff" });
  assert.equal(
    out,
    "The user referenced workspace context. Use it to answer.\n\n// Current git diff:\nsome diff",
  );
});
```

Also update the import line at the top of `retrieval.test.ts` to add
`formatDiff` to the existing named-import list from `./retrieval`.

- [ ] **Step 6: Run retrieval tests to verify they fail**

Run: `node --import tsx --test src/context/retrieval.test.ts` (from
`packages/core`)
Expected: FAIL — `formatDiff` doesn't exist yet, and the `buildContextMessage`
calls with a `diff` key don't match its current parameter type.

- [ ] **Step 7: Implement `formatDiff` and widen `buildContextMessage`**

In `packages/core/src/context/retrieval.ts`, add `formatDiff` immediately
after the existing `formatProblems` function:

```typescript
export function formatDiff(diff: string): string {
  return `// Current git diff:\n${diff}`;
}
```

Then replace the existing `buildContextMessage` function:

```typescript
// Assemble the final context message the chat prepends before the user turn.
export function buildContextMessage(parts: {
  retrieved?: string;
  files?: string;
  problems?: string;
}): string {
  const sections: string[] = [];
  if (parts.files) sections.push(parts.files);
  if (parts.problems) sections.push(parts.problems);
  if (parts.retrieved) sections.push("// Relevant code from the workspace:\n" + parts.retrieved);
  if (sections.length === 0) return "";
  return (
    "The user referenced workspace context. Use it to answer.\n\n" +
    sections.join("\n\n")
  );
}
```

with:

```typescript
// Assemble the final context message the chat prepends before the user turn.
export function buildContextMessage(parts: {
  retrieved?: string;
  files?: string;
  problems?: string;
  diff?: string;
}): string {
  const sections: string[] = [];
  if (parts.files) sections.push(parts.files);
  if (parts.problems) sections.push(parts.problems);
  if (parts.diff) sections.push(parts.diff);
  if (parts.retrieved) sections.push("// Relevant code from the workspace:\n" + parts.retrieved);
  if (sections.length === 0) return "";
  return (
    "The user referenced workspace context. Use it to answer.\n\n" +
    sections.join("\n\n")
  );
}
```

- [ ] **Step 8: Run retrieval tests to verify they pass**

Run: `node --import tsx --test src/context/retrieval.test.ts` (from
`packages/core`)
Expected: all tests PASS (9 pre-existing + 3 new = 12).

- [ ] **Step 9: Run the full core suite**

Run: `npm test -w @xprei/core`
Expected: PASS — previous total (148) + 3 new `mentions.test.ts` tests +
3 new `retrieval.test.ts` tests = 154.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/context/mentions.ts packages/core/src/context/mentions.test.ts packages/core/src/context/retrieval.ts packages/core/src/context/retrieval.test.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(core): parse @diff mention, add formatDiff, widen buildContextMessage"
```

---

### Task 3: `contextEngine.ts` — `readDiff()` and the fifth tier

**Files:**
- Modify: `extensions/vscode/src/context/contextEngine.ts`

**Interfaces:**
- Consumes: `getGitApi`, `GitAPI` from `./gitApi` (Task 1, same-directory-
  tree relative import, e.g. `../git/gitApi`); `diff` field on `Mentions`,
  `formatDiff`, widened `buildContextMessage` from `@xprei/core` (Task 2).
- Produces: no change to `buildContext(mentions: Mentions, contextWindow: number): Promise<string>`'s
  public signature — this task only changes the method's internals plus
  one new private method.

- [ ] **Step 1: Update the imports**

In `extensions/vscode/src/context/contextEngine.ts`, the imports
currently read (lines 6-21):

```typescript
import * as vscode from "vscode";
import { ProviderRegistry } from "../providers/registry";
import { chunkFile, Chunk } from "@xprei/core";
import { hasContextRequest, Mentions } from "@xprei/core";
import {
  buildContextMessage,
  budgetContext,
  FileContext,
  formatFiles,
  formatHits,
  formatProblems,
  MIN_SCORE,
  ProblemInfo,
  SegmentTier,
  TRUNCATION_MARKER,
} from "@xprei/core";
import { VectorStore, SearchHit } from "@xprei/core";
import { isExcludedPath, SCAN_EXCLUDE } from "@xprei/core";
```

Replace with (adds `formatDiff`; adds the new `../git/gitApi` import;
everything else unchanged):

```typescript
import * as vscode from "vscode";
import { ProviderRegistry } from "../providers/registry";
import { getGitApi } from "../git/gitApi";
import { chunkFile, Chunk } from "@xprei/core";
import { hasContextRequest, Mentions } from "@xprei/core";
import {
  buildContextMessage,
  budgetContext,
  FileContext,
  formatDiff,
  formatFiles,
  formatHits,
  formatProblems,
  MIN_SCORE,
  ProblemInfo,
  SegmentTier,
  TRUNCATION_MARKER,
} from "@xprei/core";
import { VectorStore, SearchHit } from "@xprei/core";
import { isExcludedPath, SCAN_EXCLUDE } from "@xprei/core";
```

- [ ] **Step 2: Add the `readDiff()` method**

Immediately after the existing `readProblems()` method (currently ending
around line 305, right before `resolveRel()`), add:

```typescript
  // The current working-tree state vs. the last commit: unstaged plus
  // staged changes, combined — matches the agent loop's view_diff tool's
  // `git diff HEAD` semantics. "" if there's no git repo, nothing has
  // changed, or the vscode.git extension isn't available.
  private async readDiff(): Promise<string> {
    const api = await getGitApi();
    const repo = api?.repositories[0];
    if (!repo) return "";
    const [unstaged, staged] = await Promise.all([repo.diff(false), repo.diff(true)]);
    return [unstaged, staged].filter(Boolean).join("\n");
  }
```

- [ ] **Step 3: Replace `buildContext()`'s body**

Replace the existing method (currently lines 142-216):

```typescript
  // Turn parsed mentions into a context message, or "" if nothing to add.
  // contextWindow is the resolved provider's token-count capability — used
  // to size the context block via budgetContext() instead of blindly
  // concatenating everything the mentions resolved to. Tier priority
  // (highest to lowest): @file: ("break", explicit request) > @problems
  // ("skip", compact and actionable) > @open ("break", bulkier, ordered
  // like files) > @codebase hits ("skip", a relevance guess). Every tier
  // is built unconditionally (even when empty) — budgetContext's return
  // value is positionally aligned with the input tier array.
  async buildContext(mentions: Mentions, contextWindow: number): Promise<string> {
    if (!hasContextRequest(mentions)) return "";
    await this.load();

    const files = await this.readFiles(mentions.files);
    let hits: SearchHit[] = [];

    if (mentions.codebase && this.store.size > 0 && mentions.cleaned) {
      const embedder = await this.embedder();
      if (embedder && embedder.key === this.store.modelKey) {
        const [qv] = await embedder.embed([mentions.cleaned]);
        if (qv) hits = this.store.search(qv, RETRIEVE_K);
      }
    }

    const openFiles = mentions.open
      ? await this.readOpenFiles(new Set(files.map((f) => f.path)))
      : [];
    const problems = mentions.problems ? this.readProblems() : [];

    const fileTier: SegmentTier = {
      segments: files.map((f) => ({ text: f.content, data: f })),
      strategy: "break",
    };
    const problemTier: SegmentTier = {
      segments: problems.map((p) => ({ text: formatProblems([p]), data: p })),
      strategy: "skip",
    };
    const openTier: SegmentTier = {
      segments: openFiles.map((f) => ({ text: f.content, data: f })),
      strategy: "break",
    };
    const eligibleHits = hits.filter((h) => h.score >= MIN_SCORE);
    const hitTier: SegmentTier = {
      segments: eligibleHits.map((h) => ({ text: h.chunk.text, data: h })),
      strategy: "skip",
    };

    const [keptFileSegs, keptProblemSegs, keptOpenSegs, keptHitSegs] = budgetContext(
      [fileTier, problemTier, openTier, hitTier],
      contextWindow,
    );

    const budgetedFiles: FileContext[] = keptFileSegs.map((seg) => ({
      ...(seg.data as FileContext),
      content: seg.text,
    }));
    // "skip" never truncates a whole diagnostic (each one is its own
    // segment), so seg.data is used raw.
    const budgetedProblems: ProblemInfo[] = keptProblemSegs.map((seg) => seg.data as ProblemInfo);
    const budgetedOpenFiles: FileContext[] = keptOpenSegs.map((seg) => ({
      ...(seg.data as FileContext),
      content: seg.text,
    }));
    // "skip" never truncates, so seg.text === chunk.text and data can be used raw.
    // If this tier ever becomes "break", reconstruct from seg.text like files do.
    const budgetedHits: SearchHit[] = keptHitSegs.map((seg) => seg.data as SearchHit);

    const allFiles = [...budgetedFiles, ...budgetedOpenFiles];

    return buildContextMessage({
      files: allFiles.length ? formatFiles(allFiles, Number.POSITIVE_INFINITY) : undefined,
      problems: budgetedProblems.length ? formatProblems(budgetedProblems) : undefined,
      retrieved: budgetedHits.length ? formatHits(budgetedHits, Number.NEGATIVE_INFINITY) : undefined,
    });
  }
```

with:

```typescript
  // Turn parsed mentions into a context message, or "" if nothing to add.
  // contextWindow is the resolved provider's token-count capability — used
  // to size the context block via budgetContext() instead of blindly
  // concatenating everything the mentions resolved to. Tier priority
  // (highest to lowest): @file: ("break", explicit request) > @problems
  // ("skip", compact and actionable) > @diff ("break", one segment) >
  // @open ("break", bulkier, ordered like files) > @codebase hits
  // ("skip", a relevance guess). Every tier is built unconditionally
  // (even when empty) — budgetContext's return value is positionally
  // aligned with the input tier array.
  async buildContext(mentions: Mentions, contextWindow: number): Promise<string> {
    if (!hasContextRequest(mentions)) return "";
    await this.load();

    const files = await this.readFiles(mentions.files);
    let hits: SearchHit[] = [];

    if (mentions.codebase && this.store.size > 0 && mentions.cleaned) {
      const embedder = await this.embedder();
      if (embedder && embedder.key === this.store.modelKey) {
        const [qv] = await embedder.embed([mentions.cleaned]);
        if (qv) hits = this.store.search(qv, RETRIEVE_K);
      }
    }

    const openFiles = mentions.open
      ? await this.readOpenFiles(new Set(files.map((f) => f.path)))
      : [];
    const problems = mentions.problems ? this.readProblems() : [];
    const diff = mentions.diff ? await this.readDiff() : "";

    const fileTier: SegmentTier = {
      segments: files.map((f) => ({ text: f.content, data: f })),
      strategy: "break",
    };
    const problemTier: SegmentTier = {
      segments: problems.map((p) => ({ text: formatProblems([p]), data: p })),
      strategy: "skip",
    };
    const diffTier: SegmentTier = {
      segments: diff ? [{ text: formatDiff(diff), data: null }] : [],
      strategy: "break",
    };
    const openTier: SegmentTier = {
      segments: openFiles.map((f) => ({ text: f.content, data: f })),
      strategy: "break",
    };
    const eligibleHits = hits.filter((h) => h.score >= MIN_SCORE);
    const hitTier: SegmentTier = {
      segments: eligibleHits.map((h) => ({ text: h.chunk.text, data: h })),
      strategy: "skip",
    };

    const [keptFileSegs, keptProblemSegs, keptDiffSegs, keptOpenSegs, keptHitSegs] = budgetContext(
      [fileTier, problemTier, diffTier, openTier, hitTier],
      contextWindow,
    );

    const budgetedFiles: FileContext[] = keptFileSegs.map((seg) => ({
      ...(seg.data as FileContext),
      content: seg.text,
    }));
    // "skip" never truncates a whole diagnostic (each one is its own
    // segment), so seg.data is used raw.
    const budgetedProblems: ProblemInfo[] = keptProblemSegs.map((seg) => seg.data as ProblemInfo);
    // "break" may have truncated this — always reconstruct from seg.text,
    // not from the original (untruncated) diff string.
    const budgetedDiff: string | undefined = keptDiffSegs[0]?.text;
    const budgetedOpenFiles: FileContext[] = keptOpenSegs.map((seg) => ({
      ...(seg.data as FileContext),
      content: seg.text,
    }));
    // "skip" never truncates, so seg.text === chunk.text and data can be used raw.
    // If this tier ever becomes "break", reconstruct from seg.text like files do.
    const budgetedHits: SearchHit[] = keptHitSegs.map((seg) => seg.data as SearchHit);

    const allFiles = [...budgetedFiles, ...budgetedOpenFiles];

    return buildContextMessage({
      files: allFiles.length ? formatFiles(allFiles, Number.POSITIVE_INFINITY) : undefined,
      problems: budgetedProblems.length ? formatProblems(budgetedProblems) : undefined,
      diff: budgetedDiff,
      retrieved: budgetedHits.length ? formatHits(budgetedHits, Number.NEGATIVE_INFINITY) : undefined,
    });
  }
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck -w xpreiIDE-ai`
Expected: PASS.

- [ ] **Step 5: Compile**

Run: `npm run compile -w xpreiIDE-ai`
Expected: PASS, `dist/extension.js` rebuilt.

- [ ] **Step 6: Commit**

```bash
git add extensions/vscode/src/context/contextEngine.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(vscode): gather the git diff into the @diff context tier"
```

---

### Task 4: User-facing docs

**Files:**
- Modify: `extensions/vscode/README.md`
- Modify: `README.md`

**Interfaces:** none — documentation only. Required by the `CLAUDE.md`
convention: this phase adds a new chat mention users can type directly.

- [ ] **Step 1: Update the "Codebase context (@mentions)" section in `extensions/vscode/README.md`**

That section currently ends with (search for "Combine any of these in
one message"):

```markdown
Two more mentions need no indexing at all:
- **`@open`** — inline every file you currently have open in an editor tab
  (including background tabs you're not looking at right now).
- **`@problems`** — inline the current error/warning diagnostics for your
  open files, so the model can see what's broken without you pasting it in.

Combine any of these in one message, e.g. `@open @problems why is this failing?`.
```

Replace it with:

```markdown
Three more mentions need no indexing at all:
- **`@open`** — inline every file you currently have open in an editor tab
  (including background tabs you're not looking at right now).
- **`@problems`** — inline the current error/warning diagnostics for your
  open files, so the model can see what's broken without you pasting it in.
- **`@diff`** — inline your current git diff (staged and unstaged
  changes combined), so the model can review or explain your in-progress
  work without you copy-pasting a diff.

Combine any of these in one message, e.g. `@diff @problems review my changes`.
```

- [ ] **Step 2: Update the root `README.md`'s Features list**

The existing bullet (search for `**Codebase-aware context**`) currently
reads:

```markdown
- **Codebase-aware context** — `@codebase` semantic retrieval, `@file:`
  mentions, `@open` (every open tab), and `@problems` (current
  error/warning diagnostics).
```

Replace it with:

```markdown
- **Codebase-aware context** — `@codebase` semantic retrieval, `@file:`
  mentions, `@open` (every open tab), `@problems` (current error/warning
  diagnostics), and `@diff` (your current git diff).
```

- [ ] **Step 3: Proofread both files**

Read both changed files back in full and confirm: no broken Markdown
(mismatched list indentation, unclosed formatting), the new content reads
naturally in place, and the "Combine any of these" example sentence still
makes sense with the new mention added.

- [ ] **Step 4: Commit**

```bash
git add extensions/vscode/README.md README.md
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "docs: document @diff mention in both user-facing READMEs"
```

---

### Task 5: Final verification

**Files:** none (verification only).

**Interfaces:** none — consumes everything built in Tasks 1-4.

- [ ] **Step 1: Run the full core test suite**

Run: `npm test -w @xprei/core`
Expected: PASS — 154 tests total (148 before this plan + 3 new
`mentions.test.ts` tests + 3 new `retrieval.test.ts` tests).

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
`extensions/vscode`), in a real git-tracked workspace:

1. Modify a tracked file but don't stage it (unstaged change). Modify a
   different tracked file and `git add` it (staged change). Send a chat
   message containing just `@diff`. Confirm both changes appear in the
   model's context, combined.
2. Send `@diff @problems @open` together and confirm all three sections
   appear, in the order files/open → problems → diff → (retrieved, if
   `@codebase` were also used).
3. `git stash` (or otherwise reach a clean working tree with no staged/
   unstaged changes), then send `@diff` again. Confirm no error is
   surfaced and the response reads as a normal plain chat (no empty diff
   artifact visible in context).
4. Run **xpreiIDE: Generate Commit Message** (the SCM title button, or
   the command palette) against some staged changes and confirm it still
   works exactly as before — this confirms the `gitApi.ts` extraction in
   Task 1 didn't regress `commitMessage.ts`.
5. Send a plain message with no mentions and confirm chat still works
   exactly as before (empty context block, no regression).

If all five checks behave as expected, no further action needed — this
task has no commit of its own.
