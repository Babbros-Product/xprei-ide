# Phase 2a: local model auto-discovery — design

Date: 2026-07-25

## Context

First sub-project from `docs/feature-roadmap.md`'s Phase 2 ("Local-first
core UX"), split out from Phase 2b (per-role models, shipped) because the
two touch different code with no shared implementation — this project only
touches onboarding logic in `extensions/vscode/src/extension.ts`'s
`activate()` and adds one new small module; Phase 2b touched
`registry.ts`/settings/call sites instead.

**Problem:** on first activation, a user with a local Ollama daemon already
running and models already pulled still has to manually run **xpreiIDE:
Add Provider** → pick "Ollama (local)" → type a model name by hand (the
existing flow never calls `listModels()` to fetch/validate it — see
`addProviderFlow.ts:67-71`). There is no proactive detection anywhere in
`extension.ts`'s `activate()` today.

## Current state (verified in code)

- `OllamaProvider.listModels(signal?: AbortSignal): Promise<string[]>`
  (`packages/core/src/providers/ollama.ts:41-52`) already exists and is
  exactly the discovery primitive needed — hits `GET /api/tags` against
  the provider's configured `baseUrl`, throws a friendly `ProviderError`
  ("Cannot reach Ollama... is 'ollama serve' running?") on network failure.
- `extensions/vscode/package.json`'s `xpreiIDE.providers` setting default
  already ships one `ollama-local` entry
  (`{id: "ollama-local", kind: "ollama", label: "Ollama (local)", baseUrl: "http://localhost:11434"}`)
  even before any Add Provider flow runs — but `xpreiIDE.activeModel` is
  **not** pre-seeded, so nothing auto-activates it.
- `addProviderFlow.ts:28-34` hardcodes the same Ollama entry as one
  QuickPick choice among presets; picking it still free-texts a model name
  (`addProviderFlow.ts:67-71`) with no live model list.
- `extension.ts`'s `activate()` has no first-activation/onboarding check of
  any kind — `selectModel()`'s only reactive warning
  ("No providers configured...") fires solely when a command is explicitly
  invoked, never proactively.
- `ProviderRegistry.getConfigs()` (`registry.ts:29-33`) reads
  `xpreiIDE.providers` from settings — the seam this project uses to find
  the existing default Ollama config, rather than re-adding it.

## Decisions

- **Silent probe, prompt only if something is found.** Runs once per
  activation, only when `xpreiIDE.activeModel` is empty. No toast, no
  output-channel noise, nothing at all if Ollama isn't reachable — a
  machine with no Ollama installed sees zero behavior change.
- **Reuse the existing config; never upsert.** Looks for an existing
  `kind: "ollama"` config pointing at `http://localhost:11434` in
  `getConfigs()`. If found, only `activeModel` gets written — `providers`
  is untouched. If not found (user deleted/renamed the default entry),
  discovery skips silently; it does not recreate the config. This keeps
  the feature simple for the overwhelmingly common case (default config
  present, per the package.json default) without adding upsert logic for a
  rare, self-inflicted edge case.
- **Auto-pick if there's exactly one model, otherwise show a picker.**
  Different from `selectModel()`'s existing manual-selection UX (which
  always shows a QuickPick regardless of count) — deliberately, since
  discovery's whole point is reducing friction for the common single-model
  case. This means discovery gets its own small model-pick helper rather
  than reusing `selectModel()`'s QuickPick step verbatim.
- **Re-probe every activation until resolved**, not just once ever. No
  `globalState` "dismissed" flag — matches the trigger condition exactly
  (only fires while `activeModel` is empty); a user who wants Ollama
  eventually clicks through, one who doesn't just ignores a passive toast
  each session.
- **Reachable-but-zero-models gets its own informational toast**, distinct
  from the "N models found, use it?" confirmation — telling the user to
  `ollama pull` something, with no action buttons (nothing to activate).

