# Prompt files & glob-scoped rules — design

Date: 2026-07-26

## Context

Two customization features (gap analysis 2026-07-26; feature ideas from
public docs of comparable assistants, implementation entirely original
to this repo):

1. **Prompt files** — user-defined slash commands beyond the five
   built-ins (`/explain`, `/fix`, `/tests`, `/comments`, `/refactor`).
2. **Glob-scoped rules** — project instructions that apply only when
   working in files matching a glob, extending the single global
   `.xpreiIDErules`.

## Decisions — prompt files

- **Location:** `.xpreiIDE/prompts/*.md` at the workspace root. The
  filename minus `.md` is the command name: `review.md` → `/review`.
- **Name rules:** lowercased; only `[a-z0-9-]` names are accepted,
  anything else is skipped silently. Built-in commands win on collision.
- **Semantics:** identical to the built-ins' existing client-side
  expansion — `/review extra words` sends
  `<file content>\n\n<extra words>`; `/review` alone sends just the file
  content. No new placeholder/template syntax in v1.
- **Loading:** `chatView.ts` reads the directory when the webview posts
  `ready` (panel open/reload) and pushes
  `{type: "customPrompts", items: [{name, template}]}`; `chat.js` keeps
  them in a second map consulted after the built-ins.
  **Documented v1 limitation:** editing a prompt file requires closing
  and reopening the chat panel (or reloading the window) to pick up —
  no file watcher.
- **New loader:** `extensions/vscode/src/context/promptFiles.ts`,
  mirroring `projectRules.ts`'s conventions (vscode.workspace.fs, ""
  /empty on missing, no caching beyond the ready-time read).

## Decisions — glob-scoped rules

- **Location:** `.xpreiIDE/rules/*.md`. Each file: optional frontmatter
  then the rule text:

  ```markdown
  ---
  globs: *.tsx, src/components/**
  ---
  Use functional React components. Style with Tailwind only.
  ```

  No frontmatter (or no `globs:` line in it) = the rule always applies
  (a modular global rule).
- **Glob semantics:** reuses `matchesIgnorePattern` from
  `@xprei/core`'s `ignoreFile.ts` — the same documented glob-lite
  subset users already know from `.xpreiIDEignore` (`*` in-segment,
  `**` across segments, `/`-containing patterns anchored, bare
  patterns match at any depth). One grammar everywhere.
- **Applicability (v1):** a globbed rule applies when the **active
  editor's** workspace-relative path matches any of its globs. No
  active editor → globbed rules don't apply (global ones still do).
  Documented simplification: rules aren't matched against every file in
  the chat context, just the active editor — cheap, predictable,
  covers the dominant "I'm working in this file" case.
- **Combination order:** `.xpreiIDErules` (legacy global, unchanged)
  first, then applicable `.xpreiIDE/rules/*.md` files in filename
  order, joined by blank lines. Injected exactly where project rules
  are injected today.
- **Integration point:** `loadProjectRules()` (both call sites are in
  `chatView.ts`, confirmed) becomes
  `loadProjectRules(activeRelPath?: string)`; call sites pass the
  active editor's relative path (or undefined). The agent path already
  threads the returned string through `runAgent(..., projectRules)` —
  no orchestrator change.
- **New pure core module:** `packages/core/src/context/rules.ts`:

  ```typescript
  export interface RuleFile { globs?: string[]; body: string }
  // Tiny frontmatter parser: leading "---" line, lines until the next
  // "---"; a "globs:" line is split on commas and trimmed. Anything
  // else in the frontmatter is ignored. No frontmatter → globs
  // undefined, whole content is the body.
  export function parseRuleFile(content: string): RuleFile;
  // undefined globs → always true. globs present but no activePath →
  // false. Otherwise true when any glob matches (matchesIgnorePattern).
  export function ruleApplies(globs: string[] | undefined, activePath: string | undefined): boolean;
  ```

## Out of scope

- Prompt-file placeholder syntax (`{selection}`, `{file}`, …).
- File watchers / live reload for either feature.
- Matching rules against all context files (active editor only, v1).
- Rule/prompt discovery from user-home (workspace-only, v1).

## Testing

- `rules.test.ts` (new, pure, core): frontmatter with one glob, several
  comma-separated globs, no frontmatter, empty body, `ruleApplies`
  truth table (no globs / globs+no path / match / no match, both bare
  and anchored patterns).
- `promptFiles.ts` / `chatView.ts` / `chat.js`: extension/webview
  layer, untested by convention — typecheck/compile + manual smoke:
  create `.xpreiIDE/prompts/review.md`, reopen panel, `/review` expands;
  create `.xpreiIDE/rules/react.md` with `globs: *.tsx`, confirm the
  rule text reaches prompts only when a `.tsx` editor is active.

## User-facing docs

`extensions/vscode/README.md`'s "Project instructions & ignore file"
section becomes "Project instructions, rules & prompt files" covering
all four dotfile mechanisms; root `README.md`'s Features list gains
matching phrases.
