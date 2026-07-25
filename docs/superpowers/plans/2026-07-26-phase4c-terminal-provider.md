# Phase 4c Terminal Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `@terminal:<command>` (run a shell command via the stable
terminal shell-integration API, confirm before running, inject its
output) as a new chat context mention, per
`docs/superpowers/specs/2026-07-26-phase4c-terminal-provider-design.md`.

**Architecture:** `mentions.ts` gains a `terminalCommand` field that
captures everything after `@terminal:` to the end of the message.
`retrieval.ts` gains `formatTerminal` and a sixth `buildContextMessage`
parameter. `contextEngine.ts` gains a confirmation-gated
`runTerminalCommand()` using `vscode.window.createTerminal()` +
`TerminalShellIntegration.executeCommand()` + a bounded, partial-output-
preserving read loop, wired in as a sixth `SegmentTier` at the locked
priority position.

**Tech Stack:** TypeScript, VS Code's stable terminal shell-integration
API (`Terminal.shellIntegration`, `TerminalShellExecution.read()`,
`window.onDidChangeTerminalShellIntegration`). No proposed APIs, no
`child_process`, no new dependencies.

## Global Constraints

- **`@terminal` is the only mutating mention** — it must show a
  confirmation dialog (`"Run '<command>' in your terminal?"`, Run/Cancel)
  before executing anything. Declining returns `""` silently (not an
  error).
- **Command capture goes to end of string.** `@terminal:<command>` must
  be the last thing in the message — the regex is anchored with `$`, not
  `\S+`. Runs BEFORE every other mention regex in `parseMentions()`, so
  it claims the whole trailing span before any other regex could
  misinterpret part of the command text as a separate mention.
- **Stable API only** — `Terminal.shellIntegration` /
  `TerminalShellIntegration.executeCommand()` /
  `TerminalShellExecution.read()` / `window.onDidChangeTerminalShellIntegration`.
  No `--enable-proposed-api`, no `onDidWriteTerminalData`.
- **120-second overall execution timeout, 8000-char output cap** —
  matching the agent loop's existing `run_terminal` conventions
  (`EXEC_TIMEOUT_MS = 120_000` in `extensions/vscode/src/agent/host.ts`,
  `MAX_OBS = 8000` in `packages/core/src/agent/tools.ts`).
- **Partial output must survive a timeout.** If the command is still
  running when the 120s deadline passes, whatever output was captured so
  far is returned (with a truncation marker), not discarded.
- **Tier priority is locked**, extending the existing 5-tier order by
  one: `@file:` (`"break"`, highest) → `@problems` (`"skip"`) → `@diff`
  (`"break"`) → `@terminal` (`"break"`, new) → `@open` (`"break"`) →
  `@codebase` hits (`"skip"`, lowest).
