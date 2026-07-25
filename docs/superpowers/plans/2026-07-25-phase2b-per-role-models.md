# Phase 2b Per-Role Models Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let chat, completions, the agent loop, inline edit, and commit-message
generation each use an independently configurable model, per
`docs/superpowers/specs/2026-07-25-phase2b-per-role-models-design.md`.

**Architecture:** Generalize the existing `ProviderRegistry.resolvePointer(setting)`
pattern (already proven by `activeModel`/`embedModel`) with an optional fallback
setting, add four new resolver methods and four new settings, widen the existing
`selectModel()` QuickPick helper to support clearing a role override back to its
fallback, and add one new command that lets a user pick which role to configure.

**Tech Stack:** TypeScript, VS Code extension API. No `@xprei/core` changes.

## Global Constraints

- No changes to `packages/core` — this project is entirely extension-layer
  (`extensions/vscode/src/**` + `extensions/vscode/package.json`).
- `extensions/vscode` has no unit tests by existing convention — every task
  is verified by `npm run typecheck -w xpreiIDE-ai` (and the final task also
  by `npm run compile -w xpreiIDE-ai` + manual smoke), not by an automated
  test suite.
- `resolveActive()` (chat) and `resolveEmbed()` (embeddings) keep their
  exact current no-fallback behavior — unchanged in this plan.
- New settings follow the existing flat `xpreiIDE.<name>` convention (not
  nested under a group), matching `activeModel`/`embedModel`'s exact shape:
  `{ "type": "string", "default": "", "description": "..." }`.
- **User-facing docs stay current** (`CLAUDE.md` convention, added
  2026-07-25): `extensions/vscode/README.md` and the root `README.md`'s
  Features list must be updated for this feature as part of this plan, not
  deferred — see Task 5.
- Commits: author `xpreiIDE <mbsajay1@gmail.com>`; footer
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; Conventional
  Commit prefixes (feat/docs/etc).

---

### Task 1: `ProviderRegistry` fallback resolution + four new role resolvers

**Files:**
- Modify: `extensions/vscode/src/providers/registry.ts`

**Interfaces:**
- Produces: `resolvePointer(setting: string, fallbackSetting?: string): Promise<ResolvedModel | undefined>` —
  now **public** (was `private`) and takes an optional second parameter.
  When the primary setting is empty/unparseable, it recurses into
  `fallbackSetting` (if given) instead of returning `undefined`.
- Produces: `resolveCompletion()`, `resolveAgent()`, `resolveInlineEdit()`,
  `resolveCommitMessage()` — each `(): Promise<ResolvedModel | undefined>`,
  mirroring the existing `resolveActive()`/`resolveEmbed()` shape exactly.
- Consumes: nothing new — `ResolvedModel`, `parsePointer`, `getConfigs()`,
  `build()` all already exist in this file.

- [ ] **Step 1: Widen `resolvePointer` and make it public**

In `extensions/vscode/src/providers/registry.ts`, replace the existing
private method (currently lines 85-94):

```typescript
  private async resolvePointer(setting: string): Promise<ResolvedModel | undefined> {
    const pointer = vscode.workspace
      .getConfiguration("xpreiIDE")
      .get<string>(setting, "");
    const parsed = ProviderRegistry.parsePointer(pointer);
    if (!parsed) return undefined;
    const cfg = this.getConfigs().find((c) => c.id === parsed.providerId);
    if (!cfg) return undefined;
    return { provider: await this.build(cfg), model: parsed.model };
  }
```

with:

```typescript
  // Reads xpreiIDE.<setting> as a "providerId::model" pointer. If it's
  // empty/unparseable and fallbackSetting is given, resolves that setting
  // instead — this is how e.g. an unset completionModel falls back to
  // activeModel. Public: extension.ts's selectModel() QuickPick previews
  // the effective (fallback-resolved) model before writing an override.
  async resolvePointer(
    setting: string,
    fallbackSetting?: string,
  ): Promise<ResolvedModel | undefined> {
    const pointer = vscode.workspace
      .getConfiguration("xpreiIDE")
      .get<string>(setting, "");
    const parsed = ProviderRegistry.parsePointer(pointer);
    if (!parsed) {
      return fallbackSetting ? this.resolvePointer(fallbackSetting) : undefined;
    }
    const cfg = this.getConfigs().find((c) => c.id === parsed.providerId);
    if (!cfg) return undefined;
    return { provider: await this.build(cfg), model: parsed.model };
  }
```

