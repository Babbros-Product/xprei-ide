# Diff-Preview-Before-Apply Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agent file edits buffer in memory and are reviewed as one batch
of per-file diffs at end-of-run, instead of landing on disk step by step.

**Architecture:** `PendingEditOverlay` is an `AgentHost` decorator: file
writes/deletes are recorded in memory; reads answer from the overlay
first, falling back to the real host. The orchestrator hands tools the
overlay (fresh per run), flushes pending edits to real disk before any
tool that touches the real world outside the host seam (`run_terminal`,
`mcp__*`), and at `final` (or maxSteps exhaustion) fires a new optional
`onBatch` event for per-file accept/reject. Missing `onBatch` =
accept-all, keeping headless tests and the sidecar behavior-identical.
The VS Code webview renders the batch as one card of per-file diffs.

**Tech Stack:** TypeScript, Node's built-in `node:test` + `assert/strict`,
vanilla JS webview.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-24-diff-preview-before-apply-design.md`
  (approved). Spec paths say `src/agent/…`; the agent now lives in
  `packages/core/src/agent/` — all new core code goes there.
- **Checkpoint wraps the REAL host, unchanged.** `Checkpoint.note()` is
  first-snapshot-wins (verified), so noting at flush time is idempotent
  and safe any time before the real write.
- **Spec extensions (deliberate, documented here):**
  - `multi_edit` (added after the spec) writes via `host.writeFile` — the
    overlay buffers it automatically; covered by tests.
  - MCP tools (added after the spec) execute outside the `AgentHost` seam
    — pre-execution flush triggers for `tool.name === "run_terminal"` OR
    `tool.name.startsWith("mcp__")`, same rationale as the spec's
    run_terminal rule.
  - `glob` (added to `AgentHost` after the spec) is overlaid like
    `listDir`/`grep`.
  - maxSteps exhaustion settles the batch exactly like `final` (the user
    still reviews what was done); abort and stream-error drop pending
    edits silently per the spec.
  - `PendingEdit` gains `deleted?: boolean` (the spec's delete-marker
    concept, made explicit). No current tool deletes files — exercised by
    unit tests only.
- **Ordering at final:** settle the batch (onBatch → flush/discard) FIRST,
  then fire `events.onFinal`. Keeps harness/sidecarBundle tests (which
  read files after the `agent.final` event) byte-identical in observable
  behavior.
- **`flush()` never throws:** returns
  `{ flushed: PendingEdit[]; failed: { path: string; error: string }[] }`.
  Failed entries stay pending. run_terminal flush site prepends a warning
  to the tool observation; batch site emits `onError` naming failed paths.
- **`view_diff` known limitation (documented, not fixed):** it shells out
  to `git diff` against real disk, so mid-run it won't see pending
  (unflushed) edits. Flushing for a read-only tool would silently write —
  worse. Left as a v1 gap.
- **NO sidecar (`session.ts`/`stdio.ts`) changes** — it omits `onBatch`,
  getting accept-all-at-final, which preserves its current contract.
- **webview/ is the source of truth** — never edit
  `extensions/vscode/media/` (generated copy).
- **Commits:** author `xpreiIDE <mbsajay1@gmail.com>`, NO Co-Authored-By
  or other footers, Conventional Commit prefixes.
- Original implementation only — no code copied from any external product.

---

### Task 1: `pendingEditOverlay.ts` — pure, fully unit tested

**Files:**
- Create: `packages/core/src/agent/pendingEditOverlay.ts`
- Create: `packages/core/src/agent/pendingEditOverlay.test.ts`
- Modify: `packages/core/package.json` (register test file after
  `src/providers/fimModels.test.ts`)
- Modify: `packages/core/src/index.ts` (barrel-export after
  `./providers/fimModels`)

**Interfaces:**
- Produces: `PendingEdit { path: string; before: string; existed:
  boolean; after: string; deleted?: boolean }`, `FlushResult { flushed:
  PendingEdit[]; failed: { path: string; error: string }[] }`,
  `class PendingEditOverlay implements AgentHost { constructor(real:
  AgentHost); get pending(): PendingEdit[]; flush(path?: string):
  Promise<FlushResult>; discard(path: string): void }` — Task 2 consumes
  all of these.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/agent/pendingEditOverlay.test.ts`:

