# xpreiIDE AI

Bring-your-own-model AI assistant for VS Code. Chat with a local **Ollama**
daemon or any **OpenAI-compatible** endpoint (OpenAI, vLLM, LM Studio,
OpenRouter, Together, …). A pure extension — no fork, no branded app, runs
on stock VS Code.

## Run it (dev)

This extension is part of an npm-workspaces monorepo; the platform-neutral engine
lives in `@xprei/core` (`packages/core`). Install from the **repo root**:

```bash
npm install                          # repo root — links @xprei/core
npm run watch -w xpreiIDE-ai         # esbuild bundles dist/extension.js, rebuilds on change
```

Then press **F5** in VS Code to launch an Extension Development Host.

## Use

1. Start a model backend — e.g. `ollama serve` and `ollama pull llama3.1`.
2. Open the **xpreiIDE** icon in the activity bar → Chat panel.
3. If a local Ollama daemon is already running, xpreiIDE detects it on
   startup and sets it up automatically — or offers to, if you have more
   than one model installed (accept the prompt and pick one). Otherwise
   run **xpreiIDE: Select Model** (Command Palette) → pick provider → pick
   model.
4. Type and hit Enter. Tokens stream in.

## Automatic Ollama setup

When no chat model is configured yet, xpreiIDE checks on startup whether a
local Ollama daemon is running at `http://localhost:11434`. If it finds
one:

- **One model installed** — it's selected automatically, and a notification
  tells you which.
- **Several installed** — a notification offers to use Ollama; accept it
  and pick a model from the list.
- **Ollama running, no models pulled** — a notification suggests running
  `ollama pull llama3.1`.

If Ollama isn't running, nothing happens at all — no prompt, no error. The
check stops entirely once a chat model is set, and you can always change
the model later with **xpreiIDE: Select Model**.

## Add a hosted / custom model

Use **xpreiIDE: Add Provider** for guided setup (a preset list plus a
"Custom…" option), or hand-edit the shared config file at
`~/.xpreiide/config.yaml` (the same file the IntelliJ and Eclipse
plugins read, if you use those too):

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

For `openai-compat` providers, run **xpreiIDE: Set Provider API Key**
(stored in the OS keychain via SecretStorage, never in the config file).
`baseUrl` must include the API version segment (e.g. `/v1`).

## Per-role models

By default, chat, completions, the agent, inline edit (Cmd-K), and commit-
message generation all use whatever model **xpreiIDE: Select Model** set
for chat. To use a different model for one of them — e.g. a small, fast
local model for completions while a larger model drives the agent — run
**xpreiIDE: Select Model for Role...**, pick a role, then pick a provider
and model as usual. Roles left unconfigured keep following the chat model
automatically; running the command again on a role you've already
overridden offers a **"Clear override"** option to revert it back to
following chat.

## Architecture

| Layer | Files |
|-------|-------|
| Provider abstraction | `src/providers/provider.ts` |
| Ollama adapter (NDJSON) | `src/providers/ollama.ts` |
| OpenAI-compat adapter (SSE) | `src/providers/openai-compat.ts` |
| Registry + secrets | `src/providers/registry.ts` |
| Chat sidebar | `src/ui/chat/chatView.ts`, `media/chat.*` |
| Context / RAG index | `src/context/*.ts` |
| Inline (Cmd-K) edit | `src/edit/*.ts` |
| Agent loop (tools, ReAct protocol) | `src/agent/*.ts` |
| Activation + commands | `src/extension.ts` |

## Codebase context (@mentions)

Set an embedding model (**xpreiIDE: Select Embedding Model**, e.g.
`ollama-local::nomic-embed-text`), run **xpreiIDE: Rebuild Codebase Index**, then
in chat use `@codebase <question>` for semantic retrieval or `@file:src/x.ts` to
inline a specific file. The index updates as you edit.