- [ ] **Step 2: Add the four new role resolvers**

Immediately after the existing `resolveEmbed()` method (currently lines
71-73), add:

```typescript
  // Resolve the completion model (xpreiIDE.completionModel), falling back
  // to the chat model (xpreiIDE.activeModel) when unset.
  async resolveCompletion(): Promise<ResolvedModel | undefined> {
    return this.resolvePointer("completionModel", "activeModel");
  }

  // Resolve the agent-loop model (xpreiIDE.agentModel), falling back to
  // the chat model (xpreiIDE.activeModel) when unset.
  async resolveAgent(): Promise<ResolvedModel | undefined> {
    return this.resolvePointer("agentModel", "activeModel");
  }

  // Resolve the inline-edit (Cmd/Ctrl+K) model (xpreiIDE.inlineEditModel),
  // falling back to the chat model (xpreiIDE.activeModel) when unset.
  async resolveInlineEdit(): Promise<ResolvedModel | undefined> {
    return this.resolvePointer("inlineEditModel", "activeModel");
  }

  // Resolve the commit-message model (xpreiIDE.commitMessageModel),
  // falling back to the chat model (xpreiIDE.activeModel) when unset.
  async resolveCommitMessage(): Promise<ResolvedModel | undefined> {
    return this.resolvePointer("commitMessageModel", "activeModel");
  }
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck -w xpreiIDE-ai`
Expected: PASS. (Nothing calls the new methods yet, but the file itself
must compile — the widened `resolvePointer` signature is a strict
superset of the old one, so no existing caller breaks.)

- [ ] **Step 4: Commit**

```bash
git add extensions/vscode/src/providers/registry.ts
git commit -m "feat(vscode): add per-role model resolution with chat-model fallback"
```

---

### Task 2: Widen `selectModel()` with a clear-override step

**Files:**
- Modify: `extensions/vscode/src/extension.ts`

