# Phase 2b: per-role models — design

Date: 2026-07-25

## Context

Second sub-project from `docs/feature-roadmap.md`'s Phase 2 ("Local-first
core UX"), split out from Phase 2 because it and auto-discovery (Phase 2a)
touch different code with no shared implementation — this project only
touches `extensions/vscode/src/providers/registry.ts`, `extension.ts`, and
the four extension-layer call sites listed below; Phase 2a touches
onboarding logic in `extension.ts`'s `activate()` and the "Add Provider"
flow instead.

**Problem:** today there is exactly one model pointer,
`xpreiIDE.activeModel`, shared by five independent call sites — chat,
inline completions, the agent loop, inline edit (Cmd/Ctrl+K), and commit-
message generation. A user who wants a small, fast local model driving
every keystroke's ghost-text completion, but a larger model driving the
agent's multi-step reasoning, cannot express that today: changing the
active model changes it everywhere at once. `xpreiIDE.embedModel` already
proves the alternative — a second, independent pointer, resolved through
the same `resolvePointer()` machinery — for exactly one role (embeddings).
This project generalizes that existing, working pattern to the other four
call sites instead of inventing a new one.

## Current state (verified in code)

- `ProviderRegistry.resolvePointer(setting: string)` (`registry.ts:85-94`)
  already takes the setting name as a parameter — reads
  `xpreiIDE.<setting>`, parses the `"providerId::model"` pointer, looks up
  the matching `ProviderConfig`, and builds a live `Provider`. `
  resolveActive()` (66-68) and `resolveEmbed()` (71-73) are both one-line
  wrappers over it.
- `selectModel(registry, setting, role)` in `extension.ts:124-176` is
  already generic over which setting it writes: two-step QuickPick (pick a
  provider via `pickProvider()`, then pick one of that provider's
  `listModels()` results), then persists `"providerId::model"` to the given
  setting. `pickProvider()` (`extension.ts:239-247`) auto-selects with no
  picker shown when there is exactly one configured provider.
- `xpreiIDE.selectModel` and `xpreiIDE.selectEmbedModel`
  (`extension.ts:71-76`) are both one-line command registrations calling
  `selectModel()` with `"activeModel"`/`"chat"` and
  `"embedModel"`/`"embedding"` respectively.
- The five call sites reading `resolveActive()` today:
  `ui/chat/chatView.ts:302` (chat), `completion/inlineCompletionProvider.ts:48`
  (completions), `agent/runner.ts:103` (agent), `edit/inlineEdit.ts:88`
  (inline edit), `git/commitMessage.ts:50` (commit message).
- `packages/core/src/agent/orchestrator.ts` takes a flat
  `{provider: Provider; model: string}` pair — untouched by this project;
  only the extension-side call that builds that pair changes.

## Decisions

- **Six roles, six pointers total:** `activeModel` (chat, unchanged name/
  behavior), `completionModel`, `agentModel`, `inlineEditModel`,
  `commitMessageModel` (all new), `embedModel` (unchanged). Inline edit and
  commit message each get their own pointer rather than folding into chat —
  matches the roadmap's spirit of maximum flexibility and costs nothing
  extra given the mechanism already generalizes cleanly.
