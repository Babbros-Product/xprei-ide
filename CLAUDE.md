# xpreiIDE — project context

A Cursor-like AI assistant where anyone plugs in **their own models or local
open-source models (via Ollama)** and an agent completes their project.
Repo dir: `D:\Claude\BABBROSIDE` (git, branch `master`). Was named "BABBROSIDE".

## Locked decisions

- **Foundation:** a **pure VS Code extension**, published to the VS Code
  Marketplace and Open VSX — NOT a branded distro/fork. (Reversed from an
  earlier Code-OSS-distro plan; see "Superseded" below for why.)
- **Core principle:** all logic lives in the extension, developed and run
  against **stock VS Code** — no core patches, no custom build pipeline.
- **AI scope:** chat + @context/RAG + Cmd-K inline edit + **agentic multi-file**.
- **Models:** Ollama (NDJSON) + any OpenAI-compatible endpoint (SSE). Two adapters
  cover ~95% of "bring your own model".
- **Agent tool-calling:** a **universal prompt-based JSON tool protocol**, not
  native function-calling (unreliable on OSS models). Agent quality is model-gated.

### Superseded: branded Code-OSS distro (P0)

Originally planned as a VSCodium-style branded distro build (own installer,
own icon, Code-OSS core patched to dock chat in the Secondary Side Bar).
Dropped 2026-07-25 in favor of shipping as a normal extension:
- 99% of the work already lived in the extension and already ran on stock
  VS Code — the distro added packaging risk without adding user value.
- The Secondary Side Bar placement required patching VS Code core
  (`viewsExtensionPoint.ts`) because `auxiliarybar` was never a stable
  `viewsContainers` contribution point for extensions (confirmed still true
  as of this date — see microsoft/vscode issues #151681, #198087). Chat now
  lives in a normal Activity Bar container instead; users can drag it to the
  Secondary Side Bar themselves if they want that layout.
- The distro build had a standing, unfixable-from-here blocker: node-gyp
  native-module compilation failed under this machine's sandboxed shell
  tooling (Windows Job Object nesting restriction), worked around with
  `--ignore-scripts` but never cleanly resolved, plus 30-45 min full
  rebuilds and no installer signing/auto-update story.
- The `build/` directory (Code-OSS checkout, build scripts, staged output)
  was removed entirely. If a branded distro is ever revisited, git history
  before commit that removed it has the full working toolchain and scripts.

## Layout

npm-workspaces monorepo (root `package.json`, workspaces `packages/*` +
`extensions/*`). The platform-neutral core was extracted from the extension in
Phase 0 of the multi-IDE plan (see `docs/multi-ide-plan.md`) so it can be reused
by future JetBrains/Eclipse plugins via a shared Node sidecar.

```
packages/core/             # @xprei/core — platform-neutral, no vscode import
  src/providers/           # provider.ts, ollama.ts, openai-compat.ts, presets.ts, modelList.ts
  src/context/             # chunking, vectorstore, retrieval, mentions, exclude (RAG substrate)
  src/edit/                # prompt.ts (inline-edit prompt builder)
  src/agent/               # protocol, tools, checkpoint, orchestrator, pathResolve, host (interface)
  src/host/nodeHost.ts     # Node AgentHost impl (fs/exec) — the sidecar's file/exec layer
  src/server/              # session.ts (JSON-RPC session) + stdio.ts (entrypoint) — the sidecar
  src/index.ts             # barrel — the public API the extension imports (NOT server/stdio.ts,
                            # which has a top-level auto-start side effect; import it directly)
  # ALL unit tests live here now (97, run: npm test -w @xprei/core)
extensions/vscode/    # the VS Code platform layer — imports @xprei/core
  src/providers/           # registry.ts, addProviderFlow.ts (config/secrets/QuickPick)
  src/context/             # contextEngine.ts, projectRules.ts (vscode.fs/index persistence)
  src/edit/                # inlineEdit.ts (Cmd-K diff decorations)
  src/agent/               # host.ts (VscodeAgentHost), runner.ts, editDecorations.ts
  src/completion/          # ghost-text inline completions
  src/git/                 # SCM commit-message generation
  src/ui/chat/             # chat webview host (chatView.ts)
  media/                   # GENERATED copy of webview/ (gitignored) — see scripts/sync-webview.mjs
  scripts/sync-webview.mjs # copies webview/ -> media/, runs as a `compile` pre-step
extensions/intellij/       # JetBrains plugin (Kotlin/Gradle) — scaffolded, NOT compiled/run yet
                            # (written with no local JDK/Gradle to verify against — see
                            # extensions/intellij/README.md before touching this code)
extensions/eclipse/        # Eclipse plugin (Java/Tycho) — scaffolded, NOT compiled/run yet
                            # (written with no local Maven to verify against — see
                            # extensions/eclipse/README.md before touching this code)
webview/                    # shared chat UI (chat.js/css, icons) — host-agnostic, reused by
                            # the intellij/eclipse plugins. bridge.js is the transport shim:
                            # window.xprei = { postMessage, onMessage }, one contract, three hosts.
docs/                      # specs (superpowers/specs) + multi-ide-plan.md
```

## Phase status

- **P1 providers + chat** — done
- **P2 context/RAG** (@codebase/@file, dependency-free cosine store) — done
- **P3 Cmd-K inline edit** (red/green diff, Enter/Esc) — done
- **P4 agent loop** (tools, protocol, approvals, checkpoints) — done, `48b31ba`
- **P5 polish** — in progress. Done: chat lives in an Activity Bar container
  and opens automatically on startup; quick actions (Explain/Fix/Tests/Comments/
  Refactor via right-click or `/slash` commands, seeded into chat); `.xpreiIDErules`
  project-instructions file; chat code-block actions (Copy/Insert/Apply);
  Edit & resend / Regenerate on the latest turn; named/persistent chat sessions
  (Plan-mode history only); agent approval cards show a real before/after diff;
  agent-written files get a brief gutter flash if open; inline chat (Ctrl+I);
  commit-message generation from the staged diff (SCM title button); ghost-text
  inline completions (ties up any configured model via `chatStream`, not a
  dedicated FIM endpoint — quality is model-gated); weak-model protocol retry
  (`xpreiIDE.agent.protocolRetries`, default 2 — corrective reprompt + visible
  retry indicator instead of silently ending the run on unparseable output;
  design: `docs/superpowers/specs/2026-07-25-weak-model-protocol-retry-design.md`).
  Still open: per-role models, telemetry, diff-preview-before-apply for
  multi-file agent runs (design spec written and approved:
  `docs/superpowers/specs/2026-07-24-diff-preview-before-apply-design.md` —
  implementation not started).
- **Marketplace publish** — not started. Extension is publish-ready
  (`package.json` has publisher/license/icon/categories/keywords,
  `.vscodeignore` and `LICENSE` present, `vscode:prepublish` runs the
  minified build). Publishing itself (VS Code Marketplace `vsce publish` +
  Open VSX `ovsx publish`) needs the user's own publisher account/PAT — not
  done by the agent.

## Working in the monorepo

```
npm install                          # from repo ROOT — links @xprei/core into the extension
npm test -w @xprei/core              # 97 tests, all pure/headless (node --import tsx --test)
npm run typecheck -w @xprei/core     # core tsc --noEmit
npm run typecheck -w xpreiIDE-ai     # extension tsc --noEmit (resolves @xprei/core via workspace)
npm run compile -w xpreiIDE-ai       # esbuild → dist/extension.js (inlines @xprei/core from source)
# then F5 in VS Code for an Extension Development Host
```

**All unit tests live in `@xprei/core`** (the pure modules moved there in Phase 0).
Tests are dependency-free: pure modules + fakes (`_fakehost.ts`, provider mocks).
No test needs a live model. When adding a test file, add it to the `test` script
list in `packages/core/package.json`. The extension itself has no unit tests (its
coupled/UI layer is verified by typecheck + compile + manual smoke).

`@xprei/core` is a **source-only** workspace package: its `exports` point at
`src/index.ts`, so both tsc and esbuild consume the TypeScript directly — no
separate core build step. It's an extension **devDependency** (bundled by esbuild
at compile time, not a runtime dep).