**Interfaces:**
- Consumes: `ProviderRegistry.resolvePointer(setting, fallbackSetting?)` from Task 1.
- Produces: `type ModelSetting = "activeModel" | "embedModel" | "completionModel" | "agentModel" | "inlineEditModel" | "commitMessageModel"`
  (Task 3's `RoleEntry.setting` field uses this exact type).
  `selectModel(registry, setting: ModelSetting, role: string, fallbackSetting?: "activeModel"): Promise<void>` —
  same name, now takes 1-2 more parameters than before (both optional in
  practice: `fallbackSetting` is genuinely optional; existing callers
  `xpreiIDE.selectModel`/`xpreiIDE.selectEmbedModel` at lines 71-76 don't
  pass it and keep working unchanged since `setting`'s type still accepts
  their string literals).

- [ ] **Step 1: Add the `ModelSetting` type and widen the function signature**

In `extensions/vscode/src/extension.ts`, immediately after the existing
`QUICK_ACTIONS` array (currently lines 13-19), add:

```typescript
type ModelSetting =
  | "activeModel"
  | "embedModel"
  | "completionModel"
  | "agentModel"
  | "inlineEditModel"
  | "commitMessageModel";
```

(It's declared here, at the top of the file, rather than next to
`selectModel` further down, because Task 3 adds a `RoleEntry` interface in
this same spot that also needs this type — one declaration, used by both.)

Then replace the function's signature and body (currently lines 124-176):

```typescript
// Two-step QuickPick: choose a provider, then a model it reports. Persisted to
// the given setting as "providerId::model". When fallbackSetting is given and
// a resolution already exists (an explicit override or the fallback itself),
// offers a "clear override" shortcut before the provider/model picker.
async function selectModel(
  registry: ProviderRegistry,
  setting: ModelSetting,
  role: string,
  fallbackSetting?: "activeModel",
): Promise<void> {
  const configs = registry.getConfigs();
  if (configs.length === 0) {
    vscode.window.showWarningMessage(
      "No providers configured. Add one under Settings → xpreiIDE.providers.",
    );
    return;
  }

  if (fallbackSetting) {
    const effective = await registry.resolvePointer(setting, fallbackSetting);
    if (effective) {
      const choice = await vscode.window.showQuickPick(
        [
          {
            label: `Clear override (use Chat model: ${effective.provider.label}/${effective.model})`,
            action: "clear" as const,
          },
          { label: `Choose a specific model for ${role}...`, action: "choose" as const },
        ],
        { placeHolder: `Configure the ${role} model` },
      );
      if (!choice) return;
      if (choice.action === "clear") {
        await vscode.workspace
          .getConfiguration("xpreiIDE")
          .update(setting, "", vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`xpreiIDE ${role} now follows the Chat model.`);
        return;
      }
    }
  }

  const pickedProvider = await pickProvider(configs, `Select a provider for ${role}`);
  if (!pickedProvider) return;

  let models: string[];
  try {
    const provider = await registry.build(pickedProvider);
    models = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Loading models…" },
      () => provider.listModels(),
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      err instanceof Error ? err.message : "Failed to list models.",
    );
    return;
  }

  if (models.length === 0) {
    vscode.window.showWarningMessage(
      `No models found for ${pickedProvider.label}. Pull one (e.g. 'ollama pull llama3.1').`,
    );
    return;
  }

  const model = await vscode.window.showQuickPick(models, {
    placeHolder: `Select a ${role} model`,
  });
  if (!model) return;

  await vscode.workspace
    .getConfiguration("xpreiIDE")
    .update(
      setting,
      ProviderRegistry.formatActive(pickedProvider.id, model),
      vscode.ConfigurationTarget.Global,
    );
  vscode.window.showInformationMessage(
    `xpreiIDE ${role} model: ${pickedProvider.label} / ${model}`,
  );
}
```

(Everything after the opening clear-override block — `pickProvider`
onward — is byte-for-byte identical to the current function; only the
signature and the new `if (fallbackSetting)` block are new.)

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck -w xpreiIDE-ai`
Expected: PASS — the two existing call sites
(`selectModel(registry, "activeModel", "chat")` and
`selectModel(registry, "embedModel", "embedding")`, lines 71-76) omit the
new 4th parameter, which is optional, so they still typecheck unchanged.

- [ ] **Step 3: Commit**

```bash
git add extensions/vscode/src/extension.ts
git commit -m "feat(vscode): let selectModel clear a role override back to its fallback"
```

---

### Task 3: `selectRoleModel` command + settings/command registration

**Files:**
- Modify: `extensions/vscode/src/extension.ts`
- Modify: `extensions/vscode/package.json`

**Interfaces:**
- Consumes: `ModelSetting`, `selectModel(registry, setting, role, fallbackSetting?)` from Task 2.
- Produces: `selectRoleModel(registry: ProviderRegistry): Promise<void>`,
  the `xpreiIDE.selectRoleModel` command, and the `ROLES` array (used only
  within `extension.ts`, not exported).

- [ ] **Step 1: Add the `ROLES` array and `selectRoleModel` function**

In `extensions/vscode/src/extension.ts`, immediately after the
`ModelSetting` type alias Task 2 added (right after `QUICK_ACTIONS`), add:

```typescript
interface RoleEntry {
  label: string;
  setting: ModelSetting;
  role: string;
  fallbackSetting?: "activeModel";
}

const ROLES: RoleEntry[] = [
  { label: "Chat", setting: "activeModel", role: "chat" },
  {
    label: "Completions",
    setting: "completionModel",
    role: "completion",
    fallbackSetting: "activeModel",
  },
  { label: "Agent", setting: "agentModel", role: "agent", fallbackSetting: "activeModel" },
  {
    label: "Inline Edit (Cmd/Ctrl+K)",
    setting: "inlineEditModel",
    role: "inline edit",
    fallbackSetting: "activeModel",
  },
  {
    label: "Commit Message",
    setting: "commitMessageModel",
    role: "commit message",
    fallbackSetting: "activeModel",
  },
  { label: "Embeddings", setting: "embedModel", role: "embedding" },
];

async function selectRoleModel(registry: ProviderRegistry): Promise<void> {
  const picked = await vscode.window.showQuickPick(
    ROLES.map((r) => ({ label: r.label, entry: r })),
    { placeHolder: "Select which role to configure a model for" },
  );
  if (!picked) return;
  await selectModel(registry, picked.entry.setting, picked.entry.role, picked.entry.fallbackSetting);
}
```
- [ ] **Step 2: Register the command in `activate()`**

In `extensions/vscode/src/extension.ts`, immediately after the existing
`xpreiIDE.selectEmbedModel` registration (currently lines 74-76), add:

```typescript
    vscode.commands.registerCommand("xpreiIDE.selectRoleModel", () =>
      selectRoleModel(registry),
    ),
```

- [ ] **Step 3: Add the command declaration to `package.json`**

In `extensions/vscode/package.json`, immediately after the existing
`xpreiIDE.selectEmbedModel` command entry (currently lines 59-62), add:

```json
      {
        "command": "xpreiIDE.selectRoleModel",
        "title": "xpreiIDE: Select Model for Role..."
      },
```

- [ ] **Step 4: Add the four new settings to `package.json`**

In `extensions/vscode/package.json`, immediately after the existing
`xpreiIDE.embedModel` property (currently lines 211-215), add:

```json
        "xpreiIDE.completionModel": {
          "type": "string",
          "default": "",
          "description": "Model for inline ghost-text completions, formatted 'providerId::modelName'. Empty falls back to xpreiIDE.activeModel. Set via 'xpreiIDE: Select Model for Role...'."
        },
        "xpreiIDE.agentModel": {
          "type": "string",
          "default": "",
          "description": "Model for the agent's multi-step tool loop, formatted 'providerId::modelName'. Empty falls back to xpreiIDE.activeModel. Set via 'xpreiIDE: Select Model for Role...'."
        },
        "xpreiIDE.inlineEditModel": {
          "type": "string",
          "default": "",
          "description": "Model for inline edit (Cmd/Ctrl+K), formatted 'providerId::modelName'. Empty falls back to xpreiIDE.activeModel. Set via 'xpreiIDE: Select Model for Role...'."
        },
        "xpreiIDE.commitMessageModel": {
          "type": "string",
          "default": "",
          "description": "Model for commit-message generation, formatted 'providerId::modelName'. Empty falls back to xpreiIDE.activeModel. Set via 'xpreiIDE: Select Model for Role...'."
        },
```

- [ ] **Step 5: Validate `package.json` is well-formed JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('extensions/vscode/package.json', 'utf8')); console.log('valid JSON')"`
Expected: prints `valid JSON` with no error (a misplaced comma in a hand-
edited JSON file is the most common mistake in this step).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck -w xpreiIDE-ai`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add extensions/vscode/src/extension.ts extensions/vscode/package.json
git commit -m "feat(vscode): add xpreiIDE.selectRoleModel command and 4 new role settings"
```

---

### Task 4: Wire the four call sites to their new resolvers

**Files:**
- Modify: `extensions/vscode/src/completion/inlineCompletionProvider.ts:48`
- Modify: `extensions/vscode/src/agent/runner.ts:103`
- Modify: `extensions/vscode/src/edit/inlineEdit.ts:88`
- Modify: `extensions/vscode/src/git/commitMessage.ts:50`

**Interfaces:**
- Consumes: `resolveCompletion()`, `resolveAgent()`, `resolveInlineEdit()`,
  `resolveCommitMessage()` from Task 1.

- [ ] **Step 1: `inlineCompletionProvider.ts`**

Replace (line 48):

```typescript
    const resolved = await this.registry.resolveActive().catch(() => undefined);
```

with:

```typescript
    const resolved = await this.registry.resolveCompletion().catch(() => undefined);
```

- [ ] **Step 2: `runner.ts`**

Replace (line 103):

```typescript
  const resolved = await registry.resolveActive();
```

with:

```typescript
  const resolved = await registry.resolveAgent();
```

- [ ] **Step 3: `inlineEdit.ts`**

Replace (line 88):

```typescript
    const resolved = await this.registry.resolveActive();
```

with:

```typescript
    const resolved = await this.registry.resolveInlineEdit();
```

- [ ] **Step 4: `commitMessage.ts`**

Replace (line 50):

```typescript
  const resolved = await registry.resolveActive();
```

with:

```typescript
  const resolved = await registry.resolveCommitMessage();
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck -w xpreiIDE-ai`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add extensions/vscode/src/completion/inlineCompletionProvider.ts extensions/vscode/src/agent/runner.ts extensions/vscode/src/edit/inlineEdit.ts extensions/vscode/src/git/commitMessage.ts
git commit -m "feat(vscode): route completions/agent/inline-edit/commit-message through their own role models"
```

---

### Task 5: User-facing docs

**Files:**
- Modify: `extensions/vscode/README.md`
- Modify: `README.md`

**Interfaces:** none — documentation only. Required by the `CLAUDE.md`
convention added 2026-07-25: every plan that adds a user-facing feature
must update both READMEs as part of the plan.

- [ ] **Step 1: Add a "Per-role models" section to `extensions/vscode/README.md`**

Insert a new section immediately after the existing "Add a hosted / custom
model" section (which currently ends with the ` ``` ` closing the
`baseUrl` JSON example, right before the `## Architecture` heading):

