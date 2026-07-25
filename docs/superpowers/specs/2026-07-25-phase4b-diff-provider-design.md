# Phase 4b: @diff context provider — design

Date: 2026-07-25

## Context

Third provider sub-project of Phase 4 ("Richer context providers") from
`docs/feature-roadmap.md`, following the decomposition (Foundation → 4a →
4b → 4c → 4d → 4e). Adds `@diff` — inject the current git diff (staged +
unstaged) as chat context, so the user can ask about their in-progress
changes without pasting a diff by hand.

Phase 1 already built an agent-loop tool with the same name-in-spirit,
`view_diff` (`packages/core/src/agent/tools.ts`), which runs `git diff
HEAD` via `AgentHost.exec()`. That's a different code path (the agent tool
loop, with shell exec available through `AgentHost`) — `ContextEngine`
(where chat mentions are built) has no `AgentHost`, no shell-exec seam,
and is VS Code-API-only today. `@diff` reuses neither `view_diff`'s
implementation nor its exact git invocation; it's a parallel feature for
a parallel code path, sharing only its conceptual output (a diff).

## Decisions

- **Reuse `vscode.git`'s built-in extension API, not shell exec.**
  `extensions/vscode/src/git/commitMessage.ts` already established this
  exact pattern (`getGitApi()` + `Repository.diff(cached?: boolean)`) for
  the SCM commit-message feature. `@diff` follows the identical approach
  rather than introducing `child_process` into `ContextEngine` — no new
  host-access seam, reuses a pattern already proven and shipped in this
  codebase.
- **Extract the shared git-API helper.** `commitMessage.ts`'s private
  `getGitApi()` plus its ambient `GitRepository`/`GitAPI`/
  `GitExtensionExports` interfaces move into a new shared module,
  `extensions/vscode/src/git/gitApi.ts`. Both `commitMessage.ts` and
  `contextEngine.ts` import from it — avoids a second private copy of the
  identical ambient typing.
- **Staged + unstaged combined**, matching Phase 1's `view_diff` semantics
  (`git diff HEAD` covers both) for consistency across the two code paths
  that both call themselves "the diff." `repo.diff(false)` (unstaged) and
  `repo.diff(true)` (staged) are both called and concatenated.
- **One single segment, `"break"` strategy.** A diff can't be usefully
  split into independent pieces the way files or diagnostics can — a
  truncated middle-of-a-diff is still a readable (if incomplete) patch,
  unlike a truncated diagnostic. `"break"` truncates it if the budget is
  tight, same semantics as `@file:`/`@open`.
- **Tier priority: between `@problems` and `@open`.** `@diff` is an
  explicit user request (like `@file:`/`@open`), so it sits with them
  rather than the relevance-guess `@codebase` hits. Placed after
  `@problems` (very compact, deserves to survive) and before `@open`
  (bulkier, a closer priority match to a diff's typical size). Full
  order, highest to lowest: `@file:` (`"break"`) → `@problems` (`"skip"`)
  → `@diff` (`"break"`, one segment) → `@open` (`"break"`) →
  `@codebase` hits (`"skip"`).
- **Silent-empty on every "nothing to show" case**, matching
  `@problems`/`@open`'s existing precedent (not `commitMessage.ts`'s
  warning-toast pattern — a toast fits an explicit one-shot command, not
  a chat mention that silently contributes nothing when there's nothing
  to contribute, consistent with how the other Phase 4a providers already
  behave). Covers: no git repository in the workspace, repo present but
  clean working tree, `vscode.git` extension not installed/activated.

## Architecture

### `extensions/vscode/src/git/gitApi.ts` (new)

Extracted verbatim from `commitMessage.ts`'s current private helper:

```typescript
// Ambient typing for the subset of the built-in "vscode.git" extension's
// API this codebase uses — that extension ships no public .d.ts. Shared
// by commitMessage.ts and contextEngine.ts.

export interface GitRepository {
  inputBox: { value: string };
  diff(cached?: boolean): Promise<string>;
}
export interface GitAPI {
  repositories: GitRepository[];
}
export interface GitExtensionExports {
  getAPI(version: 1): GitAPI;
}

export async function getGitApi(): Promise<GitAPI | undefined> {
  const ext = vscode.extensions.getExtension<GitExtensionExports>("vscode.git");
  if (!ext) return undefined;
  const exports = ext.isActive ? ext.exports : await ext.activate();
  return exports.getAPI(1);
}
```

`commitMessage.ts` drops its own copies of these and imports from the new
module instead — no behavior change to commit-message generation.

### `packages/core/src/context/mentions.ts`