## Architecture

New file, `extensions/vscode/src/providers/autoDiscover.ts`, exporting one
function:

```typescript
export async function tryAutoDiscoverOllama(registry: ProviderRegistry): Promise<void>
```

Called fire-and-forget from `activate()`, right after the existing
`void engine.load();` line (`extension.ts:160`):

```typescript
void tryAutoDiscoverOllama(registry);
```

### `tryAutoDiscoverOllama` flow

1. Read `xpreiIDE.activeModel` directly via
   `vscode.workspace.getConfiguration("xpreiIDE").get<string>("activeModel", "")`.
   Non-empty → return immediately, no probe.
2. Find a matching config:
   `registry.getConfigs().find(c => c.kind === "ollama" && c.baseUrl.replace(/\/$/, "") === "http://localhost:11434")`.
   Not found → return immediately, no probe (per the "never upsert"
   decision).
3. Build the provider (`registry.build(cfg)`) and call `listModels()` with
   a 1.5-second timeout via `AbortController`:
   ```typescript
   const controller = new AbortController();
   const timer = setTimeout(() => controller.abort(), 1500);
   try {
     models = await provider.listModels(controller.signal);
   } catch {
     return; // unreachable, timed out, or any other failure — stay silent
   } finally {
     clearTimeout(timer);
   }
   ```
4. `models.length === 0` → one informational toast, no buttons:
   `"Ollama is running but has no models installed yet. Try 'ollama pull llama3.1', then reload the window."`
   Return.
5. `models.length === 1` → write `activeModel` directly via
   `ProviderRegistry.formatActive(cfg.id, models[0])`
   (`ConfigurationTarget.Global`), then show:
   `"xpreiIDE: using Ollama's <model>. Change anytime with 'xpreiIDE: Select Model'."`
6. `models.length > 1` → show
   `"Ollama detected with <N> models — use it for chat?"` with a single
   **"Use Ollama"** action button (dismissing/ignoring the toast does
   nothing further, matching "re-probe every activation"). On accept, show
   a `vscode.window.showQuickPick(models, {placeHolder: "Select a chat model"})`;
   on pick, write `activeModel` the same way step 5 does and show the same
   style of confirmation toast.

No changes to `addProviderFlow.ts` or `registry.ts` — this project is
additive only.

## Out of scope

- Auto-discovering any provider other than Ollama at `localhost:11434` —
  matches the roadmap's exact scope ("detect a running Ollama daemon").
- Re-adding/upserting the `ollama-local` config if it's missing.
- A `globalState` "don't ask again" flag.
- Any change to `@xprei/core`, `registry.ts`, or `addProviderFlow.ts`.
- Per-role model auto-discovery (Phase 2b already shipped manual per-role
  selection; this project only ever writes `activeModel`, matching the
  existing "first provider auto-activates chat" precedent in
  `addProviderFlow.ts:88-95`).

## Testing

`autoDiscover.ts` lives in `extensions/vscode` — no unit tests by existing
convention (`CLAUDE.md`: "The extension itself has no unit tests").
Verified by:
- `npm run typecheck -w xpreiIDE-ai` (must pass).
- `npm run compile -w xpreiIDE-ai` (must pass).
- Manual smoke test in the Extension Development Host, four scenarios:
  (a) Ollama running with ≥2 models pulled, `activeModel` unset — confirm
  the "N models detected" toast, confirm the QuickPick and activation both
  work; (b) Ollama running with exactly 1 model pulled — confirm direct
  auto-activation and its confirmation toast, no QuickPick shown;
  (c) Ollama running with 0 models pulled — confirm the "pull a model"
  toast with no action buttons; (d) Ollama not running at all — confirm
  total silence (no toast, no output-channel entry); (e) `activeModel`
  already set — confirm no network call happens at all (temporarily add a
  `console.log`/output-channel line during manual testing to verify the
  early return, remove it before committing).
