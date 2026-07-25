# Phase 5: `multi_edit` Agent Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `multi_edit` agent tool that batches multiple sequential
find/replace edits against one file into a single tool call, atomically.

**Architecture:** A prerequisite fix in `orchestrator.ts`'s `runTool()`
(currently only able to *restrict* the callable tool set via
`AgentDeps.tools`, never *add* to it) makes `AgentDeps.tools` a true
override — needed for MCP tools later (Phase 7) but exposed now by this
phase's testing. `multi_edit` itself is a new `TOOLS` array entry:
sequential in-memory find/replace, single `writeFile()` only if every
edit succeeds. One VS Code-layer touch: `runner.ts`'s per-tool-name
approval-card preview gains a `multi_edit` branch.

**Tech Stack:** TypeScript, Node's built-in `node:test` + `assert/strict`.

## Global Constraints

- **Sequential application, single file.** Each edit operates on the
  result of the previous edit, not independently against the original.
- **Exact-match-once per edit** — same rule as `edit_file`'s single pair,
  re-applied per edit in the batch.
- **Atomic: validate fully in memory, write once.** `host.writeFile()` is
  called exactly once, only if every edit succeeds. A failure partway
  through leaves the file completely unchanged.
- **No whole-file-overwrite mode** — `find` is always required on every
  edit (unlike `edit_file`, which allows omitting it).
- **No orchestrator changes beyond the prerequisite fix** — checkpoint/
  revert and the gutter-flash `onEdit` event already key off
  `tool.mutating` + `result.wrote` generically.
- **Commits:** author `xpreiIDE <mbsajay1@gmail.com>` — pass it
  explicitly, e.g. `git -c user.name="xpreiIDE" -c
  user.email="mbsajay1@gmail.com" commit -m "..."`. **Do NOT add a
  `Co-Authored-By` footer or any other footer.** Conventional Commit
  prefixes (feat/test/etc).
- **No README changes** — `multi_edit` is model-invoked, not directly
  typed by the user, unlike the `@`-mention providers earlier this
  session.

---

### Task 1: Prerequisite fix — `orchestrator.ts`'s tool lookup

**Files:**
- Modify: `packages/core/src/agent/orchestrator.ts`
- Test: `packages/core/src/agent/orchestrator.test.ts`

