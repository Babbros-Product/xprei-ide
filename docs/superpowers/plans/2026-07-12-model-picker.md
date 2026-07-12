# Model Picker + Provider Presets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a composer-row model dropdown to the xpreiIDE chat panel (listing every model across every configured provider — Ollama, OpenAI, Gemini, any OpenAI-compatible endpoint) plus a one-click "add provider" flow with OpenAI/Gemini/Ollama presets, so switching or adding models no longer requires the command palette or hand-edited JSON.

**Architecture:** A new pure function `aggregateModels()` (`src/providers/modelList.ts`) walks the configured `ProviderConfig[]`, calls each provider's `listModels()`, and falls back to `cfg.model` on failure — this is the part with real logic, so it's the part that's unit tested. `ProviderRegistry.listAllModels()` is a thin vscode-config-reading wrapper around it. The chat webview requests this list on load and after adding a provider, renders it as a `<select>` next to Send/Stop/Agent, and posts back either a `selectModel` or `addProvider` message. `addProviderFlow.ts` holds the QuickPick/InputBox wizard (OpenAI/Gemini presets from `presets.ts`, Ollama local, or a pointer to manual JSON config) and is shared by both the `xpreiIDE.addProvider` command and the webview's "+ Add provider…" entry.

**Tech Stack:** TypeScript, VS Code Extension API (`vscode.workspace.getConfiguration`, `SecretStorage`, `QuickPick`/`InputBox`), vanilla webview JS/CSS (no framework, matches existing `chat.js`), `node --test` + `tsx` for unit tests.

## Global Constraints

- Secrets: API keys only via `SecretStorage` (`ProviderRegistry.setApiKey`), never written to plaintext settings.
- `Provider` / `ProviderConfig` interfaces (`src/providers/provider.ts`) are stable — do not modify them; new capability goes through the registry/aggregation layer.
- Tests are dependency-free (pure modules + fakes, no live model/network/vscode). Every new test file must be added to the `test` script list in `extensions/xpreiIDE-ai/package.json`.
- Commits: `git commit --author "xpreiIDE <mbsajay1@gmail.com>"`, footer `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`, Conventional Commit prefixes (feat/fix/docs/test).
- PATH does not persist between tool invocations on this machine — every shell command touching `node`/`npm` must prepend nvm4w to PATH (see step commands below; this is already baked into each command in this plan).
- Line endings are forced to LF via `.gitattributes` — no action needed.

---

### Task 1: Provider presets (`presets.ts`)

**Files:**
- Create: `extensions/xpreiIDE-ai/src/providers/presets.ts`
- Test: `extensions/xpreiIDE-ai/src/providers/presets.test.ts`
- Modify: `extensions/xpreiIDE-ai/package.json:142` (add test file to `test` script)

**Interfaces:**
- Produces: `PRESETS: ProviderPreset[]` where `ProviderPreset = { id: string; kind: "openai-compat"; label: string; baseUrl: string }`; `uniqueProviderId(base: string, existingIds: string[]): string`.

- [ ] **Step 1: Write the failing tests**

```typescript
// extensions/xpreiIDE-ai/src/providers/presets.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { PRESETS, uniqueProviderId } from "./presets";

test("PRESETS includes OpenAI and Gemini with correct base URLs", () => {
  const openai = PRESETS.find((p) => p.id === "openai");
  const gemini = PRESETS.find((p) => p.id === "gemini");
  assert.ok(openai, "openai preset missing");
  assert.equal(openai?.baseUrl, "https://api.openai.com/v1");
  assert.equal(openai?.kind, "openai-compat");
  assert.ok(gemini, "gemini preset missing");
  assert.equal(gemini?.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
  assert.equal(gemini?.kind, "openai-compat");
});

test("uniqueProviderId returns the base id when it is free", () => {
  assert.equal(uniqueProviderId("openai", []), "openai");
  assert.equal(uniqueProviderId("openai", ["gemini"]), "openai");
});

test("uniqueProviderId appends -2 when the base id is taken", () => {
  assert.equal(uniqueProviderId("openai", ["openai"]), "openai-2");
});

test("uniqueProviderId skips already-taken numbered suffixes", () => {
  assert.equal(uniqueProviderId("openai", ["openai", "openai-2"]), "openai-3");
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
export PATH="/c/nvm4w/nodejs:/c/Users/mbsaj/AppData/Roaming/npm:$PATH"
node --import tsx --test "D:/Claude/BABBROSIDE/extensions/xpreiIDE-ai/src/providers/presets.test.ts"
```
Expected: FAIL — `Cannot find module './presets'`.

