# Phase 1 agent tools — design

Date: 2026-07-25

## Context

First implementation phase from `docs/feature-roadmap.md`'s "Phase 1 — Quick
agent-tool wins": three additive agent tools, no dependencies on any other
phase. All three route through the existing universal prompt-based JSON tool
protocol (`packages/core/src/agent/protocol.ts`) — the same mechanism
`read_file`/`grep`/etc. already use — so they work with any model, including
weak local ones, with no native function-calling required.

- `read_file_range` — read a line range instead of a whole file. Token
  efficiency win, most valuable on small-context local models.
- `glob_search` — glob-based file finding, complements `grep`/`list_dir`.
- `view_diff` — surface the current git diff as agent context.

## Architecture

All three follow the existing tool shape in `packages/core/src/agent/tools.ts`:
a `Tool` entry (`ToolSpec` + `run(args, host)`) pushed onto the `TOOLS` array,
using the existing `str()`/`truncate()`/`errText()` helpers. No changes to
`protocol.ts` or the `Tool`/`ToolResult` interfaces.

Two of the three need no `AgentHost` interface change at all:

- **`read_file_range`** calls the existing `host.readFile` and slices by line
  index entirely in the tool layer.
- **`view_diff`** calls the existing `host.exec("git diff HEAD")` and returns
  its stdout. No new host method.

One needs a new host method:

- **`glob_search`** adds `glob(pattern: string): Promise<string[]>` to
  `AgentHost` (`packages/core/src/agent/host.ts`). Implemented via one shared,
  dependency-free glob matcher (new module `packages/core/src/agent/glob.ts`,
  pure and unit-tested — same "pure module in @xprei/core" pattern as
  `exclude.ts`), reused by **all three** host implementations
  (`NodeAgentHost`, `VscodeAgentHost`, `FakeHost`) so glob semantics are
  identical everywhere. `VscodeAgentHost` does **not** use
  `vscode.workspace.findFiles`'s native glob engine for this — it walks
  `vscode.workspace.fs` and matches through the same shared matcher as the
  other two hosts, trading a little more code for one guaranteed-consistent
  glob dialect across hosts.

## Tool specs

### `read_file_range`

- **Args:** `{ "path": string, "startLine": number, "endLine": number }`,
  1-indexed, inclusive — matches the line numbering `read_file` already
  displays.
- **Clamping:** `startLine < 1` clamps to `1`. `endLine` beyond the file's
  line count clamps to the last line. If `startLine > endLine` after
  clamping, return an `Error: ...` observation.
- **Errors:** missing/non-string `path`, missing/non-numeric `startLine` or
  `endLine`, or unreadable file → `Error: ...` observation, same style as
  existing tools.
- **Output:** the requested lines formatted as `"${lineNo}\t${line}"` (same
  format as `read_file`), passed through `truncate()`.

### `glob_search`

- **Args:** `{ "pattern": string, "path"?: string }` — `pattern` matched
  against the workspace-relative path; optional `path` scopes the search
  root, mirroring `grep`'s optional `path` arg.
- **Glob dialect (intentionally minimal):** `*` (wildcard within one path
  segment), `**` (wildcard across any depth), `?` (single character). No
  brace or bracket expansion — keeps the matcher small; nothing in this
  repo's own tooling needs more than this subset.
- **Exclusions:** walks skip anything `isExcludedPath` already flags
  (`node_modules`, `.git`, `dist`, `out`, `build`, etc. —
  `packages/core/src/context/exclude.ts`), same as `grep`'s existing walk.
- **Cap:** 200 matched paths (grep caps at 50 *hits*, but a glob hit is just
  a path — shorter than grep's line-text hits — so a higher cap is
  reasonable). Truncation is noted in the observation the same way other
  list-producing tools do.
- **No matches:** `No files match "<pattern>".` Missing/empty `pattern`:
  `Error: 'pattern' is required.`

### `view_diff`

- **Args:** none.
- Runs `host.exec("git diff HEAD")`. Empty stdout → `No changes.`.
  Non-empty stdout → the diff text through `truncate()`, same as
  `run_terminal`'s output handling.
- No git repo / git not installed → `exec` still returns an `ExecResult`
  with a nonzero code and populated `stderr`; surfaced the same way
  `run_terminal` already surfaces exec failures. No special-casing needed —
  `view_diff` doesn't need to distinguish "not a repo" from any other
  nonzero-exit case.

## Files touched

- `packages/core/src/agent/host.ts` — add `glob()` to `AgentHost`.
- `packages/core/src/agent/glob.ts` **(new)** — pure `matchGlob(pattern, path): boolean`
  plus a shared recursive-walk helper usable by both real hosts.
- `packages/core/src/agent/glob.test.ts` **(new)** — matcher unit tests: `*`,
  `**`, `?`, excluded-dir skipping, path-scoping.
- `packages/core/src/agent/tools.ts` — add `read_file_range`, `glob_search`,
  `view_diff` to `TOOLS`.
- `packages/core/src/agent/tools.test.ts` — extend with cases for all three
  (clamping, truncation, no-matches, empty diff) against `FakeHost`.
- `packages/core/src/agent/_fakehost.ts` — add `glob()`, matching over the
  in-memory file map via the shared matcher. `exec()` needs no changes —
  tests set `execResult` directly for the diff case, as already supported.
- `packages/core/src/host/nodeHost.ts` — implement `glob()` via a recursive
  walk (same shape as the existing `walk()` used by `grep`) + the shared
  matcher.
- `packages/core/src/host/nodeHost.test.ts` — extend with `glob()` cases
  against real temp-dir fixtures, matching this file's existing test style.
- `extensions/vscode/src/agent/host.ts` — implement `glob()` via
  `vscode.workspace.fs` walk + the shared matcher. No unit tests (the
  extension layer has none, per `CLAUDE.md` — verified by typecheck +
  manual smoke instead).
- `packages/core/package.json` — register `glob.test.ts` in the `test`
  script list, per this repo's convention that every new test file must be
  added there.

## Testing

Unit tests only, no live model needed, matching this repo's existing
convention (`CLAUDE.md`: "No test needs a live model"):

- `glob.test.ts` — the matcher in isolation.
- `tools.test.ts` — each tool's args validation, clamping, truncation, and
  error paths, against `FakeHost`.
- `nodeHost.test.ts` — `glob()` against real temp-dir fixtures.
- VS Code host (`extensions/vscode/src/agent/host.ts`) — verified by
  `npm run typecheck -w xpreiIDE-ai` and manual F5 smoke, same as the rest
  of that layer; no unit tests, consistent with existing project convention.

## Out of scope

- Any change to the agent protocol, orchestrator, or approval-card UI —
  these are read-only/informational tools (`mutating: false`), no new
  approval flow needed.
- Context-window budgeting for tool observations — that's Phase 3's
  problem; these tools use the same flat `MAX_OBS` truncation every
  existing tool already uses.