```markdown
## Per-role models

By default, chat, completions, the agent, inline edit (Cmd-K), and commit-
message generation all use whatever model **xpreiIDE: Select Model** set
for chat. To use a different model for one of them — e.g. a small, fast
local model for completions while a larger model drives the agent — run
**xpreiIDE: Select Model for Role...**, pick a role, then pick a provider
and model as usual. Roles left unconfigured keep following the chat model
automatically; running the command again on a role you've already
overridden offers a **"Clear override"** option to revert it back to
following chat.
```

- [ ] **Step 2: Update the root `README.md`'s Features list**

In `README.md`, the existing "Features" section (currently around lines
164-177) has a bullet list. Add one new bullet, after the existing
"**Bring-your-own-model**" bullet (currently lines 167-168) and before
"**Agentic multi-file coder**" (line 169):

```markdown
- **Per-role models** — use a different model for chat, completions, the
  agent, inline edit, and commit messages (`xpreiIDE: Select Model for
  Role...`); any role left unconfigured follows the chat model.
```

- [ ] **Step 3: Proofread both files**

Read both changed files back in full and confirm: no broken Markdown
(unclosed code fences, mismatched list indentation), the new content
reads naturally in place, and no other part of either file still implies
there is only one model setting (e.g. double-check the root README's
"First-use quickstart" section doesn't need a matching update — it
already describes only the chat-model selection step, which is still
accurate as the *minimum* setup, so no change needed there).

