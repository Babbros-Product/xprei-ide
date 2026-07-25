# Multi-IDE expansion plan — xpreiIDE

Date: 2026-07-25
Company: **Babbros** · Product site: **xprei.online** · Support: **support@xprei.com**

## Context

xpreiIDE today is a single VS Code extension (TypeScript, `extensions/xpreiIDE-ai/`):
a bring-your-own-model AI assistant — streaming chat, @codebase RAG, Cmd-K inline
edit, an agentic multi-file loop, ghost-text completions, and commit-message
generation, all driven by user-supplied models (local Ollama or any
OpenAI-compatible endpoint).

We want the same product inside **JetBrains IDEs** (IntelliJ IDEA, PyCharm,
WebStorm, GoLand, … — all covered by one IntelliJ-Platform plugin) and
**Eclipse**. A VS Code extension cannot be ported to those platforms directly:
their plugins are JVM (Kotlin/Java) on entirely different SDKs. But the codebase
already separates cleanly into a **pure, headless core** and a **thin VS Code
platform layer**, which makes a shared-core strategy far cheaper than three
native rewrites.

### The decisive fact (from a codebase audit)

- **16 pure modules** import no `vscode` and form a coherent, self-contained core:
  all model adapters + the provider contract (`providers/provider.ts`,
  `ollama.ts`, `openai-compat.ts`, `presets.ts`, `modelList.ts`), the whole RAG
  substrate (`context/chunking.ts`, `vectorstore.ts`, `retrieval.ts`,
  `mentions.ts`, `exclude.ts`), the inline-edit prompt builder (`edit/prompt.ts`),
  and the **entire agent brain** (`agent/protocol.ts`, `tools.ts`, `checkpoint.ts`,
  `orchestrator.ts`, `pathResolve.ts`). It already runs headless in tests via
  `_fakehost.ts` fakes.
- **12 coupled modules** are the VS Code platform layer (webview host, editor
  decorations, config/secret/index persistence, completions, commit-msg).
- The chat UI (`media/chat.js` / `chat.css` + the HTML template) is a
  self-contained web app that talks to its host over a single `postMessage`
  channel — reusable inside any embedded browser.

## Decisions (locked)

- **Architecture:** one shared **Node "xprei-core" sidecar** (JSON-RPC over
  stdio) reused by all IDEs; each IDE ships a **thin native plugin** that hosts
  the existing chat webview in an embedded browser and bridges editor/secret/
  config concerns. Not a 3× native rewrite.
- **Targets (phase 1):** JetBrains **and** Eclipse, together.
- **Parity (first release):** **MVP** — streaming chat, BYO-model management, and
  the agent multi-file loop with approvals + revert. Inline-edit diff, @codebase
  RAG surfacing, ghost-text completions, and commit-message gen are fast-follows.
- **Deliverables now:** this plan + a branded multi-IDE README draft. No plugin
  code yet.

### Why the sidecar is Node (the effort-saver)

Because the sidecar is Node, it owns **all filesystem / exec / grep / RAG-index**
work directly against the workspace path the plugin hands it. The JVM plugins
therefore do **not** reimplement the agent file tools, the RAG pipeline, or the
orchestrator. A plugin's whole job is: (1) host the webview, (2) supply workspace
root + active-file/selection context, (3) apply edits the user accepts into the
editor, (4) store secrets in the IDE's secure store, (5) persist config.

## Target repo layout (monorepo)

Current state (Phases 0-1 done and verified; Phase 2 scaffolded, unverified):

```
xprei-ide/                      # repo root (was BABBROSIDE)
  package.json                  # npm workspaces: packages/*, extensions/*
  packages/
    core/                       # @xprei/core — the 16 pure modules, no vscode
      src/providers|context|edit|agent/…   # moved from extensions/xpreiIDE-ai/src
      src/host/nodeHost.ts      # Node AgentHost (fs/exec/exclusion-aware grep)
      src/server/session.ts     # transport-agnostic JSON-RPC session
      src/server/stdio.ts       # line-delimited-JSON sidecar entrypoint (dev)
      src/server/sidecarBundle.test.ts  # builds + proves the distributable .cjs
      # dist/sidecar.cjs (gitignored) — `npm run build:sidecar`, what plugins ship
  extensions/
    xpreiIDE-ai/                # VS Code extension → consumes @xprei/core
      media/                    # GENERATED copy of webview/, gitignored
      scripts/sync-webview.mjs  # copies webview/ -> media/ pre-compile
  webview/                      # shared chat UI, host-agnostic — chat.js/css,
                                 # bridge.js (transport shim), index.html,
                                 # theme-fallback.css, icons
  plugins/
    intellij/                   # Kotlin/Gradle — scaffolded, NOT yet compiled
                                 # (no local JDK/Gradle to verify against — see
                                 # plugins/intellij/README.md)
    eclipse/                    # Java, PDE/OSGi plugin — not started (Phase 3)
  docs/
```

