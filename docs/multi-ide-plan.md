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

```
xprei-ide/                      # repo root (was BABBROSIDE)
  packages/
    core/                       # @xprei/core — the 16 pure modules, no vscode
      src/ …                    # moved verbatim from extensions/xpreiIDE-ai/src
      src/server.ts             # NEW: JSON-RPC-over-stdio sidecar entrypoint
      src/host/nodeHost.ts      # NEW: Node AgentHost (fs/exec/grep) for the sidecar
  extensions/
    xpreiIDE-ai/                # existing VS Code extension → consumes @xprei/core
  plugins/
    intellij/                   # Kotlin, Gradle IntelliJ Platform plugin
    eclipse/                    # Java, PDE/OSGi plugin
  webview/                      # shared chat UI (moved from media/), host-agnostic
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

## Shared webview transport shim

`media/chat.js` today calls `acquireVsCodeApi().postMessage`. Extract a tiny
`bridge` module with `postMessage(msg)` + `onMessage(cb)`; provide three
implementations selected at load time:

- **VS Code:** `acquireVsCodeApi()` (unchanged behavior).
- **JetBrains/JCEF:** an injected JS object + `window.cefQuery` (or
  `JBCefJSQuery`) round-trip.
- **Eclipse/SWT:** `BrowserFunction` (Java→JS via `browser.execute`, JS→Java via a
  registered function).

Everything else in the webview (rendering, model picker, approvals) stays identical.

## Phased implementation

### Phase 0 — Extract & validate the core (de-risks everything)
- Create `packages/core`; move the 16 pure modules in unchanged. Publish as
  `@xprei/core` (workspace package). Keep the existing 71 tests green there.
- Refactor `extensions/xpreiIDE-ai` to import from `@xprei/core`. **Success gate:
  the VS Code extension behaves identically and all tests pass** — proof the core
  is cleanly extractable.
- Add `src/host/nodeHost.ts` (a Node `AgentHost`: `fs`, `child_process`, a grep)
  and `src/server.ts` (the JSON-RPC sidecar) with headless tests.

### Phase 1 — Shared webview + sidecar as a standalone product
- Move `media/chat.*` to `webview/`; add the transport shim; keep VS Code working
  through it.
- Wire the sidecar end-to-end: a CLI harness that runs a chat + an agent task
  against a temp workspace, proving MVP works with no IDE at all.

### Phase 2 — IntelliJ plugin (Kotlin, Gradle IntelliJ Platform)
- ToolWindow hosting a `JBCefBrowser` that loads `webview/`.
- Launch + supervise the sidecar child process; bridge JCEF ↔ stdio.
- Native glue: workspace root from `project.basePath`; secrets via **PasswordSafe**;
  config via `PersistentStateComponent`; apply-edit via `WriteCommandAction` on the
  `Document`; actions/menus for Select Model / Add Provider / chat toggle.
- MVP feature set only.

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
