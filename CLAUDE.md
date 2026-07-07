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
- **P0 branded distro build** — **done**. `build/VSCode-win32-x64/xpreiIDE.exe`
  built and staged with `xpreiIDE-ai` as a built-in. See `build/README.md` and
  the build status below for how the native-module blocker was worked around.
- **P5 polish** — not started (per-role models, weak-model handling, telemetry).

## P0 build status (this machine) — DONE

Toolchain installed and confirmed working (persists across sessions):
- Node via **nvm4w** (`C:\nvm4w`, `NVM_HOME=%LOCALAPPDATA%\nvm`) — active version
  20.18.3. Switch with `& "$env:LOCALAPPDATA\nvm\nvm.exe" use <version>` (run
  from inside that directory — see gotcha below).
- yarn 1.22.22 (global via npm)
- VS Build Tools 2022 + C++ workload (Desktop development with C++)
- Inno Setup 6.7.3 (installer target)

**Native-module blocker (worked around):** `yarn install` in `build/vscode`
fails compiling native modules (`@vscode/policy-watcher`, `@vscode/spdlog`,
`@vscode/deviceid`, etc.) via node-gyp with `AssignProcessToJobObject: (87) The
parameter is incorrect` — an OS-level Windows Job Object nesting restriction
inherited from this environment's process ancestry, not fixable from inside
any shell tool (confirmed across Bash sandboxed/unsandboxed, PowerShell tool,
two Node 20.x versions). **Fix used:** run every `yarn install` with
`--ignore-scripts` (skips node-gyp entirely). These native modules are
runtime-only bindings for enterprise policy/Windows-cert-store/structured
logging/telemetry — not needed to compile or run the editor itself.

**Full working build sequence** (already executed once; rerun after a clean
checkout or dependency bump):
```powershell
$env:Path = "C:\nvm4w\nodejs;C:\Users\mbsaj\AppData\Roaming\npm;" + $env:Path
# 1. Root deps (--ignore-scripts avoids the node-gyp blocker above)
yarn --cwd D:\Claude\BABBROSIDE\build\vscode install --ignore-scripts
# 2. VS Code has a SEPARATE build/package.json with its own deps (easy to miss)
yarn --cwd D:\Claude\BABBROSIDE\build\vscode\build install --ignore-scripts
# 3. Every built-in extension has its OWN package.json too (94 total, including
#    nested css/html/json/markdown-language-features\server subfolders, plus
#    the extensions/ folder's own manifest) — install each with --ignore-scripts
# 4. Then the real build:
yarn --cwd D:\Claude\BABBROSIDE\build\vscode gulp vscode-win32-x64
```
Takes ~30-45 min (TypeScript compile of the whole codebase alone is ~25-30
min and reruns from scratch every time — `clean-out-build` wipes prior output
unconditionally). Output: `build/VSCode-win32-x64/xpreiIDE.exe` (~379MB).
Stage the extension in with:
```powershell
node build\scripts\stage-extension.mjs build\VSCode-win32-x64
```
Installer (needs Inno Setup):
```powershell
cd build\vscode
yarn gulp vscode-win32-x64-inno-setup
```

## Environment gotchas (this machine)

- **PATH does not persist between tool invocations.** Each PowerShell/Bash tool
  call appears to get a fresh/stale env snapshot — newly-installed tools (nvm,
  yarn) aren't on PATH until explicitly prepended in *every* command:
  `$env:Path = "C:\nvm4w\nodejs;C:\Users\mbsaj\AppData\Roaming\npm;" + $env:Path`
  (PowerShell) or `export PATH="/c/nvm4w/nodejs:...:$PATH"` (Bash).
- `nvm.exe` must be run from inside `%LOCALAPPDATA%\nvm` (relative-path bug if
  invoked via a bare full path from elsewhere) with `$env:NVM_HOME` /
  `$env:NVM_SYMLINK` set.
- Native Windows job-object restriction above applies to **any** node-gyp
  compile step invoked from the agent's shell tools, not just this build —
  keep in mind for any future task needing native npm module compilation.

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