- [ ] **Step 3: Write the implementation**

```typescript
// extensions/xpreiIDE-ai/src/providers/presets.ts
// One-click provider setup: baseUrl presets for well-known OpenAI-compatible
// endpoints, so adding OpenAI/Gemini doesn't require hand-editing JSON.

export interface ProviderPreset {
  id: string;
  kind: "openai-compat";
  label: string;
  baseUrl: string;
}

export const PRESETS: ProviderPreset[] = [
  { id: "openai", kind: "openai-compat", label: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  {
    id: "gemini",
    kind: "openai-compat",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  },
];

// Appends a numeric suffix ("-2", "-3", ...) until the id is not in existingIds.
export function uniqueProviderId(base: string, existingIds: string[]): string {
  if (!existingIds.includes(base)) return base;
  let n = 2;
  while (existingIds.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
```

- [ ] **Step 4: Add the test file to `package.json`'s `test` script**

In `extensions/xpreiIDE-ai/package.json`, the `"test"` script currently ends with `...src/agent/orchestrator.test.ts"`. Append `" src/providers/presets.test.ts"` before the closing quote so the full script reads (only the new segment shown, insert after the existing last entry):

```json
"test": "node --import tsx --test src/providers/ollama.test.ts src/providers/openai-compat.test.ts src/context/chunking.test.ts src/context/vectorstore.test.ts src/context/mentions.test.ts src/edit/prompt.test.ts src/agent/protocol.test.ts src/agent/tools.test.ts src/agent/checkpoint.test.ts src/agent/orchestrator.test.ts src/providers/presets.test.ts"
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
export PATH="/c/nvm4w/nodejs:/c/Users/mbsaj/AppData/Roaming/npm:$PATH"
node --import tsx --test "D:/Claude/BABBROSIDE/extensions/xpreiIDE-ai/src/providers/presets.test.ts"
```
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
cd "D:/Claude/BABBROSIDE" && git add extensions/xpreiIDE-ai/src/providers/presets.ts extensions/xpreiIDE-ai/src/providers/presets.test.ts extensions/xpreiIDE-ai/package.json
git commit --author "xpreiIDE <mbsajay1@gmail.com>" -m "$(cat <<'EOF'
feat: add OpenAI/Gemini provider presets

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Model aggregation (`modelList.ts`)

**Files:**
- Create: `extensions/xpreiIDE-ai/src/providers/modelList.ts`
- Test: `extensions/xpreiIDE-ai/src/providers/modelList.test.ts`
- Modify: `extensions/xpreiIDE-ai/package.json` (add test file to `test` script)

**Interfaces:**
- Consumes: `Provider`, `ProviderConfig` from `./provider` (unchanged, existing types — see `provider.ts:34-56`).
- Produces: `ModelEntry = { providerId: string; providerLabel: string; model: string; active: boolean }`; `aggregateModels(configs: ProviderConfig[], buildProvider: (cfg: ProviderConfig) => Promise<Provider>, activePointer: string): Promise<ModelEntry[]>`. Task 3 imports both from this file.

- [ ] **Step 1: Write the failing tests**

