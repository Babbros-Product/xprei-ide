# xpreiIDE — project context

A Cursor-like AI IDE where anyone plugs in **their own models or local
open-source models (via Ollama)** and an agent completes their project.
Repo dir: `D:\Claude\BABBROSIDE` (git, branch `master`). Was named "BABBROSIDE".

## Locked decisions

- **Foundation:** branded distro build on **Code-OSS** (MIT), VSCodium-style — NOT
  a heavy fork of core files. Ship as a downloadable branded app, Open VSX gallery.
- **Core principle:** keep the fork diff tiny; put all logic in the bundled
  extension. Develop the extension against **stock VS Code** (fast F5), package into
  the distro only at P0.
- **AI scope:** chat + @context/RAG + Cmd-K inline edit + **agentic multi-file**.
- **Models:** Ollama (NDJSON) + any OpenAI-compatible endpoint (SSE). Two adapters
  cover ~95% of "bring your own model".
- **Agent tool-calling:** a **universal prompt-based JSON tool protocol**, not
  native function-calling (unreliable on OSS models). Agent quality is model-gated.

## Layout

```
extensions/xpreiIDE-ai/     # the extension — 99% of the work
  src/providers/            # provider.ts, ollama.ts, openai-compat.ts, registry.ts
  src/context/              # chunking, vectorstore, mentions, retrieval, contextEngine
  src/edit/                 # Cmd-K inline edit (prompt.ts, inlineEdit.ts)
  src/agent/                # protocol, tools, host, checkpoint, orchestrator, runner
  src/ui/chat/ + media/     # chat webview
build/                      # P0 branded-distro build tooling (scaffold only)
```

## Phase status

- **P1 providers + chat** — done
- **P2 context/RAG** (@codebase/@file, dependency-free cosine store) — done
- **P3 Cmd-K inline edit** (red/green diff, Enter/Esc) — done
- **P4 agent loop** (tools, protocol, approvals, checkpoints) — done, `48b31ba`
- **P0 branded distro build** — tooling **scaffolded** in `build/` (not yet run;
  needs C++ toolchain + long multi-GB source build). See `build/README.md`.
- **P5 polish** — not started (per-role models, weak-model handling, telemetry).

## Working in the extension

```
cd extensions/xpreiIDE-ai
npm install
npm run typecheck        # tsc --noEmit
npm test                 # node --import tsx --test  (49 tests, all pure/headless)
npm run compile          # esbuild → dist/extension.js
# then F5 in VS Code for an Extension Development Host
```

Tests are dependency-free: pure modules + fakes (`_fakehost.ts`, provider mocks).
No test needs a live model. When adding a test file, add it to the `test` script
list in `package.json`.

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
- P0: branded icon assets not in repo; installer/signing/auto-update not wired.
