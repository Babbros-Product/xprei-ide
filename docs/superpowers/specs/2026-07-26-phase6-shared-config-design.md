# Phase 6: Shared YAML config format — design

Date: 2026-07-26

## Context

Phase 6 of `docs/feature-roadmap.md`. Replaces three independent
implementations of the same provider/model config concept — VS Code's
`xpreiIDE.providers`/`activeModel`/etc. settings, the JetBrains plugin's
`XpreiSettingsState.kt` (`PersistentStateComponent`), and the Eclipse
plugin's `XpreiSettings.java` (preferences JSON blob) — with one shared
file format, read/written identically across hosts. Sequenced before
Phase 7 because MCP server definitions need a sane config home across all
three hosts too.

**Scope decision (approved):** the IntelliJ and Eclipse plugins are
scaffolded but not compiled/verified in this environment (no local
JDK/Gradle/Maven). Scope is: build the shared schema/parser as a tested
`@xprei/core` module, fully migrate VS Code onto it (typechecked,
compiled, tested), and port the equivalent read/write logic into the
IntelliJ/Eclipse scaffolds — clearly marked **unverified**, matching how
those scaffolds were originally written.

## Decisions

- **Exact scope: 7 settings.** `providers` (array of
  `{ id, kind, label, baseUrl, model? }`), `activeModel`, `embedModel`,
  `completionModel`, `agentModel`, `inlineEditModel`,
  `commitMessageModel`. Confirmed by grepping every
  `getConfiguration("xpreiIDE")` call site in the extension — VS
  Code-only UX toggles (`agent.autoApprove`, `agent.maxSteps`,
  `agent.protocolRetries`, `completions.enabled`) are untouched; they're
  host-specific preferences with no IntelliJ/Eclipse equivalent, not
  provider/model identity, and stay in native `settings.json`.
- **Location: `~/.xpreiide/config.yaml`.** One file in the user's home
  directory (`os.homedir()`-based), outside any single IDE's proprietary
  settings storage — the entire point of "shared." Same resolved path
  across VS Code, IntelliJ, Eclipse, and a future CLI host.
- **Hand-rolled restricted YAML subset, no dependency.** Real YAML
  (anchors, multi-document files, complex escaping, indentation edge
  cases) is a much larger grammar than this project's prior hand-rolled
  parsing (gitignore-glob subset, HTML stripping, regex symbol
  extraction) — but the actual schema needed is simple: a flat 5-field
  object array plus 6 flat string fields today, with Phase 7 needing one
  more level of nesting (`mcpServers: { name: { command, args, env } }`)
  later. Supported: block-style `key: value` mappings, `- ` sequences (of
  scalars or nested mappings), simple quoted/unquoted scalar strings,
  `#` comments. **Not supported:** anchors/aliases, flow collections
  (`[a, b]`, `{a: b}`), multi-document files, complex escape sequences.
  Documented gap, consistent with this project's house style (the
  Eclipse plugin already hand-rolls its own `MiniJson.java` for the same
  reason).
- **No caching, read fresh on every access.** Matches the
  `.xpreiIDErules`/`.xpreiIDEignore` convention already established this
  session — no invalidation logic needed because there's no cache.
- **Clean cutover, no migration code.** `CLAUDE.md` confirms the
  Marketplace publish hasn't happened yet — no real installed users exist
  to migrate. The 7 `contributes.configuration` entries are removed from
  `extensions/vscode/package.json` outright.
- **Unknown-key preservation on write.** The parsed config keeps the full
  raw parsed object alongside its typed fields; serializing merges known
  fields back over that raw object rather than starting from a blank
  object. A write triggered by "add a provider" must not silently delete
  a `mcpServers` section a later phase (or a hand-editing user) added.

## Architecture

### `packages/core/src/config/yamlLite.ts` (new, pure)

```typescript
// Hand-rolled restricted-subset YAML parser/serializer. No dependency,
// no anchors, no flow collections, no multi-document files — see the
// design doc for why. Pure module — no vscode, no file I/O.

export type YamlValue = string | number | boolean | null | YamlValue[] | YamlMap;
export interface YamlMap { [key: string]: YamlValue }

// Parses a block-style mapping document (top-level scalar/sequence
// documents are not supported — every config file this project writes
// is a top-level mapping). Indentation-based recursive descent: lines
// are stripped of comments/trailing whitespace, blank lines dropped,
// each line's leading-space count determines nesting depth relative to
// its parent key.
export function parseYamlLite(content: string): YamlMap

// Canonical 2-space-indent, block-style-only output. Always quotes a
// string scalar that would otherwise be ambiguous (looks like a number,
// boolean, "null", or contains ": "/"#"/leading "- ").
export function stringifyYamlLite(value: YamlMap): string
```