```typescript
// extensions/xpreiIDE-ai/src/providers/modelList.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateModels } from "./modelList";
import { Provider, ProviderCapabilities, ProviderConfig } from "./provider";

const caps: ProviderCapabilities = { tools: false, embeddings: false, contextWindow: 4096 };

function fakeProvider(id: string, models: string[] | Error): Provider {
  return {
    id,
    label: id,
    capabilities: caps,
    async listModels() {
      if (models instanceof Error) throw models;
      return models;
    },
    async *chatStream() {
      // unused by these tests
    },
  };
}

const cfgOk: ProviderConfig = { id: "a", kind: "ollama", label: "A", baseUrl: "http://a" };
const cfgFallback: ProviderConfig = {
  id: "b",
  kind: "openai-compat",
  label: "B",
  baseUrl: "http://b",
  model: "fallback-model",
};
const cfgNoFallback: ProviderConfig = { id: "c", kind: "openai-compat", label: "C", baseUrl: "http://c" };

test("aggregateModels lists models from a healthy provider and marks the active one", async () => {
  const build = async (cfg: ProviderConfig) => fakeProvider(cfg.id, ["m1", "m2"]);
  const entries = await aggregateModels([cfgOk], build, "a::m2");
  assert.deepEqual(entries, [
    { providerId: "a", providerLabel: "A", model: "m1", active: false },
    { providerId: "a", providerLabel: "A", model: "m2", active: true },
  ]);
});

test("aggregateModels falls back to cfg.model when listModels rejects", async () => {
  const build = async (cfg: ProviderConfig) => fakeProvider(cfg.id, new Error("offline"));
  const entries = await aggregateModels([cfgFallback], build, "");
  assert.deepEqual(entries, [
    { providerId: "b", providerLabel: "B", model: "fallback-model", active: false },
  ]);
});

test("aggregateModels skips a provider with no fallback but keeps others", async () => {
  const build = async (cfg: ProviderConfig) =>
    cfg.id === "c" ? fakeProvider(cfg.id, new Error("offline")) : fakeProvider(cfg.id, ["m1"]);
  const entries = await aggregateModels([cfgOk, cfgNoFallback], build, "");
  assert.deepEqual(entries, [{ providerId: "a", providerLabel: "A", model: "m1", active: false }]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
export PATH="/c/nvm4w/nodejs:/c/Users/mbsaj/AppData/Roaming/npm:$PATH"
node --import tsx --test "D:/Claude/BABBROSIDE/extensions/xpreiIDE-ai/src/providers/modelList.test.ts"
```
Expected: FAIL — `Cannot find module './modelList'`.

- [ ] **Step 3: Write the implementation**

```typescript
// extensions/xpreiIDE-ai/src/providers/modelList.ts
// Pure aggregation logic for the model picker: given configured providers and
// a way to build each one, resolve every available model name. Kept vscode-free
// so it's directly unit-testable; ProviderRegistry.listAllModels() is the thin
// vscode-config-reading wrapper around this.

import { Provider, ProviderConfig } from "./provider";

export interface ModelEntry {
  providerId: string;
  providerLabel: string;
  model: string;
  active: boolean;
}

export async function aggregateModels(
  configs: ProviderConfig[],
  buildProvider: (cfg: ProviderConfig) => Promise<Provider>,
  activePointer: string,
): Promise<ModelEntry[]> {
  const out: ModelEntry[] = [];
  for (const cfg of configs) {
    let models: string[];
    try {
      const provider = await buildProvider(cfg);
      models = await provider.listModels();
    } catch {
      models = cfg.model ? [cfg.model] : [];
    }
    for (const model of models) {
      out.push({
        providerId: cfg.id,
        providerLabel: cfg.label,
        model,
        active: `${cfg.id}::${model}` === activePointer,
      });
    }
  }
  return out;
}
```

- [ ] **Step 4: Add the test file to `package.json`'s `test` script**

Append `" src/providers/modelList.test.ts"` to the same `test` script from Task 1 Step 4, so it now ends `...src/providers/presets.test.ts src/providers/modelList.test.ts"`.

- [ ] **Step 5: Run tests to verify they pass**

