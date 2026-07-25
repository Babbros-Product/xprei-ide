# Phase 2a Ollama Auto-Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On activation, silently detect a running local Ollama daemon and
offer one-click chat-model setup, per
`docs/superpowers/specs/2026-07-25-phase2a-ollama-auto-discovery-design.md`.

**Architecture:** One new self-contained module
(`extensions/vscode/src/providers/autoDiscover.ts`) exporting a single
function, called fire-and-forget from `activate()`. It reuses the existing
`OllamaProvider.listModels()` primitive and the existing `ollama-local`
provider config that `package.json` already ships by default; the only
thing it ever writes is `xpreiIDE.activeModel`.

**Tech Stack:** TypeScript, VS Code extension API, `AbortController` for
the probe timeout. No new dependencies. No `@xprei/core` changes.

## Global Constraints

- **No changes to `packages/core`** — this project is entirely
  extension-layer (`extensions/vscode/**`).
- **No changes to `extensions/vscode/src/providers/addProviderFlow.ts` or
  `extensions/vscode/src/providers/registry.ts`** — the spec's "Out of
  scope" section names both explicitly; this project is additive only.
- **Never writes `xpreiIDE.providers`** — discovery reuses the existing
  `ollama-local` config and only ever writes `xpreiIDE.activeModel`.
- **Silent on failure** — an unreachable daemon, a timeout, or any other
  error produces NO toast, NO output-channel entry, and no thrown error.
- Probe timeout is **1500 ms**, via `AbortController`.
- Probe target is a config where `kind === "ollama"` and `baseUrl` (with
  any trailing slash stripped) equals **`http://localhost:11434`**.
- `extensions/vscode` has no unit tests by existing convention — every task
  is verified by `npm run typecheck -w xpreiIDE-ai` (final task also by
  `npm run compile -w xpreiIDE-ai` + manual smoke), not an automated suite.
- **User-facing docs stay current** (`CLAUDE.md` convention): both
  `extensions/vscode/README.md` and the root `README.md` Features list must
  be updated as part of this plan — see Task 3.
- **Commits:** author `xpreiIDE <mbsajay1@gmail.com>` — pass it explicitly,
  e.g. `git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "..."`.
  **Do NOT add a `Co-Authored-By` footer or any other footer** (the
  convention was updated 2026-07-25 to drop it). Conventional Commit
  prefixes (feat/docs/etc).

---

### Task 1: The `autoDiscover.ts` module

**Files:**
- Create: `extensions/vscode/src/providers/autoDiscover.ts`

**Interfaces:**
- Consumes (all already exist, no changes needed):
  - `ProviderRegistry.getConfigs(): ProviderConfig[]` (`registry.ts`)
  - `ProviderRegistry.build(cfg: ProviderConfig): Promise<Provider>` (`registry.ts`)
  - `ProviderRegistry.formatActive(providerId: string, model: string): string` — **static** method (`registry.ts`)
  - `Provider.listModels(signal?: AbortSignal): Promise<string[]>` (`@xprei/core`)
  - `ProviderConfig` type from `@xprei/core` (fields used: `id`, `kind`, `baseUrl`)
- Produces: `tryAutoDiscoverOllama(registry: ProviderRegistry): Promise<void>` —
  Task 2 calls this. Never rejects: all failure paths are caught internally
  and return normally.

- [ ] **Step 1: Create the module**

Create `extensions/vscode/src/providers/autoDiscover.ts` with exactly this
content:

