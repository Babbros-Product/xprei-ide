# Phase 4e: @repomap context provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bare `@repomap` chat mention that inlines a lightweight,
regex-based "what's exported where" overview of the workspace (TypeScript/
JavaScript + Python only, v1) as the eighth and last context tier.

**Architecture:** A new pure module (`packages/core/src/context/repomap.ts`)
extracts top-level exported/public symbol names per file via per-language
regex (no AST, no dependency, no cross-file reference graph or ranking).
`mentions.ts` gains a `repomap: boolean` flag parsed the same way `@open`/
`@problems`/`@diff` are. `contextEngine.ts` walks the workspace (capped at
`MAX_REPOMAP_FILES`), runs `extractSymbols()` per file, and feeds the
results into `buildContext()` as a new `"skip"`-strategy tier positioned
after `@open`, before `@codebase` hits.

**Tech Stack:** TypeScript, Node's built-in `node:test` + `assert/strict`
(existing project test runner — no new dependency), VS Code extension API
(`vscode.workspace.findFiles`/`fs`).

## Global Constraints

- **Scope:** deliberately simplified v1 — regex-based extraction only, no
  AST/tree-sitter, no cross-file reference graph, no importance ranking.
  Not full aider parity (explicitly out of scope).
- **Language coverage:** TypeScript/JavaScript (`.ts`, `.tsx`, `.js`,
  `.jsx`) and Python (`.py`) only. Any other extension contributes nothing
  — `extractSymbols()` returns `undefined`, the caller skips the file
  entirely (never lists it with zero symbols).
- **No new dependency.** Regex only, matching every prior Phase 4
  provider's dependency-free constraint.
- **No caching.** Computed fresh on every `@repomap` mention — no
  persistence, no invalidation, no watcher wiring.
- **Capped scan:** `MAX_REPOMAP_FILES = 500` — same defensive-cap spirit
  as the existing `MAX_FILE_BYTES`/`MAX_FILE_CHARS` constants in
  `contextEngine.ts`.