```bash
export PATH="/c/nvm4w/nodejs:/c/Users/mbsaj/AppData/Roaming/npm:$PATH"
node --import tsx --test "D:/Claude/BABBROSIDE/extensions/xpreiIDE-ai/src/providers/modelList.test.ts"
```
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
cd "D:/Claude/BABBROSIDE" && git add extensions/xpreiIDE-ai/src/providers/modelList.ts extensions/xpreiIDE-ai/src/providers/modelList.test.ts extensions/xpreiIDE-ai/package.json
git commit --author "xpreiIDE <mbsajay1@gmail.com>" -m "$(cat <<'EOF'
feat: add pure model-aggregation logic for the model picker

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `ProviderRegistry.listAllModels()`

**Files:**
- Modify: `extensions/xpreiIDE-ai/src/providers/registry.ts`

**Interfaces:**
- Consumes: `aggregateModels`, `ModelEntry` from `./modelList` (Task 2); `this.getConfigs()` and `this.build(cfg)` (existing, `registry.ts:20-32`).
- Produces: `ProviderRegistry.listAllModels(): Promise<ModelEntry[]>`. Task 6 (chatView) calls this directly.

No new test in this task — `aggregateModels` (the logic) is already covered by Task 2; this method is a 3-line vscode-config wrapper, consistent with how `resolveActive`/`resolveEmbed` in the same file are covered only by typecheck, not unit tests (they also read live `vscode.workspace.getConfiguration`).

- [ ] **Step 1: Add the import and method**

In `extensions/xpreiIDE-ai/src/providers/registry.ts`, add to the top imports (after the existing `Provider, ProviderConfig` import on line 8):

```typescript
import { aggregateModels, ModelEntry } from "./modelList";
```

Add this method to the `ProviderRegistry` class, directly after `resolveEmbed()` (currently `registry.ts:44-46`):

```typescript
  // Aggregate every model from every configured provider, for the chat
  // panel's model picker. Never throws — a provider that fails to list
  // models is skipped (or falls back to its configured default model).
  async listAllModels(): Promise<ModelEntry[]> {
    const activePointer = vscode.workspace
      .getConfiguration("xpreiIDE")
      .get<string>("activeModel", "");
    return aggregateModels(this.getConfigs(), (cfg) => this.build(cfg), activePointer);
  }
```

- [ ] **Step 2: Typecheck**

```bash
export PATH="/c/nvm4w/nodejs:/c/Users/mbsaj/AppData/Roaming/npm:$PATH"
npm --prefix "D:/Claude/BABBROSIDE/extensions/xpreiIDE-ai" run typecheck
```
Expected: exits 0, no errors.

- [ ] **Step 3: Commit**

```bash
cd "D:/Claude/BABBROSIDE" && git add extensions/xpreiIDE-ai/src/providers/registry.ts
git commit --author "xpreiIDE <mbsajay1@gmail.com>" -m "$(cat <<'EOF'
feat: expose ProviderRegistry.listAllModels for the chat model picker

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Add-provider flow (`addProviderFlow.ts`)

**Files:**
- Create: `extensions/xpreiIDE-ai/src/providers/addProviderFlow.ts`

**Interfaces:**
- Consumes: `PRESETS`, `uniqueProviderId` from `./presets` (Task 1); `ProviderConfig` from `./provider`; `ProviderRegistry` from `./registry` (`getConfigs()`, `setApiKey()`, `formatActive()` — all existing).
- Produces: `runAddProviderFlow(registry: ProviderRegistry): Promise<void>`. Task 5 (command) and Task 6 (chatView) both call this — single implementation, no duplication.

This is a vscode QuickPick/InputBox wizard with no return value to assert on — not unit tested, matching the existing convention for `selectModel`/`setApiKey` in `extension.ts:60-154`, which are also untested vscode-glue functions. Verified by typecheck + manual smoke test in Task 9.

- [ ] **Step 1: Write the implementation**

```typescript
// extensions/xpreiIDE-ai/src/providers/addProviderFlow.ts
// QuickPick/InputBox wizard for adding a provider without hand-editing JSON.
// Shared by the "xpreiIDE.addProvider" command and the chat panel's
// "+ Add provider…" picker entry — one implementation, two entry points.

