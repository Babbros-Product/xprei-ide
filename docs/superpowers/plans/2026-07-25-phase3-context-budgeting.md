# Phase 3 Context-Window Budgeting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Size the `@codebase`/`@file:` context block against the resolved
provider's `contextWindow` instead of blindly concatenating, per
`docs/superpowers/specs/2026-07-25-phase3-context-budgeting-design.md`.

**Architecture:** One new pure `@xprei/core` module (`budget.ts`) that fits
files and search hits into a char budget derived from `contextWindow`,
consumed by a small retrofit of `contextEngine.ts`'s `buildContext()` and
its one call site in `chatView.ts`.

**Tech Stack:** TypeScript. No new dependencies (char-count heuristic, no
tokenizer).

## Global Constraints

- No new runtime dependencies — `CHARS_PER_TOKEN = 4` is a hand-written
  heuristic constant, matching the project's dependency-free philosophy.
- `budgetContext`'s exact algorithm (files-then-hits priority,
  skip-and-continue for hits, `CONTEXT_BLOCK_FRACTION = 0.5`) is locked by
  the spec — do not deviate.
- `retrieval.ts`'s `formatFiles`/`formatHits` keep their current
  signatures — no changes to those functions or their existing tests.
  `contextEngine.ts` calls `formatFiles` with `Number.POSITIVE_INFINITY`
  as the `maxChars` override so its old 8000-char default can't
  double-truncate already-budgeted content.
- **No user-facing docs update in this plan.** This phase has no new
  command, setting, or visible toggle — it's an invisible behavior change
  (the context block is sized more sensibly under the hood, with no new
  surface for a user to learn). The `CLAUDE.md` docs convention applies to
  plans that add or change a *user-facing* feature; this one doesn't, so
  `extensions/vscode/README.md` and the root `README.md` are intentionally
  not touched here.
- `packages/core` is source-only; every new test file must be added to the
  `test` script list in `packages/core/package.json`.
- `extensions/vscode` has no unit tests by existing convention — its two
  tasks are verified by `npm run typecheck -w xpreiIDE-ai` (the final task
  also by `npm run compile -w xpreiIDE-ai`), not an automated suite.
- **Commits:** author `xpreiIDE <mbsajay1@gmail.com>` — pass it explicitly,
  e.g. `git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "..."`.
  **Do NOT add a `Co-Authored-By` footer or any other footer.** Conventional
  Commit prefixes (feat/test/etc).

---

### Task 1: `budget.ts` — the pure budgeting module

**Files:**
- Create: `packages/core/src/context/budget.ts`
- Create: `packages/core/src/context/budget.test.ts`
- Modify: `packages/core/package.json` (add `budget.test.ts` to the `test` script)
- Modify: `packages/core/src/index.ts` (add the barrel export)

**Interfaces:**
- Consumes: `FileContext`, `MIN_SCORE` from `./retrieval`; `SearchHit`
  from `./vectorstore` (both already exist, unchanged).
- Produces: `CHARS_PER_TOKEN: number`, `CONTEXT_BLOCK_FRACTION: number`,
  `interface BudgetedContext { files: FileContext[]; hits: SearchHit[] }`,
  `budgetContext(files: FileContext[], hits: SearchHit[], contextWindow: number): BudgetedContext`
  — Task 2 imports and calls this exact function.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/core/src/context/budget.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { budgetContext, CHARS_PER_TOKEN, CONTEXT_BLOCK_FRACTION } from "./budget";
import { FileContext, MIN_SCORE } from "./retrieval";
import { SearchHit } from "./vectorstore";

function file(path: string, content: string): FileContext {
  return { path, content };
}

function hit(path: string, text: string, score: number): SearchHit {
  return { score, chunk: { id: `${path}#1`, path, startLine: 1, endLine: 1, text } };
}

