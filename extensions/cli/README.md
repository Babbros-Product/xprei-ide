# xpreiIDE CLI

Headless, one-shot usage of the same agent/chat engine that powers the
VS Code extension — useful for CI or no-IDE workflows.

## Install

```bash
npm install -g xprei-cli   # once published
```

## Prerequisites

Requires a `~/.xpreiide/config.yaml` — the same shared config file the
VS Code extension writes when you add a provider there. If you haven't
used the VS Code extension yet, write one by hand:

```yaml
providers:
  - id: ollama-local
    kind: ollama
    label: Ollama (local)
    baseUrl: http://localhost:11434
activeModel: ollama-local::llama3.1
```

For `openai-compat` providers, set an environment variable instead of
storing the key in the config file: `XPREI_APIKEY_<PROVIDERID>`
(provider id uppercased, non-alphanumeric characters replaced with `_`)
— e.g. a provider with `id: openai` reads `XPREI_APIKEY_OPENAI`.

## Usage

```bash
xprei chat "explain this error message"
xprei agent "add a .gitignore for a Node project" --auto-approve
```

Flags (both subcommands):
- `--workspace <path>` — defaults to the current directory.
- `--model <providerId::model>` — defaults to the config file's
  `activeModel`.
- `--config <path>` — defaults to `~/.xpreiide/config.yaml`.

`agent`-only flags:
- `--auto-approve` — skip the y/n approval prompt for every mutating
  tool call. **Required for non-interactive CI use** — without it, a
  run with no TTY to read from will hang waiting for input.
- `--max-steps <n>` — cap the number of agent steps (default:
  unlimited).

Exit code is `0` on success, non-zero on any error or agent-reported
failure — safe to use in a shell script's `&&`/`||` chain or a CI job's
pass/fail check.

## What this is not

No interactive multi-turn REPL, no MCP tool support, no CLI-native
provider-configuration command (`xprei add-provider`, etc.) — v1 assumes
`~/.xpreiide/config.yaml` already exists.