import * as vscode from "vscode";
import { PRESETS, uniqueProviderId } from "./presets";
import { ProviderConfig } from "./provider";
import { ProviderRegistry } from "./registry";

type AddChoice =
  | { label: string; kind: "custom" }
  | {
      label: string;
      kind: "ollama" | "openai-compat";
      id: string;
      baseUrl: string;
      needsKey: boolean;
    };

export async function runAddProviderFlow(registry: ProviderRegistry): Promise<void> {
  const choices: AddChoice[] = [
    ...PRESETS.map((p) => ({
      label: p.label,
      kind: p.kind,
      id: p.id,
      baseUrl: p.baseUrl,
      needsKey: true,
    })),
    {
      label: "Ollama (local)",
      kind: "ollama",
      id: "ollama-local",
      baseUrl: "http://localhost:11434",
      needsKey: false,
    },
    { label: "Custom…", kind: "custom" },
  ];

  const picked = await vscode.window.showQuickPick(
    choices.map((c) => ({ label: c.label, choice: c })),
    { placeHolder: "Add a model provider" },
  );
  if (!picked) return;
  const choice = picked.choice;

  if (choice.kind === "custom") {
    const action = await vscode.window.showInformationMessage(
      "Add a provider manually: Settings → xpreiIDE.providers (JSON array).",
      "Open Settings",
    );
    if (action === "Open Settings") {
      await vscode.commands.executeCommand("workbench.action.openSettingsJson");
    }
    return;
  }

  let apiKey = "";
  if (choice.needsKey) {
    const key = await vscode.window.showInputBox({
      prompt: `API key for ${choice.label}`,
      password: true,
      ignoreFocusOut: true,
    });
    if (key == null) return;
    apiKey = key;
  }

  const model = await vscode.window.showInputBox({
    prompt: `Default model name for ${choice.label} (optional, e.g. gpt-4o-mini)`,
    ignoreFocusOut: true,
  });
  if (model === undefined) return;

  const settings = vscode.workspace.getConfiguration("xpreiIDE");
  const existing = registry.getConfigs();
  const id = uniqueProviderId(choice.id, existing.map((c) => c.id));

  const cfg: ProviderConfig = {
    id,
    kind: choice.kind,
    label: choice.label,
    baseUrl: choice.baseUrl,
    ...(model ? { model } : {}),
  };

  await settings.update("providers", [...existing, cfg], vscode.ConfigurationTarget.Global);
  if (choice.needsKey) await registry.setApiKey(id, apiKey);

  const activePointer = settings.get<string>("activeModel", "");
  if (!activePointer && model) {
    await settings.update(
      "activeModel",
      ProviderRegistry.formatActive(id, model),
      vscode.ConfigurationTarget.Global,
    );
  }

  vscode.window.showInformationMessage(`xpreiIDE: added provider ${choice.label}.`);
}
```

- [ ] **Step 2: Typecheck**

```bash
export PATH="/c/nvm4w/nodejs:/c/Users/mbsaj/AppData/Roaming/npm:$PATH"
npm --prefix "D:/Claude/BABBROSIDE/extensions/xpreiIDE-ai" run typecheck
```
Expected: exits 0, no errors. This is also the step that validates the `AddChoice` discriminated union narrows correctly after the `choice.kind === "custom"` check.

- [ ] **Step 3: Commit**

```bash
cd "D:/Claude/BABBROSIDE" && git add extensions/xpreiIDE-ai/src/providers/addProviderFlow.ts
git commit --author "xpreiIDE <mbsajay1@gmail.com>" -m "$(cat <<'EOF'
feat: add provider quick-add wizard (OpenAI/Gemini/Ollama presets)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Wire the `xpreiIDE.addProvider` command

