# xpreiIDE AI

Bring-your-own-model AI assistant for VS Code. Chat with a local **Ollama**
daemon or any **OpenAI-compatible** endpoint (OpenAI, vLLM, LM Studio,
OpenRouter, Together, …). A pure extension — no fork, no branded app, runs
on stock VS Code.

## Contents

- [Run it (dev)](#run-it-dev)
- [Getting started](#getting-started)
- [Adding a hosted / custom model](#adding-a-hosted--custom-model)
- [Per-role models](#per-role-models)
- [Chat modes: Plan, Edit, Agent](#chat-modes-plan-edit-agent)
- [Working with chat](#working-with-chat)
- [Bringing in context (@mentions)](#bringing-in-context-mentions)
- [Project instructions & ignore file](#project-instructions--ignore-file)
- [The Agent, in depth](#the-agent-in-depth)
- [MCP servers](#mcp-servers)
- [Inline edit (Cmd-K)](#inline-edit-cmd-k)
- [Inline chat (Ctrl-I)](#inline-chat-ctrl-i)
- [Quick actions](#quick-actions)
- [Ghost-text completions](#ghost-text-completions)
- [Commit message generation](#commit-message-generation)
- [Settings reference](#settings-reference)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Architecture (for contributors)](#architecture-for-contributors)

## Run it (dev)

This extension is part of an npm-workspaces monorepo; the platform-neutral engine
lives in `@xprei/core` (`packages/core`). Install from the **repo root**:

```bash
npm install                          # repo root — links @xprei/core
npm run watch -w xpreiIDE-ai         # esbuild bundles dist/extension.js, rebuilds on change
```

Then press **F5** in VS Code to launch an Extension Development Host.

## Getting started

1. Start a model backend. The easiest option is a local, free one:
   ```bash
   ollama serve
   ollama pull llama3.1
   ```
2. Click the **xpreiIDE** icon in the Activity Bar to open the chat panel
   (it also opens automatically the first time you install the extension).
3. **You usually don't need to do anything else.** If a local Ollama daemon
   is already running when the extension starts, it's detected automatically
   — see [Automatic Ollama setup](#automatic-ollama-setup) below. If nothing
   was detected, run **xpreiIDE: Select Model** from the Command Palette
   (`Ctrl/Cmd+Shift+P`) and pick a provider and model.
4. Type a message and press **Enter**. The reply streams in token by token.

### Automatic Ollama setup

When no chat model is configured yet, xpreiIDE checks on startup whether a
local Ollama daemon is running at `http://localhost:11434`. If it finds one:

- **One model installed** — it's selected automatically, and a notification
  tells you which.
- **Several installed** — a notification offers to use Ollama; accept it
  and pick a model from the list.
- **Ollama running, no models pulled** — a notification suggests running
  `ollama pull llama3.1`.

If Ollama isn't running, nothing happens at all — no prompt, no error. The
check stops entirely once a chat model is set, and you can always change
the model later with **xpreiIDE: Select Model**.

## Adding a hosted / custom model

Use **xpreiIDE: Add Model Provider** for guided setup — a list of common
presets (OpenAI, and similar) plus a "Custom…" option for anything else
that speaks the OpenAI-compatible chat API. You'll be asked for:

- A **base URL** (must include the API version segment, e.g. `/v1`).
- An **API key**, if the provider needs one — this is stored in your OS's
  secure credential store (Windows Credential Manager, macOS Keychain,
  etc.) via VS Code's `SecretStorage`, **never** written to a plain-text
  file. You can also set/change a key later with **xpreiIDE: Set Provider
  API Key**.
- Optionally, a default model name.

Advanced: providers (minus API keys) are stored in one shared, human-
editable file at `~/.xpreiide/config.yaml` — the same file the IntelliJ
and Eclipse plugins read, if you use those too. You can hand-edit it
directly instead of using the guided flow:

```yaml
providers:
  - id: ollama-local
    kind: ollama
    label: Ollama (local)
    baseUrl: http://localhost:11434
  - id: openai
    kind: openai-compat
    label: OpenAI
    baseUrl: https://api.openai.com/v1
```

## Per-role models

By default, chat, ghost-text completions, the agent, inline edit (Cmd-K),
and commit-message generation all use whatever model **xpreiIDE: Select
Model** set for chat. If you'd rather use a different model for one of
them — for example, a small, fast local model for completions while a
larger model drives the agent — run **xpreiIDE: Select Model for
Role...**, pick a role, then pick a provider and model as usual.

Roles you haven't overridden keep following the chat model automatically.
Running the command again on a role you've already overridden offers a
**"Clear override"** option to go back to following chat.

## Chat modes: Plan, Edit, Agent

Three buttons at the top of the composer control what the model is allowed
to do with your message:

- **Plan** (default) — a plain conversation. The model can read your
  question and any context you bring in, and answer in prose or code
  snippets, but it cannot touch your files or run anything. Good for
  questions, explanations, and discussing an approach before committing
  to changes.
- **Edit** — the model can read and write files directly (create files,
  make find/replace edits, batch multiple edits into one file), but has
  no access to a terminal and can't run commands. Good for scoped,
  file-only changes where you don't want a stray shell command.
- **Agent** — the full autonomous loop: everything Edit mode can do, plus
  running terminal commands, viewing your git diff, and (if you've
  configured any) calling MCP server tools. See
  [The Agent, in depth](#the-agent-in-depth) below.

## Working with chat

- **Sessions.** The **+** button in the chat panel starts a new, named
  chat session; your previous sessions are preserved and you can switch
  between them. History for each session persists across VS Code
  restarts.
- **Code blocks.** Every code block the model writes gets three buttons:
  **Copy** (clipboard), **Insert** (drops it at your cursor in the active
  editor), and **Apply** (applies it as an edit to the file it names, if
  it names one).
- **Edit & resend / Regenerate.** Hover your own last message to edit its
  text and resend it — useful if you mistyped or want to rephrase.
  Hover the model's last reply to regenerate it (ask again with the same
  prompt, useful if the first answer wasn't great).
- **Slash commands.** Typing `/explain`, `/fix`, `/tests`, `/comments`, or
  `/refactor` at the start of a message expands it into a full prompt for
  that quick action before sending — the same five actions available via
  right-click (see [Quick actions](#quick-actions)).

## Bringing in context (@mentions)

Type `@` in chat to pull in context from your workspace instead of
copy-pasting it yourself.

**Needs an index first:** set an embedding model (**xpreiIDE: Select
Embedding Model**, e.g. `ollama-local::nomic-embed-text`) and run
**xpreiIDE: Rebuild Codebase Index** once. After that:

- **`@codebase <question>`** — semantic search across your whole indexed
  workspace; the model gets back the most relevant chunks of code.
- **`@file:src/x.ts`** — inline one specific file in full.

The index updates automatically as you edit and save files, so you don't
need to re-run the rebuild command after every change.

**No index needed** for these — they read live workspace state on demand:

- **`@currentFile`** — inline the active editor's live buffer (including
  unsaved changes), the same way `@file:` would.
- **`@symbol:<name>`** — inline a function/class/etc.'s full source, up
  to 3 best matches, e.g. `@symbol:budgetContext explain this`. Needs a
  language extension installed for the file it's defined in (uses VS
  Code's own symbol index) — without one, it contributes nothing.
- **`@open`** — inline every file you currently have open in an editor
  tab, including background tabs you're not looking at right now.
- **`@problems`** — inline the current error/warning diagnostics for your
  open files, so the model can see what's broken without you pasting it
  in.
- **`@diff`** — inline your current git diff (staged and unstaged changes
  combined), so the model can review or explain your in-progress work.
- **`@terminal:<command>`** — run a shell command and inline its output,
  e.g. `why did this fail @terminal:npm test`. You'll be asked to confirm
  before it runs — this is the only mention that executes anything.
  **`@terminal:` must be the last thing in your message**: everything
  after the colon, to the end of the text, is treated as the command.
- **`@url:<address>`** — fetch a public web page and inline its content
  (HTML is stripped down to readable text), e.g.
  `@url:https://example.com/docs summarize this`. For safety, addresses
  that resolve to your own machine or your local network (localhost,
  private IP ranges, cloud metadata endpoints) are silently ignored — if
  `@url:` contributes nothing, that's why.
- **`@repomap`** — inline a lightweight overview of the exported/public
  functions, classes, etc. across your workspace's TypeScript, JavaScript,
  and Python files, so the model gets a sense of what's where without you
  opening every file. It's a quick regex-based summary, not a full
  dependency graph — other languages, and symbols re-exported or aliased
  under a different name, aren't covered.
- **`@commits`** — inline the last 10 commits' metadata (hash, date,
  author, subject line) — no diffs, just history for context.
- **`@search:<text>`** — inline up to 50 workspace hits for an exact,
  case-insensitive substring, e.g. `@search:TRUNCATION_MARKER where is
  this used`. Single-token only in v1 — no quoted multi-word queries yet.
- **`@os`** — inline one line describing your platform, architecture, and
  OS release, for questions where that matters (build/tooling issues).

You can combine any of these in one message, e.g.
`@diff @problems review my changes`. If the context you bring in is large,
xpreiIDE automatically trims it to fit your model's context window,
prioritizing explicit requests (`@file:`, `@url:`, …) over broader/lower-
confidence ones (`@codebase` search hits).

## Project instructions & ignore file

Two optional dotfiles at your workspace root, both read fresh every time
they're needed — no caching, no reload required:

- **`.xpreiIDErules`** — plain text, injected into every chat/edit/agent
  prompt as extra project-specific instructions (coding conventions, "we
  use tabs not spaces", "always write tests", whatever's useful to remind
  the model of on every request).
- **`.xpreiIDEignore`** — one pattern per line, `.gitignore`-style syntax
  (`#` comments, blank lines ignored, `*` within a path segment, `**`
  across segments, a pattern containing `/` anchors to the workspace
  root, a pattern without `/` matches at any depth). Use it to keep
  extra paths out of the codebase index — generated files, large data
  directories, anything you don't want the model reading via
  `@codebase`. This adds to, not replaces, the built-in exclusions
  (`node_modules`, `.git`, `dist`, and similar are always excluded
  regardless of this file). Affects the codebase index, `@open`, and
  `@repomap` — **not** the agent's file-search tools. Not a full
  `.gitignore` implementation: `!` negation and backslash escaping
  aren't supported.

## The Agent, in depth

Switch the composer to **Agent** mode, describe a task in plain English
(e.g. *"add a `/health` route and a test for it"*), and press Send. The
agent works through the task step by step, showing you its reasoning,
what it's doing, and the result of each step as it goes — you're never
waiting on a black box.

**What it can do:**
- Read files (whole file, or a specific line range), list directories,
  search text across the workspace (`grep`), find files by pattern
  (`glob`), and view your current git diff.
- Create new files, edit existing ones (single find/replace, or several
  find/replace edits to one file batched into a single step), and run
  shell commands.
- If you've configured any [MCP servers](#mcp-servers), call their tools
  too.

**Safety and control:**
- **Approval gates + end-of-run review.** Every file write and terminal
  command still asks for approval before the agent proceeds — but file
  edits no longer land on disk one by one. They're held in memory and
  presented at the end of the run as one **batch review**: a card of
  per-file diffs, each with its own Accept/Reject, plus Accept all /
  Reject all. Rejected files never touch disk at all. The one exception:
  if the agent runs a terminal command mid-run, edits made before that
  point are written first (the command needs real files to act on) —
  those were each individually approved already. Set
  `xpreiIDE.agent.autoApprove` to skip the per-step prompts (the batch
  review still appears; MCP tool calls are also auto-approved, use with
  caution).
- **One-click revert.** Every agent run is checkpointed. **xpreiIDE:
  Revert Last Agent Run** undoes everything it did — restores edited
  files to how they were, deletes any files it created — in one step.
- **Bounds.** `xpreiIDE.agent.maxSteps` caps how many steps a run can
  take before stopping on its own (default: unlimited — it stops only
  when the model says it's done, or you press Stop yourself).
- **Works with any model.** No reliance on a model's built-in
  "function-calling" feature — every model speaks one universal
  text-based tool format, so a small local Ollama model works the same
  way as a large hosted one. That said, agent *quality* still depends on
  the model: a 7B local model won't reason as well as a top hosted one.

## MCP servers

MCP (Model Context Protocol) servers give the agent extra tools beyond
the built-in file/terminal ones — for example, a filesystem server with
its own specialized file-search tools, or a server that talks to some
other system entirely. Configure them by hand-editing
`~/.xpreiide/config.yaml` (the same shared file from
[Adding a hosted / custom model](#adding-a-hosted--custom-model) above):

```yaml
mcpServers:
  filesystem:
    command: npx
    args:
      - -y
      - "@modelcontextprotocol/server-filesystem"
      - /path/to/allowed/directory
```

Once configured, a server's tools are automatically available in **Agent**
mode (not Edit mode, and not Plan mode, which has no tools at all),
labeled `MCP: <tool> (<server>)` in the approval card and step log. Every
MCP tool call requires your approval, exactly like a file write or
terminal command — there's no way to know in advance whether a given MCP
tool is safe, so none are treated as automatically trusted. If a
configured server fails to start (wrong command, crashes immediately),
it's silently skipped — its tools simply won't show up; everything else
keeps working.

## Inline edit (Cmd-K)

Select some code, press **Cmd-K** (Ctrl-K on Windows/Linux), and type an
instruction describing the change you want. The model's proposed rewrite
appears right there in the editor as a red (old)/green (new) diff —
press **Enter** to accept it, **Esc** to reject it and leave your code
untouched.

## Inline chat (Ctrl-I)

A quick way to ask a question without opening the chat panel. Press
**Ctrl-I** (works with or without a selection) and type your question in
the popup box. If you have code selected, xpreiIDE asks about that
selection specifically; otherwise it's a general question. The answer
appears in your chat history, same as if you'd typed it there.

## Quick actions

Right-click selected code (or use the matching slash command in chat —
see [Working with chat](#working-with-chat)) for five one-click prompts:

- **Explain Selection** — what does this code do.
- **Fix Selection** — find and fix bugs in it.
- **Generate Tests for Selection** — write unit tests covering the main
  cases and edge cases.
- **Add Comments to Selection** — add clear comments explaining the
  non-obvious parts.
- **Refactor Selection** — clean it up without changing its behavior.

Each seeds a ready-made prompt into chat with your selection attached, so
you get a good answer without having to write the request yourself.

## Ghost-text completions

As you type, xpreiIDE suggests a completion inline (greyed-out "ghost"
text) — press **Tab** to accept it, like any other inline suggestion in
VS Code. Toggle this on/off with the `xpreiIDE.completions.enabled`
setting.

If your configured completion model is a **FIM-trained code model**
(codellama, deepseek-coder, qwen2.5-coder, codestral, codegemma,
granite-code, starcoder, or similar), xpreiIDE automatically uses
Ollama's native fill-in-the-middle completion for genuinely better
suggestions — no setup needed beyond picking that model. Any other model
falls back to a chat-based completion approach that works with anything,
just at somewhat lower quality.

## Commit message generation

In the Source Control panel, with some changes staged, click the
**Generate Commit Message** button (or run **xpreiIDE: Generate Commit
Message**). The model reads your staged diff and writes a commit message
into the input box for you to review, edit, and commit as usual.

## Settings reference

All under `xpreiIDE.*` in VS Code Settings:

| Setting | Default | What it does |
|---------|---------|---------------|
| `agent.maxSteps` | `0` (unlimited) | Caps how many steps one agent run can take before stopping on its own. |
| `agent.autoApprove` | `false` | Skips the approval prompt for every file write, terminal command, and MCP tool call during agent runs. Use with caution. |
| `agent.protocolRetries` | `2` | How many times the agent retries when a model's reply isn't valid — weaker/local models drift out of the expected format more often. Raise this if you're using a small local model and see frequent protocol-error messages. |
| `completions.enabled` | `true` | Turns ghost-text inline completions on or off. |

Model selections (active chat model, embedding model, per-role overrides)
and provider configuration live in `~/.xpreiide/config.yaml`, not VS
Code settings — see [Adding a hosted / custom model](#adding-a-hosted--custom-model).

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| **Ctrl/Cmd-K** | Inline edit on the current selection |
| **Enter** (while an inline edit diff is showing) | Accept the inline edit |
| **Esc** (while an inline edit diff is showing) | Reject the inline edit |
| **Ctrl-I** | Inline chat popup |

Every other action (selecting a model, rebuilding the index, reverting an
agent run, etc.) is available via the Command Palette (`Ctrl/Cmd-Shift-P`),
searching for "xpreiIDE".

## Architecture (for contributors)

| Layer | Files |
|-------|-------|
| Provider abstraction | `src/providers/provider.ts` |
| Ollama adapter (NDJSON) | `src/providers/ollama.ts` |
| OpenAI-compat adapter (SSE) | `src/providers/openai-compat.ts` |
| Registry + secrets | `src/providers/registry.ts` |
| Shared config store | `src/config/configStore.ts` |
| Chat sidebar | `src/ui/chat/chatView.ts`, `media/chat.*` |
| Context / RAG index | `src/context/*.ts` |
| Inline (Cmd-K) edit | `src/edit/*.ts` |
| Agent loop (tools, ReAct protocol) | `src/agent/*.ts` |
| MCP client | `packages/core/src/mcp/*.ts` (shared `@xprei/core`, not this extension) |
| Activation + commands | `src/extension.ts` |