```typescript
import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeHost } from "./_fakehost";
import { PendingEditOverlay } from "./pendingEditOverlay";

test("readFile falls back to the real host when nothing is buffered", async () => {
  const overlay = new PendingEditOverlay(new FakeHost({ "a.ts": "real" }));
  assert.equal(await overlay.readFile("a.ts"), "real");
});

test("readFile returns buffered content after a write; real host untouched", async () => {
  const real = new FakeHost({ "a.ts": "old" });
  const overlay = new PendingEditOverlay(real);
  await overlay.writeFile("a.ts", "new");
  assert.equal(await overlay.readFile("a.ts"), "new");
  assert.equal(real.files.get("a.ts"), "old");
});

test("first write captures before/existed; a second write preserves them", async () => {
  const overlay = new PendingEditOverlay(new FakeHost({ "a.ts": "v0" }));
  await overlay.writeFile("a.ts", "v1");
  await overlay.writeFile("a.ts", "v2");
  const [e] = overlay.pending;
  assert.equal(e.before, "v0");
  assert.equal(e.existed, true);
  assert.equal(e.after, "v2");
});

test("exists is true for an overlay-created file and false after deleteFile of a real file", async () => {
  const overlay = new PendingEditOverlay(new FakeHost({ "gone.ts": "x" }));
  await overlay.writeFile("new.ts", "n");
  await overlay.deleteFile("gone.ts");
  assert.equal(await overlay.exists("new.ts"), true);
  assert.equal(await overlay.exists("gone.ts"), false);
});

test("readFile on a delete-marker throws like a missing file", async () => {
  const overlay = new PendingEditOverlay(new FakeHost({ "gone.ts": "x" }));
  await overlay.deleteFile("gone.ts");
  await assert.rejects(() => overlay.readFile("gone.ts"));
});

test("deleteFile of an overlay-only creation removes the entry entirely (net zero)", async () => {
  const overlay = new PendingEditOverlay(new FakeHost());
  await overlay.writeFile("tmp.ts", "x");
  await overlay.deleteFile("tmp.ts");
  assert.equal(overlay.pending.length, 0);
});

test("deleteFile of a real file records a delete-marker; flush deletes it for real", async () => {
  const real = new FakeHost({ "gone.ts": "bye" });
  const overlay = new PendingEditOverlay(real);
  await overlay.deleteFile("gone.ts");
  const [e] = overlay.pending;
  assert.equal(e.deleted, true);
  assert.equal(e.before, "bye");
  await overlay.flush();
  assert.equal(real.files.has("gone.ts"), false);
});

test("listDir merges overlay-created names and hides overlay-deleted ones", async () => {
  const overlay = new PendingEditOverlay(new FakeHost({ "src/a.ts": "1", "src/b.ts": "2" }));
  await overlay.writeFile("src/c.ts", "3");
  await overlay.deleteFile("src/b.ts");
  const names = await overlay.listDir("src");
  assert.ok(names.includes("a.ts"));
  assert.ok(names.includes("c.ts"));
  assert.ok(!names.includes("b.ts"));
});

test("grep sees overlay content and drops stale real-host hits for overlaid files", async () => {
  const overlay = new PendingEditOverlay(new FakeHost({ "a.ts": "needle old" }));
  await overlay.writeFile("a.ts", "nothing here");
  await overlay.writeFile("b.ts", "needle new");
  const hits = await overlay.grep("needle");
  assert.deepEqual(hits.map((h) => h.file), ["b.ts"]);
});

test("glob includes overlay-created files matching the pattern and excludes deleted ones", async () => {
  const overlay = new PendingEditOverlay(new FakeHost({ "a.ts": "1", "b.ts": "2" }));
  await overlay.writeFile("c.ts", "3");
  await overlay.deleteFile("b.ts");
  const out = await overlay.glob("*.ts");
  assert.ok(out.includes("a.ts"));
  assert.ok(out.includes("c.ts"));
  assert.ok(!out.includes("b.ts"));
});

test("flush() writes everything, clears state, and returns the flushed entries", async () => {
  const real = new FakeHost();
  const overlay = new PendingEditOverlay(real);
  await overlay.writeFile("x.ts", "X");
  await overlay.writeFile("y.ts", "Y");
  const { flushed, failed } = await overlay.flush();
  assert.equal(flushed.length, 2);
  assert.equal(failed.length, 0);
  assert.equal(overlay.pending.length, 0);
  assert.equal(real.files.get("x.ts"), "X");
  assert.equal(real.files.get("y.ts"), "Y");
});

test("flush(path) flushes one entry and leaves the rest pending", async () => {
  const real = new FakeHost();
  const overlay = new PendingEditOverlay(real);
  await overlay.writeFile("x.ts", "X");
  await overlay.writeFile("y.ts", "Y");
  await overlay.flush("x.ts");
  assert.equal(real.files.get("x.ts"), "X");
  assert.equal(real.files.has("y.ts"), false);
  assert.deepEqual(overlay.pending.map((e) => e.path), ["y.ts"]);
});

test("discard drops an entry without writing", async () => {
  const real = new FakeHost();
  const overlay = new PendingEditOverlay(real);
  await overlay.writeFile("x.ts", "X");
  overlay.discard("x.ts");
  assert.equal(overlay.pending.length, 0);
  assert.equal(real.files.has("x.ts"), false);
});

test("a write failure during flush is reported per-entry; others flush; the failed one stays pending", async () => {
  class FailingHost extends FakeHost {
    async writeFile(path: string, content: string): Promise<void> {
      if (path === "bad.ts") throw new Error("disk full");
      return super.writeFile(path, content);
    }
  }
  const real = new FailingHost();
  const overlay = new PendingEditOverlay(real);
  await overlay.writeFile("good.ts", "G");
  await overlay.writeFile("bad.ts", "B");
  const { flushed, failed } = await overlay.flush();
  assert.deepEqual(flushed.map((e) => e.path), ["good.ts"]);
  assert.deepEqual(failed.map((f) => f.path), ["bad.ts"]);
  assert.match(failed[0].error, /disk full/);
  assert.deepEqual(overlay.pending.map((e) => e.path), ["bad.ts"]);
});
```