**Files:**
- Modify: `extensions/xpreiIDE-ai/src/extension.ts`
- Modify: `extensions/xpreiIDE-ai/package.json` (command contribution)

**Interfaces:**
- Consumes: `runAddProviderFlow` from `./providers/addProviderFlow` (Task 4).

- [ ] **Step 1: Register the command in `extension.ts`**

Add to the imports at the top of `extension.ts` (after the existing `ProviderRegistry` import on line 7):

```typescript
import { runAddProviderFlow } from "./providers/addProviderFlow";
```

Add a new `registerCommand` call inside the `context.subscriptions.push(...)` block (`extension.ts:24-49`), directly after the `xpreiIDE.setApiKey` registration (currently lines 40-42):

```typescript
    vscode.commands.registerCommand("xpreiIDE.addProvider", () =>
      runAddProviderFlow(registry),
    ),
```

- [ ] **Step 2: Add the command contribution to `package.json`**

In `extensions/xpreiIDE-ai/package.json`, add to the `"commands"` array (after the `xpreiIDE.setApiKey` entry, currently lines 45-48):

```json
      {
        "command": "xpreiIDE.addProvider",
        "title": "xpreiIDE: Add Model Provider"
      },
```

- [ ] **Step 3: Typecheck**

```bash
export PATH="/c/nvm4w/nodejs:/c/Users/mbsaj/AppData/Roaming/npm:$PATH"
npm --prefix "D:/Claude/BABBROSIDE/extensions/xpreiIDE-ai" run typecheck
```
Expected: exits 0, no errors.

- [ ] **Step 4: Commit**

```bash
cd "D:/Claude/BABBROSIDE" && git add extensions/xpreiIDE-ai/src/extension.ts extensions/xpreiIDE-ai/package.json
git commit --author "xpreiIDE <mbsajay1@gmail.com>" -m "$(cat <<'EOF'
feat: register xpreiIDE: Add Model Provider command

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Chat panel wiring (`chatView.ts`)

**Files:**
- Modify: `extensions/xpreiIDE-ai/src/ui/chat/chatView.ts`

**Interfaces:**
- Consumes: `registry.listAllModels()` (Task 3), `runAddProviderFlow` (Task 4).
- Produces: webview receives `{type: "models", items: ModelEntry[]}`; webview may send `{type: "selectModel", pointer: string}` or `{type: "addProvider"}` (consumed by Task 7's `chat.js`).

- [ ] **Step 1: Import `runAddProviderFlow`**

Add to the imports at the top of `chatView.ts` (after the existing `ProviderRegistry` import on line 10):

```typescript
import { runAddProviderFlow } from "../../providers/addProviderFlow";
```

- [ ] **Step 2: Send the model list on `ready`, and handle the two new inbound message types**

Replace the `onDidReceiveMessage` handler (currently `chatView.ts:37-45`):

```typescript
    view.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === "send") {
        if (msg.agent) void this.onAgent(String(msg.text ?? ""));
        else void this.onSend(String(msg.text ?? ""));
      } else if (msg?.type === "stop") this.inflight?.abort();
      else if (msg?.type === "reset") this.history = [];
      else if (msg?.type === "ready") {
        this.rehydrate();
        void this.sendModels();
      } else if (msg?.type === "selectModel") void this.onSelectModel(String(msg.pointer ?? ""));
      else if (msg?.type === "addProvider") void this.onAddProvider();
    });
```

- [ ] **Step 3: Add the three new private methods**

Add directly after the existing `private rehydrate(): void { ... }` method (currently `chatView.ts:49-55`):

```typescript
  // Push the current cross-provider model list to the webview, e.g. on load
  // or after a selection/add-provider round trip changes what's available.
  private async sendModels(): Promise<void> {
    const items = await this.registry.listAllModels();
    this.post({ type: "models", items });
  }

  private async onSelectModel(pointer: string): Promise<void> {
    if (!pointer) return;
    await vscode.workspace
      .getConfiguration("xpreiIDE")
      .update("activeModel", pointer, vscode.ConfigurationTarget.Global);
    await this.sendModels();
  }

  private async onAddProvider(): Promise<void> {
    await runAddProviderFlow(this.registry);
    await this.sendModels();
  }