Package a local `.vsix`: from `extensions/vscode`,
`npx @vscode/vsce package --no-dependencies`. The `--no-dependencies` flag is
**required** in this workspace — without it vsce follows the `@xprei/core`
symlink and tries to package the whole repo. Safe because esbuild has already
inlined the core into `dist/extension.js`.

## Environment gotchas (this machine)

- **PATH does not persist between tool invocations.** Each PowerShell/Bash tool
  call appears to get a fresh/stale env snapshot — newly-installed tools (nvm,
  yarn) aren't on PATH until explicitly prepended in *every* command:
  `$env:Path = "C:\nvm4w\nodejs;C:\Users\mbsaj\AppData\Roaming\npm;" + $env:Path`
  (PowerShell) or `export PATH="/c/nvm4w/nodejs:...:$PATH"` (Bash).
- `nvm.exe` must be run from inside `%LOCALAPPDATA%\nvm` (relative-path bug if
  invoked via a bare full path from elsewhere) with `$env:NVM_HOME` /
  `$env:NVM_SYMLINK` set.

## Conventions

- **Secrets:** API keys only in `SecretStorage` (OS keychain), never in settings.
- **Provider interface is stable** — new features go through adapters/agent, not by
  changing `Provider`. Agent uses the plain `chatStream`, no interface changes.
- **Tools call `AgentHost`, never vscode/fs directly** — keeps them unit-testable.
- **Commits:** author `xpreiIDE <mbsajay1@gmail.com>`; footer
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Conventional prefixes
  (feat/fix). Line endings: `.gitattributes` forces LF.

## Deferred / known gaps

- Indexer uses an exclude-glob, not true `.gitignore` parsing.
- Brute-force cosine search (fine to a few-k chunks; upgrade to LanceDB/sqlite-vss later).
- Static per-provider capabilities (no per-model tool detection).
- Unbounded chat history (no trimming yet).
- Inline edit applies once on completion, not token-by-token into the buffer.
- Agent feeds observations as `user` turns (not a `tool` role) for OSS compatibility.
