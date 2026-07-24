# Diff-preview-before-apply for multi-file agent runs — design

Date: 2026-07-24

## Problem

The agent loop (`src/agent/orchestrator.ts`) is strict ReAct: on each step
the model picks one tool call, a mutating tool is approved individually,
executed immediately against the real filesystem, and the observation is
fed back before the model picks its next action. There is no point at which
the user sees the full set of changes a task is about to make before any of
them land on disk — approval is per-file, per-step, as the run goes.

`CLAUDE.md` (P5, "still open") calls this out explicitly: a true upfront
batch preview needs an orchestrator redesign, not just a UI change, because
the model's own subsequent reasoning depends on reading back files it just
wrote (e.g. editing a file it created two steps ago). This spec is that
redesign.

## Scope

In scope:
1. `PendingEditOverlay` — an `AgentHost` decorator that buffers
   `create_file`/`edit_file` writes in memory instead of touching disk, and
   answers `read_file`/`grep`/`list_dir`/`exists` from the overlay first,
   falling back to the real host.
2. Orchestrator wiring: mutating file tools run against the overlay;
   `run_terminal` triggers a silent flush of pending edits immediately
   before it runs (so the shell command sees consistent real files); `final`
   triggers a batch-review event for whatever edits are still pending.
3. A batch-review UI in the chat webview: one diff card per pending file,
   each with its own Accept/Reject, plus an "Accept all" / "Reject all"
   shortcut. Replaces the per-file approval card *only* for the edits still
   pending at `final` — edits already flushed by a `run_terminal` call went
   through the existing per-call approval and are unaffected.
4. Checkpoint integration: `Checkpoint.note()` still fires exactly once per
   path, at the point that path is actually written (flush or batch-accept),
   so the existing whole-run revert keeps working unchanged.

Out of scope:
- Changing `run_terminal`'s own approval UX (still per-call, immediate, as
  today).
- Any change to the tool protocol, `protocol.ts`, or the tool specs sent to
  the model — tools keep calling `host.readFile`/`writeFile` exactly as
  they do now; only which `AgentHost` instance they're handed changes.
- Deferring `run_terminal` itself, or any other non-file-write mutating
  tool that might be added later — only file writes are bufferable.
- A settings toggle to fall back to today's fully-immediate per-step
  approval. Not requested; can be a follow-up if the batch flow proves
  worse for some workflows.

## Architecture

### `PendingEditOverlay`

New file `src/agent/pendingEditOverlay.ts`. Implements `AgentHost`,
constructed with the real host it wraps:

```ts
export interface PendingEdit {
  path: string;
  before: string; // "" if the file doesn't exist on the real host yet
  existed: boolean;
  after: string;
}

export class PendingEditOverlay implements AgentHost {
  constructor(private readonly real: AgentHost) {}

  get cwd(): string { return this.real.cwd; }

  async readFile(path: string): Promise<string> // overlay entry if present, else real.readFile
  async exists(path: string): Promise<boolean>  // overlay entry (incl. delete-marker) if present, else real.exists
  async listDir(path: string): Promise<string[]> // real.listDir, with overlay-only new files merged in and overlay-deleted files removed, for the given dir
  async grep(query: string, path?: string): Promise<GrepHit[]> // real.grep, plus a linear scan of overlay entries under `path`
  async exec(command: string): Promise<ExecResult> // passthrough to real.exec (unaffected)

  async writeFile(path: string, content: string): Promise<void> // records/overwrites the overlay entry; does not call real.writeFile
  async deleteFile(path: string): Promise<void> // records a delete-marker entry; does not call real.deleteFile

  get pending(): PendingEdit[] // current overlay entries, diff-shaped
  async flush(path?: string): Promise<PendingEdit[]> // writes the given entry, or every pending entry if omitted, to `real` (or deletes, for delete-markers); clears just that entry (or all) from the overlay; returns what was written
  discard(path: string): void // drops one overlay entry without writing
}
```