```

- [ ] **Step 4: Add the `<select>` to the composer HTML**

In the `html()` method, replace the `.row` div (currently `chatView.ts:191-196`):

```html
    <div class="row">
      <select id="modelSelect" aria-label="Model"></select>
      <button type="submit" id="sendBtn">Send</button>
      <button type="button" id="stopBtn" disabled>Stop</button>
      <button type="button" id="resetBtn">Reset</button>
      <label class="agentToggle"><input type="checkbox" id="agentChk" /> Agent</label>
    </div>
```

- [ ] **Step 5: Typecheck**

```bash
export PATH="/c/nvm4w/nodejs:/c/Users/mbsaj/AppData/Roaming/npm:$PATH"
npm --prefix "D:/Claude/BABBROSIDE/extensions/xpreiIDE-ai" run typecheck
```
Expected: exits 0, no errors.

- [ ] **Step 6: Commit**

```bash
cd "D:/Claude/BABBROSIDE" && git add extensions/xpreiIDE-ai/src/ui/chat/chatView.ts
git commit --author "xpreiIDE <mbsajay1@gmail.com>" -m "$(cat <<'EOF'
feat: wire model picker messages into the chat webview host

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Webview picker UI (`chat.js`, `chat.css`)

**Files:**
- Modify: `extensions/xpreiIDE-ai/media/chat.js`
- Modify: `extensions/xpreiIDE-ai/media/chat.css`

**Interfaces:**
- Consumes: `{type: "models", items: {providerId, providerLabel, model, active}[]}` inbound message (Task 6).
- Produces: `{type: "selectModel", pointer: string}` / `{type: "addProvider"}` outbound messages (consumed by Task 6).