test("files that fit entirely within budget are returned unchanged", () => {
  const files = [file("a.ts", "x".repeat(100)), file("b.ts", "y".repeat(100))];
  const result = budgetContext(files, [], 10000); // huge window, no truncation expected
  assert.deepEqual(result.files, files);
});

test("a file that overflows the remaining budget is truncated, files after it are dropped", () => {
  // contextWindow=10 tokens * 4 chars/token * 0.5 fraction = 20 char budget.
  // a.ts alone (25 chars) already overflows the 20-char budget, so it gets
  // truncated to fill it exactly; b.ts and c.ts never get a chance.
  const files = [file("a.ts", "x".repeat(25)), file("b.ts", "y".repeat(5)), file("c.ts", "z".repeat(5))];
  const result = budgetContext(files, [], 10);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].path, "a.ts");
  assert.equal(result.files[0].content, "x".repeat(20) + "\n…(truncated)");
});

test("files alone consuming the entire budget leave zero room for hits", () => {
  const files = [file("a.ts", "x".repeat(20))]; // exactly fills a 20-char budget
  const hits = [hit("b.ts", "z".repeat(5), 0.9)];
  const result = budgetContext(files, hits, 10); // budget = 20
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].content, "x".repeat(20));
  assert.deepEqual(result.hits, []);
});

test("a higher-scored hit too large to fit is skipped; a smaller lower-scored hit after it still fits", () => {
  // budget = 10 tokens * 4 * 0.5 = 20 chars
  const hits = [
    hit("big.ts", "x".repeat(25), 0.9), // doesn't fit, skipped
    hit("small.ts", "y".repeat(10), 0.5), // fits, included
  ];
  const result = budgetContext([], hits, 10);
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].chunk.path, "small.ts");
});

test("hits below MIN_SCORE are excluded regardless of size or budget", () => {
  const hits = [hit("a.ts", "x", MIN_SCORE - 0.01)];
  const result = budgetContext([], hits, 1000);
  assert.deepEqual(result.hits, []);
});

test("empty files and hits produce empty output with no errors", () => {
  const result = budgetContext([], [], 8192);
  assert.deepEqual(result, { files: [], hits: [] });
});

test("a contextWindow of 0 yields an empty budget for both files and hits", () => {
  // totalBudget = floor(0 * 4 * 0.5) = 0, so the files loop's very first
  // `if (remaining <= 0) break;` fires immediately — nothing is pushed,
  // not even truncated to zero length.
  const files = [file("a.ts", "x")];
  const hits = [hit("b.ts", "y", 0.9)];
  const result = budgetContext(files, hits, 0);
  assert.deepEqual(result, { files: [], hits: [] });
});

