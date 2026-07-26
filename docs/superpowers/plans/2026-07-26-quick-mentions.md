# Quick Context Mentions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Five new chat mentions — `@currentFile`, `@symbol:<name>`,
`@os`, `@commits`, `@search:<text>` — following the established
provider pattern.

**Architecture:** Parse in `mentions.ts` (pure), format in
`retrieval.ts` (pure), gather + tier in `contextEngine.ts`.
`@currentFile`/`@symbol` fold into the existing file tier; `@commits`,
`@search`, `@os` add three new tiers (11 total). `gitApi.ts`'s ambient
type is widened with `log()` (declaring more of the real `vscode.git`
API, same pattern as `diff()`).

**Tech Stack:** TypeScript, `node:test`, VS Code API
(`executeWorkspaceSymbolProvider`, `executeDocumentSymbolProvider`,
`vscode.git`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-26-quick-mentions-design.md`.
- Tier order (locked, high→low): file(+currentFile+symbol) `"break"` >
  problems `"skip"` > diff `"break"` > commits `"break"` > terminal
  `"break"` > url `"break"` > search `"skip"` > open `"break"` >
  repomap `"skip"` > hits `"skip"` > os `"break"`. Every tier built
  unconditionally (positional alignment invariant).
- `buildContextMessage` section order: files, problems, diff, commits,
  terminal, url, search, repomap, os, retrieved.
- `@search` v1: single `\S+` token; ≤50 hits; respects `SCAN_EXCLUDE` +
  `.xpreiIDEignore` + `MAX_FILE_BYTES`. `@commits`: 10 entries,
  metadata only. `@symbol`: ≤3 matches, DocumentSymbol range with a
  ±30-line fallback.
- **This plan executes AFTER the diff-preview plan** — core suite
  baseline is 283 tests.
- Commits: author `xpreiIDE <mbsajay1@gmail.com>`, no footers,
  Conventional prefixes. Original code only.

---

### Task 1: `mentions.ts` parsing

**Files:** Modify `packages/core/src/context/mentions.ts`,
`packages/core/src/context/mentions.test.ts`.

**Interfaces — Produces:** `Mentions` gains `currentFile: boolean; os:
boolean; commits: boolean; symbol: string | undefined; search: string |
undefined`; `hasContextRequest` fires for each.

- [ ] **Step 1: Failing tests** — append to `mentions.test.ts`:

```typescript
test("@currentFile, @os, and @commits set their flags and are stripped", () => {
  const m = parseMentions("@currentFile @os @commits what is this");
  assert.equal(m.currentFile, true);
  assert.equal(m.os, true);
  assert.equal(m.commits, true);
  assert.equal(m.cleaned, "what is this");
  assert.ok(hasContextRequest(m));
});

test("@symbol:<name> captures the symbol name", () => {
  const m = parseMentions("explain @symbol:budgetContext to me");
  assert.equal(m.symbol, "budgetContext");
  assert.equal(m.cleaned, "explain to me");
  assert.ok(hasContextRequest(m));
});

test("@search:<text> captures the query token", () => {
  const m = parseMentions("@search:TRUNCATION_MARKER where is this used");
  assert.equal(m.search, "TRUNCATION_MARKER");
  assert.equal(m.cleaned, "where is this used");
  assert.ok(hasContextRequest(m));
});

test("the five quick mentions default to unset", () => {
  const m = parseMentions("plain question");
  assert.equal(m.currentFile, false);
  assert.equal(m.os, false);
  assert.equal(m.commits, false);
  assert.equal(m.symbol, undefined);
  assert.equal(m.search, undefined);
});

test("quick mentions combine with existing ones", () => {
  const m = parseMentions("@currentFile @diff @search:foo review");
  assert.equal(m.currentFile, true);
  assert.equal(m.diff, true);
  assert.equal(m.search, "foo");
  assert.equal(m.cleaned, "review");
});

test("@symbol does not swallow a trailing @terminal command", () => {
  const m = parseMentions("@symbol:parseAction check @terminal:npm test");
  assert.equal(m.symbol, "parseAction");
  assert.equal(m.terminalCommand, "npm test");
});
```

- [ ] **Step 2:** run `node --import tsx --test src/context/mentions.test.ts`
  (from packages/core) — new tests FAIL.

- [ ] **Step 3: Implement.** In `mentions.ts`: extend the doc comment
  with the five mentions; add to `Mentions` (after `repomap`):
  `currentFile: boolean; os: boolean; commits: boolean; symbol: string
  | undefined; search: string | undefined;`. Add regexes after
  `REPOMAP_RE`:

```typescript
const CURRENT_FILE_RE = /(^|\s)@currentFile\b/gi;
const OS_RE = /(^|\s)@os\b/gi;
const COMMITS_RE = /(^|\s)@commits\b/gi;
const SYMBOL_RE = /(^|\s)@symbol:(\S+)/gi;
const SEARCH_RE = /(^|\s)@search:(\S+)/gi;
```

In `parseMentions()`: declare `let currentFile = false; let os = false;
let commits = false; let symbol: string | undefined; let search: string
| undefined;`; add five replace blocks after the REPOMAP_RE block
(flags set `= true`; SYMBOL_RE/SEARCH_RE capture `(_m, pre, v) =>
{ symbol = v; return pre; }` style), all before FILE_RE; add the five
fields to the returned object; widen `hasContextRequest` with
`|| m.currentFile || m.os || m.commits || m.symbol !== undefined ||
m.search !== undefined`.

- [ ] **Step 4:** tests pass (30 in file). **Step 5:** full suite
  `npm test` → 289 (283 + 6). **Step 6:** commit:

```bash
git add packages/core/src/context/mentions.ts packages/core/src/context/mentions.test.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(core): parse @currentFile, @symbol, @os, @commits, @search mentions"
```

---

### Task 2: `retrieval.ts` formatters + widened assembly

**Files:** Modify `packages/core/src/context/retrieval.ts`,
`packages/core/src/context/retrieval.test.ts`.

**Interfaces — Produces:** `SearchHitLine { path: string; line: number;
text: string }`, `formatCommits(lines: string): string`,
`formatSearchHits(query: string, hits: SearchHitLine[]): string`,
`formatOs(info: string): string`; `buildContextMessage` gains
`commits?`, `search?`, `os?` (section order per Global Constraints).

- [ ] **Step 1: Failing tests** — append to `retrieval.test.ts` (add
  `formatCommits, formatOs, formatSearchHits, SearchHitLine` to the
  `./retrieval` import):

```typescript
test("formatCommits prepends the header", () => {
  assert.equal(formatCommits("abc1234 me 2026-07-26 fix"), "// Recent commits:\nabc1234 me 2026-07-26 fix");
});

test("formatSearchHits renders a header plus one line per hit", () => {
  const hits: SearchHitLine[] = [
    { path: "a.ts", line: 3, text: "const x = 1;" },
    { path: "b.ts", line: 9, text: "let y;" },
  ];
  assert.equal(
    formatSearchHits("x", hits),
    '// Search results for "x":\n// a.ts:3: const x = 1;\n// b.ts:9: let y;',
  );
});

test("formatOs wraps the info line", () => {
  assert.equal(formatOs("win32 x64"), "// OS: win32 x64");
});

test("buildContextMessage assembles all ten sections in the locked order", () => {
  const out = buildContextMessage({
    files: "F", problems: "P", diff: "D", commits: "C", terminal: "T",
    url: "U", search: "S", repomap: "R", os: "O",
    retrieved: "X",
  });
  assert.equal(
    out,
    "The user referenced workspace context. Use it to answer.\n\n" +
      "F\n\nP\n\nD\n\nC\n\nT\n\nU\n\nS\n\nR\n\nO\n\n// Relevant code from the workspace:\nX",
  );
});
```

- [ ] **Step 2:** run — FAIL. **Step 3: Implement** in `retrieval.ts`:

```typescript
export interface SearchHitLine {
  path: string;
  line: number;
  text: string;
}

export function formatCommits(lines: string): string {
  return `// Recent commits:\n${lines}`;
}

export function formatSearchHits(query: string, hits: SearchHitLine[]): string {
  return [`// Search results for "${query}":`, ...hits.map((h) => `// ${h.path}:${h.line}: ${h.text}`)].join("\n");
}

export function formatOs(info: string): string {
  return `// OS: ${info}`;
}
```

Widen `buildContextMessage`'s parameter with `commits?: string;
search?: string; os?: string;` and push sections in the order: files,
problems, diff, **commits**, terminal, url, **search**, repomap, **os**,
retrieved.

- [ ] **Step 4:** tests pass (26 in file). **Step 5:** full suite → 293.
  **Step 6:** typecheck core. **Step 7:** commit:

```bash
git add packages/core/src/context/retrieval.ts packages/core/src/context/retrieval.test.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(core): formatters and assembly slots for commits/search/os context"
```

---

### Task 3: `gitApi.ts` widening + `contextEngine.ts` gathering and tiers

**Files:** Modify `extensions/vscode/src/git/gitApi.ts`,
`extensions/vscode/src/context/contextEngine.ts`.

**Interfaces — Consumes:** Task 1's `Mentions` fields, Task 2's
formatters/`SearchHitLine`.

- [ ] **Step 1: Widen `gitApi.ts`** — add:

```typescript
export interface GitCommit {
  hash: string;
  message: string;
  authorName?: string;
  commitDate?: Date;
}
```

and to `GitRepository`: `log?(options?: { maxEntries?: number }):
Promise<GitCommit[]>;` (optional — older VS Code builds may lack it;
callers guard).

- [ ] **Step 2: contextEngine imports + consts.** Add `import * as
  nodeOs from "node:os";`; add `formatCommits, formatOs,
  formatSearchHits, SearchHitLine` to the `@xprei/core` import list.
  Add const after `MAX_REPOMAP_FILES`: `const MAX_SEARCH_HITS = 50;`.

- [ ] **Step 3: Gathering helpers** — add before `resolveRel`:

```typescript
  // @currentFile — the live buffer of the active editor (unsaved
  // changes included), clipped like any explicit file request.
  private readCurrentFile(): FileContext | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;
    const raw = editor.document.getText();
    const content =
      raw.length > MAX_FILE_CHARS ? raw.slice(0, MAX_FILE_CHARS) + TRUNCATION_MARKER : raw;
    return { path: this.rel(editor.document.uri), content };
  }

  // @symbol — workspace-symbol lookup, up to 3 best matches; each
  // symbol's FULL range comes from the document symbol tree (workspace
  // symbol results may carry name-only ranges), falling back to ±30
  // lines when no document symbols are available.
  private async readSymbol(name: string): Promise<FileContext[]> {
    try {
      const symbols =
        (await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
          "vscode.executeWorkspaceSymbolProvider",
          name,
        )) ?? [];
      const lower = name.toLowerCase();
      const exact = symbols.filter((s) => s.name.toLowerCase() === lower);
      const chosen = (exact.length > 0
        ? exact
        : symbols.filter((s) => s.name.toLowerCase().startsWith(lower))
      ).slice(0, 3);
      const out: FileContext[] = [];
      for (const sym of chosen) {
        try {
          const doc = await vscode.workspace.openTextDocument(sym.location.uri);
          const range = (await this.fullSymbolRange(doc, sym)) ?? this.fallbackRange(doc, sym);
          const raw = doc.getText(range);
          const content =
            raw.length > MAX_FILE_CHARS ? raw.slice(0, MAX_FILE_CHARS) + TRUNCATION_MARKER : raw;
          out.push({
            path: `${this.rel(sym.location.uri)}:${range.start.line + 1}-${range.end.line + 1} (${sym.name})`,
            content,
          });
        } catch {
          // unreadable match — skip it
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  private async fullSymbolRange(
    doc: vscode.TextDocument,
    sym: vscode.SymbolInformation,
  ): Promise<vscode.Range | undefined> {
    try {
      const tree =
        (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
          "vscode.executeDocumentSymbolProvider",
          doc.uri,
        )) ?? [];
      const target = sym.location.range.start;
      const walk = (nodes: vscode.DocumentSymbol[]): vscode.Range | undefined => {
        for (const n of nodes) {
          if (!n.range) continue;
          if (n.name === sym.name && n.range.contains(target)) return n.range;
          const inner = n.children?.length ? walk(n.children) : undefined;
          if (inner) return inner;
        }
        return undefined;
      };
      return walk(tree);
    } catch {
      return undefined;
    }
  }

  private fallbackRange(doc: vscode.TextDocument, sym: vscode.SymbolInformation): vscode.Range {
    const start = sym.location.range.start.line;
    const end = Math.min(doc.lineCount - 1, start + 30);
    return new vscode.Range(start, 0, end, doc.lineAt(end).text.length);
  }

  // @commits — last 10 commits' metadata via vscode.git. "" when the
  // API/log() is unavailable or the repo has no history.
  private async readCommits(): Promise<string> {
    try {
      const api = await getGitApi();
      const repo = api?.repositories[0];
      if (!repo?.log) return "";
      const commits = await repo.log({ maxEntries: 10 });
      return commits
        .map((c) => {
          const date = c.commitDate ? new Date(c.commitDate).toISOString().slice(0, 10) : "";
          const subject = c.message.split(/\r?\n/)[0];
          return `${c.hash.slice(0, 7)} ${date} ${c.authorName ?? "?"}: ${subject}`;
        })
        .join("\n");
    } catch {
      return "";
    }
  }

  // @search — exact case-insensitive substring scan, same exclusion
  // rules as the indexer, capped at MAX_SEARCH_HITS.
  private async searchWorkspace(query: string): Promise<SearchHitLine[]> {
    const uris = await vscode.workspace.findFiles("**/*", SCAN_EXCLUDE);
    const ignorePatterns = await loadIgnorePatterns();
    const needle = query.toLowerCase();
    const hits: SearchHitLine[] = [];
    for (const uri of uris) {
      if (hits.length >= MAX_SEARCH_HITS) break;
      const rel = this.rel(uri);
      if (isExcludedPath(rel, ignorePatterns)) continue;
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > MAX_FILE_BYTES) continue;
        const raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
        const lines = raw.split(/\r?\n/);
        for (let i = 0; i < lines.length && hits.length < MAX_SEARCH_HITS; i++) {
          if (lines[i].toLowerCase().includes(needle)) {
            hits.push({ path: rel, line: i + 1, text: lines[i].trim().slice(0, 200) });
          }
        }
      } catch {
        // unreadable — skip
      }
    }
    return hits;
  }

  private osInfo(): string {
    return `${process.platform} ${nodeOs.arch()} (release ${nodeOs.release()})`;
  }
