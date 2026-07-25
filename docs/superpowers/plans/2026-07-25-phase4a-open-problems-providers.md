# Phase 4a Open+Problems Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `@open` (inline every currently-open editor tab) and
`@problems` (inline error/warning diagnostics from open files) as new
chat context mentions, per
`docs/superpowers/specs/2026-07-25-phase4a-open-problems-providers-design.md`.

**Architecture:** `mentions.ts` gains two new boolean flags. `retrieval.ts`
gains a `ProblemInfo` type + `formatProblems()` formatter (and gets its
first unit test file, backfilling the two existing formatters).
`contextEngine.ts` gains two gathering methods and two more tiers in
`buildContext()`, consumed by Phase 4 Foundation's `budgetContext()`
exactly like the existing file/hit tiers.

**Tech Stack:** TypeScript, VS Code `window.tabGroups` and
`languages.getDiagnostics` APIs. No new dependencies.

## Global Constraints

- **Tier priority is locked by the spec:** `@file:` (`"break"`, highest)
  → `@problems` (`"skip"`) → `@open` (`"break"`) → `@codebase` hits
  (`"skip"`, lowest). Do not reorder.
- **Every tier is built unconditionally** (empty array when its mention
  isn't present) — per Phase 4 Foundation's documented positional-
  alignment invariant on `budgetContext`'s return value. Never
  conditionally push a tier.
- **`@open` de-duplicates against explicit `@file:` mentions** — a file
  that's both open and `@file:`-mentioned is inlined once, via the file
  tier only.
- **`@problems`: Error + Warning severity only, scoped to files currently
  open in a tab.** No Information/Hint. No path-scoped syntax — bare
  `@problems` flag only, matching `@codebase`'s shape.
- **`@open`: all tabs via `vscode.window.tabGroups.all`**, not just
  `visibleTextEditors` — includes background/unfocused tabs.
- `packages/core` is source-only; every new test file must be added to
  the `test` script list in `packages/core/package.json`.
- `extensions/vscode` has no unit tests by existing convention — its one
  task is verified by `npm run typecheck -w xpreiIDE-ai` +
  `npm run compile -w xpreiIDE-ai` + manual smoke.
- **User-facing docs stay current** (`CLAUDE.md` convention): this phase
  adds two new chat mentions users can type directly — both
  `extensions/vscode/README.md` and the root `README.md`'s Features list
  must be updated, per Task 4.
- **Commits:** author `xpreiIDE <mbsajay1@gmail.com>` — pass it explicitly,
  e.g. `git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "..."`.
  **Do NOT add a `Co-Authored-By` footer or any other footer.** Conventional
  Commit prefixes (feat/test/docs/etc).

---

### Task 1: `mentions.ts` — parse `@open` and `@problems`

**Files:**
- Modify: `packages/core/src/context/mentions.ts`
- Modify: `packages/core/src/context/mentions.test.ts`

**Interfaces:**
- Produces: `interface Mentions { codebase: boolean; open: boolean; problems: boolean; files: string[]; cleaned: string }`
  — `open`/`problems` are new fields; `hasContextRequest(m)` now also
  returns `true` when either is set. Task 3 consumes this exact shape.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/context/mentions.test.ts`:

```typescript
test("@open sets the flag and is stripped from the query", () => {
  const m = parseMentions("what's wrong with this @open please");
  assert.equal(m.open, true);
  assert.equal(m.cleaned, "what's wrong with this please");
  assert.ok(hasContextRequest(m));
});

test("@problems sets the flag and is stripped from the query", () => {
  const m = parseMentions("fix the errors @problems now");
  assert.equal(m.problems, true);
  assert.equal(m.cleaned, "fix the errors now");
  assert.ok(hasContextRequest(m));
});

test("@open, @problems, @codebase, and @file: can all be combined", () => {
  const m = parseMentions("@open @problems @codebase check @file:a.ts too");
  assert.equal(m.open, true);
  assert.equal(m.problems, true);
  assert.equal(m.codebase, true);
  assert.deepEqual(m.files, ["a.ts"]);
  assert.equal(m.cleaned, "check too");
});

test("neither @open nor @problems is set when absent", () => {
  const m = parseMentions("just a normal question");
  assert.equal(m.open, false);
  assert.equal(m.problems, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test src/context/mentions.test.ts` (from
`packages/core`)
Expected: FAIL — `m.open`/`m.problems` are `undefined`, not `false`/`true`
as asserted (the `Mentions` interface doesn't have these fields yet).

- [ ] **Step 3: Implement the new flags**

In `packages/core/src/context/mentions.ts`, update the header comment,
interface, regexes, `parseMentions`, and `hasContextRequest`:

```typescript
// Parse @-mentions out of a chat message. Pure module — no vscode.
//   @codebase          → run semantic retrieval over the index
//   @file:src/a.ts     → inline that exact file
//   @path/to/file.ts   → shorthand for @file when it has an extension/slash
//   @open              → inline every currently-open editor tab
//   @problems          → inline error/warning diagnostics from open files
// The remaining prose (mentions stripped) is what we embed for retrieval.

export interface Mentions {
  codebase: boolean;
  open: boolean;
  problems: boolean;
  files: string[];
  // Message with mention tokens removed, used as the retrieval query.
  cleaned: string;
}

const CODEBASE_RE = /(^|\s)@codebase\b/gi;
const OPEN_RE = /(^|\s)@open\b/gi;
const PROBLEMS_RE = /(^|\s)@problems\b/gi;
const FILE_RE = /(^|\s)@file:(\S+)/gi;
// Bare @path shorthand: token containing a slash or a dotted extension.
const BARE_PATH_RE = /(^|\s)@((?:[\w.\-]+\/)+[\w.\-]+|[\w.\-]+\.[\w]+)/g;

export function parseMentions(text: string): Mentions {
  const files: string[] = [];
  let codebase = false;
  let open = false;
  let problems = false;
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
    files: [...new Set(files)],
    cleaned: cleaned.replace(/\s+/g, " ").trim(),
  };
}

export function hasContextRequest(m: Mentions): boolean {
  return m.codebase || m.open || m.problems || m.files.length > 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test src/context/mentions.test.ts` (from
`packages/core`)
Expected: all tests PASS (the 5 pre-existing tests plus the 4 new ones).

- [ ] **Step 5: Run the full core suite**

Run: `npm test -w @xprei/core`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/context/mentions.ts packages/core/src/context/mentions.test.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(core): parse @open and @problems mentions"
```

---

### Task 2: `retrieval.ts` — `ProblemInfo` + `formatProblems`, plus its first unit tests

**Files:**
- Modify: `packages/core/src/context/retrieval.ts`
- Create: `packages/core/src/context/retrieval.test.ts`
- Modify: `packages/core/package.json` (add `retrieval.test.ts` to the `test` script)

**Interfaces:**
- Produces: `interface ProblemInfo { path: string; line: number; severity: "error" | "warning"; message: string }`,
  `formatProblems(problems: ProblemInfo[]): string` — Task 3 consumes both.
- Produces: `buildContextMessage(parts: { retrieved?: string; files?: string; problems?: string }): string`
  — widened with a third optional `problems` parameter; Task 3 uses it.

- [ ] **Step 1: Write the failing tests (new file)**

Create `packages/core/src/context/retrieval.test.ts`:

```typescript
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildContextMessage,
  FileContext,
  formatFiles,
  formatHits,
  formatProblems,
  ProblemInfo,
} from "./retrieval";
import { SearchHit } from "./vectorstore";

test("formatFiles renders each file with a FILE header, joined by blank lines", () => {
  const files: FileContext[] = [
    { path: "a.ts", content: "const a = 1;" },
    { path: "b.ts", content: "const b = 2;" },
  ];
  const out = formatFiles(files);
  assert.equal(out, "// FILE: a.ts\nconst a = 1;\n\n// FILE: b.ts\nconst b = 2;");
});

test("formatFiles truncates content longer than maxChars", () => {
  const files: FileContext[] = [{ path: "big.ts", content: "x".repeat(20) }];
  const out = formatFiles(files, 10);
  assert.match(out, /^\/\/ FILE: big\.ts\nx{10}\n…\(truncated\)$/);
});

test("formatFiles returns an empty string for an empty array", () => {
  assert.equal(formatFiles([]), "");
});

test("formatHits renders each hit with a location/score header, drops hits below minScore", () => {
  const hits: SearchHit[] = [
    { score: 0.9, chunk: { id: "a#1", path: "a.ts", startLine: 1, endLine: 2, text: "code a" } },
    { score: 0.1, chunk: { id: "b#1", path: "b.ts", startLine: 1, endLine: 1, text: "code b" } },
  ];
  const out = formatHits(hits);
  assert.match(out, /a\.ts:1-2 \(score 0\.90\)/);
  assert.doesNotMatch(out, /b\.ts/);
});

test("formatHits returns an empty string when every hit is below minScore", () => {
  const hits: SearchHit[] = [
    { score: 0.05, chunk: { id: "a#1", path: "a.ts", startLine: 1, endLine: 1, text: "x" } },
  ];
  assert.equal(formatHits(hits), "");
});

test("formatProblems renders one line per diagnostic with path, line, severity, message", () => {
  const problems: ProblemInfo[] = [
    { path: "a.ts", line: 12, severity: "error", message: "Type 'string' is not assignable to type 'number'." },
    { path: "b.ts", line: 3, severity: "warning", message: "Unused variable 'x'." },
  ];
  const out = formatProblems(problems);
  assert.equal(
    out,
    "// a.ts:12 (error) Type 'string' is not assignable to type 'number'.\n" +
      "// b.ts:3 (warning) Unused variable 'x'.",
  );
});

test("formatProblems returns an empty string for an empty array", () => {
  assert.equal(formatProblems([]), "");
});

test("buildContextMessage assembles files, problems, and retrieved sections in that order", () => {
  const out = buildContextMessage({
    files: "// FILE: a.ts\ncontent",
    problems: "// a.ts:1 (error) bad",
    retrieved: "// a.ts:1-2 (score 0.90)\ncode",
  });
  assert.equal(
    out,
    "The user referenced workspace context. Use it to answer.\n\n" +
      "// FILE: a.ts\ncontent\n\n" +
      "// a.ts:1 (error) bad\n\n" +
      "// Relevant code from the workspace:\n// a.ts:1-2 (score 0.90)\ncode",
  );
});

test("buildContextMessage returns an empty string when every part is empty", () => {
  assert.equal(buildContextMessage({}), "");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test src/context/retrieval.test.ts` (from
`packages/core`)
Expected: FAIL — `formatProblems`/`ProblemInfo` don't exist yet, and
`buildContextMessage`'s test with `problems` fails since that parameter
isn't implemented.

- [ ] **Step 3: Implement `ProblemInfo`, `formatProblems`, and widen `buildContextMessage`**

Replace the entire contents of `packages/core/src/context/retrieval.ts`
with:

```typescript
// Format retrieved chunks / files / diagnostics into a context block for
// the model prompt. Pure module — no vscode.

import { SearchHit } from "./vectorstore";
import { TRUNCATION_MARKER } from "./budget";

export interface FileContext {
  path: string;
  content: string;
}

export interface ProblemInfo {
  path: string;
  line: number; // 1-based
  severity: "error" | "warning";
  message: string;
}

// Drop hits below this cosine score — weak matches add noise, not signal.
export const MIN_SCORE = 0.2;

export function formatHits(hits: SearchHit[], minScore = MIN_SCORE): string {
  const kept = hits.filter((h) => h.score >= minScore);
  if (kept.length === 0) return "";
  const blocks = kept.map((h) => {
    const loc = `${h.chunk.path}:${h.chunk.startLine}-${h.chunk.endLine}`;
    return `// ${loc} (score ${h.score.toFixed(2)})\n${h.chunk.text}`;
  });
  return blocks.join("\n\n");
}

export function formatFiles(files: FileContext[], maxChars = 8000): string {
  const blocks = files.map((f) => {
    const body = f.content.length > maxChars ? f.content.slice(0, maxChars) + TRUNCATION_MARKER : f.content;
    return `// FILE: ${f.path}\n${body}`;
  });
  return blocks.join("\n\n");
}

export function formatProblems(problems: ProblemInfo[]): string {
  return problems
    .map((p) => `// ${p.path}:${p.line} (${p.severity}) ${p.message}`)
    .join("\n");
}

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

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test src/context/retrieval.test.ts` (from
`packages/core`)
Expected: all 9 tests PASS.

- [ ] **Step 5: Register the new test file and run the full suite**

In `packages/core/package.json`'s `test` script, add
`src/context/retrieval.test.ts` to the list (place it next to
`src/context/mentions.test.ts` for readability).

Run: `npm test -w @xprei/core`
Expected: PASS — previous total (135) + 4 new `mentions.test.ts` tests
(from Task 1) + 9 new `retrieval.test.ts` tests = 148.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/context/retrieval.ts packages/core/src/context/retrieval.test.ts packages/core/package.json
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(core): add formatProblems, widen buildContextMessage, backfill retrieval.ts unit tests"
```

---

### Task 3: `contextEngine.ts` — gather `@open`/`@problems` and wire in the two new tiers

**Files:**
- Modify: `extensions/vscode/src/context/contextEngine.ts`

**Interfaces:**
- Consumes: `ProblemInfo`, `formatProblems`, widened `buildContextMessage`
  from `@xprei/core` (Task 2); `open`/`problems` fields on `Mentions` from
  `@xprei/core` (Task 1); existing `budgetContext`, `SegmentTier`,
  `TRUNCATION_MARKER` (Phase 4 Foundation).
- Produces: no change to `buildContext(mentions: Mentions, contextWindow: number): Promise<string>`'s
  public signature — this task only changes the method's internals plus
  two new private methods.

- [ ] **Step 1: Update the imports**

In `extensions/vscode/src/context/contextEngine.ts`, the imports currently
read (lines 6-21):

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
  MIN_SCORE,
  SegmentTier,
  TRUNCATION_MARKER,
} from "@xprei/core";
import { VectorStore, SearchHit } from "@xprei/core";
import { isExcludedPath, SCAN_EXCLUDE } from "@xprei/core";
```

Replace with (adds `formatProblems`, `ProblemInfo`; everything else
unchanged):

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

- [ ] **Step 2: Add one shared tab-enumeration helper and the two new private gathering methods**

Immediately after the existing `readFiles()` method (currently ending
around line 216, right before `resolveRel()`), add:

```typescript
  // Every open tab's resolved workspace-relative path, across all tab
  // groups (including background ones the user isn't currently looking
  // at). Shared by readOpenFiles() and readProblems() so both derive
  // "what's open" from one vscode.window.tabGroups.all pass.
  private openTabPaths(): { uri: vscode.Uri; path: string }[] {
    const out: { uri: vscode.Uri; path: string }[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText) {
          out.push({ uri: tab.input.uri, path: this.rel(tab.input.uri) });
        }
      }
    }
    return out;
  }

  // Read every open tab's content, excluding any path already covered by
  // an explicit @file: mention (that file is inlined once, via the file
  // tier).
  private async readOpenFiles(excludePaths: Set<string>): Promise<FileContext[]> {
    const out: FileContext[] = [];
    for (const { uri, path } of this.openTabPaths()) {
      if (excludePaths.has(path)) continue;
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const raw = Buffer.from(bytes).toString("utf8");
        const content =
          raw.length > MAX_FILE_CHARS ? raw.slice(0, MAX_FILE_CHARS) + TRUNCATION_MARKER : raw;
        out.push({ path, content });
      } catch {
        // ignore unreadable / missing
      }
    }
    return out;
  }

  // Error/warning diagnostics scoped to files currently open in a tab —
  // "what's broken in front of me right now," not the whole workspace.
  private readProblems(): ProblemInfo[] {
    const openPaths = new Set(this.openTabPaths().map((t) => t.path));

    const out: ProblemInfo[] = [];
    for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
      const path = this.rel(uri);
      if (!openPaths.has(path)) continue;
      for (const d of diagnostics) {
        if (d.severity === vscode.DiagnosticSeverity.Error) {
          out.push({ path, line: d.range.start.line + 1, severity: "error", message: d.message });
        } else if (d.severity === vscode.DiagnosticSeverity.Warning) {
          out.push({ path, line: d.range.start.line + 1, severity: "warning", message: d.message });
        }
      }
    }
    return out;
  }
