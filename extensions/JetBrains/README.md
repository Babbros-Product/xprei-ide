# xpreiIDE — JetBrains plugin

## ✅ Status: verified live in a sandbox IDE (2026-07-26)

This plugin was originally scaffolded on a machine with no JDK/Gradle
installed and was unverified. It has since been built for real (JDK 21,
Gradle 9.6.1) AND run for real in a sandbox IDE (`gradle runIde`): the
xpreiIDE tool window opens, a local Ollama provider was configured
through the **⚙** panel, plain chat streamed a real response, and an
Agent-mode task ran end-to-end — approval card with a diff, file
actually written, VFS-refreshed in the editor. Two real bugs were found
during that live pass and fixed (see "Bugs found by the first live
sandbox run" below), on top of the two compile-time bugs from the first
real build (see below that). Still unverified: revert-last-run (no
command wired up yet — known MVP gap, not a bug) and the PasswordSafe
secrets path (the tested provider needed no API key).

### What to do first

```bash
# from extensions/JetBrains, with a JDK 17+ and Gradle on PATH:
gradle build                            # compiles Kotlin, packages the plugin
gradle buildPlugin                      # produces build/distributions/xpreiIDE-intellij-*.zip
gradle runIde                           # launches a sandbox IDE with the plugin loaded — verified working
```

A Gradle wrapper isn't committed (see below) — either generate one
(`gradle wrapper --gradle-version 8.10`) or use a system Gradle install
directly, as above.

### Bugs found by the first live sandbox run (fixed)

1. **Chat/agent hung forever with no error on a bad model pointer.**
   `XpreiHostBridge.sendRequest("chat.send"/"agent.run", ...)` passed no
   result callback, so a sidecar-side rejection (`resolveModel` failing —
   e.g. a stale `activeModel` pointer left over in the shared
   `~/.xpreiide/config.yaml`) arrived as an RPC error response tied to the
   request id and was silently dropped: only the async notification events
   (`chat.done`/`chat.error`/`agent.final`/`agent.error`) ever cleared
   `inflightRequestId`, so the composer stayed busy forever. Fixed by
   handling the `{error}` response on both calls, resetting
   `inflightRequestId` and surfacing a real error message. The Eclipse
   plugin had the identical bug (same pattern, fixed the same way).
2. **Header showed "New chat"/"Chat history" icons with no real function
   behind them** — this plugin runs a single in-memory chat session (see
   "Deliberate MVP simplifications" below), so those two buttons implied
   functionality that isn't there yet. Hidden on this host only (shared
   `webview/index.html`, via a `.singleSessionHide` CSS class) — VS Code's
   separately-generated header is unaffected and keeps full session history.

### Bugs found by the first real build (fixed)

1. **`instrumentationTools()` — unresolved reference.** This method, part of
   the `dependencies { intellijPlatform { ... } }` DSL in earlier IntelliJ
   Platform Gradle Plugin 2.x releases, no longer exists in 2.18.1 (the
   pinned version) — removed from `build.gradle.kts`; instrumentation is
   handled automatically now.