## The sidecar protocol (JSON-RPC over stdio)

One long-lived process per IDE window. Requests / streaming notifications:

- `initialize({ workspaceRoot, config })` → capabilities
- `models.list({ providerId })` → string[]
- `chat.send({ sessionId, messages, mode, mentions })` → streams `chat.delta`
  notifications, ends with `chat.done`
- `chat.stop({ sessionId })`
- `agent.run({ task, mode })` → streams `agent.step|thought|tool|observation|final`
  and `agent.edit` notifications; emits `agent.approvalRequest` and awaits
  `agent.approve({ id, choice })`
- `agent.revert()` (uses the existing `Checkpoint`)
- `rag.rebuild()` / `context.build({ mentions })` / `embed({ texts, model })`
- Secrets are **never persisted by the sidecar**: the plugin passes the decrypted
  API key for a provider at `initialize` (or on demand); the sidecar holds it in
  memory only.

The existing `agent/orchestrator.ts` `Approver` + event interfaces map directly
onto these notifications — no redesign of the agent loop.

## Shared webview transport shim — ✅ built (Phase 1)

`webview/bridge.js`: `window.xprei = { postMessage(msg), onMessage(cb) }`.

- **VS Code:** `acquireVsCodeApi()` (unchanged behavior).
- **JetBrains (JCEF) and Eclipse (SWT) share one native contract**, not two
  bespoke ones: a plugin injects `window.xpreiHostBridge.postMessage(jsonString)`
  (via `JBCefJSQuery.inject()` for JetBrains, a registered `BrowserFunction` for
  Eclipse) and pushes inbound messages by calling a global
  `window.__xpreiReceive(jsonStringOrObject)` from native code.

Everything else in the webview (rendering, model picker, approvals) is untouched.

## Phased implementation

### Phase 0 — Extract & validate the core (de-risks everything) — ✅ done
- `packages/core` created; the 16 pure modules moved in unchanged, exported via
  `src/index.ts`. npm-workspaces monorepo (root `package.json`).
- `extensions/xpreiIDE-ai` refactored to import from `@xprei/core`. **Success
  gate met:** tsc clean, esbuild bundle unchanged in size, `vsce package
  --no-dependencies` produces a clean vsix, reinstalled and smoke-tested.
- `src/host/nodeHost.ts` (Node `AgentHost`: fs/exec/exclusion-aware grep) added,
  with its own tests run against a real temp dir.
- `src/server/session.ts` (transport-agnostic JSON-RPC session: chat streaming +
  the full agent loop with approval round-trips) + `src/server/stdio.ts` (the
  line-delimited-JSON entrypoint) added.
- **82 tests** in `@xprei/core` by the end of this phase (71 moved + 7 NodeHost
  + 4 session).

### Phase 1 — Shared webview + sidecar as a standalone product — ✅ done
- `media/chat.*` moved to root-level `webview/` (host-agnostic source of truth).
  The VS Code extension's `media/` is now a **generated copy**, synced from
  `webview/` by `extensions/xpreiIDE-ai/scripts/sync-webview.mjs` as a
  `compile`-script pre-step (gitignored) — vsce refuses to package files it
  reaches via a path outside the extension root, so a physical copy is
  required, not a symlink.
- `webview/bridge.js` — the transport shim. Contract: `window.xprei =
  { postMessage(msg), onMessage(cb) }`. VS Code uses `acquireVsCodeApi()`
  unchanged; JetBrains and Eclipse share ONE native contract instead of two
  bespoke ones — a plugin injects `window.xpreiHostBridge.postMessage(json)`
  and pushes inbound messages via a global `window.__xpreiReceive(json)`.
  `chat.js` itself only changed two lines (`acquireVsCodeApi()` →
  `window.xprei`, the inbound `window.addEventListener("message", …)` →
  `vscode.onMessage(cb)`) — everything else (rendering, model picker,
  approvals) is untouched.
- `src/server/harness.test.ts` — the Phase 1 gate. Spawns the **real**
  `node --import tsx src/server/stdio.ts` child process (not an in-process
  call — the exact thing a JetBrains/Eclipse plugin will do), drives it over
  real stdin/stdout with real line-delimited JSON, against a throwaway local
  HTTP server speaking the Ollama wire format (fully offline/deterministic) and
  a real temp workspace dir. Proves: chat streaming end-to-end, and an agent
  run that writes a real file through a real approval round-trip.