```

- [ ] **Step 4: buildContext wiring.** Update the doc comment's tier
  list to the 11-tier order from Global Constraints. In the gather
  block (after `repoFiles`):

```typescript
    const currentFile = mentions.currentFile ? this.readCurrentFile() : undefined;
    const symbolSnippets = mentions.symbol ? await this.readSymbol(mentions.symbol) : [];
    const commitsText = mentions.commits ? await this.readCommits() : "";
    const searchHits = mentions.search ? await this.searchWorkspace(mentions.search) : [];
    const osLine = mentions.os ? this.osInfo() : "";
```

Replace the file-tier construction and `@open` dedup set: build
`const explicitFiles = [...files, ...(currentFile ? [currentFile] : []), ...symbolSnippets];`
then `fileTier` maps `explicitFiles`, and `readOpenFiles(new
Set(explicitFiles.map((f) => f.path)))` replaces the previous
`files`-only set. Add three tiers in priority position:

```typescript
    const commitsTier: SegmentTier = {
      segments: commitsText ? [{ text: formatCommits(commitsText), data: null }] : [],
      strategy: "break",
    };
    const searchTier: SegmentTier = {
      segments: searchHits.map((h) => ({ text: `// ${h.path}:${h.line}: ${h.text}`, data: h })),
      strategy: "skip",
    };
    const osTier: SegmentTier = {
      segments: osLine ? [{ text: formatOs(osLine), data: null }] : [],
      strategy: "break",
    };
