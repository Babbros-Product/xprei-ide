# Phase 9: CLI extension — design

Date: 2026-07-26

## Context

Phase 9 of `docs/feature-roadmap.md`, sequenced last. A new host,
`extensions/cli`, for headless usage of the same agent/chat engine — "CI
or no-IDE workflows" per the roadmap. Depends on Phase 6 for provider
config (reads `~/.xpreiide/config.yaml` directly) and benefits from
everything else in the backlog being stable.

**Key finding that reshapes scope:** `packages/core/src/server/
sidecarBundle.test.ts` already proves the sidecar (`server/stdio.ts`)
runs standalone via plain `node`, spawned from outside the monorepo. But
the CLI does **not** need to spawn that sidecar as a subprocess and speak
JSON-RPC to it — that indirection exists specifically for other-language
hosts (IntelliJ/Eclipse) that can't import a TypeScript module directly.
The CLI is itself a Node process, so it imports `@xprei/core` directly
in-process, including `packages/core/src/host/nodeHost.ts`'s
`NodeAgentHost` — an already-complete, already-tested, vscode-free
`AgentHost` implementation built for exactly this. Phase 9 is therefore
mostly wiring (config, secrets, terminal I/O, packaging), not new engine
work.

## Decisions

- **Two one-shot subcommands, no interactive REPL in v1.** `xprei agent
  "<task>"` and `xprei chat "<message>"`. The roadmap's own framing ("CI
  or no-IDE workflows") is inherently one-shot — a full multi-turn
  terminal REPL is explicitly deferred as a possible v2, not built now.
- **Direct in-process use of `@xprei/core`, not a sidecar subprocess.**
  `NodeAgentHost` + `OllamaProvider`/`OpenAICompatProvider` + `Agent` are
  imported and driven directly, exactly like `extensions/vscode` does via
  its own `VscodeAgentHost`, just with the Node-native host instead of
  the VS Code one.