```typescript
// First-run convenience: if no chat model is configured yet, quietly probe
// for a local Ollama daemon and offer one-click setup. Deliberately silent
// when nothing is found — a machine without Ollama sees no UI at all.
// Only ever writes xpreiIDE.activeModel; the ollama-local provider config
// itself already ships as a package.json default.

import * as vscode from "vscode";
import { ProviderConfig } from "@xprei/core";
import { ProviderRegistry } from "./registry";

const OLLAMA_URL = "http://localhost:11434";
const PROBE_TIMEOUT_MS = 1500;

export async function tryAutoDiscoverOllama(registry: ProviderRegistry): Promise<void> {
  const settings = vscode.workspace.getConfiguration("xpreiIDE");
  // Already configured — never probe, never nag.
  if (settings.get<string>("activeModel", "")) return;

  const cfg = findLocalOllamaConfig(registry.getConfigs());
  // The default config was removed/renamed by the user; don't recreate it.
  if (!cfg) return;

  const models = await probeModels(registry, cfg);
  if (!models) return; // unreachable, timed out, or errored — stay silent

  if (models.length === 0) {
    vscode.window.showInformationMessage(
      "Ollama is running but has no models installed yet. " +
        "Try 'ollama pull llama3.1', then reload the window.",
    );
    return;
  }

  if (models.length === 1) {
    await setActiveModel(cfg.id, models[0]);
    return;
  }

  const action = await vscode.window.showInformationMessage(
    `Ollama detected with ${models.length} models — use it for chat?`,
    "Use Ollama",
  );
  if (action !== "Use Ollama") return;

  const model = await vscode.window.showQuickPick(models, {
    placeHolder: "Select a chat model",
  });
  if (!model) return;
  await setActiveModel(cfg.id, model);
}

function findLocalOllamaConfig(configs: ProviderConfig[]): ProviderConfig | undefined {
  return configs.find(
    (c) => c.kind === "ollama" && c.baseUrl.replace(/\/+$/, "") === OLLAMA_URL,
  );
}

// Returns the model list, or undefined if the daemon can't be reached in
// time (or fails any other way) — callers treat undefined as "stay silent".
async function probeModels(
  registry: ProviderRegistry,
  cfg: ProviderConfig,
): Promise<string[] | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const provider = await registry.build(cfg);
    return await provider.listModels(controller.signal);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function setActiveModel(providerId: string, model: string): Promise<void> {
  await vscode.workspace
    .getConfiguration("xpreiIDE")
    .update(
      "activeModel",
      ProviderRegistry.formatActive(providerId, model),
      vscode.ConfigurationTarget.Global,
    );
  vscode.window.showInformationMessage(
    `xpreiIDE: using Ollama's ${model}. Change anytime with 'xpreiIDE: Select Model'.`,
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck -w xpreiIDE-ai`
Expected: PASS. (Nothing imports this module yet — Task 2 wires it — but
the file itself must compile.)

- [ ] **Step 3: Commit**

```bash
git add extensions/vscode/src/providers/autoDiscover.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(vscode): add local Ollama auto-discovery module"
```

---

### Task 2: Wire it into `activate()`

**Files:**
- Modify: `extensions/vscode/src/extension.ts`

**Interfaces:**
- Consumes: `tryAutoDiscoverOllama(registry: ProviderRegistry): Promise<void>`
  from Task 1.

- [ ] **Step 1: Add the import**

In `extensions/vscode/src/extension.ts`, add to the existing import block
at the top (after the existing
`import { runAddProviderFlow } from "./providers/addProviderFlow";` line):

```typescript
import { tryAutoDiscoverOllama } from "./providers/autoDiscover";
```

- [ ] **Step 2: Call it from `activate()`**

In the same file, find the existing line `void engine.load();` (currently
line 160, just after the big `context.subscriptions.push(...)` block).
Immediately after it, add:

```typescript

  // First-run convenience: if no chat model is set yet, quietly look for a
  // local Ollama daemon and offer one-click setup. Fire-and-forget — it
  // must never delay activation, and stays silent when nothing is found.
  void tryAutoDiscoverOllama(registry);
```

The surrounding region should end up reading:

```typescript
  void engine.load();

  // First-run convenience: if no chat model is set yet, quietly look for a
  // local Ollama daemon and offer one-click setup. Fire-and-forget — it
  // must never delay activation, and stays silent when nothing is found.
  void tryAutoDiscoverOllama(registry);

  // Chat lives in its own Activity Bar container — open it on startup so
  // it's not hidden behind an icon the user has to discover. (Users can
  // drag the view to the Secondary Side Bar themselves if they prefer —
  // VS Code has no stable extension-contribution API for that placement.)
  void vscode.commands.executeCommand("workbench.view.extension.xpreiIDE");
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck -w xpreiIDE-ai`
Expected: PASS.

- [ ] **Step 4: Compile**

Run: `npm run compile -w xpreiIDE-ai`
Expected: PASS, `dist/extension.js` rebuilt.

- [ ] **Step 5: Commit**

```bash
git add extensions/vscode/src/extension.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(vscode): run Ollama auto-discovery on activation"
```

---

### Task 3: User-facing docs

**Files:**
- Modify: `extensions/vscode/README.md`
- Modify: `README.md`

**Interfaces:** none — documentation only. Required by the `CLAUDE.md`
convention: every plan that adds a user-facing feature must update both
READMEs as part of the plan.

- [ ] **Step 1: Update the "Use" section of `extensions/vscode/README.md`**

That section currently reads:

```markdown
## Use