```

Widen the `budgetContext` call/destructure to 11, order:
`[fileTier, problemTier, diffTier, commitsTier, terminalTier, urlTier,
searchTier, openTier, repomapTier, hitTier, osTier]` →
`keptFileSegs, keptProblemSegs, keptDiffSegs, keptCommitsSegs,
keptTerminalSegs, keptUrlSegs, keptSearchSegs, keptOpenSegs,
keptRepomapSegs, keptHitSegs, keptOsSegs`. Reconstruct:

```typescript
    const budgetedCommits: string | undefined = keptCommitsSegs[0]?.text;
    // "skip" never truncates — seg.data is the hit, used raw.
    const budgetedSearch: SearchHitLine[] = keptSearchSegs.map((seg) => seg.data as SearchHitLine);
    const budgetedOs: string | undefined = keptOsSegs[0]?.text;
```

And in the final `buildContextMessage({...})` add `commits:
budgetedCommits,` after `diff`, `search: budgetedSearch.length ?
formatSearchHits(mentions.search!, budgetedSearch) : undefined,` after
`url`, and `os: budgetedOs,` after `repomap`.

- [ ] **Step 5:** `npm run typecheck -w xpreiIDE-ai` +
  `npm run compile -w xpreiIDE-ai` — PASS. **Step 6:** commit:

```bash
git add extensions/vscode/src/git/gitApi.ts extensions/vscode/src/context/contextEngine.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(vscode): gather and tier @currentFile/@symbol/@os/@commits/@search context"
```

---

### Task 4: Docs

- [ ] `extensions/vscode/README.md` "Bringing in context (@mentions)":
  add `@currentFile` and `@symbol:<name>` under the no-index list's
  top (they're explicit like `@file:`), and `@commits`, `@search:<text>`,
  `@os` entries, each one sentence with the documented limitation
  (symbol needs a language extension; search is a single token, 50-hit
  cap; commits is metadata-only, last 10).
- [ ] Root `README.md` Codebase-aware-context bullet: extend the list
  with `@currentFile`, `@symbol:<name>`, `@commits`, `@search:<text>`,
  `@os`.
- [ ] Proofread, commit:

```bash
git add extensions/vscode/README.md README.md
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "docs: document the five quick context mentions"
```

---

### Task 5: Final verification

- [ ] `npm test -w @xprei/core` — 293 (283 + 6 mentions + 4 retrieval).
- [ ] `npm run typecheck -w @xprei/core` / `-w xpreiIDE-ai` — PASS.
- [ ] `npm run compile -w xpreiIDE-ai` — PASS.
- [ ] Manual smoke (user-run, Extension Development Host): each mention
  once in this real repo — `@currentFile` with a file open;
  `@symbol:budgetContext`; `@commits`; `@search:TRUNCATION_MARKER`;
  `@os`; and one combined message.
