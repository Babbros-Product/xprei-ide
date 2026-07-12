# Model picker + provider presets — design

Date: 2026-07-12

## Problem

Chat panel has no visible model switcher — active model is set only via
the `xpreiIDE: Select Model` command palette entry. Configuring a new
provider (e.g. OpenAI, Gemini) requires hand-editing the `xpreiIDE.providers`
JSON array in settings. Users expect a Copilot-Chat/Claude-Code-style
dropdown in the chat composer that lists every configured model across
every provider (Ollama local, OpenAI, Gemini, any OpenAI-compatible
endpoint), plus a quick way to add a new provider without hand-writing JSON.

Editing behavior itself (chat instructing the IDE to modify code) is
already covered by the existing Agent tool loop (`src/agent/`) — confirmed
as the right mechanism; this spec does not change agent internals.

## Scope

In scope:
1. `ProviderRegistry.listAllModels()` — aggregate available models across
   all configured providers.
2. Composer-row model `<select>` in the chat webview, wired to the above.
3. `xpreiIDE.addProvider` command + `presets.ts` (OpenAI, Gemini, Ollama
   local, Custom) for one-click provider setup, reachable both from the
   command palette and from a `"+ Add provider…"` entry in the picker.

Out of scope:
- Native Gemini adapter (existing `OpenAICompatProvider` reused via
  Gemini's OpenAI-compat endpoint).
- Anthropic/Claude preset.
- Any change to plain-chat edit behavior or the Agent tool loop.

## Architecture

### `registry.listAllModels()`

New method on `ProviderRegistry` (`src/providers/registry.ts`):

```ts
export interface ModelEntry {
  providerId: string;
  providerLabel: string;
  model: string;
  active: boolean;
}

async listAllModels(): Promise<ModelEntry[]>
```

For each `ProviderConfig` from `getConfigs()`:
- Build the provider via existing `build(cfg)`.
- Try `provider.listModels()`. On success, map each returned model name to
  an entry.
- On failure (network error, provider unreachable), fall back to
  `[cfg.model]` if `cfg.model` is set; otherwise skip this provider
  entirely (it contributes no entries — not an error to the caller).
- Mark `active: true` on the entry whose `providerId::model` pointer
  matches the current `xpreiIDE.activeModel` setting.

Failures from one provider must not block others — each provider's
`listModels()` call is wrapped in its own try/catch.

### Composer-row picker

`src/ui/chat/chatView.ts`:
- On webview `ready` message, in addition to existing rehydration, call
  `registry.listAllModels()` and post
  `{type: 'models', items: ModelEntry[]}`.
- Handle new inbound message `{type: 'selectModel', pointer: string}`:
  write it via
  `vscode.workspace.getConfiguration('xpreiIDE').update('activeModel', pointer, vscode.ConfigurationTarget.Global)`.
- Handle new inbound message `{type: 'addProvider'}`: invoke the same flow
  as the `xpreiIDE.addProvider` command (extract to a shared function so
  both the command and this message handler call it), then re-post a
  refreshed `models` list.

`media/chat.js` / `media/chat.css`:
- Add a `<select id="modelSelect">` into the existing composer `.row`
  (next to Send/Stop/Agent).
- Populate on `{type:'models'}`: `<optgroup>` per `providerLabel`,
  `<option value="providerId::model">`. Select the entry marked `active`.
  Always append a final `<option value="__add__">+ Add provider…</option>`.
- `onchange`: if value is `__add__`, post `{type:'addProvider'}` and reset
  selection to the previous value (don't leave `__add__` selected); else
  post `{type:'selectModel', pointer: value}`.

### Provider presets + quick-add

New `src/providers/presets.ts` (pure module, no `vscode` import — unit
testable):

```ts
export interface ProviderPreset {
  id: string;        // stable slug, e.g. "openai", "gemini"
  kind: "openai-compat";
  label: string;
  baseUrl: string;
}

export const PRESETS: ProviderPreset[] = [
  { id: "openai", kind: "openai-compat", label: "OpenAI",
    baseUrl: "https://api.openai.com/v1" },
  { id: "gemini", kind: "openai-compat", label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
];

// Appends a numeric suffix if id already exists in existingIds.
export function uniqueProviderId(base: string, existingIds: string[]): string
```

New command `xpreiIDE.addProvider` (registered in `extension.ts`,
implemented alongside the existing `setApiKey`/`selectModel` command
handlers):
1. `QuickPick`: `OpenAI`, `Google Gemini`, `Ollama (local)`, `Custom…`
   (reuses `PRESETS` plus a synthetic Ollama-local entry and a Custom path
   that falls back to today's manual-JSON guidance).
2. For non-Ollama presets: `InputBox` for API key (password-masked) →
   `registry.setApiKey(id, key)`.
3. `InputBox` for default model name (free text, e.g. `gpt-4o-mini`,
   `gemini-2.0-flash`, `llama3`), optional — becomes `cfg.model`.
4. Compute `id` via `uniqueProviderId(preset.id, existing configs' ids)`,
   append the new `ProviderConfig` to `xpreiIDE.providers`
   (`ConfigurationTarget.Global`).
5. If `xpreiIDE.activeModel` is currently unset, set it to
   `providerId::model` for the newly added provider (formatted via
   `ProviderRegistry.formatActive`).

The chat-panel `"+ Add provider…"` picker entry triggers the same
underlying function, not a duplicate implementation.

## Error handling

- `listAllModels()` never throws — provider-level failures degrade to
  "fewer entries," not a broken picker.
- If `listAllModels()` returns zero entries (e.g. Ollama not running, no
  providers configured), the `<select>` still renders with just
  `"+ Add provider…"` so there's always a path forward.
- `addProvider` flow: cancelling any QuickPick/InputBox step aborts the
  whole flow with no partial state written (no config entry, no stored
  key).

## Testing

- `src/providers/registry.test.ts` (new): `listAllModels()` with a mix of
  fake providers (one healthy, one whose `listModels()` rejects with no
  `cfg.model` fallback, one whose `listModels()` rejects with a
  `cfg.model` fallback) — asserts the aggregated list and the `active`
  flag against a given `activeModel` pointer. Uses the existing
  `_testutil.ts` fake-provider pattern.
- `src/providers/presets.test.ts` (new): `uniqueProviderId()` collision
  behavior (base id free, base id taken once, taken twice).
- Add both new test files to the `test` script list in `package.json`.
- No webview test harness exists in this project; `chat.js` picker
  behavior is verified manually (matches existing project convention for
  webview-side code).

## Non-goals / deferred

- No native Gemini adapter — relies on Google's OpenAI-compat endpoint
  staying available (documented as a known dependency, not hidden).
- No Anthropic/Claude preset.
- No per-model capability detection in the picker (all entries shown
  regardless of tool-calling support); existing static
  `ProviderCapabilities` gating elsewhere is unaffected.