**Interfaces:**
- Produces: `runTool()` resolves tools via `this.tools.find((t) => t.name
  === action.tool)` instead of the module-level `toolByName()` — Task 2's
  `multi_edit` tool (added to the static `TOOLS` array) doesn't strictly
  need this fix to be callable (it's now IN the static array), but this
  regression test proves `AgentDeps.tools` can carry a tool that is NOT
  in the static array, which is the actual bug this phase's spec
  identified and the property Phase 7 (MCP) will depend on.

- [ ] **Step 1: Write the failing regression test**

Read `packages/core/src/agent/orchestrator.test.ts` first to see its
existing fake-provider/fake-host/fake-approver setup helpers, then add a
test using the same helpers (append at the end of the file):

```typescript
test("a tool in deps.tools but NOT in the static TOOLS array is callable", async () => {
  const customTool: Tool = {
    name: "custom_echo",
    description: "test-only tool",
    args: "{}",
    mutating: false,
    async run() {
      return { observation: "echoed" };
    },
  };
  const provider = fakeProvider([
    JSON.stringify({ tool: "custom_echo", args: {} }),
    JSON.stringify({ final: "done" }),
  ]);
  const host = new FakeHost();
  const events = fakeEvents();
  const agent = new Agent({
    provider,
    model: "m",
    host,
    approver: { approve: async () => true },
    events,
    tools: [customTool],
  });
  await agent.run("task");
  assert.ok(events.observations.some((o) => o === "echoed"));
});
```

Adjust the exact helper names (`fakeProvider`, `fakeEvents`, `FakeHost`
import path, the shape `events.observations` is collected into) to match
whatever this test file's existing tests actually use — read the file
first; do not guess at names not confirmed by reading it.

- [ ] **Step 2: Run the test to verify it fails**

Run (from `packages/core`): `node --import tsx --test src/agent/orchestrator.test.ts`
Expected: FAIL — the "unknown tool" branch fires (`toolByName("custom_echo")`
returns `undefined` since `custom_echo` isn't in the static `TOOLS` array),
producing an error observation instead of `"echoed"`.

- [ ] **Step 3: Fix `runTool()` in `orchestrator.ts`**

Find this block near the top of `runTool()`:

```typescript
const tool = toolByName(action.tool);
if (!tool || !this.tools.includes(tool)) {
  return `Error: unknown tool "${action.tool}". Available: ${this.tools
    .map((t) => t.name)
    .join(", ")}.`;
}
```

Replace it with:

```typescript
const tool = this.tools.find((t) => t.name === action.tool);
if (!tool) {
  return `Error: unknown tool "${action.tool}". Available: ${this.tools
    .map((t) => t.name)
    .join(", ")}.`;
}
```

Remove `toolByName` from the `import { Tool, TOOLS, toolByName } from
"./tools";` line at the top of the file (becomes `import { Tool, TOOLS }
from "./tools";`) — `orchestrator.ts` no longer calls it.
`toolByName` itself stays exported from `tools.ts` (other callers, if
any, are unaffected).

- [ ] **Step 4: Run the test to verify it passes**

Run (from `packages/core`): `node --import tsx --test src/agent/orchestrator.test.ts`
Expected: PASS — including every pre-existing test in this file (the fix
only changes lookup mechanics, not behavior for tools that are already in
the static array, which every pre-existing test uses).

- [ ] **Step 5: Run the full core suite to confirm nothing broke**

Run (from `packages/core`): `npm test`
Expected: PASS — 221 tests total (220 before this plan + 1 new).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/agent/orchestrator.ts packages/core/src/agent/orchestrator.test.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "fix(core): agent tool lookup now honors deps.tools as a true override, not just a filter"
```

---

### Task 2: `multi_edit` tool

**Files:**
- Modify: `packages/core/src/agent/tools.ts`
- Modify: `packages/core/src/agent/tools.test.ts`

**Interfaces:**
- Consumes: nothing new — uses the existing `Tool`/`ToolResult`
  interfaces and the `str`/`errText` helpers already in `tools.ts`.
- Produces: a `"multi_edit"` entry in the exported `TOOLS` array — Task 3
  consumes its name (`"multi_edit"`) for the `runner.ts` UI branch.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/agent/tools.test.ts`, after the existing
`edit_file` tests:

```typescript
test("multi_edit applies edits sequentially, each operating on the prior result", () => {
  return (async () => {
    const host = new FakeHost({ "a.ts": "let a = 1;" });
    const r = await tool("multi_edit").run(
      {
        path: "a.ts",
        edits: [
          { find: "let", replace: "const" },
          { find: "const a = 1", replace: "const a = 2" },
        ],
      },
      host,
    );
    assert.equal(host.files.get("a.ts"), "const a = 2;");
    assert.equal(r.wrote, "a.ts");
    assert.match(r.observation, /Applied 2 edit\(s\)/);
  })();
});

test("multi_edit aborts the whole batch on an ambiguous match, file unchanged", () => {
  return (async () => {
    const host = new FakeHost({ "a.ts": "x x\ny" });
    const r = await tool("multi_edit").run(
      {
        path: "a.ts",
        edits: [
          { find: "y", replace: "z" },
          { find: "x", replace: "w" },
        ],
      },
      host,
    );
    assert.match(r.observation, /multiple times/);
    assert.equal(host.files.get("a.ts"), "x x\ny");
  })();
});

test("multi_edit aborts the whole batch when a later edit's find is not found, file unchanged", () => {
  return (async () => {
    const host = new FakeHost({ "a.ts": "one\ntwo" });
    const r = await tool("multi_edit").run(
      {
        path: "a.ts",
        edits: [
          { find: "one", replace: "1" },
          { find: "three", replace: "3" },
        ],
      },
      host,
    );
    assert.match(r.observation, /not found/);
    assert.equal(host.files.get("a.ts"), "one\ntwo");
  })();
});

test("multi_edit errors on an empty edits array without reading the file", () => {
  return (async () => {
    const host = new FakeHost({ "a.ts": "x" });
    const r = await tool("multi_edit").run({ path: "a.ts", edits: [] }, host);
    assert.match(r.observation, /non-empty array/);
  })();
});

test("multi_edit errors when 'edits' is missing entirely", () => {
  return (async () => {
    const host = new FakeHost({ "a.ts": "x" });
    const r = await tool("multi_edit").run({ path: "a.ts" }, host);
    assert.match(r.observation, /non-empty array/);
  })();
});

test("multi_edit errors on a malformed edit, identifying the index", () => {
  return (async () => {
    const host = new FakeHost({ "a.ts": "x" });
    const r = await tool("multi_edit").run(
      { path: "a.ts", edits: [{ find: "x", replace: "y" }, { find: "x" }] },
      host,
    );
    assert.match(r.observation, /edits\[1\]/);
  })();
});
```

(The `return (async () => { ... })();` wrapper matches this file's
existing `async` test style if the file's tests are already written as
`test("...", async () => { ... })` directly — read the file first and
use whichever form its existing tests use; do not introduce a second
style. If existing tests are `test("...", async () => {...})`, write
these the same way instead of wrapping.)

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `packages/core`): `node --import tsx --test src/agent/tools.test.ts`
Expected: FAIL — `toolByName("multi_edit")` returns `undefined`, so
`tool("multi_edit")`'s `assert.ok(t, ...)` fails first.

- [ ] **Step 3: Add the `multi_edit` tool to `tools.ts`**

In `packages/core/src/agent/tools.ts`, insert this entry into the `TOOLS`
array immediately after the existing `edit_file` entry and before
`run_terminal`:

```typescript
  {
    name: "multi_edit",
    description:
      "Apply multiple find/replace edits to a single file in one call. Edits are " +
      "applied in order — each operates on the result of the previous one. Each " +
      "'find' must match exactly once at the point it's applied. All edits are " +
      "validated before any are written: if any edit fails, the file is left " +
      "completely unchanged.",
    args: '{ "path": string, "edits": Array<{ "find": string, "replace": string }> }',
    mutating: true,
    async run(args, host) {
      const path = str(args, "path");
      if (!path) return { observation: "Error: 'path' is required." };

      const rawEdits = args["edits"];
      if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
        return { observation: "Error: 'edits' must be a non-empty array." };
      }

      const edits: { find: string; replace: string }[] = [];
      for (let i = 0; i < rawEdits.length; i++) {
        const e = rawEdits[i] as Record<string, unknown> | null;
        const find = e && typeof e["find"] === "string" ? e["find"] : undefined;
        const replace = e && typeof e["replace"] === "string" ? e["replace"] : undefined;
        if (find === undefined || replace === undefined) {
          return { observation: `Error: edits[${i}] must have string 'find' and 'replace'.` };
        }
        edits.push({ find, replace });
      }

      let content: string;
      try {
        content = await host.readFile(path);
      } catch (err) {
        return { observation: `Error: cannot read ${path}. ${errText(err)}` };
      }

      for (let i = 0; i < edits.length; i++) {
        const { find, replace } = edits[i];
        const first = content.indexOf(find);
        if (first < 0) {
          return { observation: `Error: edits[${i}]'s 'find' text not found in ${path} (after applying ${i} prior edit(s)).` };
        }
        if (content.indexOf(find, first + find.length) >= 0) {
          return { observation: `Error: edits[${i}]'s 'find' text matches multiple times in ${path} (after applying ${i} prior edit(s)); make it more specific.` };
        }
        content = content.slice(0, first) + replace + content.slice(first + find.length);
      }

      await host.writeFile(path, content);
      return { observation: `Applied ${edits.length} edit(s) to ${path}.`, wrote: path };
    },
  },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `packages/core`): `node --import tsx --test src/agent/tools.test.ts`