- **Config: reads Phase 6's `~/.xpreiide/config.yaml` directly**, via the
  same `parseConfig`/`XpreiConfig` from `@xprei/core`. `--config <path>`
  overrides the default location — both a genuinely useful override for
  real users and a requirement for tests (which must never read or
  mutate the real user's home-directory config).
- **Secrets: environment variables, not OS keychain.** The CLI has no
  `SecretStorage` equivalent and this project takes no OS-keychain
  dependency. `openai-compat` providers read their API key from
  `XPREI_APIKEY_<PROVIDERID>` (provider id uppercased, non-alphanumeric
  characters replaced with `_`) — a standard, dependency-free CLI
  convention. `ollama` providers need no key, unchanged.
- **Approval: a terminal `Approver`, gated by `--auto-approve`.** Default
  behavior prints the tool name + summary to stdout and reads a `y`/`n`
  line from stdin via `node:readline` before running a mutating tool —
  `--auto-approve` skips prompting entirely (required for true
  non-interactive CI use, where there's no TTY to read from). Mirrors VS
  Code's own `agent.autoApprove` setting, CLI-flag-driven instead of
  settings-driven.
- **Plain-text stdout, no TUI/colors in v1.** Step number, thought, tool
  summary, observation, final text — printed as they arrive. Kept simple
  deliberately; a richer terminal UI is a possible follow-up, not
  required by the roadmap's stated use case.
- **Exit codes: 0 on `final`, non-zero on `onError` or an unhandled
  failure** (config load failure, unresolvable model pointer, etc.) — the
  detail CI/shell-script usability actually depends on.
- **Bundled via esbuild, mirroring the existing sidecar build exactly.**
  `build:cli` produces one self-contained `dist/cli.cjs`
  (`--platform=node --format=cjs --target=node18`), no `node_modules`
  needed at runtime — same shape as the already-proven `build:sidecar`
  script.

## Architecture

### `extensions/cli/package.json` (new)

```json
{
  "name": "xprei-cli",
  "version": "0.0.1",
  "bin": { "xprei": "./dist/cli.cjs" },
  "scripts": {
    "build:cli": "esbuild src/cli.ts --bundle --outfile=dist/cli.cjs --platform=node --format=cjs --target=node18",
    "typecheck": "tsc --noEmit",
    "test": "node --import tsx --test src/cli.test.ts"
  },
  "devDependencies": {
    "@xprei/core": "*",
    "@types/node": "^20.0.0",
    "esbuild": "^0.21.0",
    "tsx": "^4.0.0",
    "typescript": "^5.4.0"
  }
}
```

No root `package.json` change needed — its `workspaces` array already
includes `"extensions/*"`.

### `extensions/cli/src/cli.ts` (new) — entrypoint

Hand-rolled argument parsing (no dependency, consistent with this
project's house style; the surface is small):

```typescript
#!/usr/bin/env node

interface ParsedArgs {
  subcommand: "agent" | "chat";
  text: string; // task or message, positional
  workspace: string; // --workspace, default process.cwd()
  model?: string; // --model providerId::model, default from config
  autoApprove: boolean; // --auto-approve
  maxSteps?: number; // --max-steps
  configPath?: string; // --config
}

function parseArgs(argv: string[]): ParsedArgs // throws a descriptive Error on malformed input
```

Loads config (`loadCliConfig(parsed.configPath)`, see below), resolves
the requested (or default) model pointer against the loaded
`ProviderConfig[]`, builds the right `Provider` (reading
`XPREI_APIKEY_<ID>` for `openai-compat`), constructs a `NodeAgentHost`
rooted at `parsed.workspace`, and either:

- **`chat`**: calls `provider.chatStream()` directly with a single user
  message, writes each `delta` to `process.stdout` as it arrives, exits 0
  on the stream's `done`, exits 1 with the error message on stderr on
  failure.
- **`agent`**: constructs `Agent` (from `@xprei/core`) with `host`,
  `approver: new TerminalApprover(autoApprove)`, and `events` that print
  each callback to stdout (`onStep`, `onThought`, `onTool`,
  `onObservation`, `onFinal`, `onError`, `onProtocolError`), then calls
  `agent.run(task)`. Exits 0 after `onFinal` fires, 1 after `onError`.

### `extensions/cli/src/terminalApprover.ts` (new)

```typescript
import * as readline from "node:readline";
import { Approver, Tool } from "@xprei/core";

export class TerminalApprover implements Approver {
  constructor(private readonly autoApprove: boolean) {}

  async approve(tool: Tool, args: Record<string, unknown>): Promise<boolean> {
    if (this.autoApprove) return true;
    process.stdout.write(`\n${tool.name} ${JSON.stringify(args)}\nApprove? [y/N] `);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer: string = await new Promise((resolve) => rl.question("", resolve));
    rl.close();
    return answer.trim().toLowerCase() === "y";
  }
}
```

### `extensions/cli/src/cliConfig.ts` (new)

```typescript
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseConfig, XpreiConfig } from "@xprei/core";

export function defaultConfigPath(): string {
  return path.join(os.homedir(), ".xpreiide", "config.yaml");
}

export async function loadCliConfig(configPath?: string): Promise<XpreiConfig> {
  const p = configPath ?? defaultConfigPath();
  try {
    const content = await fs.readFile(p, "utf8");
    return parseConfig(content).config;
  } catch {
    throw new Error(`No config found at ${p}. Run the VS Code extension once to create it, or write one by hand.`);
  }
}

// "my-provider" -> "XPREI_APIKEY_MY_PROVIDER"
export function apiKeyEnvVar(providerId: string): string {
  return `XPREI_APIKEY_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}
```

Note the CLI's failure mode when no config exists is a clear error, not
a silently-empty default provider list — the CLI has no UI to configure
providers itself in v1, so it points the user at the VS Code extension
(or hand-editing the file) rather than pretending to work with zero
providers.

## Out of scope

- An interactive multi-turn REPL — one-shot `agent`/`chat` only.
- Any CLI-native provider-configuration flow (`xprei add-provider`, etc.)
  — v1 assumes `~/.xpreiide/config.yaml` already exists (created by the
  VS Code extension, or hand-written).
- ANSI colors, progress spinners, or any richer terminal UI than plain
  sequential stdout lines.
- MCP tool support in the CLI's agent mode — not excluded by design, but
  not explicitly wired in this phase; `Agent`'s `tools` override already
  supports it as a follow-up once Phase 7 ships, by concatenating
  `McpManager.getTools()` the same way `runner.ts` does.
- Windows-specific packaging (a signed `.exe`, an installer) — ships as a
  plain Node bin script via `npm`, matching the roadmap's own framing
  ("mirroring Continue's shape").

## Testing

Mirrors `sidecarBundle.test.ts`'s rigor exactly — the actual bundled
artifact, spawned with plain `node`, from a neutral cwd, against a fake
Ollama server (`startFakeOllama`, already in
`packages/core/src/server/_harnessUtil.ts`):

- `sidecar.cjs`-style "bundle exists and is non-trivial" sanity check for
  `dist/cli.cjs`.
- `xprei chat "hi"` against a fake Ollama returning a canned reply:
  stdout contains the full reply text, process exits 0.
- `xprei agent "create hello.txt" --auto-approve` against a fake Ollama
  scripted to call `create_file` then `final`: the file exists on disk in
  the temp workspace afterward with the expected content, process exits
  0, stdout contains the final summary.
- `xprei agent "create hello.txt"` (no `--auto-approve`) with `n\n` piped
  to stdin: the file is confirmed NOT written, process exits with the
  agent's normal "rejected" flow (not a crash).
- `xprei agent ... --config <temp-file-with-a-broken-provider-id>`:
  process exits non-zero with a clear stderr message, not a stack trace.
- `parseArgs`/`apiKeyEnvVar` (pure functions): direct unit tests, no
  process spawn needed — malformed argv (missing positional text, unknown
  flag) throws a descriptive error; `apiKeyEnvVar` normalizes hyphens and
  mixed case correctly.

## User-facing docs

New `extensions/cli/README.md` (install via `npm install -g` from the
package, or `npx`, once published — publishing itself is a separate,
user-driven step like the VS Code Marketplace publish already is):
usage for both subcommands, the config-file dependency on Phase 6's
`~/.xpreiide/config.yaml`, the `XPREI_APIKEY_<ID>` environment-variable
convention, and the `--auto-approve` requirement for CI. Root
`README.md`'s Features/layout description gains a short mention of the
CLI host alongside VS Code/IntelliJ/Eclipse.