- **Tier shape:** multi-segment, `"skip"` strategy (like `@codebase` hits
  or `@open`'s files) — not a single monolithic blob like `@diff`/
  `@terminal`/`@url`.
- **Tier priority** (highest to lowest, full order after this plan):
  `@file:` (`"break"`) > `@problems` (`"skip"`) > `@diff` (`"break"`) >
  `@terminal` (`"break"`) > `@url` (`"break"`) > `@open` (`"break"`) >
  `@repomap` (`"skip"`) > `@codebase` hits (`"skip"`, lowest). Every tier
  is built unconditionally (even when empty) — `budgetContext()`'s return
  value is positionally aligned with the input tier array.
- **User-facing docs must be updated** in the same set of tasks:
  `extensions/vscode/README.md`'s @mentions section and root `README.md`'s
  Features list — `@repomap` is directly typeable in chat.
- **Commits:** author `xpreiIDE <mbsajay1@gmail.com>` — pass it explicitly,
  e.g. `git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "..."`.
  **Do NOT add a `Co-Authored-By` footer or any other footer.** Conventional
  Commit prefixes (feat/test/docs/etc).

---

### Task 1: `repomap.ts` — pure, fully unit tested

**Files:**
- Create: `packages/core/src/context/repomap.ts`
- Create: `packages/core/src/context/repomap.test.ts`
- Modify: `packages/core/package.json` (register the new test file)
- Modify: `packages/core/src/index.ts` (barrel-export the new module)

**Interfaces:**
- Produces: `interface FileSymbols { path: string; symbols: string[] }` —
  Tasks 2 and 3 both import this type.
- Produces: `extractSymbols(path: string, content: string): FileSymbols | undefined`
  — Task 3 consumes this directly.

- [ ] **Step 1: Write the failing `repomap` tests**

Create `packages/core/src/context/repomap.test.ts`:

```typescript
import assert from "node:assert/strict";
import { test } from "node:test";
import { extractSymbols } from "./repomap";

test("extractSymbols finds an exported function", () => {
  const result = extractSymbols("a.ts", "export function foo() {}\n");
  assert.deepEqual(result, { path: "a.ts", symbols: ["foo"] });
});

test("extractSymbols finds an exported async function", () => {
  const result = extractSymbols("a.ts", "export async function bar() {}\n");
  assert.deepEqual(result, { path: "a.ts", symbols: ["bar"] });
});

test("extractSymbols finds an exported class", () => {
  const result = extractSymbols("a.ts", "export class Baz {}\n");
  assert.deepEqual(result, { path: "a.ts", symbols: ["Baz"] });
});

test("extractSymbols finds an exported interface", () => {
  const result = extractSymbols("a.ts", "export interface Qux {\n  x: number;\n}\n");
  assert.deepEqual(result, { path: "a.ts", symbols: ["Qux"] });
});

test("extractSymbols finds an exported type alias", () => {
  const result = extractSymbols("a.ts", "export type Quux = string;\n");
  assert.deepEqual(result, { path: "a.ts", symbols: ["Quux"] });
});

test("extractSymbols finds an exported const and let", () => {
  const result = extractSymbols("a.ts", "export const corge = 1;\nexport let grault = 2;\n");
  assert.deepEqual(result, { path: "a.ts", symbols: ["corge", "grault"] });
});

test("extractSymbols finds multiple exports across a .js file, in source order", () => {
  const content = "export function a() {}\nexport const b = 1;\nexport class C {}\n";
  const result = extractSymbols("a.js", content);
  assert.deepEqual(result, { path: "a.js", symbols: ["a", "b", "C"] });
});

test("extractSymbols ignores non-exported top-level declarations", () => {
  const result = extractSymbols("a.ts", "function internal() {}\nconst x = 1;\n");
  assert.equal(result, undefined);
});

test("extractSymbols finds top-level Python def and class at column 0", () => {
  const content = "def foo():\n    return 1\n\nclass Bar:\n    pass\n";
  const result = extractSymbols("a.py", content);
  assert.deepEqual(result, { path: "a.py", symbols: ["foo", "Bar"] });
});

test("extractSymbols excludes underscore-prefixed Python names", () => {
  const content = "def _private():\n    pass\n\ndef public():\n    pass\n";
  const result = extractSymbols("a.py", content);
  assert.deepEqual(result, { path: "a.py", symbols: ["public"] });
});

test("extractSymbols excludes indented Python def/class inside a class body", () => {
  const content = "class Outer:\n    def method(self):\n        pass\n";
  const result = extractSymbols("a.py", content);
  assert.deepEqual(result, { path: "a.py", symbols: ["Outer"] });
});

test("extractSymbols returns undefined for an unrecognized extension", () => {
  const result = extractSymbols("README.md", "# Title\n\nSome text.\n");
  assert.equal(result, undefined);
});

test("extractSymbols returns undefined for a recognized extension with zero matches", () => {
  const result = extractSymbols("empty.ts", "// just a comment\nconst x = 1;\n");
  assert.equal(result, undefined);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `packages/core`): `node --import tsx --test src/context/repomap.test.ts`
Expected: FAIL — `./repomap` doesn't exist yet.

- [ ] **Step 3: Implement `repomap.ts`**

Create `packages/core/src/context/repomap.ts`:

```typescript
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `packages/core`): `node --import tsx --test src/context/repomap.test.ts`
Expected: PASS — all 13 tests green.

- [ ] **Step 5: Register the test file and barrel-export the module**

In `packages/core/package.json`, add `src/context/repomap.test.ts` to the
`test` script's file list, immediately after `src/context/htmlStrip.test.ts`.

In `packages/core/src/index.ts`, add immediately after
`export * from "./context/htmlStrip";`:

```typescript
export * from "./context/repomap";
```

- [ ] **Step 6: Run the full core suite to confirm nothing broke**

