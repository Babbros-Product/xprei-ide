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
| **JetBrains** (IntelliJ IDEA, PyCharm, WebStorm, GoLand, …) | 🚧 In development | [Build from source](#jetbrains-ides) |
| **Eclipse** | 🚧 In development | [Build from source](#eclipse) |

> JetBrains and Eclipse plugins share the same engine as the VS Code extension via
> a bundled local core process — see [`docs/multi-ide-plan.md`](docs/multi-ide-plan.md)
> for the architecture. The steps below marked *in development* describe the
> intended flow; the plugins are being built now.

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
cd extensions/xpreiIDE-ai
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
cd extensions/xpreiIDE-ai
npm run watch          # rebuilds on change
# press F5 in VS Code → Extension Development Host
```

---

## JetBrains IDEs

> 🚧 *In development.* One plugin covers all IntelliJ-Platform IDEs (IntelliJ IDEA,
> PyCharm, WebStorm, GoLand, RubyMine, CLion, Rider, …).

**Install (planned — JetBrains Marketplace):**
1. In the IDE: **Settings → Plugins → Marketplace**.
2. Search **xpreiIDE**, click **Install**, restart the IDE.

**Build from source (current):**
```bash
cd plugins/intellij
./gradlew buildPlugin            # output: build/distributions/xpreiIDE-*.zip
```
Then in the IDE: **Settings → Plugins → ⚙ → Install Plugin from Disk…** → select the
built `.zip` → restart.

**Run:**
1. Ensure **Node.js ≥ 18** is on your `PATH` (`node --version`).
2. Open the **xpreiIDE** tool window (right-hand tool-window bar, or
   **View → Tool Windows → xpreiIDE**).
3. **Settings → Tools → xpreiIDE → Add provider**, or use the **＋** in the chat
   composer, to configure a model.
4. Pick a model in the composer dropdown and start chatting.

**Dev sandbox:**
```bash
cd plugins/intellij
./gradlew runIde                 # launches a sandbox IDE with the plugin loaded
```

---

## Eclipse

> 🚧 *In development.*

**Install (planned — update site):**
1. **Help → Install New Software… → Add…**
2. Location: `https://xprei.online/eclipse/update-site`
3. Select **xpreiIDE**, finish the wizard, restart Eclipse.

**Install from a dropins zip (current):**
```bash
cd plugins/eclipse
mvn clean package                # Tycho build → target/*.zip
```
Unzip into your Eclipse `dropins/` folder and restart Eclipse.

**Run:**
1. Ensure **Node.js ≥ 18** is on your `PATH`.
2. **Window → Show View → Other… → xpreiIDE → Chat**.
3. Configure a model provider in the chat settings panel (**＋**).
4. Pick a model and start chatting.

**Dev workbench:**
Import `plugins/eclipse` as an Eclipse plugin project and launch an
**Eclipse Application** run configuration (runtime workbench).

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
- **Agentic multi-file coder** — a universal JSON tool protocol that works even on
  smaller open-source models (no reliance on native function-calling), with
  approval gates and one-click revert.
- **Codebase-aware context** — `@codebase` semantic retrieval and `@file:` mentions.
- **Inline edit** — select code, describe a change, review a red/green diff.
- **Ghost-text completions**, **commit-message generation**, and right-click quick
  actions (Explain / Fix / Tests / Comments / Refactor).
- **Project rules** — a `.xpreiIDErules` file at your workspace root is injected
  into every prompt.

> Feature availability rolls out per IDE — VS Code has the full set today;
> JetBrains and Eclipse ship an MVP (chat + BYO-model + agent loop) first, with the
> rest as fast-follows. See [`docs/multi-ide-plan.md`](docs/multi-ide-plan.md).

---

## Repository layout

```
extensions/xpreiIDE-ai/     # VS Code extension (available today)
plugins/intellij/           # JetBrains plugin (in development)
plugins/eclipse/            # Eclipse plugin (in development)
packages/core/              # shared bring-your-own-model + agent core (in development)
webview/                    # shared chat UI (in development)
docs/                       # design specs and the multi-IDE plan
```

---

## Support & company

- **Company:** Babbros
- **Website:** [xprei.online](https://xprei.online)
- **Support:** support@xprei.com
- **License:** MIT (see [`extensions/xpreiIDE-ai/LICENSE`](extensions/xpreiIDE-ai/LICENSE))