### `packages/core/src/config/schema.ts` (new, pure)

```typescript
import { ProviderConfig } from "../providers/provider";

export interface XpreiConfig {
  providers: ProviderConfig[];
  activeModel: string;
  embedModel: string;
  completionModel: string;
  agentModel: string;
  inlineEditModel: string;
  commitMessageModel: string;
}

export const DEFAULT_CONFIG: XpreiConfig = {
  providers: [
    { id: "ollama-local", kind: "ollama", label: "Ollama (local)", baseUrl: "http://localhost:11434" },
  ],
  activeModel: "",
  embedModel: "",
  completionModel: "",
  agentModel: "",
  inlineEditModel: "",
  commitMessageModel: "",
};

// Parses raw file content into a typed config, defensively: missing or
// malformed fields fall back to DEFAULT_CONFIG's values; each providers[]
// entry missing a required string field (id/kind/label/baseUrl) is
// dropped rather than crashing the whole parse; unrecognized top-level
// keys are preserved internally (not exposed on XpreiConfig) so a
// subsequent serializeConfig() call doesn't drop them.
export function parseConfig(content: string): XpreiConfig

// Merges config's known fields over the raw map parseConfig retained
// (preserving unknown keys like a future mcpServers section), then
// stringifies via stringifyYamlLite.
export function serializeConfig(config: XpreiConfig): string
```

Internally, `parseConfig` needs to retain the raw map for
`serializeConfig` to merge onto. Rather than a hidden module-level cache
(which would break with concurrent parse/serialize of different
content), `parseConfig`/`serializeConfig` take the raw map as an
explicit optional second argument/return pair:

```typescript
export function parseConfig(content: string): { config: XpreiConfig; raw: YamlMap };
export function serializeConfig(config: XpreiConfig, raw: YamlMap): string;
```

Callers (the VS Code config store) thread `raw` through explicitly —
consistent with this codebase's preference for explicit data flow over
hidden state (mirrors how `Checkpoint`/`PendingEditOverlay`-style designs
elsewhere in this project pass state explicitly rather than via module
globals).

### `extensions/vscode/src/config/configStore.ts` (new)

```typescript
// Reads/writes the shared ~/.xpreiide/config.yaml. No caching — every
// call re-reads the file, matching projectRules.ts/ignoreFile.ts.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG, parseConfig, serializeConfig, XpreiConfig, YamlMap } from "@xprei/core";

function configPath(): string {
  return path.join(os.homedir(), ".xpreiide", "config.yaml");
}

export async function loadConfig(): Promise<{ config: XpreiConfig; raw: YamlMap }> {
  try {
    const content = await fs.readFile(configPath(), "utf8");
    return parseConfig(content);
  } catch {
    return { config: DEFAULT_CONFIG, raw: {} };
  }
}

export async function saveConfig(config: XpreiConfig, raw: YamlMap): Promise<void> {
  const p = configPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, serializeConfig(config, raw), "utf8");
}
```

### VS Code call-site migration

Every current `vscode.workspace.getConfiguration("xpreiIDE").get/update`
call for one of the 7 settings is replaced with `loadConfig()`/
`saveConfig()`. This makes several previously-synchronous reads async —
each call site listed below already sits inside an `async` function today
(confirmed by reading each), so this is a mechanical `await` insertion,
not a structural rewrite:

- **`extensions/vscode/src/providers/registry.ts`**: `getConfigs()`
  becomes `async getConfigs(): Promise<ProviderConfig[]>`; `addConfig()`/
  `removeConfig()` load, mutate, save; `resolvePointer()` loads once and
  reads both the requested setting and (recursively) the fallback from
  the same loaded config, instead of two separate
  `getConfiguration().get()` calls.
- **`extensions/vscode/src/extension.ts`**'s `selectModel()`: the
  `raw`/final `update()` calls become `loadConfig()`/`saveConfig()`
  round-trips.
- **`extensions/vscode/src/ui/chat/chatView.ts`**'s `onSelectModel()`:
  same pattern.
- **`extensions/vscode/src/providers/addProviderFlow.ts`**: provider save
  goes through `ProviderRegistry.addConfig()` (already migrated above) —
  no direct settings access to change if it only calls through the
  registry; confirmed at implementation time, adjusted directly if it
  turns out to touch settings independently.
