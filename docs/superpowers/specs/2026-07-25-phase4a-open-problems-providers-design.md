# Phase 4a: @open + @problems context providers — design

Date: 2026-07-25

## Context

First provider sub-project of Phase 4 ("Richer context providers") from
`docs/feature-roadmap.md`, per the decomposition agreed this session
(Foundation → 4a → 4b → 4c → 4d → 4e). Bundled here because both are
simple synchronous VS Code API reads with no external I/O, no shell
execution, and no network access — the lowest-risk pair of the six
planned providers.

**`@open`** — inject the content of every currently-open editor tab, so
the model sees what the user is actively working with without an explicit
`@file:` for each one.

**`@problems`** — inject the workspace's current error/warning diagnostics
(red/yellow squigglies), so the model can see what's broken without the
user having to paste compiler/linter output by hand.

Both build on Phase 4 Foundation's tier-based `budgetContext` (just
shipped): each becomes one more `SegmentTier` in `contextEngine.ts`'s
`buildContext()`, consumed the same way the existing file/hit tiers are.

## Decisions

- **`@open`: all tabs, not just visible ones.** `vscode.window.tabGroups.all`
  (every tab in every group) rather than `vscode.window.visibleTextEditors`
  (only what's on-screen right now) — matches how a user actually thinks
  of "what I have open," including background tabs in an unfocused split
  or a tab group that isn't currently visible.
- **`@open`: full content, not just a file list.** Reuses the exact
  `FileContext { path, content }` shape `@file:` already produces, so the
  model genuinely sees the code, not just that a file exists. This also
  means `@open` reuses `formatFiles` — no new formatter needed for this
  provider.
- **`@open`: de-duplicated against explicit `@file:` mentions.** A file
  that's both open in a tab and explicitly `@file:`-mentioned is only
  inlined once, via the file tier — `@open`'s gathering step excludes any
  path already present in `mentions.files`.
- **`@problems`: Error + Warning severity only, scoped to open files.**
  Skips `Information`/`Hint` (often just style nits, not "broken") and
  skips diagnostics on files the user isn't currently looking at — keeps
  the block relevant to "what's wrong in front of me right now" rather
  than every lint warning in the whole workspace.
- **`@problems`: bare flag, no path argument.** Matches `@codebase`'s
  existing shape (`@problems`, not `@problems:src/x.ts`) — since it's
  already scoped to open files by design, a path argument would be
  redundant.
- **Tier priority** (extends Foundation's tier list, files still first,
  hits still last): `@file:` (`"break"`, unchanged, highest — explicit
  request) → `@problems` (`"skip"` — compact, highly actionable list;
  a small tier deserves to survive even when one item is large) →
  `@open` (`"break"` — bulkier, ordered like files, truncate-and-stop
  on overflow) → `@codebase` hits (`"skip"`, unchanged, lowest — a
  relevance guess). Every tier is built **unconditionally** (empty array
  when its mention isn't present), per Foundation's documented
  positional-alignment invariant — never conditionally pushed.

## Architecture

### `packages/core/src/context/mentions.ts`

Two new boolean flags, parsed the same simple way as `@codebase`:

```typescript
export interface Mentions {
  codebase: boolean;
  open: boolean;      // new
  problems: boolean;  // new
  files: string[];
  cleaned: string;
}

const OPEN_RE = /(^|\s)@open\b/gi;
const PROBLEMS_RE = /(^|\s)@problems\b/gi;
```

Stripped from `cleaned` the same way `CODEBASE_RE` already is.
`hasContextRequest()` becomes `m.codebase || m.open || m.problems || m.files.length > 0`.

### `packages/core/src/context/retrieval.ts`

One new type and formatter, matching the existing style:

```typescript
export interface ProblemInfo {
  path: string;
  line: number; // 1-based
  severity: "error" | "warning";
  message: string;
}

export function formatProblems(problems: ProblemInfo[]): string {
  return problems
    .map((p) => `// ${p.path}:${p.line} (${p.severity}) ${p.message}`)
    .join("\n");
}
```

`@open` needs no new formatter — it reuses `formatFiles` against the same
`FileContext[]` shape `@file:` already produces.

### `extensions/vscode/src/context/contextEngine.ts`

Two new private gathering methods:

```typescript
private readOpenFiles(excludePaths: Set<string>): Promise<FileContext[]>
// Enumerates vscode.window.tabGroups.all, filters to TabInputText tabs,
// reads each file's content (same MAX_FILE_CHARS truncation readFiles()
// already applies), skips any path in excludePaths (already-@file:'d).

private readProblems(): ProblemInfo[]
// vscode.languages.getDiagnostics() filtered to Error/Warning severity
// and to paths currently open in a tab (same tab enumeration as
// readOpenFiles, so both share one tabGroups.all pass).
```

`buildContext()` grows two more tiers, built unconditionally:

```typescript
const openFiles = mentions.open
  ? await this.readOpenFiles(new Set(files.map((f) => f.path)))
  : [];
const problems = mentions.problems ? this.readProblems() : [];

const problemTier: SegmentTier = {
  segments: problems.map((p) => ({ text: formatOneProblem(p), data: p })),
  strategy: "skip",
};
const openTier: SegmentTier = {
  segments: openFiles.map((f) => ({ text: f.content, data: f })),
  strategy: "break",
};

const [keptFiles, keptProblems, keptOpen, keptHits] = budgetContext(
  [fileTier, problemTier, openTier, hitTier],
  contextWindow,
);
```

(`formatOneProblem` — a small per-item formatter, or `formatProblems`
called on a one-element array per segment, whichever reads more naturally
in the final implementation — the important constraint is that each
diagnostic becomes its own segment so `"skip"` can drop individual
diagnostics rather than the whole list.)

`buildContextMessage` (in `retrieval.ts`) gains a `problems?: string`
parameter alongside its existing `files?`/`retrieved?`, assembled the same
way; `@open`'s reconstructed `FileContext[]` is folded into the same
`files` section `@file:` already produces (concatenated before calling
`formatFiles`, since both are the same shape and same formatter) — no new
section needed in the assembled message for `@open` specifically.

## Out of scope

- No path-scoped `@problems:src/x.ts` syntax — bare flag only.
- No diagnostics from files that aren't open — matches your chosen scope.
- No Information/Hint severity.
- No change to `@codebase`/`@file:` behavior or priority relative to each
  other — only their position relative to the two new tiers changes.
- `formatFiles`/`formatHits` currently have **no existing unit tests**
  (`retrieval.test.ts` does not exist yet) — this plan adds tests for the
  new `formatProblems` and, since a test file is being created for this
  module for the first time, backfills basic coverage for the two
  existing formatters at the same time (cheap, and closes a real gap
  discovered while scoping this phase).

## Testing

- `mentions.ts`: extend the existing `mentions.test.ts` with cases for
  `@open`/`@problems` flag parsing, stripping, and combination with
  existing mention types (e.g. `@open @problems @codebase` together).
- `retrieval.ts`: new `retrieval.test.ts` — `formatProblems` (single/
  multiple diagnostics, empty array), plus backfilled basic tests for
  `formatFiles`/`formatHits`/`buildContextMessage` (including the new
  `problems?` parameter).
- `contextEngine.ts`: extension-layer, VS Code-API-dependent — no unit
  tests, verified by `npm run typecheck -w xpreiIDE-ai` +
  `npm run compile -w xpreiIDE-ai`, plus a manual smoke test: open 2-3
  files with a mix of errors/warnings, send `@open`, confirm all open
  files' content appears; send `@problems`, confirm errors/warnings from
  open files appear with correct path/line/severity; send both together
  with `@file:` and `@codebase`, confirm all four tiers appear in the
  documented priority order and none crash when a mention type has
  nothing to contribute (e.g. `@problems` with zero diagnostics).