No unit test — this project has no webview test harness (see spec's Testing section); verified via typecheck-equivalent manual smoke test in Task 9. `chat.js` has `// @ts-check` but is plain JS with no build step of its own (loaded directly by the webview), so there's no compile gate beyond visual inspection here.

- [ ] **Step 1: Grab the new element and render incoming model lists**

In `chat.js`, add to the element lookups at the top (after the existing `agentChk` lookup on line 12):

```javascript
  const modelSelect = /** @type {HTMLSelectElement} */ (document.getElementById("modelSelect"));
```

Add a new function, placed after `setBusy` (currently ends at line 30):

```javascript
  function renderModels(items) {
    modelSelect.innerHTML = "";
    const groups = new Map();
    for (const item of items) {
      let group = groups.get(item.providerLabel);
      if (!group) {
        group = document.createElement("optgroup");
        group.label = item.providerLabel;
        groups.set(item.providerLabel, group);
        modelSelect.appendChild(group);
      }
      const opt = document.createElement("option");
      opt.value = item.providerId + "::" + item.model;
      opt.textContent = item.model;
      if (item.active) opt.selected = true;
      group.appendChild(opt);
    }
    const addOpt = document.createElement("option");
    addOpt.value = "__add__";
    addOpt.textContent = "+ Add provider…";
    modelSelect.appendChild(addOpt);
  }

  modelSelect.addEventListener("change", () => {
    if (modelSelect.value === "__add__") {
      vscode.postMessage({ type: "addProvider" });
      return;
    }
    vscode.postMessage({ type: "selectModel", pointer: modelSelect.value });
  });
```

- [ ] **Step 2: Handle the `models` message type**

In the `window.addEventListener("message", ...)` switch (currently `chat.js:61-92`), add a case after `"agent"` (currently lines 88-90):

```javascript
      case "models":
        renderModels(msg.items);
        break;
```

- [ ] **Step 3: Style the select to match the existing composer controls**

In `chat.css`, add after the `.row` rule (currently lines 116-119):

```css
#modelSelect {
  font-family: inherit;
  font-size: inherit;
  color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
  background: var(--vscode-dropdown-background, var(--vscode-input-background));
  border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
  border-radius: 4px;
  padding: 4px 6px;
  max-width: 45%;
}
```

- [ ] **Step 4: Commit**

```bash
cd "D:/Claude/BABBROSIDE" && git add extensions/xpreiIDE-ai/media/chat.js extensions/xpreiIDE-ai/media/chat.css
git commit --author "xpreiIDE <mbsajay1@gmail.com>" -m "$(cat <<'EOF'
feat: render composer-row model picker in the chat webview

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Full verification + manual smoke test

**Files:** none (verification only).

- [ ] **Step 1: Run the full test suite**

```bash
export PATH="/c/nvm4w/nodejs:/c/Users/mbsaj/AppData/Roaming/npm:$PATH"
npm --prefix "D:/Claude/BABBROSIDE/extensions/xpreiIDE-ai" test
```
Expected: all tests pass, including the 4 + 3 new tests from Tasks 1 and 2 (total test count increases from 49 to 56).

- [ ] **Step 2: Run typecheck one more time on the whole extension**

```bash
export PATH="/c/nvm4w/nodejs:/c/Users/mbsaj/AppData/Roaming/npm:$PATH"
npm --prefix "D:/Claude/BABBROSIDE/extensions/xpreiIDE-ai" run typecheck
```
Expected: exits 0, no errors.

- [ ] **Step 3: Compile the bundle**

```bash
export PATH="/c/nvm4w/nodejs:/c/Users/mbsaj/AppData/Roaming/npm:$PATH"
npm --prefix "D:/Claude/BABBROSIDE/extensions/xpreiIDE-ai" run compile
```
Expected: exits 0, `dist/extension.js` rebuilt with no esbuild errors.

- [ ] **Step 4: Manual smoke test in an Extension Development Host**

This step needs a real VS Code window (F5), so do it interactively rather than from the shell tool:
1. Open `D:\Claude\BABBROSIDE\extensions\xpreiIDE-ai` in VS Code, press F5 to launch an Extension Development Host.
2. Open the xpreiIDE chat panel. Confirm the model `<select>` appears in the composer row next to Send/Stop/Reset/Agent, grouped by provider, with `"+ Add provider…"` as the last option. With only the default `ollama-local` provider configured and no Ollama running locally, confirm the dropdown still renders (just the "+ Add provider…" entry) rather than erroring.
3. Pick `"+ Add provider…"` → `Custom…` → confirm it shows the "Settings → xpreiIDE.providers" info message and offers "Open Settings"; clicking it opens `settings.json`.
4. Pick `"+ Add provider…"` → `OpenAI` (or `Google Gemini`) → enter a (dummy is fine for this check) API key → enter a model name like `gpt-4o-mini` → confirm a new option shows up in the dropdown under an "OpenAI" (or "Google Gemini") group, and it's pre-selected if no model was previously active.
5. Switch the dropdown to a different model → confirm `xpreiIDE.activeModel` in Settings (JSON) updates to `providerId::model`.
6. If a local Ollama instance is available (`ollama serve` running with at least one model pulled), confirm its models also appear grouped under "Ollama (local)".

Report the outcome of this manual pass in the task's completion notes — this plan cannot claim "done" without it, per this project's UI-verification convention (CLAUDE.md: "For UI or frontend changes... test the golden path... before reporting the task as complete").

- [ ] **Step 5: Final commit (only if smoke test step required fixups)**

If Step 4 surfaced a bug, fix it, re-run Steps 1-3, then:

```bash
cd "D:/Claude/BABBROSIDE" && git add -A
git commit --author "xpreiIDE <mbsajay1@gmail.com>" -m "$(cat <<'EOF'
fix: address model-picker smoke-test findings

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
If Step 4 found nothing to fix, skip this step — Tasks 1-7 are already committed individually.