- **Every tier is built unconditionally** (empty segments array when its
  mention isn't present) — per Phase 4 Foundation's documented
  positional-alignment invariant. Never conditionally pushed.
- **Silent-empty on every failure**: declined confirmation, no terminal
  shell integration available, command produces no output, any
  exception — all return `""`, no error toast.
- **The created terminal is left open and shown**, not disposed —
  transparency: the user asked for a command to run, they should be able
  to see/interact with the real terminal afterward.
- `packages/core` is source-only; both extended test files
  (`mentions.test.ts`, `retrieval.test.ts`) are already registered in
  `packages/core/package.json`'s `test` script from earlier Phase 4
  plans — no new registration needed.
- `extensions/vscode` has no unit tests by existing convention — its one
  task is verified by `npm run typecheck -w xpreiIDE-ai` +
  `npm run compile -w xpreiIDE-ai` + manual smoke.
- **User-facing docs stay current** (`CLAUDE.md` convention): `@terminal`
  is a new chat mention users can type directly — both
  `extensions/vscode/README.md` and the root `README.md`'s Features list
  must be updated, per Task 4, including the confirmation-dialog
  behavior and the "must be last in the message" usage constraint.
- **Commits:** author `xpreiIDE <mbsajay1@gmail.com>` — pass it explicitly,
  e.g. `git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "..."`.
  **Do NOT add a `Co-Authored-By` footer or any other footer.** Conventional
  Commit prefixes (feat/test/docs/etc).

---

### Task 1: `mentions.ts` — parse `@terminal:<command>`; `retrieval.ts` — `formatTerminal` + widened `buildContextMessage`

**Files:**
- Modify: `packages/core/src/context/mentions.ts`
- Modify: `packages/core/src/context/mentions.test.ts`
- Modify: `packages/core/src/context/retrieval.ts`
- Modify: `packages/core/src/context/retrieval.test.ts`

**Interfaces:**
- Produces: `interface Mentions { codebase: boolean; open: boolean; problems: boolean; diff: boolean; terminalCommand: string | undefined; files: string[]; cleaned: string }`
  — `terminalCommand` is new; `hasContextRequest(m)` now also returns
  `true` when `m.terminalCommand !== undefined`.
- Produces: `formatTerminal(command: string, output: string): string`,
  `buildContextMessage(parts: { retrieved?: string; files?: string; problems?: string; diff?: string; terminal?: string }): string`
  — Task 2 consumes both.

- [ ] **Step 1: Write the failing mentions tests**

Append to `packages/core/src/context/mentions.test.ts`:

```typescript
test("@terminal:<command> captures everything to the end of the message", () => {
  const m = parseMentions("why did this fail @terminal:npm test");
  assert.equal(m.terminalCommand, "npm test");
  assert.equal(m.cleaned, "why did this fail");
  assert.ok(hasContextRequest(m));
});

test("@terminal:<command> with a multi-word command including flags", () => {
  const m = parseMentions("@terminal:git status -sb");
  assert.equal(m.terminalCommand, "git status -sb");
});

test("@terminal is undefined when absent", () => {
  const m = parseMentions("just a normal question");
  assert.equal(m.terminalCommand, undefined);
  assert.equal(hasContextRequest(m), false);
});

test("@terminal:<command> runs before other mention regexes and doesn't let them steal from it", () => {
  // Without the "runs first, claims to end-of-string" rule, FILE_RE or
  // BARE_PATH_RE could try to parse "src/index.ts" out of the command
  // text as a separate @file: mention. It must not.
  const m = parseMentions("@terminal:npm run build src/index.ts");
  assert.equal(m.terminalCommand, "npm run build src/index.ts");
  assert.deepEqual(m.files, []);
});

test("@terminal combines with other mention types when they precede it", () => {
  const m = parseMentions("@codebase @diff explain @terminal:npm test");
  assert.equal(m.codebase, true);
  assert.equal(m.diff, true);
  assert.equal(m.terminalCommand, "npm test");
  assert.equal(m.cleaned, "explain");
});
```

- [ ] **Step 2: Run mentions tests to verify they fail**

Run: `node --import tsx --test src/context/mentions.test.ts` (from
`packages/core`)
Expected: FAIL — `m.terminalCommand` is `undefined`-typed-as-missing-
property error at best, or the assertions simply don't match since the
field doesn't exist yet.

- [ ] **Step 3: Implement the `terminalCommand` field**

In `packages/core/src/context/mentions.ts`, replace the entire file with:

```typescript
// Parse @-mentions out of a chat message. Pure module — no vscode.
//   @codebase          → run semantic retrieval over the index
//   @file:src/a.ts     → inline that exact file
//   @path/to/file.ts   → shorthand for @file when it has an extension/slash
//   @open              → inline every currently-open editor tab
//   @problems          → inline error/warning diagnostics from open files
//   @diff              → inline the current staged + unstaged git diff
//   @terminal:<cmd>    → run a shell command (with confirmation) and
//                        inline its output; must be the LAST thing in
//                        the message — everything after "@terminal:" to
//                        the end of the text is the command verbatim
// The remaining prose (mentions stripped) is what we embed for retrieval.

export interface Mentions {
  codebase: boolean;
  open: boolean;
  problems: boolean;
  diff: boolean;
  terminalCommand: string | undefined;
  files: string[];
  // Message with mention tokens removed, used as the retrieval query.
  cleaned: string;
}

// Anchored to end-of-string ($), non-global (only one @terminal: makes
// sense per message), captures everything after "@terminal:" to the end
// of the text. Must run BEFORE every other mention regex in
// parseMentions() below — otherwise those regexes would try to parse
// pieces of the command text (e.g. a path-looking token inside
// "npm run build src/index.ts") as separate mentions before @terminal
// ever claims the trailing span.
const TERMINAL_RE = /(^|\s)@terminal:(.+)$/i;

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
  let terminalCommand: string | undefined;
  let cleaned = text;

  cleaned = cleaned.replace(TERMINAL_RE, (_m, pre: string, command: string) => {
    terminalCommand = command;
    return pre;
  });

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
    terminalCommand,
    files: [...new Set(files)],
    cleaned: cleaned.replace(/\s+/g, " ").trim(),
  };
}

export function hasContextRequest(m: Mentions): boolean {
  return m.codebase || m.open || m.problems || m.diff || m.terminalCommand !== undefined || m.files.length > 0;
}
```

- [ ] **Step 4: Run mentions tests to verify they pass**

Run: `node --import tsx --test src/context/mentions.test.ts` (from
`packages/core`)
Expected: all tests PASS (12 pre-existing + 5 new = 17).

- [ ] **Step 5: Write the failing retrieval tests**

Append to `packages/core/src/context/retrieval.test.ts`:

```typescript
test("formatTerminal wraps the command and its output", () => {
  const out = formatTerminal("npm test", "PASS  src/index.test.ts\n5 tests passed");
  assert.equal(out, "// $ npm test\nPASS  src/index.test.ts\n5 tests passed");
});

test("buildContextMessage assembles files, problems, diff, terminal, and retrieved in that order", () => {
  const out = buildContextMessage({
    files: "// FILE: a.ts\ncontent",
    problems: "// a.ts:1 (error) bad",
    diff: "// Current git diff:\nsome diff",
    terminal: "// $ npm test\nPASS",
    retrieved: "// a.ts:1-2 (score 0.90)\ncode",
  });
  assert.equal(
    out,
    "The user referenced workspace context. Use it to answer.\n\n" +
      "// FILE: a.ts\ncontent\n\n" +
      "// a.ts:1 (error) bad\n\n" +
      "// Current git diff:\nsome diff\n\n" +
      "// $ npm test\nPASS\n\n" +
      "// Relevant code from the workspace:\n// a.ts:1-2 (score 0.90)\ncode",
  );
});

test("buildContextMessage with only terminal present produces just the terminal section", () => {
  const out = buildContextMessage({ terminal: "// $ npm test\nPASS" });
  assert.equal(
    out,
    "The user referenced workspace context. Use it to answer.\n\n// $ npm test\nPASS",
  );
});
```

Also update the import line at the top of `retrieval.test.ts` to add
`formatTerminal` to the existing named-import list from `./retrieval`.

- [ ] **Step 6: Run retrieval tests to verify they fail**

Run: `node --import tsx --test src/context/retrieval.test.ts` (from
`packages/core`)
Expected: FAIL — `formatTerminal` doesn't exist yet.

- [ ] **Step 7: Implement `formatTerminal` and widen `buildContextMessage`**

In `packages/core/src/context/retrieval.ts`, add `formatTerminal`
immediately after the existing `formatDiff` function:

```typescript
export function formatTerminal(command: string, output: string): string {
  return `// $ ${command}\n${output}`;
}
```

Then replace the existing `buildContextMessage` function:

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

with:

```typescript
// Assemble the final context message the chat prepends before the user turn.
export function buildContextMessage(parts: {
  retrieved?: string;
  files?: string;
  problems?: string;
  diff?: string;
  terminal?: string;
}): string {
  const sections: string[] = [];
  if (parts.files) sections.push(parts.files);
  if (parts.problems) sections.push(parts.problems);
  if (parts.diff) sections.push(parts.diff);
  if (parts.terminal) sections.push(parts.terminal);
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
Expected: all tests PASS (12 pre-existing + 3 new = 15).

- [ ] **Step 9: Run the full core suite**

Run: `npm test -w @xprei/core`
Expected: PASS — previous total (154) + 5 new `mentions.test.ts` tests +
3 new `retrieval.test.ts` tests = 162.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/context/mentions.ts packages/core/src/context/mentions.test.ts packages/core/src/context/retrieval.ts packages/core/src/context/retrieval.test.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(core): parse @terminal:<command> mention, add formatTerminal, widen buildContextMessage"
```

---

### Task 2: `contextEngine.ts` — `runTerminalCommand()` and the sixth tier

**Files:**
- Modify: `extensions/vscode/src/context/contextEngine.ts`

**Interfaces:**
- Consumes: `terminalCommand` field on `Mentions`, `formatTerminal`,
  widened `buildContextMessage` from `@xprei/core` (Task 1).
- Produces: no change to `buildContext(mentions: Mentions, contextWindow: number): Promise<string>`'s
  public signature — this task only changes the method's internals plus
  three new private methods (`runTerminalCommand`, `executeAndRead`,
  `waitForShellIntegration`).

- [ ] **Step 1: Add the new constants**

In `extensions/vscode/src/context/contextEngine.ts`, the constants
currently read (lines 27-31):

```typescript
const INDEX_FILE = "index.json";
const EMBED_BATCH = 64;
const MAX_FILE_BYTES = 200 * 1024;
const MAX_FILE_CHARS = 8000;
const RETRIEVE_K = 6;
```

Add two more:

```typescript
const INDEX_FILE = "index.json";
const EMBED_BATCH = 64;
const MAX_FILE_BYTES = 200 * 1024;
const MAX_FILE_CHARS = 8000;
const RETRIEVE_K = 6;
const MAX_TERMINAL_CHARS = 8000;
const TERMINAL_EXEC_TIMEOUT_MS = 120_000;
// Separate, shorter bound just for "does this terminal even support
// shell integration" — if it hasn't attached in this long, it's not
// going to (some shells/environments never enable it), so there's no
// reason to burn the full 120s exec budget waiting for it.
const SHELL_INTEGRATION_TIMEOUT_MS = 5_000;
```

- [ ] **Step 2: Update the imports**

The imports currently read (lines 6-25):

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

Replace with (adds `formatTerminal`; everything else unchanged):

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
  formatTerminal,
  MIN_SCORE,
  ProblemInfo,
  SegmentTier,
  TRUNCATION_MARKER,
} from "@xprei/core";
import { VectorStore, SearchHit } from "@xprei/core";
import { isExcludedPath, SCAN_EXCLUDE } from "@xprei/core";
```

- [ ] **Step 3: Add the three new private methods**

Immediately after the existing `readDiff()` method (currently ending
around line 339, right before `resolveRel()`), add:

```typescript
  // Waits for shell integration to attach to a freshly created terminal
  // (it isn't available immediately — the shell needs to load its
  // integration script first). Resolves to undefined if it doesn't
  // attach within timeoutMs, which covers shells/environments that never
  // enable shell integration at all. Always cleans up its listener,
  // whether it resolves via the event or via the timeout.
  private waitForShellIntegration(
    terminal: vscode.Terminal,
    timeoutMs: number,
  ): Promise<vscode.TerminalShellIntegration | undefined> {
    if (terminal.shellIntegration) return Promise.resolve(terminal.shellIntegration);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        disposable.dispose();
        resolve(undefined);
      }, timeoutMs);
      const disposable = vscode.window.onDidChangeTerminalShellIntegration((e) => {
        if (e.terminal === terminal) {
          clearTimeout(timer);
          disposable.dispose();
          resolve(e.shellIntegration);
        }
      });
    });
  }

  // Executes command in terminal and reads its output, bounded by an
  // absolute wall-clock deadline. If the deadline passes mid-command
  // (the command is still producing output, or producing none at all),
  // returns whatever was captured so far with a truncation marker rather
  // than hanging indefinitely or discarding partial progress. Each
  // iteration of the read loop races the next chunk against the
  // remaining time budget, since a `for await` loop would otherwise
  // block indefinitely waiting for a chunk that may never come (e.g. a
  // command that produces no output for a long time before exiting).
  private async executeAndRead(
    terminal: vscode.Terminal,
    command: string,
    deadlineMs: number,
  ): Promise<string> {
    const integration = await this.waitForShellIntegration(terminal, SHELL_INTEGRATION_TIMEOUT_MS);
    if (!integration) return "";

    const execution = integration.executeCommand(command);
    const iterator = execution.read()[Symbol.asyncIterator]();
    let output = "";
    let timedOut = false;

    while (true) {
      const remaining = deadlineMs - Date.now();
      if (remaining <= 0) {
        timedOut = true;
        break;
      }

      const next = await Promise.race([
        iterator.next().then((result) => ({ timedOut: false as const, result })),
        new Promise<{ timedOut: true }>((resolve) => setTimeout(() => resolve({ timedOut: true }), remaining)),
      ]);

      if (next.timedOut) {
        timedOut = true;
        break;
      }
      if (next.result.done) break; // command finished normally
      output += next.result.value;
      if (output.length > MAX_TERMINAL_CHARS) {
        return output.slice(0, MAX_TERMINAL_CHARS) + TRUNCATION_MARKER;
      }
    }

    return timedOut && output ? output + TRUNCATION_MARKER : output;
  }

  // Runs a shell command in a visible terminal, after user confirmation
  // (the one mutating mention — every other mention is read-only). "" on
  // decline, on any failure, or if shell integration never attaches; the
  // created terminal is left open (not disposed) so the user can see/
  // interact with what actually ran.
  private async runTerminalCommand(command: string): Promise<string> {
    const confirmed = await vscode.window.showWarningMessage(
      `Run '${command}' in your terminal?`,
      "Run",
      "Cancel",
    );
    if (confirmed !== "Run") return "";

    try {
      const terminal = vscode.window.createTerminal({ name: "xpreiIDE" });
      terminal.show();
      return await this.executeAndRead(terminal, command, Date.now() + TERMINAL_EXEC_TIMEOUT_MS);
    } catch {
      return "";
    }
  }
```

- [ ] **Step 4: Replace `buildContext()`'s body**

Replace the existing method (currently lines 144-228):

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

with:

```typescript
  // Turn parsed mentions into a context message, or "" if nothing to add.
  // contextWindow is the resolved provider's token-count capability — used
  // to size the context block via budgetContext() instead of blindly
  // concatenating everything the mentions resolved to. Tier priority
  // (highest to lowest): @file: ("break", explicit request) > @problems
  // ("skip", compact and actionable) > @diff ("break", one segment) >
  // @terminal ("break", one segment, confirmation-gated) > @open
  // ("break", bulkier, ordered like files) > @codebase hits ("skip", a
  // relevance guess). Every tier is built unconditionally (even when
  // empty) — budgetContext's return value is positionally aligned with
  // the input tier array.
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
    const openTier: SegmentTier = {
      segments: openFiles.map((f) => ({ text: f.content, data: f })),
      strategy: "break",
    };
    const eligibleHits = hits.filter((h) => h.score >= MIN_SCORE);
    const hitTier: SegmentTier = {
      segments: eligibleHits.map((h) => ({ text: h.chunk.text, data: h })),
      strategy: "skip",
    };

    const [keptFileSegs, keptProblemSegs, keptDiffSegs, keptTerminalSegs, keptOpenSegs, keptHitSegs] =
      budgetContext([fileTier, problemTier, diffTier, terminalTier, openTier, hitTier], contextWindow);

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
      terminal: budgetedTerminal,
      retrieved: budgetedHits.length ? formatHits(budgetedHits, Number.NEGATIVE_INFINITY) : undefined,
    });
  }
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck -w xpreiIDE-ai`
Expected: PASS.

- [ ] **Step 6: Compile**

Run: `npm run compile -w xpreiIDE-ai`
Expected: PASS, `dist/extension.js` rebuilt.

- [ ] **Step 7: Commit**

```bash
git add extensions/vscode/src/context/contextEngine.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(vscode): run @terminal:<command> with confirmation, wire in the sixth tier"
```

---

### Task 3: User-facing docs

**Files:**
- Modify: `extensions/vscode/README.md`
- Modify: `README.md`

**Interfaces:** none — documentation only. Required by the `CLAUDE.md`
convention: `@terminal` is a new chat mention users can type directly,
and it has real usage gotchas (confirmation dialog, "must be last")
worth documenting clearly.

- [ ] **Step 1: Update the "Codebase context (@mentions)" section in `extensions/vscode/README.md`**

That section currently ends with (search for "Combine any of these in
one message"):

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

Replace it with:

```markdown
Four more mentions need no indexing at all:
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

Combine any of these in one message, e.g. `@diff @problems review my changes`.
```

- [ ] **Step 2: Update the root `README.md`'s Features list**

The existing bullet (search for `**Codebase-aware context**`) currently
reads:

```markdown
- **Codebase-aware context** — `@codebase` semantic retrieval, `@file:`
  mentions, `@open` (every open tab), `@problems` (current error/warning
  diagnostics), and `@diff` (your current git diff).
```

Replace it with:

```markdown
- **Codebase-aware context** — `@codebase` semantic retrieval, `@file:`
  mentions, `@open` (every open tab), `@problems` (current error/warning
  diagnostics), `@diff` (your current git diff), and `@terminal:<command>`
  (run a command and inline its output, with confirmation).
```

- [ ] **Step 3: Proofread both files**

Read both changed files back in full and confirm: no broken Markdown
(mismatched list indentation, unclosed formatting), the new content reads
naturally in place, and the confirmation-dialog + "must be last" usage
notes are clear to a first-time reader.

- [ ] **Step 4: Commit**

```bash
git add extensions/vscode/README.md README.md
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "docs: document @terminal:<command> mention in both user-facing READMEs"
```

---

### Task 4: Final verification

**Files:** none (verification only).

**Interfaces:** none — consumes everything built in Tasks 1-3.

- [ ] **Step 1: Run the full core test suite**

Run: `npm test -w @xprei/core`
Expected: PASS — 162 tests total (154 before this plan + 5 new
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
`extensions/vscode`), in this real workspace (or any workspace with a
terminal-integration-capable shell — bash/zsh/PowerShell/pwsh all work):

1. Send `@terminal:npm test`. Confirm the "Run 'npm test' in your
   terminal?" dialog appears. Click **Run**. Confirm a new terminal
   opens, shows the command actually running, and the chat response
   reflects the real test output.
2. Send `@terminal:npm test` again and click **Cancel**. Confirm no
   terminal opens and the chat proceeds as if `@terminal` wasn't there
   (empty context contribution, no error).
3. Send `@terminal:git status -sb` (a command with a space and a flag)
   and confirm — after confirming the dialog — the FULL command runs
   (not just `git`), proving the end-of-string capture works correctly.
4. Send a command that legitimately fails, e.g.
   `@terminal:node -e "process.exit(1)"`, and confirm its output/exit
   behavior is still captured in context (not swallowed as if it were an
   internal error).
5. Send a plain message with no mentions and confirm chat still works
   exactly as before (empty context block, no regression, no dialog).

If all five checks behave as expected, no further action needed — this
task has no commit of its own.
