# Phase 5: `multi_edit` agent tool — design

Date: 2026-07-26

## Context

Phase 5 of `docs/feature-roadmap.md`. Batches multiple find/replace edits
against a single file into one agent tool call, instead of one
`edit_file` call per edit. Depends on Phase 1's tool-registration
conventions (already established: add an entry to the `TOOLS` array,
nothing else required for the model to see it).

**Scope decision (approved):** scoped to `multi_edit` only. The roadmap
also notes this connects to the already-approved-but-unimplemented
`diff-preview-before-apply` design
(`docs/superpowers/specs/2026-07-24-diff-preview-before-apply-design.md`)
— that remains a separate, independently implementable project (its own
full orchestrator redesign: `PendingEditOverlay`, batch-review webview
UI). Not pulled into this phase.

## Decisions

- **Sequential application, single file.** `multi_edit` takes one `path`
  and an ordered array of `{ find, replace }` pairs. Each edit operates on
  the result of the *previous* edit in the same call — not all matched
  against the original file content independently.
- **Exact-match-once per edit, same rule as `edit_file`.** At the point
  each edit is applied, its `find` must match exactly once in the
  content-so-far. Zero matches or multiple matches is an error.
- **Atomic: validate fully in memory, write once.** All edits are applied
  to an in-memory copy of the file first. `host.writeFile()` is called
  exactly once, only if every edit in the batch succeeds. A failure
  partway through (e.g. edit 3 of 5 doesn't match) leaves the file
  completely unchanged — not partially edited.
- **No whole-file-overwrite mode.** Unlike `edit_file` (which allows
  omitting `find` to overwrite the whole file), `multi_edit` always
  requires `find` on every edit. Whole-file replacement is already
  `edit_file`'s/`create_file`'s job.
- **No orchestrator or protocol changes.** Confirmed by reading
  `packages/core/src/agent/orchestrator.ts:141-154`: checkpoint/revert
  and the gutter-flash `onEdit` event both key off `tool.mutating` +
  `result.wrote` generically, not per-tool-name — `multi_edit` gets both
  automatically like any other mutating tool. Tools are surfaced to the
  model purely by being in the `TOOLS` array (confirmed precedent: Phase
  1's `read_file_range`/`glob_search` needed no `protocol.ts` change).
- **One VS Code-layer touch.** `extensions/vscode/src/agent/runner.ts`'s
  `summarize()`/`buildDiffPreview()` build the approval-card preview
  purely from `args` (no file read) via a per-tool-name switch — needs a
  `multi_edit` case each.

## Architecture

### `packages/core/src/agent/tools.ts` (modified)

New entry in the `TOOLS` array, after `edit_file`:

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

### `extensions/vscode/src/agent/runner.ts` (modified)

`summarize()` gains a `multi_edit` branch, alongside the existing
`edit_file` branch:

```typescript
if (tool === "multi_edit") {
  const edits = Array.isArray(args.edits) ? args.edits : [];
  return `Edit ${path} (${edits.length} edits)`;
}
```

`buildDiffPreview()` gains a `multi_edit` branch. Since `multi_edit` has
no single find/replace pair, the preview is a numbered list on each side
(purely from `args`, no file read, consistent with the existing
comment "already ARE a diff — no need to read the file back"):

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

### Edit mode

`EDIT_MODE_TOOLS` (`runner.ts`) filters out only `run_terminal` and
`view_diff` (the two tools that spawn a subprocess) — `multi_edit` is a
file-only tool and is included in Edit mode automatically, no filter
change needed.

## Out of scope

- `diff-preview-before-apply` (separate spec, separate future project).
- Cross-file batching (`multi_edit` operates on exactly one `path` per
  call, matching `edit_file`'s single-file scope — an agent doing a
  multi-file rename still issues one `multi_edit`/`edit_file` call per
  file).
- A whole-file-overwrite mode within `multi_edit` — use `edit_file` (no
  `find`) or `create_file` instead.

## Testing

Extend `packages/core/src/agent/tools.test.ts` (same `FakeHost` pattern
already used for `edit_file`'s tests):

- Two sequential edits where the second edit's `find` only exists after
  the first edit has been applied (proves sequential, not
  independent-against-original, application).
- An ambiguous match on the second of three edits aborts the whole batch
  — the file is confirmed completely unchanged (not partially edited to
  reflect edit 1).
- A not-found match on the second of two edits aborts the batch — file
  unchanged.
- Empty `edits` array errors, without reading the file.
- Missing `edits` key entirely errors.
- A malformed edit (missing `find` or `replace`, or a non-object array
  entry) errors, identifying which index is malformed.
- A successful multi-edit call returns `wrote: path` (for checkpoint/
  revert wiring) and an observation reporting the edit count.

No test needed for `runner.ts`'s `summarize()`/`buildDiffPreview()` —
that file has no existing unit tests (VS Code-layer, UI-cosmetic only),
consistent with the rest of that module; verified by
`npm run typecheck -w xpreiIDE-ai` + `npm run compile -w xpreiIDE-ai`
plus a manual smoke test: ask the agent to make 2+ related edits to one
file in a single step, confirm the approval card shows a numbered
before/after list, confirm accepting applies all edits and rejecting
applies none.

## User-facing docs

`multi_edit` is model-invoked, not directly typed by the user (unlike the
`@`-mention providers) — no README update needed. The approval-card UX
change (numbered list instead of a single find/replace) is visible but
self-explanatory; no doc claims the current single-pair format as a
guarantee.