1. Start a model backend — e.g. `ollama serve` and `ollama pull llama3.1`.
2. Open the **xpreiIDE** icon in the activity bar → Chat panel.
3. Run **xpreiIDE: Select Model** (Command Palette) → pick provider → pick model.
4. Type and hit Enter. Tokens stream in.
```

Replace it with:

```markdown
## Use

1. Start a model backend — e.g. `ollama serve` and `ollama pull llama3.1`.
2. Open the **xpreiIDE** icon in the activity bar → Chat panel.
3. If a local Ollama daemon is already running, xpreiIDE detects it on
   startup and offers to use it — accept the prompt and you're done.
   Otherwise run **xpreiIDE: Select Model** (Command Palette) → pick
   provider → pick model.
4. Type and hit Enter. Tokens stream in.
```

- [ ] **Step 2: Add an "Automatic Ollama setup" section to `extensions/vscode/README.md`**

Insert this new section immediately **before** the existing
`## Add a hosted / custom model` heading:

```markdown
## Automatic Ollama setup

When no chat model is configured yet, xpreiIDE checks on startup whether a
local Ollama daemon is running at `http://localhost:11434`. If it finds
one:

- **One model installed** — it's selected automatically, and a notification
  tells you which.
- **Several installed** — a notification offers to use Ollama; accept it
  and pick a model from the list.
- **Ollama running, no models pulled** — a notification suggests running
  `ollama pull llama3.1`.

If Ollama isn't running, nothing happens at all — no prompt, no error. The
check stops entirely once a chat model is set, and you can always change
the model later with **xpreiIDE: Select Model**.
```

- [ ] **Step 3: Add the Features bullet to the root `README.md`**

In the "Features" section, insert one new bullet immediately **after** the
existing `- **Bring-your-own-model** — ...` bullet (which ends with
"…never in plaintext settings.") and **before** the
`- **Per-role models** — ...` bullet:

```markdown
- **Zero-config local setup** — a running Ollama daemon is detected on
  startup and offered in one click; nothing to configure by hand.
```

- [ ] **Step 4: Proofread both files**

Read both changed files back in full. Confirm: no broken Markdown
(unclosed code fences, mismatched list indentation or numbering), the new
content reads naturally in place, and no surrounding text now contradicts
it (in particular, check that the root README's "First-use quickstart"
section still reads correctly — it describes selecting a model as a step,
which remains accurate as the manual path, so it needs no change).

- [ ] **Step 5: Commit**

```bash
git add extensions/vscode/README.md README.md
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "docs: document automatic Ollama setup in both user-facing READMEs"
```

---

### Task 4: Final verification

**Files:** none (verification only).

**Interfaces:** none — consumes everything built in Tasks 1-3.

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck -w xpreiIDE-ai`
Expected: PASS.

- [ ] **Step 2: Compile**

Run: `npm run compile -w xpreiIDE-ai`
Expected: PASS, `dist/extension.js` rebuilt.

- [ ] **Step 3: Core suite still green (sanity check — this plan touches no core code)**

Run: `npm test -w @xprei/core`
Expected: PASS with the same count as before this plan started (122 tests),
since no `packages/core` file was touched.

- [ ] **Step 4: Manual smoke test**

Launch the Extension Development Host (F5 in VS Code against
`extensions/vscode`). Because discovery only runs when
`xpreiIDE.activeModel` is empty, clear that setting between scenarios
(Settings → search `xpreiIDE.activeModel` → clear it, or edit
`settings.json`), then reload the window for each:

1. **Ollama running, ≥2 models pulled, `activeModel` cleared** — expect the
   "Ollama detected with N models — use it for chat?" notification; click
   **Use Ollama**, pick a model, confirm `activeModel` is now set and the
   confirmation notification names the model.
2. **Ollama running, exactly 1 model pulled, `activeModel` cleared** —
   expect NO QuickPick: the model is activated directly and a notification
   names it.
3. **Ollama running, 0 models pulled, `activeModel` cleared** — expect the
   "no models installed yet" notification, with no action buttons, and
   `activeModel` still empty afterwards.
4. **Ollama stopped, `activeModel` cleared** — expect complete silence: no
   notification, no error, nothing in the xpreiIDE output channel. Startup
   should not feel delayed.
5. **`activeModel` already set** — expect no notification and no network
   call. (To verify the early return conclusively, temporarily add
   `console.log("probing")` just before the `probeModels` call in
   `autoDiscover.ts`, watch the Extension Development Host's Debug Console,
   and **remove the line before committing anything**.)

If all five scenarios behave as expected, no further action needed — this
task has no commit of its own.