test("CHARS_PER_TOKEN and CONTEXT_BLOCK_FRACTION have the spec's exact values", () => {
  assert.equal(CHARS_PER_TOKEN, 4);
  assert.equal(CONTEXT_BLOCK_FRACTION, 0.5);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @xprei/core` (after Step 5 registers the new file — or
temporarily run `node --import tsx --test src/context/budget.test.ts`
directly from `packages/core` to check this file in isolation first)
Expected: FAIL — `Cannot find module './budget'`.

- [ ] **Step 3: Implement `budget.ts`**

```typescript
// packages/core/src/context/budget.ts
// Fits @file:-inlined files and @codebase hits into a char budget derived
// from the provider's token-count contextWindow. No tokenizer dependency —
// CHARS_PER_TOKEN is a hand-written heuristic, matching this repo's
// dependency-free philosophy (see tools.ts's MAX_OBS for the same pattern).
// Files always win over hits: an explicit @file: request beats a relevance
// guess. The first file that overflows the remaining budget is truncated;
// any files after it are dropped. Remaining budget (if any) goes to hits
// in their existing score-sorted order, skipping (not stopping at) any hit
// too large to fit, so a smaller lower-scored hit still gets a chance.

import { FileContext, MIN_SCORE } from "./retrieval";
import { SearchHit } from "./vectorstore";

export const CHARS_PER_TOKEN = 4;
export const CONTEXT_BLOCK_FRACTION = 0.5;

export interface BudgetedContext {
  files: FileContext[];
  hits: SearchHit[];
}

export function budgetContext(
  files: FileContext[],
  hits: SearchHit[],
  contextWindow: number,
): BudgetedContext {
  const totalBudget = Math.floor(contextWindow * CHARS_PER_TOKEN * CONTEXT_BLOCK_FRACTION);
  let remaining = totalBudget;

  const keptFiles: FileContext[] = [];
  for (const f of files) {
    if (remaining <= 0) break;
    if (f.content.length <= remaining) {
      keptFiles.push(f);
      remaining -= f.content.length;
    } else {
      keptFiles.push({ path: f.path, content: f.content.slice(0, remaining) + "\n…(truncated)" });
      remaining = 0;
      break;
    }
  }

  const eligible = hits.filter((h) => h.score >= MIN_SCORE);
  const keptHits: SearchHit[] = [];
  for (const h of eligible) {
    const size = h.chunk.text.length;
    if (size <= remaining) {
      keptHits.push(h);
      remaining -= size;
    }
  }

  return { files: keptFiles, hits: keptHits };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test src/context/budget.test.ts` (from
`packages/core`)
Expected: all 8 tests PASS.

- [ ] **Step 5: Register the new test file and barrel export**

In `packages/core/package.json`'s `test` script, add
`src/context/budget.test.ts` to the list (place it next to
`src/context/mentions.test.ts` for readability).

In `packages/core/src/index.ts`, add this line next to the other
`./context/*` exports (after `export * from "./context/retrieval";`):

```typescript
export * from "./context/budget";
```

Then run the full suite to confirm nothing else broke:

Run: `npm test -w @xprei/core`
Expected: all tests PASS (existing count + 8 new).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/context/budget.ts packages/core/src/context/budget.test.ts packages/core/package.json packages/core/src/index.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(core): add context-window budgeting utility"
```

---

### Task 2: Retrofit `contextEngine.ts`'s `buildContext()`

**Files:**
- Modify: `extensions/vscode/src/context/contextEngine.ts`

**Interfaces:**
- Consumes: `budgetContext(files, hits, contextWindow): BudgetedContext`
  and `SearchHit` from `@xprei/core` (Task 1).
- Produces: `buildContext(mentions: Mentions, contextWindow: number): Promise<string>`
  — Task 3's call site uses this exact new signature.

- [ ] **Step 1: Add the new imports**

In `extensions/vscode/src/context/contextEngine.ts`, the imports at the
top currently include (lines 10-16):

```typescript
import {
  buildContextMessage,
  FileContext,
  formatFiles,
  formatHits,
} from "@xprei/core";
import { VectorStore } from "@xprei/core";
```

Change the first block to add `budgetContext`, and add a new import for
`SearchHit`:

```typescript
import {
  buildContextMessage,
  budgetContext,
  FileContext,
  formatFiles,
  formatHits,
} from "@xprei/core";
import { VectorStore, SearchHit } from "@xprei/core";
```

- [ ] **Step 2: Widen `buildContext()`'s signature and wire in budgeting**

Replace the existing method (currently lines 136-155):

```typescript
  // Turn parsed mentions into a context message, or "" if nothing to add.
  async buildContext(mentions: Mentions): Promise<string> {
    if (!hasContextRequest(mentions)) return "";
    await this.load();

    const files = await this.readFiles(mentions.files);
    let retrieved = "";

    if (mentions.codebase && this.store.size > 0 && mentions.cleaned) {
      const embedder = await this.embedder();
      if (embedder && embedder.key === this.store.modelKey) {
        const [qv] = await embedder.embed([mentions.cleaned]);
        if (qv) retrieved = formatHits(this.store.search(qv, RETRIEVE_K));
      }
    }

    return buildContextMessage({
      files: files.length ? formatFiles(files) : undefined,
      retrieved: retrieved || undefined,
    });
  }
```

with:

```typescript
  // Turn parsed mentions into a context message, or "" if nothing to add.
  // contextWindow is the resolved provider's token-count capability — used
  // to size the context block via budgetContext() instead of blindly
  // concatenating everything the mentions resolved to.
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

    const budgeted = budgetContext(files, hits, contextWindow);

    return buildContextMessage({
      files: budgeted.files.length ? formatFiles(budgeted.files, Number.POSITIVE_INFINITY) : undefined,
      retrieved: budgeted.hits.length ? formatHits(budgeted.hits) : undefined,
    });
  }
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck -w xpreiIDE-ai`
Expected: FAIL — the one existing call site in `chatView.ts` (Task 3
fixes it) now passes only 1 argument to a function requiring 2.

- [ ] **Step 4: Commit**

```bash
git add extensions/vscode/src/context/contextEngine.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(vscode): wire budgetContext into contextEngine's buildContext"
```

(Committing with a known typecheck failure is expected here — Task 3
fixes the one call site immediately next. This mirrors how earlier phases
in this repo sequenced an interface change before its consumer.)

---

### Task 3: Update `chatView.ts`'s call site

**Files:**
- Modify: `extensions/vscode/src/ui/chat/chatView.ts`

**Interfaces:**
- Consumes: `ContextEngine.buildContext(mentions, contextWindow)` from
  Task 2.

- [ ] **Step 1: Pass the resolved provider's `contextWindow`**

In `extensions/vscode/src/ui/chat/chatView.ts`, `onSend()` currently reads
(around line 338):

```typescript
      contextBlock = await this.context.buildContext(parseMentions(trimmed));
```

`resolved` (the already-resolved `{provider, model}` pair) is available
earlier in the same function (around line 323,
`const resolved = await this.registry.resolveActive();` — before this
line). Change the call to:

```typescript
      contextBlock = await this.context.buildContext(
        parseMentions(trimmed),
        resolved.provider.capabilities.contextWindow,
      );
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck -w xpreiIDE-ai`
Expected: PASS — the signature mismatch from Task 2 is now resolved.

- [ ] **Step 3: Compile**

Run: `npm run compile -w xpreiIDE-ai`
Expected: PASS, `dist/extension.js` rebuilt.

- [ ] **Step 4: Commit**

```bash
git add extensions/vscode/src/ui/chat/chatView.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(vscode): pass the resolved provider's contextWindow into buildContext"
```

---

### Task 4: Final verification

**Files:** none (verification only).

**Interfaces:** none — consumes everything built in Tasks 1-3.

- [ ] **Step 1: Run the full core test suite**

Run: `npm test -w @xprei/core`
Expected: PASS — original count plus 8 new `budget.test.ts` tests.

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
`extensions/vscode`), in a real workspace with `@codebase` indexed:

1. Configure an Ollama provider (small `contextWindow`, e.g. 8192) as the
   active chat model. Send a chat message with `@codebase <a broad query
   likely to surface several chunks>` and `@file:` on a couple of large
   files. Confirm the request still completes normally (no crash, no
   obviously-truncated-mid-sentence garbage breaking the response) and,
   if you have a way to inspect the outgoing request (e.g. a debug log or
   breakpoint in `chatStream`), confirm the context block is noticeably
   smaller than it would be if every hit/file were included whole.
2. Switch the active chat model to a large-`contextWindow` OpenAI-compat
   provider (e.g. 128000) and repeat the same `@codebase`/`@file:` message.
   Confirm more (or all) of the same content now fits — the context block
   should be visibly larger than in the small-window case.
3. Send a plain message with no `@codebase`/`@file:` mention and confirm
   chat still works exactly as before (empty context block, no regression
   to plain chat).

If all three checks behave as expected, no further action needed — this
task has no commit of its own.