2. **`buildSidecar`'s `Exec` task failed to invoke `npm` on Windows** — `npm`
   resolves to `npm.cmd`, which Gradle's `Exec`/`ProcessBuilder` can't run
   directly (it doesn't consult `PATHEXT`). Fixed by shelling through
   `cmd /c` on Windows, direct invocation elsewhere (`build.gradle.kts`
   detects `os.name`).

### Remaining risk (not yet exercised)

1. **PasswordSafe secrets round-trip.** The live-tested provider (local
   Ollama) needs no API key, so `XpreiSecrets`' `PasswordSafe.instance`
   accessor has never actually stored/retrieved a real secret. Test by
   adding an OpenAI-compatible provider with a key.
2. **Revert-last-run.** The sidecar's `agent.revert` RPC exists and is
   tested at the `packages/core` level; this plugin has no menu action
   wired to it yet (known MVP gap, see "Deliberate MVP simplifications").

### Why no Gradle wrapper is checked in

The wrapper needs a real `gradle-wrapper.jar` binary, normally produced by
running `gradle wrapper` against a real Gradle install. Committing a
hand-typed or fabricated jar would be worse than not having one — it would
look legitimate and fail in some more confusing way. Run `gradle wrapper`
yourself once (any system Gradle 8.x works) and it'll generate a real one.

## Architecture

One Kotlin ToolWindow (`XpreiToolWindowFactory` → `XpreiChatPanel`) hosts the
**same webview** (`webview/index.html` + `chat.js`/`chat.css`/`bridge.js`) the
VS Code extension and the Eclipse plugin use, inside a `JBCefBrowser`.
`XpreiHostBridge` is the translation layer between two protocols:

- **Webview ↔ host**: the exact message shapes
  `extensions/vscode/src/ui/chat/chatView.ts` speaks (`{type:"send",...}`,
  `{type:"agent",kind:"..."}`, etc.) — verified against that file's actual
  source this session, not reconstructed from memory.
- **Host ↔ sidecar**: the JSON-RPC protocol in `packages/core/src/server/
  session.ts` (`chat.send`, `agent.run`, `models.list`, ...) — the same
  protocol `packages/core/src/server/harness.test.ts` and
  `sidecarBundle.test.ts` verify end-to-end with a real spawned process.

The sidecar itself (`packages/core`'s esbuild-bundled `dist/sidecar.cjs`) is
bundled into plugin resources by `build.gradle.kts` and extracted to a temp
file at runtime (`WebviewResources.extractSidecar()`), then spawned with
`node <path>` (`SidecarProcess.kt`). **Requires Node.js ≥ 18 on the end
user's PATH** — same MVP prerequisite documented in the root README;
bundling a Node runtime per-plugin is a later fast-follow.

## Deliberate MVP simplifications (see also `XpreiHostBridge`'s header comment)

- **Single in-memory chat session.** No cross-restart persistence, no real
  multi-session history — `newChat`/`switchSession` are minimal/no-op. VS
  Code persists named sessions to `workspaceState`; this plugin doesn't yet.
- **`insertAtCursor`/`applyEdit`** (the chat code-block "Insert"/"Apply"
  buttons) are no-ops — logged, not implemented. Out of MVP scope already
  (inline-edit/editor-mutation features are explicitly fast-follow per
  `docs/multi-ide-plan.md`).
- **No revert-last-run command wired up yet.** The sidecar's `agent.revert`
  RPC exists and is tested; this plugin doesn't expose a menu action for it.
- **Agent file edits → a VFS refresh, not a native diff/decoration.** Unlike
  VS Code's gutter-flash, `chat.js` has no message case for "a file changed" —
  that's purely a VS Code `TextEditorDecoration` visual, not part of the
  shared webview protocol. On `agent.edit`, this plugin just refreshes the
  written file in the VFS so an open editor doesn't show stale content or a
  "changed on disk" conflict banner.
- **No `@codebase` RAG surfacing, inline-edit diff, ghost-text completions, or
  commit-message generation.** All already scoped as fast-follows in the plan
  doc, not attempted here.

## Config storage: shared ~/.xpreiide/config.yaml

`XpreiSettingsState`'s provider/active-model data no longer lives in
IntelliJ's own `PersistentStateComponent` XML storage — it reads/writes
`~/.xpreiide/config.yaml` directly, the same file the VS Code extension
and the Eclipse plugin use (see
`docs/superpowers/specs/2026-07-26-phase6-shared-config-design.md`).
`XpreiYamlLite` (in `XpreiSettingsState.kt`) is a hand-ported copy of
`packages/core/src/config/yamlLite.ts`'s parser/serializer. Compiles and
has been exercised live: reading the shared config file's `providers` and
`activeModel` in a real sandbox worked as part of the verified chat/agent
test pass above.

## Assumptions made when this was first written, now confirmed by compile + live run

Listed for history — all of these compiled cleanly AND were exercised in
the live sandbox test pass above, except where noted:

- `PasswordSafe.instance` (not `PasswordSafe.getInstance()`) — compiles;
  **not runtime-exercised** (see "Remaining risk" above, no API-key
  provider tested yet).
- `Content.setDisposer(Disposable)` on `com.intellij.ui.content.Content` —
  ties the chat panel's (and its child sidecar process's) disposal to the
  tool window content's lifecycle. Compiles; disposal itself wasn't
  specifically exercised (the sandbox was closed via Exit, not repeatedly
  opened/closed within one session).
- `JBCefJSQuery.create(browser as JBCefBrowserBase)` and the
  `cefBrowser.executeJavaScript("...${jsQuery.inject("json")}...")` pattern
  for injecting a JS-callable bridge function — **confirmed working live**:
  this is the exact round-trip that carries every chat/agent message.
- Gradle IntelliJ Platform Plugin **2.18.1**, `intellijIdeaCommunity("2024.3")`,
  `sinceBuild = "233"` — confirmed working (builds and runs).
- `sourceSets.main.resources.srcDir(...)` pointing outside the module
  directory (at `../../webview` and `../../packages/core/dist`) to reuse
  those directories directly, mirroring the VS Code extension's
  `scripts/sync-webview.mjs` copy step but via Gradle instead of Node.

## What IS verifiable already (do this before touching Kotlin further)

```bash
# from the repo root:
npm test -w @xprei/core                    # 301 tests, includes the sidecar
                                             # protocol this plugin depends on
npm run build:sidecar -w @xprei/core        # produces dist/sidecar.cjs directly,
                                             # isolates that step from Gradle
```

If either of those fails, fix it in `packages/core` first — this plugin can't
be more correct than the sidecar it drives.
