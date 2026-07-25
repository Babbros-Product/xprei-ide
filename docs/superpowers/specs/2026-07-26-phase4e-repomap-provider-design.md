# Phase 4e: @repomap context provider — design

Date: 2026-07-26

## Context

Sixth and last provider sub-project of Phase 4 ("Richer context
providers") from `docs/feature-roadmap.md`. Sequenced last because it's
the outlier: an "aider-style repo-map" (as originally described in the
roadmap) implies real AST parsing across multiple languages (tree-sitter
or similar) plus a reference-graph ranking algorithm (aider itself uses a
PageRank-like pass over which symbols are referenced by which files) to
decide what fits in a token budget. That is a genuinely large,
multi-language, dependency-adding project — this repo's first departure
from the dependency-free philosophy every prior phase has followed — and
realistically its own multi-session project, not something to build
alongside 4c/4d in one sitting.

**Scope decision (approved):** ship a deliberately simplified v1 —
regex-based symbol extraction, no cross-file reference graph, no
ranking. Explicitly **not** full aider parity. `@repomap` gives the model
a lightweight "here's what's exported where" overview of the workspace,
not a dependency graph.

## Decisions

- **Bare mention, no argument.** `@repomap` maps the whole workspace —
  there's no single target to name, unlike `@file:`/`@terminal:`/`@url:`.
  Matches `@open`/`@problems`/`@diff`'s flag shape.
- **Regex-based extraction, no AST, no dependency.** Per-language regexes
  find top-level exported/public symbols. Not as precise as real parsing
  (will miss unusual syntax, can't resolve re-exports or aliasing), but
  zero new dependencies, consistent with every prior Phase 4 provider's
  constraint, and "good enough" for a lightweight overview.
- **No cross-file reference graph, no ranking.** Every matched file's
  symbols are extracted independently; there's no attempt to determine
  which files are "more important" by how often they're referenced
  elsewhere (the core of aider's actual algorithm). Priority/survival
  under budget pressure is handled entirely by the existing tier
  `"skip"` strategy (smaller files survive over larger ones, in
  whatever order they're discovered), not by relevance ranking.
- **v1 language coverage: TypeScript/JavaScript + Python.** Covers this
  project's own primary language plus one of the most common secondary
  languages developers using this extension will have. Files in any
  other language contribute nothing to the map (silently skipped, not
  listed with zero symbols) — narrower coverage now, extensible later
  by adding another per-language regex to the same module.
- **No caching — computed fresh on every mention.** Matches `@open`/
  `@problems`'s "read live workspace state" philosophy rather than
  `@codebase`'s persisted/incrementally-updated index. Simpler (no
  persistence format, no invalidation, no watcher wiring) — a real
  scalability concern for a huge monorepo, but out of scope for v1;
  revisit only if real usage shows it's actually slow.
- **Multi-segment tier, `"skip"` strategy.** Unlike `@diff`/`@terminal`/
  `@url` (one monolithic blob each), a repo-map is naturally many
  independent per-file entries — the same shape as `@codebase` hits or
  `@open`'s files. `"skip"` lets smaller files' summaries survive even
  when a large file's doesn't fit.
- **Tier priority: after `@open`, before `@codebase` hits.** Grouped with
  the other broad, non-single-target context tiers. Full order, highest
  to lowest: `@file:` (`"break"`) → `@problems` (`"skip"`) → `@diff`
  (`"break"`) → `@terminal` (`"break"`) → `@url` (`"break"`) → `@open`
  (`"break"`) → `@repomap` (`"skip"`) → `@codebase` hits (`"skip"`,
  lowest).
- **Capped file scan** (`MAX_REPOMAP_FILES = 500`) to avoid a runaway
  walk on a huge monorepo — the same defensive-cap spirit as the
  existing `MAX_FILE_BYTES`/`MAX_FILE_CHARS` constants, not a new
  category of concern.

## Architecture

### `packages/core/src/context/repomap.ts` (new, pure)

```typescript
// Regex-based, per-language top-level symbol extraction. No AST, no
// dependency, no cross-file reference graph or ranking — a deliberately
// simplified v1 (see design doc for why). Pure module — no vscode.

export interface FileSymbols {
  path: string;
  symbols: string[];
}

// Returns undefined for unrecognized extensions or files with zero
// extracted symbols — callers should skip such files entirely, not
// list them with an empty symbol list.
export function extractSymbols(path: string, content: string): FileSymbols | undefined {
  // Dispatches on file extension to the matching per-language regex
  // pass (TS/JS export declarations; Python top-level def/class,
  // skipping underscore-prefixed names). Returns undefined if the
  // extension isn't recognized or the pass finds nothing.
}
```

TS/JS pass: one multiline regex anchored per-line, matching
`export [async] function|class|interface|type|const|let <Name>`.
Python pass: column-0-anchored `def`/`class <name>`, excluding names
starting with `_`.

### `packages/core/src/context/mentions.ts`

```typescript
export interface Mentions {
  codebase: boolean;
  open: boolean;
  problems: boolean;
  diff: boolean;
  terminalCommand: string | undefined;
  url: string | undefined;
  repomap: boolean; // new
  files: string[];
  cleaned: string;
}

const REPOMAP_RE = /(^|\s)@repomap\b/gi;
```

Stripped the same way `OPEN_RE`/`PROBLEMS_RE`/`DIFF_RE` are.
`hasContextRequest()` gains `|| m.repomap`.

### `packages/core/src/context/retrieval.ts`

```typescript
export function formatRepoMap(files: FileSymbols[]): string {
  return files.map((f) => `// ${f.path}: ${f.symbols.join(", ")}`).join("\n");
}
```

`buildContextMessage` gains a seventh optional parameter, `repomap?: string`,
assembled at the locked tier position (after `open`'s implicit position,
before `retrieved`).

### `extensions/vscode/src/context/contextEngine.ts`

One new private method:

```typescript
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

`buildContext()` grows an eighth tier at the locked position, built
unconditionally like every other tier:

```typescript
const repoFiles = mentions.repomap ? await this.buildRepoMap() : [];

const repomapTier: SegmentTier = {
  segments: repoFiles.map((f) => ({ text: `// ${f.path}: ${f.symbols.join(", ")}`, data: f })),
  strategy: "skip",
};
```

inserted into the `budgetContext([...])` array and the positional
destructure between the open tier/segments and the hit tier/segments.
Reconstruction after budgeting mirrors the existing hit-tier pattern
(`"skip"` never truncates, so `seg.data` is used raw): budgeted
`FileSymbols[]` fed to `formatRepoMap()`.

## Out of scope

- No AST parsing, no tree-sitter or similar dependency.
- No cross-file reference graph, no PageRank-style importance ranking.
- No language coverage beyond TypeScript/JavaScript/Python in v1.
- No caching/persistence/incremental updates — always a fresh walk.
- No path-scoped `@repomap:src/` syntax — bare flag only, whole
  workspace.
- Full aider parity remains a possible future project, explicitly
  deferred, not attempted here.

## Testing

- `mentions.ts`: extend `mentions.test.ts` with `@repomap` flag parsing
  and combination with the other mention types.
- `repomap.ts` (new, pure): full unit tests — TS/JS export variants
  (function/class/interface/type/const/let, async function), Python
  def/class at column 0 with underscore-prefixed names correctly
  excluded, indented Python def/class (inside a class body) correctly
  excluded from the top-level pass, an unrecognized extension returning
  `undefined`, and a recognized-extension file with zero matching
  symbols also returning `undefined`.
- `retrieval.ts`: extend `retrieval.test.ts` with `formatRepoMap` and
  the widened `buildContextMessage`'s seven-section ordering.
- `contextEngine.ts`'s `buildRepoMap()`: extension-layer, VS Code-API-
  dependent — no unit tests, verified by `npm run typecheck -w xpreiIDE-ai`
  + `npm run compile -w xpreiIDE-ai`, plus a manual smoke test: run
  `@repomap` in this real repo and confirm it lists TS/JS source files
  with real exported symbols (e.g. `packages/core/src/context/budget.ts`
  showing `budgetContext`, `WeightedSegment`, etc.), confirm
  `node_modules`/`dist`/`.git` are absent, and confirm a `.md`/`.json`
  file contributes nothing.