- **Fallback, not a required-setup wall:** `completionModel`,
  `agentModel`, `inlineEditModel`, and `commitMessageModel` each fall back
  to `activeModel` when empty/unset. This is a zero-config upgrade path —
  existing users see no behavior change until they explicitly override a
  role. `embedModel` keeps its current no-fallback behavior unchanged
  (falling back to a non-embedding-capable chat model would silently break
  RAG, so an unset `embedModel` continues to mean "embeddings
  unconfigured", exactly as today).
- **One generic picker command**, `xpreiIDE.selectRoleModel` ("xpreiIDE:
  Select Model for Role..."), rather than four new near-duplicate commands.
  It shows a role QuickPick, then delegates to the existing `selectModel()`
  helper. `xpreiIDE.selectModel`/`xpreiIDE.selectEmbedModel` are unchanged —
  no back-compat break for anyone who already invokes them by name or has
  bound a keybinding to them.

## Architecture

**`registry.ts`:** add `resolvePointer`'s fallback as an optional second
parameter — `resolvePointer(setting: string, fallbackSetting?: string)`.
If the primary setting is empty/unset, it recurses into
`resolvePointer(fallbackSetting)` instead of returning `undefined`. Add four
new one-line public methods mirroring `resolveActive()`/`resolveEmbed()`'s
existing shape:

```typescript
async resolveCompletion(): Promise<ResolvedModel | undefined> {
  return this.resolvePointer("completionModel", "activeModel");
}
async resolveAgent(): Promise<ResolvedModel | undefined> {
  return this.resolvePointer("agentModel", "activeModel");
}
async resolveInlineEdit(): Promise<ResolvedModel | undefined> {
  return this.resolvePointer("inlineEditModel", "activeModel");
}
async resolveCommitMessage(): Promise<ResolvedModel | undefined> {
  return this.resolvePointer("commitMessageModel", "activeModel");
}
```

`resolveActive()` and `resolveEmbed()` are unchanged — both still call
`resolvePointer()` with no second argument, so their no-fallback behavior
is preserved exactly.

**Call-site swaps** (one line each, same shape, no other change to the
surrounding function):
- `completion/inlineCompletionProvider.ts:48`: `resolveActive()` →
  `resolveCompletion()`
- `agent/runner.ts:103`: `resolveActive()` → `resolveAgent()`
- `edit/inlineEdit.ts:88`: `resolveActive()` → `resolveInlineEdit()`
- `git/commitMessage.ts:50`: `resolveActive()` → `resolveCommitMessage()`
- `ui/chat/chatView.ts:302`: unchanged — stays `resolveActive()`.

**`selectModel()` in `extension.ts`:** widen its signature to accept an
optional `fallbackSetting`:

```typescript
async function selectModel(
  registry: ProviderRegistry,
  setting: "activeModel" | "embedModel" | "completionModel" | "agentModel"
    | "inlineEditModel" | "commitMessageModel",
  role: string,
  fallbackSetting?: "activeModel",
): Promise<void>
```

When `fallbackSetting` is present, insert one QuickPick step before the
existing provider picker: build the current *effective* resolution (via
`registry.resolvePointer(setting, fallbackSetting)`, exposed for this
purpose — see below) and show two items — `"Clear override (use Chat
model: <provider.label>/<model>)"` and `"Choose a specific model for
<role>..."`. Picking the first writes `""` to `setting` and returns (info
message: `"xpreiIDE ${role} now follows the Chat model."`); picking the
second falls through into the existing `pickProvider()` →
`listModels()` → model-QuickPick flow unchanged. When no resolution
exists yet (fallback also unset), skip straight to the existing flow — no
"clear override" item to show when there's nothing to clear.

`resolvePointer` is currently private (`registry.ts:85`). Since
`selectModel()` in `extension.ts` needs to preview the fallback
resolution, make it a public method (drop `private`) — it takes only
primitive `string` arguments and returns the same `ResolvedModel`
shape `resolveActive()`/`resolveEmbed()` already expose publicly, so
widening its visibility introduces no new surface area beyond what the
class already exports.

**New command, `xpreiIDE.selectRoleModel`:**

```typescript
vscode.commands.registerCommand("xpreiIDE.selectRoleModel", () =>
  selectRoleModel(registry),
);

const ROLES: Array<{
  label: string;
  setting: "activeModel" | "completionModel" | "agentModel"
    | "inlineEditModel" | "commitMessageModel" | "embedModel";
  role: string;
  fallbackSetting?: "activeModel";
}> = [
  { label: "Chat", setting: "activeModel", role: "chat" },
  { label: "Completions", setting: "completionModel", role: "completion", fallbackSetting: "activeModel" },
  { label: "Agent", setting: "agentModel", role: "agent", fallbackSetting: "activeModel" },
  { label: "Inline Edit (Cmd/Ctrl+K)", setting: "inlineEditModel", role: "inline edit", fallbackSetting: "activeModel" },
  { label: "Commit Message", setting: "commitMessageModel", role: "commit message", fallbackSetting: "activeModel" },
  { label: "Embeddings", setting: "embedModel", role: "embedding" },
];

async function selectRoleModel(registry: ProviderRegistry): Promise<void> {
  const picked = await vscode.window.showQuickPick(
    ROLES.map((r) => ({ label: r.label, entry: r })),
    { placeHolder: "Select which role to configure a model for" },
  );
  if (!picked) return;
  const { setting, role, fallbackSetting } = picked.entry;
  await selectModel(registry, setting, role, fallbackSetting);
}
```

## Settings (`extensions/vscode/package.json`)

Four new entries in `contributes.configuration`, immediately after the
existing `xpreiIDE.embedModel` entry (currently `package.json:211-215`),
matching its exact schema shape:

```json
{
  "xpreiIDE.completionModel": {
    "type": "string",
    "default": "",
    "description": "Model for inline ghost-text completions, as \"providerId::modelName\". Empty falls back to xpreiIDE.activeModel. Set via 'xpreiIDE: Select Model for Role...'."
  },
  "xpreiIDE.agentModel": {
    "type": "string",
    "default": "",
    "description": "Model for the agent's multi-step tool loop, as \"providerId::modelName\". Empty falls back to xpreiIDE.activeModel. Set via 'xpreiIDE: Select Model for Role...'."
  },
  "xpreiIDE.inlineEditModel": {
    "type": "string",
    "default": "",
    "description": "Model for inline edit (Cmd/Ctrl+K), as \"providerId::modelName\". Empty falls back to xpreiIDE.activeModel. Set via 'xpreiIDE: Select Model for Role...'."
  },
  "xpreiIDE.commitMessageModel": {
    "type": "string",
    "default": "",
    "description": "Model for commit-message generation, as \"providerId::modelName\". Empty falls back to xpreiIDE.activeModel. Set via 'xpreiIDE: Select Model for Role...'."
  }
}
```

One new command entry in `contributes.commands`, immediately after the
existing `xpreiIDE.selectEmbedModel` entry (`package.json:59-62`):

```json
{
  "command": "xpreiIDE.selectRoleModel",
  "title": "xpreiIDE: Select Model for Role..."
}
```

## Out of scope

- No change to `Provider`, `ProviderConfig`, `ProviderCapabilities`, or any
  `@xprei/core` module — this is entirely an extension-layer (settings +
  registry + call-site) change.
- No change to `xpreiIDE.selectModel`/`xpreiIDE.selectEmbedModel` command
  behavior or IDs — both keep working exactly as today.
- No per-model capability detection (context window, tool support) — that
  remains the separate, already-flagged gap in `CLAUDE.md`.
- Auto-discovery (Phase 2a) is a separate spec — this project assumes
  providers are already configured through the existing manual "Add
  Provider" flow.

## Testing

`registry.ts` and `extension.ts` are both extension-layer code with no
unit tests, per this repo's existing convention (`CLAUDE.md`: "The
extension itself has no unit tests"). Verified by:
- `npm run typecheck -w xpreiIDE-ai` (must pass — the widened `selectModel`
  signature and new registry methods must typecheck cleanly).
- `npm run compile -w xpreiIDE-ai` (must pass).
- Manual smoke test in the Extension Development Host: configure two
  providers/models, use "xpreiIDE: Select Model for Role..." to set a
  distinct `agentModel`, confirm the agent loop actually uses it (e.g. by
  checking which provider's traffic fires), then clear the override via
  the same command and confirm the agent falls back to using
  `activeModel` again. Repeat once for `completionModel` to confirm ghost-
  text completions pick up the override independently of chat.

No `@xprei/core` changes means no new core unit tests are needed for this
project.