- **`extensions/vscode/src/providers/autoDiscover.ts`**: reads current
  `providers`/`activeModel` and writes discovered Ollama models the same
  way — migrated to `loadConfig()`/`saveConfig()`.

`extensions/vscode/package.json`: remove the 7 corresponding
`contributes.configuration` entries (`xpreiIDE.providers`,
`xpreiIDE.activeModel`, `xpreiIDE.embedModel`, `xpreiIDE.completionModel`,
`xpreiIDE.agentModel`, `xpreiIDE.inlineEditModel`,
`xpreiIDE.commitMessageModel`). The remaining UX-toggle settings
(`xpreiIDE.agent.*`, `xpreiIDE.completions.enabled`) are untouched.

### IntelliJ/Eclipse (unverified)

`extensions/intellij/src/main/kotlin/online/xprei/ide/XpreiSettingsState.kt`
and
`extensions/eclipse/online.xprei.ide.eclipse/src/online/xprei/ide/eclipse/XpreiSettings.java`
gain read/write logic for the same `~/.xpreiide/config.yaml`, using a
minimal same-grammar YAML-lite reader/writer ported into each language —
mirroring how the Eclipse plugin already hand-rolls `MiniJson.java` for
its own preferences blob. Both existing classes' public method surface
(`getConfigs`/`addOrUpdate`/`remove`/`getActiveModel`/`setActiveModel`,
etc.) stays the same shape so nothing else in either scaffold needs to
change — only the backing storage swaps from
`PersistentStateComponent`/`IEclipsePreferences` to shared-file
read/write. Clearly commented as **unverified — no local JDK/Gradle/Maven
available to compile or test against**, matching how both scaffolds were
originally written.

## Out of scope

- Migration of any pre-existing VS Code settings values — no Marketplace
  users exist yet.
- MCP server config (`mcpServers`) — Phase 7's concern; this phase only
  guarantees Phase 7 won't clobber it later, via the raw-map preservation
  above.
- Any change to VS Code's UX-only settings (`agent.autoApprove`,
  `agent.maxSteps`, `agent.protocolRetries`, `completions.enabled`).
- Compiling or running the IntelliJ/Eclipse plugins — environment
  limitation, unchanged by this phase.
- File-watcher-driven live reload if the user hand-edits
  `~/.xpreiide/config.yaml` while an IDE is open — next read picks up the
  change (no caching), but there's no push notification; acceptable given
  this mirrors the existing `.xpreiIDErules` behavior.

## Testing

- `yamlLite.test.ts` (new, pure): flat mapping, nested mapping, block
  sequence of scalars, block sequence of mappings, comments (including a
  `#` inside a quoted string, which must NOT be treated as a comment
  start), quoted vs. unquoted scalars, a round-trip test
  (`parseYamlLite(stringifyYamlLite(x))` recovers an equivalent value for
  every fixture used elsewhere in this test file).
- `schema.test.ts` (new, pure): `parseConfig` on empty content returns
  `DEFAULT_CONFIG`; malformed `providers` (not an array, or entries
  missing required fields) falls back gracefully per-entry; the
  raw-map-preservation round-trip (parse content with an unknown
  top-level key, mutate `config.activeModel`, serialize, confirm the
  unknown key survived in the output).
- VS Code layer (`configStore.ts`, migrated `registry.ts`/`extension.ts`/
  `chatView.ts`/`autoDiscover.ts`): no new unit tests (VS Code API-bound,
  same convention as every other extension-layer file) — verified by
  `npm run typecheck -w xpreiIDE-ai` + `npm run compile -w xpreiIDE-ai`,
  plus a manual smoke test: delete `~/.xpreiide/config.yaml`, launch the
  Extension Development Host, confirm a default Ollama-local provider
  appears; add a second provider via the existing flow, confirm the file
  now lists both; set a per-role model override, confirm it round-trips
  after reloading the window; hand-add an unrelated top-level key to the
  file, change a provider via the UI, confirm the hand-added key survives.
- IntelliJ/Eclipse: no automated verification possible in this
  environment — code is written to mirror the TypeScript grammar exactly,
  reviewed by inspection, and explicitly flagged as unverified in-code
  and in the task's commit message.

## User-facing docs

`extensions/vscode/README.md` and root `README.md` currently don't
document exact settings-storage mechanics in a way that needs updating
for this change (provider setup is described at the flow/UI level, not
"stored in VS Code settings.json") — confirmed at documentation-task
time; if either file does mention `xpreiIDE.providers`/settings.json by
name, that reference is updated to describe `~/.xpreiide/config.yaml`
instead.
