# Configuring AI models in xpreiIDE

xpreiIDE is bring-your-own-model: nothing is wired to a specific vendor.
Every model — cloud API key or local — is a **provider config** you add
yourself. This doc covers every way to add one and how to embed/use models
day to day.

## Quick path: the gear icon (recommended)

1. Open the xpreiIDE panel (Activity Bar → xpreiIDE icon).
2. Click the **⚙ gear icon** in the top-right of the chat panel.
3. Fill in the "Save provider" form:
   - **Kind** — `OpenAI-compatible` for OpenAI, Gemini, OpenRouter, vLLM,
     LM Studio, Together, or anything exposing `/v1/chat/completions`.
     `Ollama (local)` for a local Ollama install.
   - **Label** — display name, e.g. `OpenAI`, `Gemini`, `My laptop llama3`.
   - **Base URL** — see the table below for common endpoints.
   - **Default model** — optional; a model name to fall back to if the
     provider's `/models` list can't be fetched (useful for endpoints that
     don't implement model listing).
   - **API key** — required for OpenAI-compatible providers, hidden/skipped
     for Ollama.
4. Click **Save provider**. It appears immediately in the model dropdown
   next to Send, grouped by provider.
5. Pick a model from the dropdown — that's your active chat model.

Existing providers show in the same panel with a **Remove** button (deletes
the config and its stored API key).

## Common base URLs

| Provider | Kind | Base URL |
|---|---|---|
| OpenAI | OpenAI-compatible | `https://api.openai.com/v1` |
| Google Gemini | OpenAI-compatible | `https://generativelanguage.googleapis.com/v1beta/openai` |
| OpenRouter | OpenAI-compatible | `https://openrouter.ai/api/v1` |
| Ollama (local) | Ollama | `http://localhost:11434` |
| LM Studio (local) | OpenAI-compatible | `http://localhost:1234/v1` |
| vLLM (self-hosted) | OpenAI-compatible | `http://<host>:8000/v1` |

Gemini and OpenRouter are **not** special-cased in code — they just happen
to expose an OpenAI-compatible `/chat/completions` endpoint, so the same
adapter that talks to OpenAI talks to them.

## Alternative: model dropdown → "+ Add provider…"

The model dropdown itself has a `+ Add provider…` entry at the bottom that
runs the same flow as a Command Palette wizard (QuickPick steps instead of
an inline form). Functionally identical to the gear icon; use whichever is
more comfortable.

## Alternative: Command Palette

- `xpreiIDE: Add Model Provider` — same QuickPick wizard as above.
- `xpreiIDE: Select Model` — switch the active chat model without opening
  the panel.
- `xpreiIDE: Select Embedding Model` — pick the model used for `@codebase`
  RAG indexing (needs a provider with embeddings support, e.g. OpenAI or
  Ollama with `nomic-embed-text`).
- `xpreiIDE: Set Provider API Key` — (re)store a key for a provider that
  already exists in settings.
- `xpreiIDE: Rebuild Codebase Index` — re-index the workspace for
  `@codebase`/`@file` context after adding/changing an embedding model.

## Alternative: raw settings JSON

Providers live in the `xpreiIDE.providers` setting — a plain array, editable
by hand if you prefer:

```json
"xpreiIDE.providers": [
  {
    "id": "ollama-local",
    "kind": "ollama",
    "label": "Ollama (local)",
    "baseUrl": "http://localhost:11434"
  },
  {
    "id": "openai",
    "kind": "openai-compat",
    "label": "OpenAI",
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-4o-mini"
  }
]
```

**API keys never go in this JSON.** They're stored in the OS keychain via
VS Code's `SecretStorage`, set through the gear icon, the add-provider
wizard, or `xpreiIDE: Set Provider API Key` — never as plaintext settings.

`xpreiIDE.activeModel` and `xpreiIDE.embedModel` point at a chosen
`providerId::model` pair; both are normally set for you when you pick from
a dropdown, but can be hand-edited too.

## Running a local model (Ollama)

1. Install Ollama: https://ollama.com
2. Pull a model: `ollama pull llama3.1` (or `qwen2.5-coder`, `deepseek-coder-v2`, etc.)
3. Ollama serves on `http://localhost:11434` by default — the built-in
   `ollama-local` provider config already points there, so a pulled model
   shows up in the dropdown immediately (no key needed).

## Using the model once configured

The chat panel has three modes (buttons next to the model dropdown):

| Mode | What it can do |
|---|---|
| **Plan** | Read-only conversation — discusses/plans, cannot touch files. Fastest, no approval prompts. |
| **Edit** | Runs the agent tool loop restricted to file read/create/edit — no shell access. Mutating actions still ask for approval unless `xpreiIDE.agent.autoApprove` is on. |
| **Agent** | Full autonomous loop: file tools **and** `run_terminal` (e.g. running tests, installing packages). Same approval gate as Edit. |

Switch modes per message — no need to reconfigure anything. The model
dropdown selection applies to all three modes.

## Troubleshooting

- **Model doesn't show up in the dropdown:** the provider's `/models`
  endpoint may have failed (unreachable, wrong base URL, bad key). If you
  set a "Default model" when adding the provider, that name is used as a
  fallback and still shows up; otherwise fix the base URL/key and reopen
  the panel.
- **"No model selected" error in chat:** pick one from the dropdown, or run
  `xpreiIDE: Select Model`.
- **Local Ollama not appearing:** confirm `ollama serve` is running and
  `ollama list` shows at least one pulled model.