Six more mentions need no indexing at all:
- **`@open`** — inline every file you currently have open in an editor tab
  (including background tabs you're not looking at right now).
- **`@problems`** — inline the current error/warning diagnostics for your
  open files, so the model can see what's broken without you pasting it in.
- **`@diff`** — inline your current git diff (staged and unstaged
  changes combined), so the model can review or explain your in-progress
  work without you copy-pasting a diff.
- **`@terminal:<command>`** — run a shell command and inline its output,
  e.g. `why did this fail @terminal:npm test`. You'll be asked to confirm
  before it runs — this is the only mention that executes anything.
  **`@terminal:` must be the last thing in your message**: everything
  after the colon, to the end of the text, is treated as the command.
- **`@url:<address>`** — fetch a public URL and inline its content (HTML
  pages are stripped down to readable text), e.g.
  `@url:https://example.com/docs summarize this`. For safety, addresses
  that resolve to your own machine or local network (localhost, private
  IP ranges, cloud metadata endpoints) are silently ignored — if `@url:`
  contributes nothing, that's why.
- **`@repomap`** — inline a lightweight overview of exported/public
  top-level symbols (functions, classes, etc.) across your workspace's
  TypeScript, JavaScript, and Python files, so the model gets a sense of
  what's where without you opening every file. It's a regex-based
  summary, not a full dependency graph — other languages and re-exported/
  aliased symbols aren't covered.

Combine any of these in one message, e.g. `@diff @problems review my changes`.

## Project instructions & ignore file

Two optional dotfiles at your workspace root, both read fresh every
time they're needed (no caching, no reload required):

- **`.xpreiIDErules`** — plain text, injected into every chat/edit/agent
  system prompt as extra project-specific instructions.
- **`.xpreiIDEignore`** — one pattern per line, `.gitignore`-lite syntax
  (`#` comments, blank lines ignored, `*` within a path segment, `**`
  across segments, a pattern containing `/` anchors to the workspace
  root, a pattern without `/` matches at any depth). Adds to, not
  replaces, the indexer's built-in exclusions (`node_modules`, `.git`,
  `dist`, and similar are always excluded regardless of this file).
  Affects the codebase index, `@open`, and `@repomap` — **not** the
  agent's `grep`/`glob` tools. Not a full `.gitignore` implementation:
  `!` negation and backslash escaping aren't supported.

## MCP servers

Configure MCP (Model Context Protocol) servers by hand-editing
`~/.xpreiide/config.yaml` (the same shared config file providers live
in — see "Add a hosted / custom model" above):

```yaml
mcpServers:
  filesystem:
    command: npx
    args:
      - -y
      - "@modelcontextprotocol/server-filesystem"
      - /path/to/allowed/directory
```

Each configured server's tools are automatically available to the agent
loop (Agent mode only — not Edit mode, and not Plan mode, which has no
tools at all), named `mcp__<server>__<tool>` in the approval card and
tool-call log. Every MCP tool call requires approval, the same as any
other mutating tool — there's no way to know an MCP tool's side effects
in advance, so none are treated as auto-safe. A server that fails to
start (bad command, crash during startup) is silently skipped; its
tools simply won't appear.

## Inline edit (Cmd-K)

Select code, press **Cmd-K** (Ctrl-K on Windows/Linux), type an instruction. The
model's rewrite appears as an inline red(old)/green(new) diff — **Enter** accepts,
**Esc** rejects.

## Agent (autonomous multi-file)

Tick **Agent** in the chat composer, describe a task (e.g. *"add a /health route
and a test"*), and Send. The agent runs a tool loop — `read_file`, `read_file_range`,
`list_dir`, `grep`, `glob_search`, `view_diff`, `create_file`, `edit_file`,
`run_terminal` — one step at a time, streaming its thoughts, tool calls, and
observations into the transcript.

- **Universal protocol.** No reliance on native function-calling: every model
  speaks one JSON tool protocol (`src/agent/protocol.ts`), so local Ollama models
  work the same as hosted ones. Agent quality is still model-gated — a 7B local
  model is not GPT-4-class.
- **Approval gates.** File writes and terminal commands prompt for approval
  (**Approve** / **Approve all**). Set `xpreiIDE.agent.autoApprove` to skip.
- **Revert.** Every run is checkpointed; **xpreiIDE: Revert Last Agent Run** undoes
  all of its file changes (restores edits, deletes new files).
- **Bounds.** `xpreiIDE.agent.maxSteps` (default 0 = unlimited; stops only when
  the model finishes or you hit Stop) caps a run if you set it.