Run (from `packages/core`): `npm test`
Expected: PASS — 201 tests total (188 before this plan + 13 new
`repomap.test.ts`).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/context/repomap.ts packages/core/src/context/repomap.test.ts packages/core/package.json packages/core/src/index.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(core): add regex-based repo-map symbol extraction (@repomap groundwork)"
```

---

### Task 2: `mentions.ts` @repomap parsing + `retrieval.ts` formatRepoMap/buildContextMessage

**Files:**
- Modify: `packages/core/src/context/mentions.ts`
- Modify: `packages/core/src/context/mentions.test.ts`
- Modify: `packages/core/src/context/retrieval.ts`
- Modify: `packages/core/src/context/retrieval.test.ts`

**Interfaces:**
- Consumes: `FileSymbols` from `./repomap` (Task 1).
- Produces: `Mentions.repomap: boolean` — Task 3 consumes this.
- Produces: `formatRepoMap(files: FileSymbols[]): string` — Task 3
  consumes this.
- Produces: `buildContextMessage(parts)` gains an eighth optional field,
  `repomap?: string` — Task 3 consumes this.

- [ ] **Step 1: Write the failing `mentions.ts` tests**

Add to `packages/core/src/context/mentions.test.ts` (append at the end of
the file):

```typescript
test("@repomap sets the flag and is stripped from the query", () => {
  const m = parseMentions("give me an overview @repomap of the project");
  assert.equal(m.repomap, true);
  assert.equal(m.cleaned, "give me an overview of the project");
  assert.ok(hasContextRequest(m));
});

test("@repomap is false when absent", () => {
  const m = parseMentions("just a normal question");
  assert.equal(m.repomap, false);
});