Expected: PASS — all tests green.

- [ ] **Step 5: Run the full core suite to confirm nothing broke**

Run (from `packages/core`): `npm test`
Expected: PASS — 227 tests total (221 after Task 1 + 6 new
`multi_edit` tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/agent/tools.ts packages/core/src/agent/tools.test.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(core): add multi_edit agent tool for batched sequential find/replace"
```

---

### Task 3: `runner.ts` approval-card preview

**Files:**
- Modify: `extensions/vscode/src/agent/runner.ts`

**Interfaces:**
- Consumes: the `"multi_edit"` tool name and its `{ path, edits }` args
  shape from Task 2.

- [ ] **Step 1: Read the current `summarize()`/`buildDiffPreview()` bodies**

Read `extensions/vscode/src/agent/runner.ts` in full before editing —
these are per-tool-name `if` chains (not a `switch`), each ending in a
fallback (`return path;` for `summarize()`, `return undefined;` for
`buildDiffPreview()`). Confirm the exact current fallback lines before
inserting the new branches immediately before them.

- [ ] **Step 2: Add a `multi_edit` branch to `summarize()`**

Insert immediately before this function's final fallback line
(`return path;`):

```typescript
  if (tool === "multi_edit") {
    const edits = Array.isArray(args.edits) ? args.edits : [];
    return `Edit ${path} (${edits.length} edits)`;
  }
```

- [ ] **Step 3: Add a `multi_edit` branch to `buildDiffPreview()`**

Insert immediately before this function's final fallback line
(`return undefined;`):

```typescript
  if (tool === "multi_edit") {
    const edits = Array.isArray(args.edits) ? (args.edits as Record<string, unknown>[]) : [];
    const before = edits
      .map((e, i) => `[${i + 1}] ${typeof e.find === "string" ? e.find : ""}`)
      .join("\n");
    const after = edits
      .map((e, i) => `[${i + 1}] ${typeof e.replace === "string" ? e.replace : ""}`)
      .join("\n");
    return { before: clip(before), after: clip(after) };
  }
```

- [ ] **Step 4: Confirm `multi_edit` is included in Edit mode**

Read the `EDIT_MODE_TOOLS` filter (`TOOLS.filter((t) => t.name !==
"run_terminal" && t.name !== "view_diff")`) and confirm `multi_edit` is
not named in that filter — it should pass through unfiltered (Edit mode
is meant to allow file-editing tools, only excluding the two
subprocess-spawning ones). No code change needed if this filter is
exactly as described; if it has grown additional exclusions since the
spec was written, add `multi_edit` there is NOT correct — stop and
confirm with the user before excluding it, since the spec's decision is
that `multi_edit` belongs in Edit mode.

- [ ] **Step 5: Typecheck the extension**

Run: `npm run typecheck -w xpreiIDE-ai`
Expected: PASS.

- [ ] **Step 6: Compile the extension**

Run: `npm run compile -w xpreiIDE-ai`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add extensions/vscode/src/agent/runner.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(vscode): approval-card preview for multi_edit"
```

---

### Task 4: Final verification

**Files:** none (verification only).

**Interfaces:** none — consumes everything built in Tasks 1-3.

- [ ] **Step 1: Run the full core test suite**

Run: `npm test -w @xprei/core`
Expected: PASS — 227 tests total (220 before this plan + 1 orchestrator
regression test + 6 multi_edit tests).

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

1. Ask the agent to make two or more related edits to one file in a
   single step (e.g. "rename variable x to y and also update its
   comment" on a small test file). Confirm the model calls `multi_edit`
   (visible in the tool-call event) and the approval card shows a
   numbered before/after list, one entry per edit.
2. Accept the approval — confirm all edits landed in the file.
3. Repeat, but reject the approval — confirm the file is completely
   unchanged (none of the edits applied).
4. In Edit mode specifically, confirm `multi_edit` is still usable (not
   filtered out like `run_terminal`/`view_diff`).

This step requires a real Extension Development Host and is not
something that can be driven from an automated test — run it manually
and report any discrepancy.