- [ ] **Step 2: Run to verify failure**

Run (from `packages/core`):
`node --import tsx --test src/agent/pendingEditOverlay.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

Create `packages/core/src/agent/pendingEditOverlay.ts`:

```typescript
// AgentHost decorator that buffers file writes/deletes in memory instead
// of touching disk, so a whole agent run's edits can be reviewed as one
// batch before any of them land. Reads consult the overlay first and
// fall back to the real host. See
// docs/superpowers/specs/2026-07-24-diff-preview-before-apply-design.md.

import { AgentHost, ExecResult, GrepHit } from "./host";
import { matchGlob } from "./glob";

export interface PendingEdit {
  path: string;
  // Pre-run content, captured at FIRST write to this path (mirrors
  // Checkpoint.note's first-wins semantics) so a file edited twice still
  // diffs against its original content, not an intermediate state.
  before: string;
  existed: boolean;
  after: string;
  deleted?: boolean;
}

export interface FlushResult {
  flushed: PendingEdit[];
  failed: { path: string; error: string }[];
}

export class PendingEditOverlay implements AgentHost {
  private readonly entries = new Map<string, PendingEdit>();

  constructor(private readonly real: AgentHost) {}

  get cwd(): string {
    return this.real.cwd;
  }

  async readFile(path: string): Promise<string> {
    const e = this.entries.get(path);
    if (e) {
      if (e.deleted) throw new Error(`ENOENT: ${path}`);
      return e.after;
    }
    return this.real.readFile(path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    const e = this.entries.get(path);
    if (e) {
      e.after = content;
      delete e.deleted; // a re-created previously-deleted file is a plain edit again
      return;
    }
    const existed = await this.real.exists(path);
    const before = existed ? await this.real.readFile(path).catch(() => "") : "";
    this.entries.set(path, { path, before, existed, after: content });
  }

  async deleteFile(path: string): Promise<void> {
    const e = this.entries.get(path);
    if (e) {
      if (!e.existed) {
        this.entries.delete(path); // created only in the overlay — net zero
        return;
      }
      e.after = "";
      e.deleted = true;
      return;
    }
    if (!(await this.real.exists(path))) return; // deleting a missing file is a no-op
    const before = await this.real.readFile(path).catch(() => "");
    this.entries.set(path, { path, before, existed: true, after: "", deleted: true });
  }

  async exists(path: string): Promise<boolean> {
    const e = this.entries.get(path);
    if (e) return !e.deleted;
    return this.real.exists(path);
  }

  async listDir(path: string): Promise<string[]> {
    const prefix = path === "." || path === "" ? "" : path.replace(/\/$/, "") + "/";
    const names = new Set(await this.real.listDir(path).catch(() => [] as string[]));
    for (const [p, e] of this.entries) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf("/");
      const name = slash < 0 ? rest : rest.slice(0, slash) + "/";
      if (e.deleted && slash < 0) names.delete(name);
      else names.add(name);
    }
    return [...names];
  }

  // Real hits for any overlaid path are stale (the overlay has since
  // rewritten or deleted that file) — drop them, then scan overlay
  // content directly. The overlay map is small (run-scoped), so a
  // linear scan is fine.
  async grep(query: string, path?: string): Promise<GrepHit[]> {
    const needle = query.toLowerCase();
    const real = await this.real.grep(query, path);
    const hits = real.filter((h) => !this.entries.has(h.file));
    for (const [p, e] of this.entries) {
      if (e.deleted) continue;
      if (path && !p.startsWith(path)) continue;
      e.after.split(/\r?\n/).forEach((text, i) => {
        if (text.toLowerCase().includes(needle)) hits.push({ file: p, line: i + 1, text });
      });
    }
    return hits;
  }

  async glob(pattern: string, path?: string): Promise<string[]> {
    const real = await this.real.glob(pattern, path);
    const out = real.filter((p) => !this.entries.get(p)?.deleted);
    for (const [p, e] of this.entries) {
      if (e.deleted || e.existed) continue; // only overlay-created files can be missing from real results
      if (path && !p.startsWith(path)) continue;
      if (matchGlob(pattern, p) && !out.includes(p)) out.push(p);
    }
    return out;
  }

  exec(command: string): Promise<ExecResult> {
    return this.real.exec(command); // passthrough — see the view_diff limitation in the plan
  }

  get pending(): PendingEdit[] {
    return [...this.entries.values()].map((e) => ({ ...e }));
  }