test("@repomap combines with the other mention types", () => {
  const m = parseMentions("@repomap @diff @url:https://example.com explain this");
  assert.equal(m.repomap, true);
  assert.equal(m.diff, true);
  assert.equal(m.url, "https://example.com");
  assert.equal(m.cleaned, "explain this");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `packages/core`): `node --import tsx --test src/context/mentions.test.ts`
Expected: FAIL — `m.repomap` is `undefined`, not asserted `false`/`true`
(the property doesn't exist yet).

- [ ] **Step 3: Add `@repomap` parsing to `mentions.ts`**

In `packages/core/src/context/mentions.ts`, update the doc comment at the
top of the file — add this line after the `@url:<address>` line:

```typescript
//   @repomap           → inline a lightweight per-file symbol map
//                        (exported/public top-level names) across the
//                        workspace — TypeScript/JavaScript + Python only
```

Update the `Mentions` interface, adding `repomap` after `url`:

```typescript
export interface Mentions {
  codebase: boolean;
  open: boolean;
  problems: boolean;
  diff: boolean;
  terminalCommand: string | undefined;
  url: string | undefined;
  repomap: boolean;
  files: string[];
  // Message with mention tokens removed, used as the retrieval query.
  cleaned: string;
}
```

Add a new regex constant after `URL_RE`:

```typescript
const REPOMAP_RE = /(^|\s)@repomap\b/gi;
```

In `parseMentions()`, declare the flag alongside the others:

```typescript
let repomap = false;
```

Add the strip-and-flag block after the `URL_RE` replace and before the
`FILE_RE` replace:

```typescript
cleaned = cleaned.replace(REPOMAP_RE, (_m, pre) => {
  repomap = true;
  return pre;
});
```

Add `repomap` to the returned object, after `url`:

```typescript
return {
  codebase,
  open,
  problems,
  diff,
  terminalCommand,
  url,
  repomap,
  files: [...new Set(files)],
  cleaned: cleaned.replace(/\s+/g, " ").trim(),
};
```

Widen `hasContextRequest()`:

```typescript
export function hasContextRequest(m: Mentions): boolean {
  return (
    m.codebase ||
    m.open ||
    m.problems ||
    m.diff ||
    m.terminalCommand !== undefined ||
    m.url !== undefined ||
    m.repomap ||
    m.files.length > 0
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `packages/core`): `node --import tsx --test src/context/mentions.test.ts`
Expected: PASS — all tests green (21 pre-existing + 3 new = 24).

- [ ] **Step 5: Write the failing `retrieval.ts` tests**

Add to `packages/core/src/context/retrieval.test.ts` (append at the end,
after the existing `@url` tests):

```typescript
test("formatRepoMap renders one line per file with path and comma-joined symbols", () => {
  const files: FileSymbols[] = [
    { path: "a.ts", symbols: ["foo", "Bar"] },
    { path: "b.py", symbols: ["baz"] },
  ];
  const out = formatRepoMap(files);
  assert.equal(out, "// a.ts: foo, Bar\n// b.py: baz");
});

test("formatRepoMap returns an empty string for an empty array", () => {
  assert.equal(formatRepoMap([]), "");
});

test("buildContextMessage assembles all eight sections in the locked order", () => {
  const out = buildContextMessage({
    files: "// FILE: a.ts\ncontent",
    problems: "// a.ts:1 (error) bad",
    diff: "// Current git diff:\nsome diff",
    terminal: "// $ npm test\nPASS",
    url: "// URL: https://example.com\ncontent",
    repomap: "// a.ts: foo, Bar",
    retrieved: "// a.ts:1-2 (score 0.90)\ncode",
  });
  assert.equal(
    out,
    "The user referenced workspace context. Use it to answer.\n\n" +
      "// FILE: a.ts\ncontent\n\n" +
      "// a.ts:1 (error) bad\n\n" +
      "// Current git diff:\nsome diff\n\n" +
      "// $ npm test\nPASS\n\n" +
      "// URL: https://example.com\ncontent\n\n" +
      "// a.ts: foo, Bar\n\n" +
      "// Relevant code from the workspace:\n// a.ts:1-2 (score 0.90)\ncode",
  );
});

test("buildContextMessage with only repomap present produces just the repomap section", () => {
  const out = buildContextMessage({ repomap: "// a.ts: foo, Bar" });
  assert.equal(
    out,
    "The user referenced workspace context. Use it to answer.\n\n// a.ts: foo, Bar",
  );
});
```

Add `formatRepoMap` to the existing import from `"./retrieval"` at the
top of the test file, and add a separate import of `FileSymbols` from
`"./repomap"` (kept separate deliberately — see Step 7's note on why
`retrieval.ts` doesn't re-export this type):

```typescript
import {
  buildContextMessage,
  FileContext,
  formatDiff,
  formatFiles,
  formatHits,
  formatProblems,
  formatRepoMap,
  formatTerminal,
  formatUrl,
  ProblemInfo,
} from "./retrieval";
import { FileSymbols } from "./repomap";
```

- [ ] **Step 6: Run the tests to verify they fail**

Run (from `packages/core`): `node --import tsx --test src/context/retrieval.test.ts`
Expected: FAIL — `formatRepoMap`/`FileSymbols` are not exported from
`./retrieval` yet.

- [ ] **Step 7: Add `formatRepoMap` and widen `buildContextMessage` in `retrieval.ts`**

In `packages/core/src/context/retrieval.ts`, add an import for
`FileSymbols` from the new module, alongside the existing imports:

```typescript
import { FileSymbols } from "./repomap";
```

Do **not** re-export `FileSymbols` from `retrieval.ts` (e.g. via
`export type { FileSymbols }`) — `index.ts`'s barrel already does
`export * from "./context/repomap"` (Task 1) and
`export * from "./context/retrieval"` (pre-existing); re-exporting the
same type name from both would make it ambiguous through the barrel
(TypeScript TS2308: "Module has already exported a member named
'FileSymbols'"). `retrieval.ts` only needs `FileSymbols` for
`formatRepoMap`'s own signature below — consumers get the type from
`repomap.ts`'s barrel export directly.

Add `formatRepoMap` immediately after `formatUrl`:

```typescript
export function formatRepoMap(files: FileSymbols[]): string {
  return files.map((f) => `// ${f.path}: ${f.symbols.join(", ")}`).join("\n");
}
```

Widen `buildContextMessage`'s parameter type and body — add `repomap?: string;`
to the parameter type after `url?: string;`, and add the corresponding
`if` between the `url` and `retrieved` sections:

```typescript
export function buildContextMessage(parts: {
  retrieved?: string;
  files?: string;
  problems?: string;
  diff?: string;
  terminal?: string;
  url?: string;
  repomap?: string;
}): string {
  const sections: string[] = [];
  if (parts.files) sections.push(parts.files);
  if (parts.problems) sections.push(parts.problems);
  if (parts.diff) sections.push(parts.diff);
  if (parts.terminal) sections.push(parts.terminal);
  if (parts.url) sections.push(parts.url);
  if (parts.repomap) sections.push(parts.repomap);
  if (parts.retrieved) sections.push("// Relevant code from the workspace:\n" + parts.retrieved);
  if (sections.length === 0) return "";
  return (
    "The user referenced workspace context. Use it to answer.\n\n" +
    sections.join("\n\n")
  );
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run (from `packages/core`): `node --import tsx --test src/context/retrieval.test.ts`
Expected: PASS — all tests green (18 pre-existing + 4 new = 22).

- [ ] **Step 9: Run the full core suite to confirm nothing broke**

Run (from `packages/core`): `npm test`
Expected: PASS — 208 tests total (201 after Task 1 + 3 new
`mentions.test.ts` + 4 new `retrieval.test.ts`).

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/context/mentions.ts packages/core/src/context/mentions.test.ts packages/core/src/context/retrieval.ts packages/core/src/context/retrieval.test.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(core): parse @repomap mention, add formatRepoMap and widen buildContextMessage"
```

---

### Task 3: `contextEngine.ts` — buildRepoMap() and the eighth tier

**Files:**
- Modify: `extensions/vscode/src/context/contextEngine.ts`

**Interfaces:**
- Consumes: `extractSymbols`, `formatRepoMap`, `FileSymbols` from
  `@xprei/core` (Tasks 1-2). Consumes the existing `MAX_FILE_BYTES`
  constant (line 35), `SCAN_EXCLUDE` (already imported, line 31), and the
  existing `private rel(uri: vscode.Uri): string` helper (line 576) —
  reuse all three exactly as-is, don't redeclare.
- Produces: nothing new for later tasks — this is the last code task.

- [ ] **Step 1: Add the `MAX_REPOMAP_FILES` constant**

In `extensions/vscode/src/context/contextEngine.ts`, add immediately
after the existing `const MAX_URL_REDIRECTS = 5;` (line 47):

```typescript
const MAX_REPOMAP_FILES = 500;
```

- [ ] **Step 2: Widen the `@xprei/core` import**

The existing multi-line import from `@xprei/core` (lines 12-29) currently
reads:

```typescript
import {
  buildContextMessage,
  budgetContext,
  FileContext,
  formatDiff,
  formatFiles,
  formatHits,
  formatProblems,
  formatTerminal,
  formatUrl,
  isBlockedAddress,
  isSafeUrl,
  MIN_SCORE,
  ProblemInfo,
  SegmentTier,
  stripHtml,
  TRUNCATION_MARKER,
} from "@xprei/core";
```

Replace it with (three new names added, alphabetically placed):

```typescript
import {
  buildContextMessage,
  budgetContext,
  extractSymbols,
  FileContext,
  FileSymbols,
  formatDiff,
  formatFiles,
  formatHits,
  formatProblems,
  formatRepoMap,
  formatTerminal,
  formatUrl,
  isBlockedAddress,
  isSafeUrl,
  MIN_SCORE,
  ProblemInfo,
  SegmentTier,
  stripHtml,
  TRUNCATION_MARKER,
} from "@xprei/core";
```

- [ ] **Step 3: Add the `buildRepoMap()` private method**

Insert this new method immediately before `private resolveRel(p: string): vscode.Uri | undefined {`
(the method right after `fetchUrl()`):

```typescript
  // Walks the workspace (capped at MAX_REPOMAP_FILES) and extracts a
  // lightweight per-file symbol summary via extractSymbols() — no AST,
  // no cross-file reference graph or ranking (v1 scope, see the design
  // doc). Unreadable files and files extractSymbols() finds nothing in
  // are silently skipped, not listed with an empty symbol list.
  private async buildRepoMap(): Promise<FileSymbols[]> {
    const uris = await vscode.workspace.findFiles("**/*", SCAN_EXCLUDE, MAX_REPOMAP_FILES);
    const out: FileSymbols[] = [];
    for (const uri of uris) {
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > MAX_FILE_BYTES) continue;
        const bytes = await vscode.workspace.fs.readFile(uri);
        const result = extractSymbols(this.rel(uri), Buffer.from(bytes).toString("utf8"));
        if (result) out.push(result);
      } catch {
        // ignore unreadable files
      }
    }
    return out;
  }

```

- [ ] **Step 4: Wire the eighth tier into `buildContext()`**

Replace the existing `buildContext()` method (from its doc comment
through its closing `}`) with:

```typescript
  // Turn parsed mentions into a context message, or "" if nothing to add.
  // contextWindow is the resolved provider's token-count capability — used
  // to size the context block via budgetContext() instead of blindly
  // concatenating everything the mentions resolved to. Tier priority
  // (highest to lowest): @file: ("break", explicit request) > @problems
  // ("skip", compact and actionable) > @diff ("break", one segment) >
  // @terminal ("break", one segment, confirmation-gated) > @url
  // ("break", one segment, SSRF-checked) > @open ("break", bulkier,
  // ordered like files) > @repomap ("skip", per-file symbol summaries) >
  // @codebase hits ("skip", a relevance guess). Every tier is built
  // unconditionally (even when empty) — budgetContext's return value is
  // positionally aligned with the input tier array.
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
    const terminalOutput = mentions.terminalCommand
      ? await this.runTerminalCommand(mentions.terminalCommand)
      : "";
    const urlContent = mentions.url ? await this.fetchUrl(mentions.url) : "";
    const repoFiles = mentions.repomap ? await this.buildRepoMap() : [];

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
    const terminalTier: SegmentTier = {
      segments: terminalOutput
        ? [{ text: formatTerminal(mentions.terminalCommand!, terminalOutput), data: null }]
        : [],
      strategy: "break",
    };
    const urlTier: SegmentTier = {
      segments: urlContent ? [{ text: formatUrl(mentions.url!, urlContent), data: null }] : [],
      strategy: "break",
    };
    const openTier: SegmentTier = {
      segments: openFiles.map((f) => ({ text: f.content, data: f })),
      strategy: "break",
    };
    const repomapTier: SegmentTier = {
      segments: repoFiles.map((f) => ({
        text: `// ${f.path}: ${f.symbols.join(", ")}`,
        data: f,
      })),
      strategy: "skip",
    };
    const eligibleHits = hits.filter((h) => h.score >= MIN_SCORE);
    const hitTier: SegmentTier = {
      segments: eligibleHits.map((h) => ({ text: h.chunk.text, data: h })),
      strategy: "skip",
    };

    const [
      keptFileSegs,
      keptProblemSegs,
      keptDiffSegs,
      keptTerminalSegs,
      keptUrlSegs,
      keptOpenSegs,
      keptRepomapSegs,
      keptHitSegs,
    ] = budgetContext(
      [fileTier, problemTier, diffTier, terminalTier, urlTier, openTier, repomapTier, hitTier],
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
    // "break" may have truncated this — always reconstruct from seg.text,
    // not from the original (unbudgeted) command output.
    const budgetedTerminal: string | undefined = keptTerminalSegs[0]?.text;
    // "break" may have truncated this — always reconstruct from seg.text,
    // not from the original (unbudgeted) fetched content.
    const budgetedUrl: string | undefined = keptUrlSegs[0]?.text;
    const budgetedOpenFiles: FileContext[] = keptOpenSegs.map((seg) => ({
      ...(seg.data as FileContext),
      content: seg.text,
    }));
    // "skip" never truncates, so seg.data can be used raw.
    const budgetedRepoFiles: FileSymbols[] = keptRepomapSegs.map((seg) => seg.data as FileSymbols);
    // "skip" never truncates, so seg.text === chunk.text and data can be used raw.
    // If this tier ever becomes "break", reconstruct from seg.text like files do.
    const budgetedHits: SearchHit[] = keptHitSegs.map((seg) => seg.data as SearchHit);

    const allFiles = [...budgetedFiles, ...budgetedOpenFiles];

    return buildContextMessage({
      files: allFiles.length ? formatFiles(allFiles, Number.POSITIVE_INFINITY) : undefined,
      problems: budgetedProblems.length ? formatProblems(budgetedProblems) : undefined,
      diff: budgetedDiff,
      terminal: budgetedTerminal,
      url: budgetedUrl,
      repomap: budgetedRepoFiles.length ? formatRepoMap(budgetedRepoFiles) : undefined,
      retrieved: budgetedHits.length ? formatHits(budgetedHits, Number.NEGATIVE_INFINITY) : undefined,
    });
  }
```

- [ ] **Step 5: Typecheck the extension**

Run: `npm run typecheck -w xpreiIDE-ai`
Expected: PASS.

- [ ] **Step 6: Compile the extension**

Run: `npm run compile -w xpreiIDE-ai`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add extensions/vscode/src/context/contextEngine.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(vscode): walk the workspace for @repomap, wire in the eighth tier"
```

---

### Task 4: User-facing docs

**Files:**
- Modify: `extensions/vscode/README.md`
- Modify: `README.md`

**Interfaces:** none — documentation only. Required by the `CLAUDE.md`
convention: `@repomap` is a new chat mention users can type directly.

- [ ] **Step 1: Update the "Codebase context (@mentions)" section in `extensions/vscode/README.md`**

That section currently ends with (search for "Combine any of these in
one message"):

```markdown
Five more mentions need no indexing at all:
- **`@open`** — inline every file you currently have open in an editor tab
  (including background tabs you're not looking at right now).
- **`@problems`** — inline the current error/warning diagnostics for your
  open files, so the model can see what's broken without you pasting it in.
- **`@diff`** — inline your current git diff (staged and unstaged
  changes combined), so the model can review or explain your in-progress
  work without you copy-pasting a diff.
- **`@terminal:<command>`** — run a shell command and inline its output,
  e.g. `why did this fail @terminal:npm test`. You'll be asked to confirm
  before it runs — this is the only mention that executes anything.
  **`@terminal:` must be the last thing in your message**: everything
  after the colon, to the end of the text, is treated as the command.
- **`@url:<address>`** — fetch a public URL and inline its content (HTML
  pages are stripped down to readable text), e.g.
  `@url:https://example.com/docs summarize this`. For safety, addresses
  that resolve to your own machine or local network (localhost, private
  IP ranges, cloud metadata endpoints) are silently ignored — if `@url:`
  contributes nothing, that's why.

Combine any of these in one message, e.g. `@diff @problems review my changes`.
```

Replace it with:

```markdown
Six more mentions need no indexing at all:
- **`@open`** — inline every file you currently have open in an editor tab
  (including background tabs you're not looking at right now).
- **`@problems`** — inline the current error/warning diagnostics for your
  open files, so the model can see what's broken without you pasting it in.
- **`@diff`** — inline your current git diff (staged and unstaged
  changes combined), so the model can review or explain your in-progress
  work without you copy-pasting a diff.
- **`@terminal:<command>`** — run a shell command and inline its output,
  e.g. `why did this fail @terminal:npm test`. You'll be asked to confirm
  before it runs — this is the only mention that executes anything.
  **`@terminal:` must be the last thing in your message**: everything
  after the colon, to the end of the text, is treated as the command.
- **`@url:<address>`** — fetch a public URL and inline its content (HTML
  pages are stripped down to readable text), e.g.
  `@url:https://example.com/docs summarize this`. For safety, addresses
  that resolve to your own machine or local network (localhost, private
  IP ranges, cloud metadata endpoints) are silently ignored — if `@url:`
  contributes nothing, that's why.
- **`@repomap`** — inline a lightweight overview of exported/public
  top-level symbols (functions, classes, etc.) across your workspace's
  TypeScript, JavaScript, and Python files, so the model gets a sense of
  what's where without you opening every file. It's a regex-based
  summary, not a full dependency graph — other languages and re-exported/
  aliased symbols aren't covered.

Combine any of these in one message, e.g. `@diff @problems review my changes`.
```

- [ ] **Step 2: Update the root `README.md`'s Features list**

The existing bullet (search for `**Codebase-aware context**`) currently
reads:

```markdown
- **Codebase-aware context** — `@codebase` semantic retrieval, `@file:`
  mentions, `@open` (every open tab), `@problems` (current error/warning
  diagnostics), `@diff` (your current git diff), `@terminal:<command>`
  (run a command and inline its output, with confirmation), and
  `@url:<address>` (fetch a public URL, HTML stripped to text; private/
  internal addresses are blocked).
```

Replace it with:

```markdown
- **Codebase-aware context** — `@codebase` semantic retrieval, `@file:`
  mentions, `@open` (every open tab), `@problems` (current error/warning
  diagnostics), `@diff` (your current git diff), `@terminal:<command>`
  (run a command and inline its output, with confirmation), `@url:<address>`
  (fetch a public URL, HTML stripped to text; private/internal addresses
  are blocked), and `@repomap` (a regex-based overview of exported/public
  symbols across your TypeScript/JavaScript/Python files).
```

- [ ] **Step 3: Proofread both files**

Read both changed files back in full and confirm: no broken Markdown
(mismatched list indentation, unclosed formatting), the new content reads
naturally in place, and it's clear `@repomap` only covers TS/JS/Python.

- [ ] **Step 4: Commit**

```bash
git add extensions/vscode/README.md README.md
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "docs: document @repomap mention in both user-facing READMEs"
```

---

### Task 5: Final verification

**Files:** none (verification only).

**Interfaces:** none — consumes everything built in Tasks 1-4.

- [ ] **Step 1: Run the full core test suite**

Run: `npm test -w @xprei/core`
Expected: PASS — 208 tests total (188 before this plan + 13 new
`repomap.test.ts` + 3 new `mentions.test.ts` + 4 new `retrieval.test.ts`).

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

1. Send `@repomap what's in this codebase?` in this real repo. Confirm
   the response reflects a real per-file symbol map — e.g.
   `packages/core/src/context/budget.ts` should show `budgetContext`,
   `WeightedSegment` (or similar exported names actually in that file).
2. Confirm `node_modules`, `dist`, `.git`, and other `SCAN_EXCLUDE`
   directories are entirely absent from the map.
3. Confirm a `.md` or `.json` file in the workspace contributes nothing
   (not listed with zero symbols — just absent).
4. Send a plain message with no mentions and confirm there's no
   regression (no context block prepended, normal chat behavior).
5. Send `@repomap @diff` together and confirm both sections appear in
   the assembled context, in that order (repomap after diff, per the
   locked tier/section order).

This step requires a real Extension Development Host and is not something
that can be driven from an automated test — run it manually and report
any discrepancy.
