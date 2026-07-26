<div align="center">

# xpreiIDE

**Bring-your-own-model AI coding assistant — for every IDE.**

Chat, an agentic multi-file coder, codebase-aware context, and inline edits,
powered by *your* models: a local [Ollama](https://ollama.com) daemon or any
OpenAI-compatible endpoint. No vendor lock-in, no forced cloud.

A **[Babbros](https://xprei.online)** product · [xprei.online](https://xprei.online) · support@xprei.com

</div>

---

## Supported IDEs

| IDE | Status | Install |
|-----|--------|---------|
| **Visual Studio Code** | ✅ Available | [Marketplace / `.vsix`](#visual-studio-code) |
| **JetBrains** (IntelliJ IDEA, PyCharm, WebStorm, GoLand, …) | ✅ Verified in a sandbox IDE | [Build from source](#jetbrains-ides) |
| **Eclipse** | 🚧 Compiles & packages, not yet run live | [Build from source](#eclipse) |
| **CLI** (headless, for CI/no-IDE workflows) | ✅ Available | [`extensions/cli`](extensions/cli/README.md) |

> JetBrains and Eclipse plugins share the same engine as the VS Code extension via
> a bundled local core process — see [`docs/multi-ide-plan.md`](docs/multi-ide-plan.md)
> for the architecture. The JetBrains plugin has been built and run in a real
> sandbox IDE — chat and an agent task (with approval) both worked. The Eclipse
> plugin compiles and packages cleanly but hasn't been run in a live Eclipse
> instance yet. The CLI runs the same engine directly in-process (no editor, no
> bundled sidecar) — see its own README for `xprei agent`/`xprei chat` usage.

---

## Prerequisites (all IDEs)

1. **A model backend** — one of:
   - **Ollama (local, free):** install from [ollama.com](https://ollama.com), then
     pull a model:
     ```bash
     ollama serve
     ollama pull llama3.1
     ```
   - **Any OpenAI-compatible endpoint:** OpenAI, OpenRouter, Together, vLLM,
     LM Studio, Google Gemini (OpenAI-compat mode), etc. You'll need its base URL
     and an API key.
2. **For the JetBrains and Eclipse plugins only:** **Node.js ≥ 18** on your `PATH`
   (runs the shared local core process). The VS Code extension needs nothing extra.

---

## Visual Studio Code

**Install (from a `.vsix`):**
```bash
code --install-extension xpreiIDE-ai-0.0.1.vsix
```
*(Marketplace / Open VSX listing coming soon — until then use the packaged `.vsix`.)*

**Or build it yourself:**
```bash
cd extensions/vscode
npm install
npm run compile
npx @vscode/vsce package        # produces xpreiIDE-ai-<version>.vsix
```

**Run:**
1. Reload VS Code (`Ctrl/Cmd+Shift+P` → *Developer: Reload Window*).
2. Click the **xpreiIDE** icon in the Activity Bar to open the chat panel.
3. `Ctrl/Cmd+Shift+P` → **xpreiIDE: Select Model** → pick your provider and model.
4. Type in the chat box and press **Enter**.

**Developer loop (live reload):**
```bash
cd extensions/vscode
npm run watch          # rebuilds on change
# press F5 in VS Code → Extension Development Host
```

---

## JetBrains IDEs

> ✅ *Verified in a live sandbox IDE (2026-07-26).* One plugin covers all
> IntelliJ-Platform IDEs (IntelliJ IDEA, PyCharm, WebStorm, GoLand, RubyMine,
> CLion, Rider, …). Built for real against a JDK 21/Gradle 9.6.1 toolchain,
> then run for real via `gradle runIde`: chat streamed a response from a
> local Ollama model, and an Agent-mode task ran end-to-end with an approval
> card and a real file edit. See
> [`extensions/JetBrains/README.md`](extensions/JetBrains/README.md) for the
> full status and what's still unverified (revert-last-run, the PasswordSafe
> secrets path).

**Build from source (current):**
```bash
# one-time: build the shared engine the plugin ships (needs Node.js)
npm install
npm run build:sidecar -w @xprei/core

cd extensions/JetBrains
gradle buildPlugin                      # output: build/distributions/xpreiIDE-*.zip
# no local Gradle? run `gradle wrapper --gradle-version 8.10` first (see
# extensions/JetBrains/README.md) to generate ./gradlew
```
Then in the IDE: **Settings → Plugins → ⚙ → Install Plugin from Disk…** → select the
built `.zip` → restart.

**Run:**
1. Ensure **Node.js ≥ 18** is on your `PATH` (`node --version`).
2. Open the **xpreiIDE** tool window (right-hand tool-window bar, or
   **View → Tool Windows → xpreiIDE**).
3. Use the **＋** in the chat composer to configure a model provider.
4. Pick a model in the composer dropdown and start chatting.

**Dev sandbox:**
```bash
cd extensions/JetBrains
./gradlew runIde                 # launches a sandbox IDE with the plugin loaded
```

---

## Eclipse

> 🚧 *In development — compiles and packages cleanly, not yet run in a live
> Eclipse instance.* Same status as the JetBrains plugin: the code is
> written and has been built for real against a JDK 21/Maven 3.9.16/Tycho
> 5.0.2 toolchain. See [`extensions/eclipse/README.md`](extensions/eclipse/README.md)
> for the full status and what's still unverified.

**Build from source (current):**
```bash
# one-time: build the shared engine the plugin ships (needs Node.js)
npm install
npm run build:sidecar -w @xprei/core

cd extensions/eclipse
mvn clean package                # Tycho build → target/*.zip (needs JDK 17+, Maven 3.9+)
```
Unzip the built module's `target/*.zip` into your Eclipse `dropins/` folder and
restart Eclipse.

**Run:**
1. Ensure **Node.js ≥ 18** is on your `PATH`.
2. **Window → Show View → Other… → xpreiIDE → Chat**.
3. Configure a model provider in the chat settings panel (**＋**).
4. Pick a model and start chatting.

**Dev workbench:**
Import `extensions/eclipse` as an Eclipse plugin project (or open it via
`mvn eclipse:eclipse` / m2e) and launch an **Eclipse Application** run
configuration (runtime workbench).

---

## First-use quickstart (any IDE)

1. Start your model backend (`ollama serve`, or have your API endpoint + key ready).
2. Open the **xpreiIDE** chat panel.
3. Add / select a model (**Select Model**, or the composer dropdown).
4. Choose a mode in the composer:
   - **Plan** — ask questions, get answers (no file changes).
   - **Edit** — the agent proposes file edits (no shell access).
   - **Agent** — full autonomous multi-file loop, including running commands.
5. Type your request and send. Agent file writes and terminal commands prompt for
   approval inline; every run can be reverted.

---

## Features

- **Streaming chat** with Plan / Edit / Agent modes and named sessions.
- **Bring-your-own-model** — local Ollama or any OpenAI-compatible endpoint; API
  keys stored in your OS keychain, never in plaintext settings.
- **Zero-config local setup** — a running Ollama daemon is detected on
  startup and offered in one click; nothing to configure by hand for chat.
- **Per-role models** — use a different model for chat, completions, the
  agent, inline edit, and commit messages (`xpreiIDE: Select Model for
  Role...`); any role left unconfigured follows the chat model.
- **Agentic multi-file coder** — a universal JSON tool protocol that works even on
  smaller open-source models (no reliance on native function-calling), with
  approval gates, end-of-run batch diff review (rejected edits never touch
  disk), one-click revert, and batched multi-edit (several find/replace edits
  to one file in a single step).
- **Codebase-aware context** — `@codebase` semantic retrieval, `@file:`
  mentions, `@currentFile` (the active editor's live buffer), `@symbol:<name>`
  (a function/class's full source via the language server), `@open` (every
  open tab), `@problems` (current error/warning diagnostics), `@diff` (your
  current git diff), `@commits` (last 10 commits' metadata),
  `@terminal:<command>` (run a command and inline its output, with
  confirmation), `@url:<address>` (fetch a public URL, HTML stripped to
  text; private/internal addresses are blocked), `@search:<text>` (up to 50
  workspace hits for an exact substring), `@repomap` (a regex-based overview
  of exported/public symbols across your TypeScript/JavaScript/Python
  files), and `@os` (platform/architecture/OS release).
- **Inline edit** — select code, describe a change, review a red/green diff.
- **Inline chat** — a quick popup question (with or without a selection),
  no need to open the chat panel.
- **Ghost-text completions** — real Ollama fill-in-the-middle for
  FIM-trained code models (codellama, deepseek-coder, qwen2.5-coder, …),
  chat-based fallback for everything else.
- **Commit-message generation**, and right-click quick actions (Explain /
  Fix / Tests / Comments / Refactor — also available as `/slash` commands
  in chat).
- **Project rules** — a `.xpreiIDErules` file at your workspace root is injected
  into every prompt, plus modular `.xpreiIDE/rules/*.md` files that can be
  scoped to matching files via frontmatter (`globs: *.tsx, src/**`), and
  `.xpreiIDE/prompts/*.md` files that become your own `/name` slash commands.
- **Ignore file** — a `.xpreiIDEignore` file (`.gitignore`-lite syntax)
  excludes extra paths from the codebase index, on top of the built-in
  exclusions.
- **MCP servers** — configure MCP servers in the shared config file;
  their tools become available to the agent loop automatically, named
  `mcp__<server>__<tool>`.

> Feature availability rolls out per IDE — VS Code has the full set today;
> JetBrains and Eclipse ship an MVP (chat + BYO-model + agent loop) first, with the
> rest as fast-follows. See [`docs/multi-ide-plan.md`](docs/multi-ide-plan.md).

---

## Repository layout

```
extensions/vscode/          # VS Code extension (package name "xpreiIDE-ai", available today)
extensions/JetBrains/        # JetBrains plugin (compiles & packages, not yet run in a sandbox IDE)
extensions/eclipse/         # Eclipse plugin (compiles & packages, not yet run in a live Eclipse instance)
extensions/cli/             # xprei-cli — headless CLI, available today
packages/core/              # shared bring-your-own-model + agent core (@xprei/core, powers every host)
webview/                    # shared chat UI, reused by every host's chat panel
docs/                       # design specs and the multi-IDE plan
```

---

## Support & company

- **Company:** Babbros
- **Website:** [xprei.online](https://xprei.online)
- **Support:** support@xprei.com
- **License:** MIT (see [`extensions/vscode/LICENSE`](extensions/vscode/LICENSE))