`before`/`existed` are captured at first-write time (mirrors
`Checkpoint.note()`'s existing semantics) so a file edited twice in one run
still diffs against its *original* pre-run content, not an intermediate
overlay state.

`listDir`/`grep` only need to reconcile overlay entries that fall under the
requested `path` prefix — a linear scan over the (small, run-scoped) overlay
map is sufficient; no need for a trie or path-indexed structure at this
scale.

### Orchestrator wiring (`orchestrator.ts`)

`Agent` currently takes `host: AgentHost` in `AgentDeps` and hands it
straight to `tool.run(args, this.deps.host)`. Change: the constructor wraps
`deps.host` in a `PendingEditOverlay` once per `run()` call (fresh overlay
per task, not reused across runs) and passes the overlay to tools instead of
the raw host. `Checkpoint` keeps wrapping the *real* host, unchanged,
because it only ever needs to know about paths that actually reached disk.

`runTool()` today fires `onEdit` (the gutter-flash signal) immediately
after any mutating tool call where `result.wrote` is set, reading the
after-content back from the host. With writes now buffered, that firing
point is wrong for `create_file`/`edit_file`: the file isn't really on
disk yet, so an immediate read-back would show stale (or missing) content,
and the flash would never re-fire when the edit actually lands later. Fix:
drop the unconditional `onEdit` firing from the `result.wrote` branch for
file-write tools entirely; `onEdit` is instead fired once per path at the
point it actually flushes to real disk (both flush sites below), sourced
directly from the `PendingEdit.before`/`after` already captured by the
overlay rather than re-read from the host. `run_terminal` never sets
`result.wrote`, so it was never part of this path and is unaffected.

In `runTool()`:
- Before executing `run_terminal` specifically (checked by `tool.name`),
  call `checkpoint.note(path)` for every path in `overlay.pending` *first*
  (checkpoint reads from the real host, so this is safe to do any time
  before the real write happens), then call `overlay.flush()` to perform
  the writes — same ordering `runTool` already uses for other mutating
  tools, just applied to a batch instead of one path. For each entry
  `flush()` returns, fire `onEdit(path, before, after)` from the returned
  `PendingEdit`.
- After the loop exits via `final` (not via error or abort), if
  `overlay.pending.length > 0`, fire a new `onBatch` event with the pending
  list instead of the existing single-file `onEdit` event (which stays for
  files flushed mid-run by `run_terminal`).
- On abort (`signal.aborted`) or an error return, pending overlay entries
  are simply dropped (never written) — no special cleanup needed since
  nothing touched disk.

### `AgentEvents` addition

```ts
export interface AgentEvents {
  // ...existing members unchanged...
  onBatch?(entries: PendingEdit[]): Promise<BatchDecision[]>;
}

export interface BatchDecision {
  path: string;
  accept: boolean;
}
```

`onBatch` is async and returns the per-file decisions — the orchestrator
awaits it, then for each accepted path calls `checkpoint.note(path)`
*before* `overlay.flush(path)`, mirroring the single-file approval path
and the same before-the-write ordering used for the `run_terminal` flush
above, then fires `onEdit(path, before, after)` from the flushed entry
(consistent with the `run_terminal` flush site — both are just "a path
left the overlay and landed on disk" moments). Rejected paths are dropped
via `overlay.discard(path)`, which fires no event. Optional, like `onEdit`, so headless
test callers that don't care about batch UI don't need to implement it —
tests can omit it and rely on the default (implemented as: treat missing
`onBatch` as "accept everything," so existing orchestrator tests that don't
set up a batch UI keep passing unchanged).

### Runner / `ChatApprover` (`runner.ts`)

New `onBatch` implementation posts a `kind: "batch"` message to the chat
webview (parallel to the existing `kind: "approval"` message for
`requestApproval`), with the full `PendingEdit[]` list, and resolves once
the webview posts back per-file decisions.

### Webview (`chat.js` / `chatView.ts`)

New render path for `kind: "batch"`: a list of diff cards, each reusing the
existing before/after diff rendering already built for the single-file
approval card, each with its own Accept/Reject buttons instead of one
Approve/Reject/Approve-all row. A header-level "Accept all" / "Reject all"
sets every card's choice at once before a single "Done" submits the whole
batch back as one message (`{type: "batchResponse", decisions: [...]}`).

## Data flow (typical multi-edit task, no `run_terminal`)

1. Agent step 1: `create_file("a.ts", ...)` → overlay records it, no disk
   write, no approval prompt (still requires `approver.approve()` today —
   unchanged; only the *write* is deferred, not the approval gate).
2. Agent step 2: `read_file("a.ts")` → overlay returns the pending content
   from step 1, not a disk read (file may not even exist on disk yet).
3. Agent step 3: `edit_file("b.ts", ...)` → overlay records it.
4. Agent step 4: `final` → `overlay.pending` has 2 entries → `onBatch`
   fires → webview shows 2 diff cards → user accepts `a.ts`, rejects `b.ts`
   → `a.ts` flushes to disk (checkpoint notes it), `b.ts` is discarded,
   never existed on disk.

## Data flow (task that also runs tests)

1. Agent creates/edits 3 files (buffered, as above).
2. Agent calls `run_terminal("npm test")` → orchestrator checkpoints all 3
   pending paths, then flushes them to real disk, *before* the approval
   prompt for the command itself is shown (the command needs to see real
   files to be meaningful; there's no diff to preview for a shell command,
   only the command string, which the existing approval card already
   shows) → command runs against real files → observation fed back.
3. Agent makes one more edit based on test output, then `final` → only that
   last edit is pending → single-entry batch review (still goes through the
   same `onBatch` path, not a special-cased single-file path — one entry is
   just the minimum case of the general flow).

This means "diff preview before apply" is not an absolute guarantee across
an entire run once `run_terminal` is involved — edits preceding a terminal
call are written silently (no diff card) so the command has real files to
act on. This is called out in-code and is a deliberate trade-off: the
alternative (also gating the pre-terminal flush on a diff approval) was
considered and rejected during design because it doubles the approval
surface for the common edit→test→fix loop without adding real review value
(the user already approves the terminal command itself, and can inspect the
already-flushed files via the standard editor/SCM diff view or the existing
gutter-flash feedback).

## Error handling

- Overlay `readFile` on a path with a delete-marker entry throws the same
  "file not found" shape the real host would, so tool error messages stay
  consistent regardless of whether a file is pending-deleted or actually
  absent.
- If `overlay.flush()` (full or single-path) throws partway through writing
  multiple entries (e.g. disk full, permissions), already-written entries
  stay written and checkpointed (so revert still covers them); unwritten
  entries stay pending and are surfaced back in a follow-up `onBatch`/retry
  rather than silently lost — `flush()` returns/throws per-entry results
  rather than an all-or-nothing promise.
- Webview disconnect/reload mid-batch-review: same pattern already used for
  `pendingApproval` (`chatView.ts`) — the promise simply never resolves
  until a response arrives; `rehydrate()` does not need special handling
  for an in-flight batch since the batch only exists for the duration of a
  single agent run tied to one webview session.

## Testing

- `pendingEditOverlay.test.ts` (new, headless against the existing fake
  host pattern used elsewhere in `src/agent/*.test.ts`): overlay-read
  falls back to real host; overlay-read returns pending content after a
  buffered write; `listDir`/`grep` merge pending creates and hide pending
  deletes; `flush()` writes everything and clears state; `flush()` on a
  subset (single path) leaves the rest pending; `discard()` drops without
  writing; delete-marker semantics for `exists`/`readFile`.
- `orchestrator.test.ts` (extend): a run with only `create_file`/`edit_file`
  calls never calls the underlying real host's `writeFile` until `onBatch`
  accepts, and `onEdit` does not fire until that accept; `run_terminal`
  triggers a flush (real `writeFile` called, `onEdit` fires per flushed
  path) before the command executes; `onBatch` receives exactly the
  still-pending entries at `final`; per-file accept/reject in the batch
  response results in exactly the accepted paths being written and firing
  `onEdit`, rejected paths firing neither; omitting `onBatch` in test deps
  defaults to accept-all (keeps existing tests passing unmodified).
- No new UI/webview test infra exists in this repo (chat.js is untested
  today, consistent with the rest of the webview layer) — batch-review
  webview rendering is verified manually per the project's existing "test
  in a real Extension Development Host" convention for UI changes.