- **84 tests** in `@xprei/core` by the end of this phase (+2 harness).

### Phase 2 — IntelliJ plugin (Kotlin, Gradle IntelliJ Platform) — 🚧 scaffolded, **not yet compiled**
Written on a machine with no local JDK/Gradle (confirmed absent) — everything
below is code-complete but unverified by an actual build. See
`plugins/intellij/README.md` for the full caveat, the exact list of
assumptions made without a compiler, and what to check first.

- `XpreiToolWindowFactory` + `XpreiChatPanel`: ToolWindow (anchored right —
  JetBrains has no core-patch blocker for that placement, unlike VS Code)
  hosting a `JBCefBrowser` that loads the shared `webview/index.html`.
- `XpreiHostBridge`: the translation layer, built from chatView.ts's actual
  source (not memory) — webview message protocol ↔ sidecar JSON-RPC protocol.
  Ports `runner.ts`'s `summarize()`/`buildDiffPreview()` for approval cards.
- `SidecarProcess` + `WebviewResources`: launches the bundled `sidecar.cjs`
  (extracted from plugin resources to a temp file) via `ProcessBuilder`, and
  extracts the webview assets the same way for `JBCefBrowser.loadURL()`.
- `XpreiSettingsState` (`PersistentStateComponent`, app-level) for non-secret
  provider config; `XpreiSecrets` (`PasswordSafe`) for API keys.
- `build.gradle.kts` wires `sourceSets.main.resources.srcDir` directly at
  `../../webview` and `../../packages/core/dist` — no separate copy step,
  and a `buildSidecar` Gradle `Exec` task runs `npm run build:sidecar` so the
  bundle is always fresh.
- **A real, testable gap this pass found and fixed in `packages/core`
  (not just documented around):** the sidecar had no way to list models
  across providers at all — added `models.list` to `session.ts`, backed by
  the existing tested `aggregateModels()`. Also found and fixed: a
  user-initiated Stop was surfacing as `chat.error` instead of ending
  cleanly like the VS Code path does — `session.ts`'s `chat.send` now
  special-cases `isAbortError`, with a test proving it.
- **MVP-scope simplifications, deliberately not implemented:** cross-restart
  session persistence (single in-memory session only), `insertAtCursor`/
  `applyEdit` (no-ops), a revert-last-run command (the sidecar RPC exists and
  is tested; no menu entry yet). Full list in `plugins/intellij/README.md`.

### Phase 3 — Eclipse plugin (Java, PDE/OSGi)
- ViewPart hosting an SWT `Browser` loading `webview/`; `BrowserFunction` bridge.
- Same sidecar; native glue: workspace root from `IWorkspaceRoot`; secrets via
  **Equinox Secure Storage**; config via preferences; apply-edit via `IDocument`;
  command/handler + menu contributions.
- MVP feature set only.

### Phase 4 — READMEs, branding, packaging, distribution
- Root `README.md` (multi-IDE, Babbros / xprei.online / support@xprei.com) — see
  the draft delivered alongside this plan.
- Packaging: `vsce` (VS Code Marketplace + Open VSX); Gradle `buildPlugin` →
  **JetBrains Marketplace**; Eclipse **feature + p2 update site** (hosted under
  xprei.online) plus a dropins zip.
- Node runtime for the sidecar: MVP requires **Node ≥ 18 on PATH** (documented);
  a later phase bundles a Node runtime per plugin so users need nothing.

## Risks / open questions

- **Node dependency on JVM IDEs.** MVP: require Node on PATH. Fast-follow: bundle.
- **JCEF availability.** JetBrains ships JCEF in most IDEs but it can be disabled
  / absent on some JREs; detect and show a fallback message.
- **Eclipse SWT Browser engine varies by OS** (Edge/WebKit) — test the webview on
  Windows/macOS/Linux; avoid bleeding-edge JS/CSS.
- **Marketplace identities:** JetBrains Marketplace vendor + Eclipse signing certs
  need to be registered under Babbros.
- Secrets crossing the stdio boundary stay in-memory only; never logged.

## Verification (per phase)

- **Phase 0:** `npm test` in `packages/core` (71+ tests) green; VS Code extension
  manual smoke (chat + agent run + revert) unchanged; `vsce package` succeeds.
- **Phase 1:** CLI harness drives a chat and an agent edit against a temp repo
  through the sidecar protocol; assert streamed events + a written file.
- **Phase 2/3:** launch the plugin in a sandbox IDE (Gradle `runIde` /
  Eclipse runtime workbench), configure an Ollama model, run a chat and an agent
  task with an approval, confirm the edit lands in the editor and revert works.
```