  // Writes one entry (or all) to the real host. Never throws: a failed
  // entry stays pending and is reported in `failed`; successes are
  // cleared and returned in `flushed` so the caller can fire onEdit.
  async flush(path?: string): Promise<FlushResult> {
    const targets = path
      ? [...this.entries.values()].filter((e) => e.path === path)
      : [...this.entries.values()];
    const flushed: PendingEdit[] = [];
    const failed: { path: string; error: string }[] = [];
    for (const e of targets) {
      try {
        if (e.deleted) await this.real.deleteFile(e.path);
        else await this.real.writeFile(e.path, e.after);
        this.entries.delete(e.path);
        flushed.push({ ...e });
      } catch (err) {
        failed.push({ path: e.path, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { flushed, failed };
  }

  discard(path: string): void {
    this.entries.delete(path);
  }
}
```

- [ ] **Step 4: Run to verify pass**

`node --import tsx --test src/agent/pendingEditOverlay.test.ts` — expect
14 pass.

- [ ] **Step 5: Register + barrel-export**

`packages/core/package.json` test list: add
`src/agent/pendingEditOverlay.test.ts` after
`src/providers/fimModels.test.ts`. `packages/core/src/index.ts`: add
`export * from "./agent/pendingEditOverlay";` after the fimModels line.

- [ ] **Step 6: Full suite + typecheck**

`npm test` (from packages/core): expect 277 (263 + 14).
`npm run typecheck -w @xprei/core` (from root): PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/agent/pendingEditOverlay.ts packages/core/src/agent/pendingEditOverlay.test.ts packages/core/package.json packages/core/src/index.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(core): add PendingEditOverlay, an AgentHost decorator buffering file writes"
```

---

### Task 2: Orchestrator wiring — overlay per run, flush sites, onBatch

**Files:**
- Modify: `packages/core/src/agent/orchestrator.ts`
- Modify: `packages/core/src/agent/orchestrator.test.ts`

**Interfaces:**
- Consumes: `PendingEdit`, `PendingEditOverlay`, `FlushResult` (Task 1).
- Produces: `BatchDecision { path: string; accept: boolean }` (exported
  from orchestrator.ts); `AgentEvents.onBatch?(entries: PendingEdit[]):
  Promise<BatchDecision[]>` — Tasks 3-4 consume these.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/agent/orchestrator.test.ts` (uses the
file's existing `ScriptedProvider`, `recorder`, `FakeHost`, `yes`
helpers; add `BatchDecision`/`PendingEdit` to the orchestrator import
line):

```typescript
test("file writes are buffered: onBatch decides, rejected file never lands", async () => {
  const host = new FakeHost();
  const { events } = recorder();
  let batchEntries: PendingEdit[] = [];
  events.onBatch = async (entries) => {
    batchEntries = entries;
    return entries.map((e) => ({ path: e.path, accept: e.path === "keep.ts" }));
  };
  const agent = new Agent({
    provider: new ScriptedProvider([
      '{"tool":"create_file","args":{"path":"keep.ts","content":"K"}}',
      '{"tool":"create_file","args":{"path":"drop.ts","content":"D"}}',
      '{"final":"done"}',
    ]),
    model: "m",
    host,
    approver: yes,
    events,
  });
  await agent.run("make files");
  assert.deepEqual(batchEntries.map((e) => e.path).sort(), ["drop.ts", "keep.ts"]);
  assert.equal(host.files.get("keep.ts"), "K");
  assert.equal(host.files.has("drop.ts"), false);
});

test("onEdit fires only for accepted entries, at flush time, from PendingEdit content", async () => {
  const host = new FakeHost({ "a.ts": "old" });
  const { events } = recorder();
  const edits: { path: string; before: string; after: string }[] = [];
  events.onEdit = (path, before, after) => edits.push({ path, before, after });
  events.onBatch = async (entries) =>
    entries.map((e) => ({ path: e.path, accept: e.path === "a.ts" }));
  const agent = new Agent({
    provider: new ScriptedProvider([
      '{"tool":"edit_file","args":{"path":"a.ts","find":"old","replace":"new"}}',
      '{"tool":"create_file","args":{"path":"b.ts","content":"B"}}',
      '{"final":"done"}',
    ]),
    model: "m",
    host,
    approver: yes,
    events,
  });
  await agent.run("edit");
  assert.deepEqual(edits, [{ path: "a.ts", before: "old", after: "new" }]);
});

test("run_terminal flushes pending edits to real disk before the command executes", async () => {
  class TerminalHost extends FakeHost {
    sawContent: string | undefined;
    async exec(command: string) {
      this.sawContent = this.files.get("a.txt");
      return super.exec(command);
    }
  }
  const host = new TerminalHost();
  const { events } = recorder();
  const agent = new Agent({
    provider: new ScriptedProvider([
      '{"tool":"create_file","args":{"path":"a.txt","content":"hello"}}',
      '{"tool":"run_terminal","args":{"command":"cat a.txt"}}',
      '{"final":"done"}',
    ]),
    model: "m",
    host,
    approver: yes,
    events,
  });
  await agent.run("go");
  assert.equal(host.sawContent, "hello");
});

test("an mcp__-prefixed tool also flushes pending edits before executing", async () => {
  const host = new FakeHost();
  let sawOnDisk: boolean | undefined;
  const mcpTool: Tool = {
    name: "mcp__srv__probe",
    description: "test",
    args: "{}",
    mutating: true,
    async run() {
      sawOnDisk = host.files.has("x.ts");
      return { observation: "ok" };
    },
  };
  const { events } = recorder();
  const agent = new Agent({
    provider: new ScriptedProvider([
      '{"tool":"create_file","args":{"path":"x.ts","content":"X"}}',
      '{"tool":"mcp__srv__probe","args":{}}',
      '{"final":"done"}',
    ]),
    model: "m",
    host,
    approver: yes,
    events,
    tools: [...TOOLS, mcpTool],
  });
  await agent.run("go");
  assert.equal(sawOnDisk, true);
});

test("onBatch receives only edits still pending after a mid-run terminal flush", async () => {
  const host = new FakeHost();
  const { events } = recorder();
  let batchPaths: string[] = [];
  events.onBatch = async (entries) => {
    batchPaths = entries.map((e) => e.path);
    return entries.map((e) => ({ path: e.path, accept: true }));
  };
  const agent = new Agent({
    provider: new ScriptedProvider([
      '{"tool":"create_file","args":{"path":"early.ts","content":"E"}}',
      '{"tool":"run_terminal","args":{"command":"true"}}',
      '{"tool":"create_file","args":{"path":"late.ts","content":"L"}}',
      '{"final":"done"}',
    ]),
    model: "m",
    host,
    approver: yes,
    events,
  });
  await agent.run("go");
  assert.deepEqual(batchPaths, ["late.ts"]);
  assert.equal(host.files.get("early.ts"), "E");
  assert.equal(host.files.get("late.ts"), "L");
});

test("maxSteps exhaustion settles the batch like final (missing onBatch = accept all)", async () => {
  const host = new FakeHost();
  const { events } = recorder();
  const agent = new Agent({
    provider: new ScriptedProvider(['{"tool":"create_file","args":{"path":"s.ts","content":"S"}}']),
    model: "m",
    host,
    approver: yes,
    events,
    maxSteps: 1,
  });
  await agent.run("go");
  assert.equal(host.files.get("s.ts"), "S");
});
```

`recorder()`'s returned `events` object is typed `AgentEvents`, so
assigning `events.onBatch`/`events.onEdit` in tests type-checks — no
recorder() change needed.

- [ ] **Step 2: Run to verify failure**

`node --import tsx --test src/agent/orchestrator.test.ts` — new tests
FAIL (writes land immediately today; `PendingEdit`/`BatchDecision` not
importable yet).

- [ ] **Step 3: Implement orchestrator changes**

In `packages/core/src/agent/orchestrator.ts`:

1. Add import:
```typescript
import { PendingEdit, PendingEditOverlay } from "./pendingEditOverlay";
```

2. Add exported type + widen `AgentEvents` (after `onEdit?`):
```typescript
export interface BatchDecision {
  path: string;
  accept: boolean;
}
```
```typescript
  // Fired once at end-of-run (final or maxSteps exhaustion) when file
  // edits are still pending: the host UI shows a batch review and
  // resolves per-file decisions. Optional — when absent, every pending
  // edit is accepted (keeps headless tests and the sidecar unchanged).
  onBatch?(entries: PendingEdit[]): Promise<BatchDecision[]>;
```

3. In `run()`: create the overlay at the top (after the messages array
   is built) and thread it through:
```typescript
    // Fresh overlay per run: file writes buffer here and land on disk
    // only at a pre-terminal flush or the end-of-run batch review.
    const overlay = new PendingEditOverlay(this.deps.host);
```
   - Change `const observation = await this.runTool(action);` to
     `const observation = await this.runTool(action, overlay);`
   - At the `final` branch, replace:
```typescript
      if (action.kind === "final") {
        this.deps.events.onFinal(action.text);
        return;
      }
```
     with:
```typescript
      if (action.kind === "final") {
        await this.settleBatch(overlay);
        this.deps.events.onFinal(action.text);
        return;
      }
```
   - At the maxSteps exhaustion exit (the `onFinal("Stopped after …")`
     call after the loop), insert `await this.settleBatch(overlay);` on
     the line before it.
   - Abort (`signal?.aborted`) and stream-error returns are left
     untouched — pending edits are simply dropped, nothing reached disk.

4. Replace `runTool` in full:
```typescript
  private async runTool(
    action: Extract<Action, { kind: "tool" }>,
    overlay: PendingEditOverlay,
  ): Promise<string> {
    const tool = this.tools.find((t) => t.name === action.tool);
    if (!tool) {
      return `Error: unknown tool "${action.tool}". Available: ${this.tools
        .map((t) => t.name)
        .join(", ")}.`;
    }
    this.deps.events.onTool(tool.name, action.args);

    // Tools that touch the real world outside the AgentHost seam must
    // see consistent real files — flush pending edits first. These edits
    // were each already individually approved at their own step; only
    // the write was deferred. (run_terminal per the spec; mcp__* is a
    // deliberate extension for the same reason.)
    let flushWarning: string | undefined;
    if (tool.name === "run_terminal" || tool.name.startsWith("mcp__")) {
      flushWarning = await this.flushPending(overlay);
    }

    if (tool.mutating) {
      const ok = await this.deps.approver.approve(tool, action.args);
      if (!ok) return "User rejected this action. Choose a different step.";
    }

    try {
      const result = await tool.run(action.args, overlay);
      return flushWarning ? `${flushWarning}\n${result.observation}` : result.observation;
    } catch (err) {
      return `Error running ${tool.name}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // Checkpoint-note + flush every pending edit (pre-terminal/MCP flush
  // site). Returns a warning line when any entry failed to write, else
  // undefined. note() reads the REAL host, which the buffered write
  // hasn't touched yet, so noting here still captures pre-run content
  // (first-snapshot-wins makes repeats harmless).
  private async flushPending(overlay: PendingEditOverlay): Promise<string | undefined> {
    const pending = overlay.pending;
    if (pending.length === 0) return undefined;
    for (const e of pending) await this.checkpoint.note(e.path);
    const { flushed, failed } = await overlay.flush();
    for (const f of flushed) this.deps.events.onEdit?.(f.path, f.before, f.after);
    if (failed.length > 0) {
      return `Warning: failed to write pending edit(s): ${failed
        .map((f) => `${f.path} (${f.error})`)
        .join(", ")}`;
    }
    return undefined;
  }

  // End-of-run batch review: ask onBatch (or accept everything when the
  // host doesn't implement it), then flush accepted entries and discard
  // rejected ones. Paths missing from the decisions are treated as
  // rejected (defensive).
  private async settleBatch(overlay: PendingEditOverlay): Promise<void> {
    const pending = overlay.pending;
    if (pending.length === 0) return;
    const decisions = this.deps.events.onBatch
      ? await this.deps.events.onBatch(pending)
      : pending.map((e) => ({ path: e.path, accept: true }));
    const accepted = new Set(decisions.filter((d) => d.accept).map((d) => d.path));
    for (const entry of pending) {
      if (!accepted.has(entry.path)) {
        overlay.discard(entry.path);
        continue;
      }
      await this.checkpoint.note(entry.path);
      const { flushed, failed } = await overlay.flush(entry.path);
      for (const f of flushed) this.deps.events.onEdit?.(f.path, f.before, f.after);
      if (failed.length > 0) {
        this.deps.events.onError(
          `Failed to write accepted edit(s): ${failed.map((f) => `${f.path} (${f.error})`).join(", ")}`,
        );
      }
    }
  }
```

Note what this removes relative to the old `runTool`: the
note-at-tool-time block and the onEdit-at-`result.wrote` block — both
replaced by the two flush sites above, exactly per the spec.

- [ ] **Step 4: Run to verify pass**

`node --import tsx --test src/agent/orchestrator.test.ts` — expect 17
pass (11 existing + 6 new). The existing "creates a file … revertible"
test passes because run ends via `final` and missing onBatch =
accept-all; "rejected mutating tool" is untouched (rejection happens
before any write).

- [ ] **Step 5: Full suite + typecheck**

`npm test` (packages/core): expect 283 (277 + 6). Includes
harness/sidecarBundle suites, which must stay green — they read files
after `agent.final`, and settleBatch runs before `onFinal` fires.
`npm run typecheck -w @xprei/core`: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/agent/orchestrator.ts packages/core/src/agent/orchestrator.test.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(core): buffer agent file edits in a per-run overlay with end-of-run batch review"
```

---

### Task 3: VS Code plumbing — `runner.ts` + `chatView.ts`

**Files:**
- Modify: `extensions/vscode/src/agent/runner.ts`
- Modify: `extensions/vscode/src/ui/chat/chatView.ts`

**Interfaces:**
- Consumes: `PendingEdit`, `BatchDecision` from `@xprei/core` (Tasks
  1-2).
- Produces: `export type RequestBatch = (entries: PendingEdit[]) =>
  Promise<BatchDecision[]>;` in runner.ts; webview message contract
  `{type:"agent", kind:"batch", entries:[{path, before, after, existed,
  deleted}]}` out / `{type:"batchResponse", decisions:[{path, accept}]}`
  in — Task 4 consumes the message contract.

- [ ] **Step 1: runner.ts**

Add `BatchDecision, PendingEdit` to the existing `@xprei/core` import
lines. Add after the `RequestApproval` type:

```typescript
export type RequestBatch = (entries: PendingEdit[]) => Promise<BatchDecision[]>;
```

Widen `runAgent`'s signature — insert `requestBatch: RequestBatch,`
immediately after the `requestApproval: RequestApproval,` parameter.
Add to the `events` object literal, after `onEdit`:

```typescript
    onBatch: (entries) => requestBatch(entries),
```

- [ ] **Step 2: chatView.ts**

Add `BatchDecision, PendingEdit` to the `@xprei/core` imports and
`RequestBatch`-adjacent types are not needed (the lambda is typed by
`runAgent`'s parameter). Add a field next to `pendingApproval`:

```typescript
  private pendingBatch?: (decisions: BatchDecision[]) => void;
```

Add a handler case next to the `approvalResponse` case:

```typescript
      else if (msg?.type === "batchResponse") {
        const raw = Array.isArray(msg.decisions) ? msg.decisions : [];
        const decisions: BatchDecision[] = raw.map((d: Record<string, unknown>) => ({
          path: String(d?.path ?? ""),
          accept: !!d?.accept,
        }));
        this.pendingBatch?.(decisions);
        this.pendingBatch = undefined;
      }
```

Add a method next to `requestApproval()`:

```typescript
  // Ask the chat webview to review the run's pending file edits as one
  // batch of per-file diffs — same inline-transcript pattern as
  // requestApproval, resolving when the webview posts batchResponse.
  private requestBatch(entries: PendingEdit[]): Promise<BatchDecision[]> {
    return new Promise((resolve) => {
      this.pendingBatch = resolve;
      this.post({
        type: "agent",
        kind: "batch",
        entries: entries.map((e) => ({
          path: e.path,
          before: e.before,
          after: e.after,
          existed: e.existed,
          deleted: !!e.deleted,
        })),
      });
    });
  }
```

In `onAgent()`'s `runAgent(...)` call, insert
`(entries) => this.requestBatch(entries),` immediately after the
`(tool, summary, diff) => this.requestApproval(tool, summary, diff),`
line (matching the new parameter position).

- [ ] **Step 3: Typecheck + compile**

`npm run typecheck -w xpreiIDE-ai` then `npm run compile -w xpreiIDE-ai`
— both PASS.

- [ ] **Step 4: Commit**

```bash
git add extensions/vscode/src/agent/runner.ts extensions/vscode/src/ui/chat/chatView.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(vscode): thread the batch-review round trip from the orchestrator to the webview"
```

---

### Task 4: Webview batch card (`webview/chat.js`)

**Files:**
- Modify: `webview/chat.js` (source of truth; `extensions/vscode/media/`
  is regenerated at compile)

**Interfaces:**
- Consumes: `{kind:"batch", entries:[{path, before, after, existed,
  deleted}]}` message; posts `{type:"batchResponse",
  decisions:[{path, accept}]}` (Task 3's contract).

- [ ] **Step 1: Add the message case**

In `handleAgentMsg`'s switch, after the `"approval"` case:

```javascript
      case "batch":
        addBatchCard(Array.isArray(msg.entries) ? msg.entries : []);
        break;
```

- [ ] **Step 2: Add `addBatchCard` after `addApprovalCard`**

```javascript
  // End-of-run batch review: one card, one section per pending file
  // edit, each with its own Accept/Reject toggle (default accept), plus
  // Accept all / Reject all shortcuts and a single Done submit. Reuses
  // the approval card's CSS (.msg.agent-approval, .diffPreview).
  var BATCH_CLIP = 2000;
  function clipForDisplay(s) {
    return s.length > BATCH_CLIP ? s.slice(0, BATCH_CLIP) + "\n… (truncated)" : s;
  }

  function addBatchCard(entries) {
    const el = document.createElement("div");
    el.className = "msg agent-approval";

    const label = document.createElement("div");
    label.className = "msgRole";
    label.textContent =
      "Review edits (" + entries.length + (entries.length === 1 ? " file)" : " files)");
    el.appendChild(label);

    const accept = {};
    const rowCtrls = [];

    entries.forEach((entry) => {
      accept[entry.path] = true;

      const section = document.createElement("div");
      section.className = "msgBody";

      const header = document.createElement("div");
      let suffix = "";
      if (entry.deleted) suffix = " (deleted)";
      else if (!entry.existed) suffix = " (new file)";
      header.textContent = entry.path + suffix;
      header.style.fontWeight = "bold";
      section.appendChild(header);

      if (entry.existed && entry.before) {
        const pre = document.createElement("pre");
        pre.className = "diffPreview diffBefore";
        pre.textContent = clipForDisplay(entry.before);
        section.appendChild(pre);
      }
      if (!entry.deleted) {
        const pre = document.createElement("pre");
        pre.className = "diffPreview diffAfter";
        pre.textContent = clipForDisplay(entry.after);
        section.appendChild(pre);
      }

      const row = document.createElement("div");
      row.className = "approvalActions";
      const acceptBtn = document.createElement("button");
      acceptBtn.type = "button";
      const rejectBtn = document.createElement("button");
      rejectBtn.type = "button";
      acceptBtn.textContent = "Accept";
      rejectBtn.textContent = "Reject";
      function paint() {
        acceptBtn.className = accept[entry.path] ? "primary" : "ghostBtn";
        rejectBtn.className = accept[entry.path] ? "ghostBtn" : "primary";
      }
      acceptBtn.addEventListener("click", () => {
        accept[entry.path] = true;
        paint();
      });
      rejectBtn.addEventListener("click", () => {
        accept[entry.path] = false;
        paint();
      });
      paint();
      rowCtrls.push({ path: entry.path, paint });
      row.appendChild(acceptBtn);
      row.appendChild(rejectBtn);
      section.appendChild(row);
      el.appendChild(section);
    });

    const footer = document.createElement("div");
    footer.className = "approvalActions";

    const allBtn = document.createElement("button");
    allBtn.type = "button";
    allBtn.textContent = "Accept all";
    allBtn.addEventListener("click", () => {
      rowCtrls.forEach((c) => {
        accept[c.path] = true;
        c.paint();
      });
    });

    const noneBtn = document.createElement("button");
    noneBtn.type = "button";
    noneBtn.className = "ghostBtn";
    noneBtn.textContent = "Reject all";
    noneBtn.addEventListener("click", () => {
      rowCtrls.forEach((c) => {
        accept[c.path] = false;
        c.paint();
      });
    });

    const doneBtn = document.createElement("button");
    doneBtn.type = "button";
    doneBtn.className = "primary";
    doneBtn.textContent = "Done";
    doneBtn.addEventListener("click", () => {
      el.querySelectorAll("button").forEach((b) => (b.disabled = true));
      const kept = entries.filter((e) => accept[e.path]).length;
      const status = document.createElement("div");
      status.className = "approvalStatus";
      status.textContent = "Applied " + kept + " of " + entries.length + ".";
      el.appendChild(status);
      vscode.postMessage({
        type: "batchResponse",
        decisions: entries.map((e) => ({ path: e.path, accept: !!accept[e.path] })),
      });
    });

    footer.appendChild(allBtn);
    footer.appendChild(noneBtn);
    footer.appendChild(doneBtn);
    el.appendChild(footer);

    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
```

- [ ] **Step 3: Compile (syncs webview → media) + typecheck**

`npm run compile -w xpreiIDE-ai` and `npm run typecheck -w xpreiIDE-ai`
— PASS. (chat.js has no build-time checking beyond the sync; manual
smoke covers rendering.)

- [ ] **Step 4: Commit**

```bash
git add webview/chat.js
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(webview): batch-review card with per-file accept/reject"
```

---

### Task 5: User-facing docs

**Files:**
- Modify: `extensions/vscode/README.md`
- Modify: `README.md`

- [ ] **Step 1: Update the approval-gates bullet in "The Agent, in depth"**

In `extensions/vscode/README.md`, the bullet starting `- **Approval
gates.**` currently says every file write asks for approval and shows a
before/after diff. Replace that bullet with:

```markdown
- **Approval gates + end-of-run review.** Every file write and terminal
  command still asks for approval before the agent proceeds — but file
  edits no longer land on disk one by one. They're held in memory and
  presented at the end of the run as one **batch review**: a card of
  per-file diffs, each with its own Accept/Reject, plus Accept all /
  Reject all. Rejected files never touch disk at all. The one exception:
  if the agent runs a terminal command mid-run, edits made before that
  point are written first (the command needs real files to act on) —
  those were each individually approved already. Set
  `xpreiIDE.agent.autoApprove` to skip the per-step prompts (the batch
  review still appears; MCP tool calls are also auto-approved, use with
  caution).
```

- [ ] **Step 2: Root README agent bullet**

Extend the `- **Agentic multi-file coder**` bullet's ending
`…approval gates, one-click revert, and batched multi-edit…` to also
mention `end-of-run batch diff review (rejected edits never touch disk)`.

- [ ] **Step 3: Proofread + commit**

```bash
git add extensions/vscode/README.md README.md
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "docs: document the agent's end-of-run batch diff review"
```

---

### Task 6: Final verification

- [ ] **Step 1:** `npm test -w @xprei/core` — 283 pass (263 + 14 overlay
  + 6 orchestrator).
- [ ] **Step 2:** `npm run typecheck -w @xprei/core` — PASS.
- [ ] **Step 3:** `npm run typecheck -w xpreiIDE-ai` — PASS.
- [ ] **Step 4:** `npm run compile -w xpreiIDE-ai` — PASS.
- [ ] **Step 5: Manual smoke (Extension Development Host, user-run):**
  1. Agent task creating 2+ files with no terminal use → per-step
     approvals appear as before, files do NOT appear on disk during the
     run, batch card appears at the end; reject one file, accept the
     other → only the accepted one exists afterward; gutter flash fires
     for the accepted file only.
  2. Agent task that edits a file then runs `npm test` (or any command)
     → the edit is on disk when the command runs; the final batch card
     shows only post-command edits.
  3. **xpreiIDE: Revert Last Agent Run** after accepting a batch →
     accepted files are restored/deleted correctly.
  4. Abort a run (Stop) mid-way with pending edits → nothing lands on
     disk, no batch card.
  5. Sidecar regression is covered by the automated harness tests (no
     manual step).