```

- [ ] **Step 3: Replace `buildContext()`'s body**

Replace the existing method (currently lines 140-186):

```typescript
  // Turn parsed mentions into a context message, or "" if nothing to add.
  // contextWindow is the resolved provider's token-count capability — used
  // to size the context block via budgetContext() instead of blindly
  // concatenating everything the mentions resolved to. Files are a
  // higher-priority "break" tier (explicit user request, truncate-and-stop
  // on overflow); @codebase hits are a lower-priority "skip" tier
  // (relevance guess, skip oversized hits and keep checking smaller ones).
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

    const fileTier: SegmentTier = {
      segments: files.map((f) => ({ text: f.content, data: f })),
      strategy: "break",
    };
    const eligibleHits = hits.filter((h) => h.score >= MIN_SCORE);
    const hitTier: SegmentTier = {
      segments: eligibleHits.map((h) => ({ text: h.chunk.text, data: h })),
      strategy: "skip",
    };

    const [keptFileSegs, keptHitSegs] = budgetContext([fileTier, hitTier], contextWindow);

    const budgetedFiles: FileContext[] = keptFileSegs.map((seg) => ({
      ...(seg.data as FileContext),
      content: seg.text,
    }));
    // "skip" never truncates, so seg.text === chunk.text and data can be used raw.
    // If this tier ever becomes "break", reconstruct from seg.text like files do.
    const budgetedHits: SearchHit[] = keptHitSegs.map((seg) => seg.data as SearchHit);

    return buildContextMessage({
      files: budgetedFiles.length ? formatFiles(budgetedFiles, Number.POSITIVE_INFINITY) : undefined,
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

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck -w xpreiIDE-ai`
Expected: PASS.

- [ ] **Step 5: Compile**

Run: `npm run compile -w xpreiIDE-ai`
Expected: PASS, `dist/extension.js` rebuilt.

- [ ] **Step 6: Commit**

```bash
git add extensions/vscode/src/context/contextEngine.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(vscode): gather @open files and @problems diagnostics into the context block"
```

---

### Task 4: User-facing docs

**Files:**
- Modify: `extensions/vscode/README.md`
- Modify: `README.md`

**Interfaces:** none — documentation only. Required by the `CLAUDE.md`
convention: this phase adds two new chat mentions users can type directly.

- [ ] **Step 1: Update the "Codebase context (@mentions)" section in `extensions/vscode/README.md`**

That section currently reads (search for `## Codebase context (@mentions)`):

```markdown
## Codebase context (@mentions)

Set an embedding model (**xpreiIDE: Select Embedding Model**, e.g.
`ollama-local::nomic-embed-text`), run **xpreiIDE: Rebuild Codebase Index**, then
in chat use `@codebase <question>` for semantic retrieval or `@file:src/x.ts` to
inline a specific file. The index updates as you edit.
```

Replace it with:

```markdown
## Codebase context (@mentions)

Set an embedding model (**xpreiIDE: Select Embedding Model**, e.g.
`ollama-local::nomic-embed-text`), run **xpreiIDE: Rebuild Codebase Index**, then
in chat use `@codebase <question>` for semantic retrieval or `@file:src/x.ts` to
inline a specific file. The index updates as you edit.

Two more mentions need no indexing at all:
- **`@open`** — inline every file you currently have open in an editor tab
  (including background tabs you're not looking at right now).
- **`@problems`** — inline the current error/warning diagnostics for your
  open files, so the model can see what's broken without you pasting it in.

Combine any of these in one message, e.g. `@open @problems why is this failing?`.
```

- [ ] **Step 2: Update the root `README.md`'s Features list**

The existing bullet (search for `**Codebase-aware context**`) currently
reads:

```markdown
- **Codebase-aware context** — `@codebase` semantic retrieval and `@file:` mentions.
```

Replace it with:

```markdown
- **Codebase-aware context** — `@codebase` semantic retrieval, `@file:`
  mentions, `@open` (every open tab), and `@problems` (current
  error/warning diagnostics).
```

- [ ] **Step 3: Proofread both files**

Read both changed files back in full and confirm: no broken Markdown
(mismatched list indentation, unclosed formatting), the new content reads
naturally in place, and no other part of either file needs a matching
update (in particular, confirm the root README's "First-use quickstart"
section doesn't reference the old two-mention set specifically — it
doesn't, it just says "Add / select a model," so no change needed there).

- [ ] **Step 4: Commit**

```bash
git add extensions/vscode/README.md README.md
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "docs: document @open and @problems mentions in both user-facing READMEs"
```

---

### Task 5: Final verification

**Files:** none (verification only).

**Interfaces:** none — consumes everything built in Tasks 1-4.

- [ ] **Step 1: Run the full core test suite**

Run: `npm test -w @xprei/core`
Expected: PASS — 148 tests total (135 before this plan + 4 new
`mentions.test.ts` tests + 9 new `retrieval.test.ts` tests).

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
`extensions/vscode`), in a real workspace:

1. Open 2-3 files, at least one containing a genuine TypeScript error
   (e.g. assign a string to a `number`-typed variable) and at least one
   containing an unused-variable warning. Leave one of the opened files
   in a background/unfocused tab group if your workspace layout supports
   split editors.
2. Send a chat message containing just `@open`. Confirm all currently
   open files' content appears in the model's context (verify via the
   model's response referencing content from the background tab too, not
   just the focused one).
3. Send a chat message containing just `@problems`. Confirm the
   error/warning you introduced appear with the correct file path, line
   number, and severity — and confirm any Information/Hint-level
   diagnostics in those same files do NOT appear.
4. Send `@open @problems @file:<some other file> @codebase <a query>` all
   together. Confirm the response reflects content from all four sources,
   and confirm the file passed via `@file:` doesn't also show up a second
   time via `@open` if it happened to also be open in a tab.
5. Send a plain message with no mentions and confirm chat still works
   exactly as before (empty context block, no regression).

If all five checks behave as expected, no further action needed — this
task has no commit of its own.