- [ ] **Step 4: Commit**

```bash
git add extensions/vscode/README.md README.md
git commit -m "docs: document per-role models in both user-facing READMEs"
```

---

### Task 6: Final verification

**Files:** none (verification only).

**Interfaces:** none — consumes everything built in Tasks 1-5.

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck -w xpreiIDE-ai`
Expected: PASS.

- [ ] **Step 2: Compile**

Run: `npm run compile -w xpreiIDE-ai`
Expected: PASS, `dist/extension.js` rebuilt.

- [ ] **Step 3: Core suite still green (sanity check — this plan touches no core code)**

Run: `npm test -w @xprei/core`
Expected: PASS, same count as before this plan started (no core files
were touched).

- [ ] **Step 4: Manual smoke test**

Launch the Extension Development Host (F5 in VS Code against
`extensions/vscode`), with at least one provider configured
(e.g. Ollama with two different pulled models), and:
1. Run **xpreiIDE: Select Model for Role...** → **Agent** → pick a
   different model than the current chat model. Confirm the info message
   names the picked provider/model.
2. Start an agent run and confirm (via the output channel or by which
   provider receives traffic) that the agent actually uses the
   overridden model, not the chat model.
3. Run **xpreiIDE: Select Model for Role...** → **Agent** again — confirm
   the "Clear override (use Chat model: ...)" option now appears and
   correctly names the chat model. Pick it, then re-run an agent task and
   confirm it now uses the chat model again.
4. Repeat steps 1-3 once for **Completions** to confirm ghost-text
   completions pick up an independent override.

If all four checks behave as expected, no further action needed — this
task has no commit of its own.
