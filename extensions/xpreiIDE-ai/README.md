# xpreiIDE AI

Bring-your-own-model AI assistant for VS Code. Chat with a local **Ollama**
daemon or any **OpenAI-compatible** endpoint (OpenAI, vLLM, LM Studio,
OpenRouter, Together, …). P1 of the xpreiIDE IDE — pure extension, runs on
stock VS Code.

## Run it (dev)

```bash
cd extensions/xpreiIDE-ai
npm install
npm run watch      # esbuild bundles to dist/extension.js, rebuilds on change
```

Then press **F5** in VS Code to launch an Extension Development Host.

## Use

1. Start a model backend — e.g. `ollama serve` and `ollama pull llama3.1`.
2. Open the **xpreiIDE** icon in the activity bar → Chat panel.
3. Run **xpreiIDE: Select Model** (Command Palette) → pick provider → pick model.
4. Type and hit Enter. Tokens stream in.

## Add a hosted / custom model

Edit `xpreiIDE.providers` in Settings (JSON):

```json
[
  { "id": "ollama-local", "kind": "ollama", "label": "Ollama (local)", "baseUrl": "http://localhost:11434" },
  { "id": "openai", "kind": "openai-compat", "label": "OpenAI", "baseUrl": "https://api.openai.com/v1" }
]
```

For `openai-compat` providers, run **xpreiIDE: Set Provider API Key** (stored
in the OS keychain via SecretStorage, never in settings). `baseUrl` must include
the API version segment (e.g. `/v1`).

## Architecture

| Layer | Files |
|-------|-------|
| Provider abstraction | `src/providers/provider.ts` |
| Ollama adapter (NDJSON) | `src/providers/ollama.ts` |
| OpenAI-compat adapter (SSE) | `src/providers/openai-compat.ts` |
| Registry + secrets | `src/providers/registry.ts` |
| Chat sidebar | `src/ui/chat/chatView.ts`, `media/chat.*` |
| Activation + commands | `src/extension.ts` |

Next phases (see the architecture plan): P2 context/RAG, P3 Cmd-K inline edit,
P4 agent loop.