One new boolean flag, parsed identically to `@open`/`@problems`:

```typescript
export interface Mentions {
  codebase: boolean;
  open: boolean;
  problems: boolean;
  diff: boolean; // new
  files: string[];
  cleaned: string;
}

const DIFF_RE = /(^|\s)@diff\b/gi;
```

Stripped from `cleaned` the same way; `hasContextRequest()` gains
`|| m.diff`.

### `packages/core/src/context/retrieval.ts`

One new formatter — a diff is a plain string, no new type needed:

```typescript
export function formatDiff(diff: string): string {
  return `// Current git diff:\n${diff}`;
}
```

`buildContextMessage` gains a fourth optional parameter, assembled in
tier-priority position:

```typescript
export function buildContextMessage(parts: {
  retrieved?: string;
  files?: string;
  problems?: string;
  diff?: string; // new
}): string {
  const sections: string[] = [];
  if (parts.files) sections.push(parts.files);
  if (parts.problems) sections.push(parts.problems);
  if (parts.diff) sections.push(parts.diff);
  if (parts.retrieved) sections.push("// Relevant code from the workspace:\n" + parts.retrieved);
  // ...
}
```

(Note: `@open`'s content is folded into the `files` section already, per
Phase 4a's design — `parts.diff` is a new, separate section between
`problems` and `retrieved`, matching the locked tier order.)

### `extensions/vscode/src/context/contextEngine.ts`

One new private gathering method:

```typescript
private async readDiff(): Promise<string> {
  const api = await getGitApi();
  const repo = api?.repositories[0];
  if (!repo) return "";
  const [unstaged, staged] = await Promise.all([repo.diff(false), repo.diff(true)]);
  return [unstaged, staged].filter(Boolean).join("\n");
}
```

`buildContext()` grows a fifth tier, inserted at its documented priority
position, built unconditionally:

```typescript
const diff = mentions.diff ? await this.readDiff() : "";

const diffTier: SegmentTier = {
  segments: diff ? [{ text: formatDiff(diff), data: null }] : [],
  strategy: "break",
};

const [keptFileSegs, keptProblemSegs, keptDiffSegs, keptOpenSegs, keptHitSegs] = budgetContext(
  [fileTier, problemTier, diffTier, openTier, hitTier],
  contextWindow,
);

const budgetedDiff = keptDiffSegs[0]?.text; // "break" may have truncated it

return buildContextMessage({
  files: allFiles.length ? formatFiles(allFiles, Number.POSITIVE_INFINITY) : undefined,
  problems: budgetedProblems.length ? formatProblems(budgetedProblems) : undefined,
  diff: budgetedDiff,
  retrieved: budgetedHits.length ? formatHits(budgetedHits, Number.NEGATIVE_INFINITY) : undefined,
});
```

(`formatDiff` is applied to the segment's `text` before budgeting, not
after — same pattern `problemTier` already uses per-segment, so the
`// Current git diff:` header itself counts toward the tier's budget, and
`"break"`'s truncation-marker append happens after the header, which is
acceptable since the header is short and fixed-size.)

## Out of scope

- No path-scoped `@diff:src/x.ts` syntax — bare flag only, matching
  `@open`/`@problems`.
- No diff-against-a-specific-commit/branch syntax — always the current
  working-tree state (staged + unstaged vs. the last commit), matching
  `view_diff`'s `git diff HEAD` semantics.
- No change to `view_diff` (the agent tool) or its exec-based
  implementation — `@diff` and `view_diff` are two independent features
  that happen to solve the same conceptual problem on two different code
  paths.
- No change to `commitMessage.ts`'s behavior — only its git-API lookup
  moves to a shared module; its own logic is untouched.

## Testing

- `mentions.ts`: extend `mentions.test.ts` with `@diff` flag parsing/
  stripping and combination with the other three mention types.
- `retrieval.ts`: extend `retrieval.test.ts` with `formatDiff` and the
  widened `buildContextMessage`'s four-section ordering (files, problems,
  diff, retrieved).
- `gitApi.ts` extraction + `contextEngine.ts`'s `readDiff()`/tier wiring:
  extension-layer, VS Code-API-dependent — no unit tests, verified by
  `npm run typecheck -w xpreiIDE-ai` + `npm run compile -w xpreiIDE-ai`,
  plus a manual smoke test: stage some changes, leave others unstaged,
  send `@diff`, confirm both appear combined in the model's context; test
  against a clean working tree and confirm silent no-op (no error, no
  empty-diff artifact in the context block); confirm `commitMessage.ts`'s
  existing behavior (SCM commit-message generation) is unaffected by the
  `gitApi.ts` extraction.
