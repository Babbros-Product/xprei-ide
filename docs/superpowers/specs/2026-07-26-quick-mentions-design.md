# Quick context mentions (@currentFile, @symbol, @os, @commits, @search) — design

Date: 2026-07-26

## Context

Five small context providers closing the gap against comparable
assistants' `@`-mention sets (gap analysis 2026-07-26, informed by
public feature lists only — all implementation original to this repo).
Each is cheap because VS Code or the existing engine already provides
the data. Follows the exact provider pattern established by Phases
4a-4e: parse in `mentions.ts` (pure), format in `retrieval.ts` (pure),
gather + tier in `contextEngine.ts` (extension layer), budget through
`budgetContext()`.

## Decisions

- **`@currentFile`** — inlines the active editor's file (the live
  buffer, including unsaved changes), clipped at the existing
  `MAX_FILE_CHARS`. Folds into the existing **file tier** as a
  `FileContext` (it's an explicit request, same priority as `@file:`).
  No active editor → contributes nothing. Not filtered by
  `.xpreiIDEignore` (explicit request, same policy as `@file:`).
- **`@symbol:<name>`** — looks the name up via VS Code's workspace
  symbol index (`vscode.executeWorkspaceSymbolProvider`), takes up to
  **3** best matches (case-insensitive exact name matches first, then
  prefix matches), and inlines each symbol's full source range as a
  `FileContext` labeled `path:start-end (name)`. Because workspace
  symbol results may carry name-only ranges, the full range is resolved
  by running `vscode.executeDocumentSymbolProvider` on the containing
  document and finding the matching `DocumentSymbol`; if the document
  provider returns nothing (no language server), fall back to ±30 lines
  around the reported location. Folds into the **file tier**.
  Language-server-dependent — documented: no language extension, no
  symbols.
- **`@os`** — one line: platform, architecture, OS release (from
  `process.platform` / `node:os`). Own tiny tier (`"break"`), lowest
  priority (it's ~60 bytes; it will always fit anyway).
- **`@commits`** — the last **10** commits' metadata (short hash,
  date, author, subject) via the `vscode.git` extension's
  `Repository.log({ maxEntries: 10 })`. The repo's ambient type in
  `extensions/vscode/src/git/gitApi.ts` is widened with `log()` and a
  `GitCommit` interface (declaring more of the real API, same pattern
  as when `diff()` was declared for `@diff`). Metadata only — no
  per-commit diffs in v1 (size). One blob, `"break"` tier. Empty/no
  repo → contributes nothing.
- **`@search:<text>`** — exact, case-insensitive substring search
  across the workspace: `findFiles("**/*", SCAN_EXCLUDE)` +
  `.xpreiIDEignore` patterns + the existing `MAX_FILE_BYTES` per-file
  cap, collecting up to **50** hits formatted `path:line: text`.
  Multi-segment `"skip"` tier (each hit its own segment, small ones
  survive budget pressure). **Single non-space token argument in v1**
  (`@search:handleLine`) — same `\S+` capture as `@file:`/`@url:`;
  documented limitation (identifiers are the main use case; quoted
  multi-word search is a possible follow-up).

### Parsing (mentions.ts)

New regexes, all run after `TERMINAL_RE` (which claims to end-of-string
first) and before `FILE_RE`/`BARE_PATH_RE`:

```typescript
const CURRENT_FILE_RE = /(^|\s)@currentFile\b/gi;
const OS_RE = /(^|\s)@os\b/gi;
const COMMITS_RE = /(^|\s)@commits\b/gi;
const SYMBOL_RE = /(^|\s)@symbol:(\S+)/gi;
const SEARCH_RE = /(^|\s)@search:(\S+)/gi;
```

`Mentions` gains: `currentFile: boolean; os: boolean; commits: boolean;
symbol: string | undefined; search: string | undefined`.
`hasContextRequest()` widened accordingly.

### Tier order (locked, high → low)

`@file:` + `@currentFile` + `@symbol` (one shared file tier, `"break"`)
→ `@problems` (`"skip"`) → `@diff` (`"break"`) → `@commits` (`"break"`)
→ `@terminal` (`"break"`) → `@url` (`"break"`) → `@search` (`"skip"`)
→ `@open` (`"break"`) → `@repomap` (`"skip"`) → `@codebase` hits
(`"skip"`) → `@os` (`"break"`, last — trivially small). 11 tiers, each
built unconditionally (positional alignment invariant).

### Formatters (retrieval.ts)

```typescript
export function formatCommits(lines: string): string; // "// Recent commits:\n" + lines
export interface SearchHitLine { path: string; line: number; text: string }
export function formatSearchHits(query: string, hits: SearchHitLine[]): string;
  // `// Search results for "<query>":` + one "// path:line: text" per hit
export function formatOs(info: string): string; // "// OS: " + info
```

`buildContextMessage` gains `commits?`, `search?`, `os?` sections.
`retrieved` stays the final section by convention; `os` goes
immediately before it. Final section order: files, problems, diff,
commits, terminal, url, search, repomap, os, retrieved.

## Out of scope

- Multi-word `@search` queries (quote support) — v1 is one token.
- Per-commit diffs in `@commits`.
- `@symbol` cross-file reference listing (definition source only).
- Any change to agent tools — these are chat mentions only.

## Testing

- `mentions.test.ts`: each new mention parses + strips; combination
  test; `@symbol`/`@search` capture args; `hasContextRequest` fires for
  each.
- `retrieval.test.ts`: the three new formatters; widened
  `buildContextMessage` full-ordering test.
- `contextEngine.ts` gathering methods: extension-layer, untested by
  convention — typecheck/compile + manual smoke (each mention in a real
  Extension Development Host; `@symbol` against this repo's own TS
  symbols; `@commits` against this repo's real history; `@search` for a
  known string; `@os`/`@currentFile` trivially).

## User-facing docs

Both READMEs' mention lists gain the five new entries with the
documented limitations (symbol needs a language server; search is
single-token; commits is metadata-only).
