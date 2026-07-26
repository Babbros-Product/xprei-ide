# Prompt Files & Glob-Scoped Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** User-defined slash commands from `.xpreiIDE/prompts/*.md`, and
project rules from `.xpreiIDE/rules/*.md` that can be scoped to files
matching a glob.

**Architecture:** A new pure core module (`rules.ts`: frontmatter parse
+ glob applicability, reusing `ignoreFile.ts`'s `matchesIgnorePattern`
grammar). `projectRules.ts` widens to merge the legacy `.xpreiIDErules`
with applicable rules files, keyed off the active editor's path. A new
`promptFiles.ts` loader feeds the webview a `customPrompts` message at
`ready`; `chat.js` consults a second map after the built-in slash
commands.

**Tech Stack:** TypeScript, `node:test`, VS Code `workspace.fs`, vanilla
JS webview.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-26-prompt-files-scoped-rules-design.md`.
- Prompt names: filename minus `.md`, lowercased, must match
  `^[a-z0-9-]+$` (else skipped). Built-ins win collisions. Expansion
  semantics identical to built-ins (`template`, or
  `template\n\n<extra>`).
- Rules applicability v1: globbed rules match against the ACTIVE EDITOR
  path only; no active editor → globbed rules don't apply, global ones
  do. Combination order: `.xpreiIDErules` first, then applicable
  `.xpreiIDE/rules/*.md` in filename order, blank-line joined.
- No file watchers — prompts load at webview `ready`; rules load per
  request (fresh reads, matching `projectRules.ts` convention).
- **Executes AFTER the quick-mentions plan** — core baseline 293 tests.
- webview/ is the source of truth (never edit `extensions/vscode/media/`).
- Commits: author `xpreiIDE <mbsajay1@gmail.com>`, no footers,
  Conventional prefixes. Original code only.

---

### Task 1: Core `rules.ts` — pure, fully unit tested

**Files:** Create `packages/core/src/context/rules.ts` +
`rules.test.ts`; modify `packages/core/package.json` (register test
after `src/agent/pendingEditOverlay.test.ts`) and
`packages/core/src/index.ts` (barrel-export after
`./agent/pendingEditOverlay`).

**Interfaces — Produces:** `RuleFile { globs?: string[]; body: string }`,
`parseRuleFile(content: string): RuleFile`, `ruleApplies(globs:
string[] | undefined, activePath: string | undefined): boolean` — Task 2
consumes both functions.

- [ ] **Step 1: Failing tests** — create `rules.test.ts`:

```typescript
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRuleFile, ruleApplies } from "./rules";

test("parseRuleFile reads a single glob from frontmatter", () => {
  const r = parseRuleFile("---\nglobs: *.tsx\n---\nUse function components.");
  assert.deepEqual(r.globs, ["*.tsx"]);
  assert.equal(r.body, "Use function components.");
});

test("parseRuleFile splits comma-separated globs and trims them", () => {
  const r = parseRuleFile("---\nglobs: *.ts, src/components/** , *.tsx\n---\nbody");
  assert.deepEqual(r.globs, ["*.ts", "src/components/**", "*.tsx"]);
});

test("parseRuleFile without frontmatter returns the whole content as body", () => {
  const r = parseRuleFile("Just a global rule.\nSecond line.");
  assert.equal(r.globs, undefined);
  assert.equal(r.body, "Just a global rule.\nSecond line.");
});

test("parseRuleFile treats unterminated frontmatter as plain body", () => {
  const content = "---\nglobs: *.ts\nno closing fence";
  assert.equal(parseRuleFile(content).body, content);
});

test("parseRuleFile ignores unknown frontmatter keys", () => {
  const r = parseRuleFile("---\nname: whatever\nglobs: *.py\n---\nbody");
  assert.deepEqual(r.globs, ["*.py"]);
});

test("ruleApplies: no globs means always applies", () => {
  assert.equal(ruleApplies(undefined, "src/a.ts"), true);
  assert.equal(ruleApplies(undefined, undefined), true);
  assert.equal(ruleApplies([], undefined), true);
});

test("ruleApplies: globs present but no active path means not applicable", () => {
  assert.equal(ruleApplies(["*.ts"], undefined), false);
});

test("ruleApplies matches bare patterns at any depth and anchored ones from the root", () => {
  assert.equal(ruleApplies(["*.tsx"], "src/deep/App.tsx"), true);
  assert.equal(ruleApplies(["src/components/**"], "src/components/Button.tsx"), true);
  assert.equal(ruleApplies(["src/components/**"], "lib/components/Button.tsx"), false);
  assert.equal(ruleApplies(["*.py"], "src/a.ts"), false);
});
```

- [ ] **Step 2:** run (from packages/core)
  `node --import tsx --test src/context/rules.test.ts` — FAIL.

- [ ] **Step 3: Implement** — create `rules.ts`:

```typescript
// Glob-scoped project rules: tiny frontmatter parser + applicability
// check for .xpreiIDE/rules/*.md files. Glob grammar is the same
// documented glob-lite subset .xpreiIDEignore uses (one grammar
// everywhere). Pure module — no vscode, no file I/O.

import { matchesIgnorePattern } from "./ignoreFile";

export interface RuleFile {
  globs?: string[];
  body: string;
}

// Frontmatter: a leading "---" line, lines until the next "---". Only a
// "globs:" line (comma-separated patterns) is recognized; other keys
// are ignored. No frontmatter — or an unterminated fence — means the
// whole content is the body and the rule always applies.
export function parseRuleFile(content: string): RuleFile {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { body: content };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return { body: content };
  let globs: string[] | undefined;
  for (const line of lines.slice(1, end)) {
    const m = line.match(/^globs:\s*(.+)$/i);
    if (m) {
      globs = m[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return { globs, body: lines.slice(end + 1).join("\n") };
}

// No globs → global rule, always applies. Globs but no active file →
// nothing to match against, doesn't apply. Otherwise any-glob-matches.
export function ruleApplies(globs: string[] | undefined, activePath: string | undefined): boolean {
  if (!globs || globs.length === 0) return true;
  if (!activePath) return false;
  return globs.some((g) => matchesIgnorePattern(activePath, g));
}
```

- [ ] **Step 4:** tests pass (8). **Step 5:** register in package.json
  test list + barrel-export in index.ts. **Step 6:** full suite → 301
  (293 + 8); typecheck core. **Step 7:** commit:

```bash
git add packages/core/src/context/rules.ts packages/core/src/context/rules.test.ts packages/core/package.json packages/core/src/index.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(core): rule-file frontmatter parsing and glob applicability"
```

---

### Task 2: Extension loaders — `projectRules.ts` widening + `promptFiles.ts`

**Files:** Modify `extensions/vscode/src/context/projectRules.ts`;
create `extensions/vscode/src/context/promptFiles.ts`; modify
`extensions/vscode/src/ui/chat/chatView.ts` (call sites).

**Interfaces — Produces:** `loadProjectRules(activeRelPath?: string):
Promise<string>` (widened, still the same name/module);
`CustomPrompt { name: string; template: string }`,
`loadCustomPrompts(): Promise<CustomPrompt[]>` — Task 3 consumes the
latter's output shape via the `customPrompts` webview message.

- [ ] **Step 1: Rewrite `projectRules.ts`:**

```typescript
// Project-level instructions: the legacy global ".xpreiIDErules" plus
// glob-scoped rule files under ".xpreiIDE/rules/*.md" (frontmatter
// `globs:` — see @xprei/core's rules.ts). Scoped rules apply when the
// ACTIVE EDITOR's path matches; global ones always. Read fresh on
// every call, no caching.

import * as vscode from "vscode";
import { parseRuleFile, ruleApplies } from "@xprei/core";

const RULES_FILENAME = ".xpreiIDErules";

export async function loadProjectRules(activeRelPath?: string): Promise<string> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return "";
  const parts: string[] = [];

  try {
    const bytes = await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(folder.uri, RULES_FILENAME),
    );
    const text = Buffer.from(bytes).toString("utf8").trim();
    if (text) parts.push(text);
  } catch {
    // no legacy rules file
  }

  try {
    const dirUri = vscode.Uri.joinPath(folder.uri, ".xpreiIDE", "rules");
    const entries = await vscode.workspace.fs.readDirectory(dirUri);
    const names = entries
      .filter(([name, type]) => type === vscode.FileType.File && name.endsWith(".md"))
      .map(([name]) => name)
      .sort();
    for (const name of names) {
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dirUri, name));
        const { globs, body } = parseRuleFile(Buffer.from(bytes).toString("utf8"));
        if (body.trim() && ruleApplies(globs, activeRelPath)) parts.push(body.trim());
      } catch {
        // unreadable rule file — skip
      }
    }
  } catch {
    // no rules directory
  }

  return parts.join("\n\n");
}
```

- [ ] **Step 2: Create `promptFiles.ts`:**

```typescript
// User-defined slash commands: each ".xpreiIDE/prompts/<name>.md"
// becomes "/<name>" in the chat composer, expanding exactly like the
// built-in slash commands. Loaded when the webview posts "ready" — no
// watcher; edits require reopening the panel (documented v1
// limitation).

import * as vscode from "vscode";

export interface CustomPrompt {
  name: string;
  template: string;
}

export async function loadCustomPrompts(): Promise<CustomPrompt[]> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return [];
  try {
    const dirUri = vscode.Uri.joinPath(folder.uri, ".xpreiIDE", "prompts");
    const entries = await vscode.workspace.fs.readDirectory(dirUri);
    const out: CustomPrompt[] = [];
    for (const [fileName, type] of entries) {
      if (type !== vscode.FileType.File || !fileName.endsWith(".md")) continue;
      const name = fileName.slice(0, -3).toLowerCase();
      if (!/^[a-z0-9-]+$/.test(name)) continue;
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dirUri, fileName));
        const template = Buffer.from(bytes).toString("utf8").trim();
        if (template) out.push({ name, template });
      } catch {
        // unreadable — skip
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}
```

- [ ] **Step 3: chatView.ts.** Add
  `import { loadCustomPrompts } from "../../context/promptFiles";`. Find
  the webview message handler's `ready` case (grep `"ready"` — it calls
  rehydrate/sendModels) and add `void this.sendCustomPrompts();`
  alongside those calls. Add the method near `sendModels()`:

```typescript
  private async sendCustomPrompts(): Promise<void> {
    this.post({ type: "customPrompts", items: await loadCustomPrompts() });
  }
```

  Update BOTH `loadProjectRules()` call sites (grep — two, one in the
  plain-chat path and one in `onAgent`) to:

```typescript
      const active = vscode.window.activeTextEditor;
      const activeRel = active
        ? vscode.workspace.asRelativePath(active.document.uri, false).replace(/\\/g, "/")
        : undefined;
      const rules = await loadProjectRules(activeRel);
```

- [ ] **Step 4:** `npm run typecheck -w xpreiIDE-ai` — PASS. **Step 5:**
  commit:

```bash
git add extensions/vscode/src/context/projectRules.ts extensions/vscode/src/context/promptFiles.ts extensions/vscode/src/ui/chat/chatView.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(vscode): glob-scoped rules and custom prompt loading"
```

---

### Task 3: Webview — merge custom prompts into slash expansion

**Files:** Modify `webview/chat.js`.

- [ ] **Step 1:** Near `SLASH_COMMANDS`, add `let customPrompts = {};`.
  In the extension→webview message handler (grep for where
  `msg.type === "models"` is handled; add a sibling branch):

```javascript
      case "customPrompts": {
        customPrompts = {};
        (Array.isArray(msg.items) ? msg.items : []).forEach((it) => {
          if (!it || typeof it.name !== "string" || typeof it.template !== "string") return;
          const key = "/" + it.name;
          if (!SLASH_COMMANDS[key]) customPrompts[key] = it.template; // built-ins win
        });
        break;
      }
```

  (If the handler is an if/else chain rather than a switch, add the
  equivalent `else if (msg.type === "customPrompts") { ... }` branch —
  match the file's existing style.)

- [ ] **Step 2:** In `expandSlashCommand`, change the lookup line to:

```javascript
    const template = SLASH_COMMANDS[m[1].toLowerCase()] || customPrompts[m[1].toLowerCase()];
```

- [ ] **Step 3:** `npm run compile -w xpreiIDE-ai` (syncs media) — PASS.
  **Step 4:** commit:

```bash
git add webview/chat.js
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(webview): expand user-defined slash commands from prompt files"
```

---

### Task 4: Docs

- [ ] `extensions/vscode/README.md`: rename the "Project instructions &
  ignore file" section to "Project instructions, rules & prompt files";
  keep the two existing bullets, add:
  - **`.xpreiIDE/rules/*.md`** — modular rule files; optional
    frontmatter `globs: *.tsx, src/**` scopes a rule to apply only when
    the active editor's file matches (same glob syntax as
    `.xpreiIDEignore`); no frontmatter = always applies. Explain merge
    order (`.xpreiIDErules` first, then rules files alphabetically).
  - **`.xpreiIDE/prompts/*.md`** — each file becomes a `/name` slash
    command (`review.md` → `/review`); typed text after the command is
    appended to the file's content; built-ins win name collisions; edits
    picked up when the chat panel reopens.
  Also update "Working with chat"'s slash-commands bullet to mention
  custom prompt files, linking the new section.
- [ ] Root `README.md`: extend the "Project rules" bullet with
  glob-scoped rule files and custom prompt files (one phrase each).
- [ ] Proofread, commit:

```bash
git add extensions/vscode/README.md README.md
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "docs: document glob-scoped rules and prompt files"
```

---

### Task 5: Final verification

- [ ] `npm test -w @xprei/core` — 301 (293 + 8 rules).
- [ ] `npm run typecheck -w @xprei/core` / `-w xpreiIDE-ai` — PASS.
- [ ] `npm run compile -w xpreiIDE-ai` — PASS.
- [ ] Manual smoke (user-run): `.xpreiIDE/prompts/review.md` → reopen
  panel → `/review` expands; `.xpreiIDE/rules/react.md` with
  `globs: *.tsx` → rule text present only when a `.tsx` editor is
  active; `.xpreiIDErules` still applies everywhere.
