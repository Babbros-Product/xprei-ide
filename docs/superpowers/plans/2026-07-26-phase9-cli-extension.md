# Phase 9: CLI Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new `extensions/cli` package providing `xprei agent "<task>"`
and `xprei chat "<message>"` — headless, one-shot usage of the same
agent/chat engine, for CI or no-IDE workflows.

**Architecture:** The CLI is itself a Node process, so it imports
`@xprei/core` directly in-process — `NodeAgentHost`, `Agent`,
`OllamaProvider`/`OpenAICompatProvider` — with no sidecar subprocess
indirection (that indirection exists only for non-Node hosts like
IntelliJ/Eclipse). It reads Phase 6's shared `~/.xpreiide/config.yaml`
directly, resolves API keys from `XPREI_APIKEY_<ID>` environment
variables, and gates mutating tool calls behind a terminal y/n prompt
unless `--auto-approve` is passed. Bundled via esbuild into one
self-contained `dist/cli.cjs`, mirroring `packages/core`'s existing
`build:sidecar` script exactly.

**Tech Stack:** TypeScript, `node:child_process`, `node:readline`,
`node:fs`/`node:os`/`node:path`, Node's built-in `node:test` +
`assert/strict`.

## Global Constraints

- **Two one-shot subcommands only** — `agent` and `chat`. No interactive
  REPL.
- **Direct in-process use of `@xprei/core`**, not a spawned sidecar
  subprocess. The CLI must NOT import anything from
  `packages/core/src/server/stdio.ts` or `.../session.ts` — both are the
  sidecar's own bespoke JSON-RPC protocol layer, irrelevant here, and
  `stdio.ts` specifically has a top-level auto-start side effect
  (`if (require.main === module) startStdioServer();`) that must never
  fire from code that merely imports one of its exports.
- **Config: reads `~/.xpreiide/config.yaml` directly** via
  `@xprei/core`'s `parseConfig`. `--config <path>` overrides the default
  location.
- **Secrets: `XPREI_APIKEY_<PROVIDERID>` environment variables**
  (provider id uppercased, non-alphanumeric replaced with `_`) for
  `openai-compat` providers. `ollama` providers need no key.
- **Approval: a terminal y/n prompt, gated by `--auto-approve`.**
  Required for true non-interactive CI use.
- **Exit codes: 0 on success (`final`/stream end), non-zero on
  `onError` or an unhandled failure** (config load failure, unresolvable
  model pointer).
- **Bundled via esbuild** into one self-contained `dist/cli.cjs`
  (`--bundle --platform=node --format=cjs --target=node18`), mirroring
  `packages/core/package.json`'s existing `build:sidecar` script exactly:
  `"esbuild src/server/stdio.ts --bundle --outfile=dist/sidecar.cjs --platform=node --format=cjs --target=node18"`.
- **Cross-package test helpers are not imported by deep relative path.**
  `packages/core/src/server/_harnessUtil.ts` (which has `startFakeOllama`)
  is a test-only file, not barrel-exported from `@xprei/core`, and every
  existing cross-package import in this codebase goes through the public
  `@xprei/core` barrel — never a deep relative path into another
  workspace package's `src/`. This plan's end-to-end test therefore
  defines its own small fake-Ollama-server helper directly inside
  `extensions/cli`, rather than reaching into `packages/core`'s test
  internals.
- **Commits:** author `xpreiIDE <mbsajay1@gmail.com>` — pass it
  explicitly, e.g. `git -c user.name="xpreiIDE" -c
  user.email="mbsajay1@gmail.com" commit -m "..."`. **Do NOT add a
  `Co-Authored-By` footer or any other footer.** Conventional Commit
  prefixes (feat/docs/etc).
- **No root `package.json` change needed** — its `workspaces` array is
  already `["packages/*", "extensions/*"]`, which auto-discovers
  `extensions/cli`.

---

### Task 1: Package scaffolding

**Files:**
- Create: `extensions/cli/package.json`
- Create: `extensions/cli/tsconfig.json`

**Interfaces:** none — no code yet, just the workspace member
definition Tasks 2-5 build inside.

- [ ] **Step 1: Create `extensions/cli/package.json`**

```json
{
  "name": "xprei-cli",
  "version": "0.0.1",
  "description": "Headless CLI for xpreiIDE — one-shot agent/chat runs for CI or no-IDE workflows.",
  "license": "MIT",
  "bin": {
    "xprei": "./dist/cli.cjs"
  },
  "scripts": {
    "build:cli": "esbuild src/cli.ts --bundle --outfile=dist/cli.cjs --platform=node --format=cjs --target=node18",
    "typecheck": "tsc --noEmit",
    "test": "node --import tsx --test src/parseArgs.test.ts src/cliConfig.test.ts"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@xprei/core": "*",
    "esbuild": "^0.21.0",
    "tsx": "^4.0.0",
    "typescript": "^5.4.0"
  }
}
```

The `test` script's file list is deliberately incomplete for now — Task
5 adds the end-to-end test file to it.

- [ ] **Step 2: Create `extensions/cli/tsconfig.json`**

Mirrors `extensions/vscode/tsconfig.json`'s shape exactly (confirmed by
reading that file):

```json
{
  "compilerOptions": {
    "module": "Node16",
    "moduleResolution": "Node16",
    "target": "ES2022",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "sourceMap": true,
    "resolveJsonModule": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Install dependencies from the repo root**

Run (from the repo root, not `extensions/cli`): `npm install`
Expected: npm links `@xprei/core` into `extensions/cli/node_modules`
via the workspace protocol, same as it already does for
`extensions/vscode`.

- [ ] **Step 4: Commit**

```bash
git add extensions/cli/package.json extensions/cli/tsconfig.json
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "chore(cli): scaffold the extensions/cli workspace package"
```

---

### Task 2: `cliConfig.ts` — config loading, arg parsing, API key env var — pure, unit tested

**Files:**
- Create: `extensions/cli/src/cliConfig.ts`
- Create: `extensions/cli/src/cliConfig.test.ts`
- Create: `extensions/cli/src/parseArgs.ts`
- Create: `extensions/cli/src/parseArgs.test.ts`

**Interfaces:**
- Consumes: `parseConfig`, `XpreiConfig` from `@xprei/core` (already
  exist, Phase 6).
- Produces: `defaultConfigPath(): string`, `loadCliConfig(configPath?:
  string): Promise<XpreiConfig>`, `apiKeyEnvVar(providerId: string):
  string` (in `cliConfig.ts`); `parseArgs(argv: string[]): ParsedArgs`
  where `ParsedArgs { subcommand: "agent" | "chat"; text: string;
  workspace: string; model?: string; autoApprove: boolean; maxSteps?:
  number; configPath?: string }` (in `parseArgs.ts`) — Task 4 consumes
  all of these.

- [ ] **Step 1: Write the failing `parseArgs` tests**

Create `extensions/cli/src/parseArgs.test.ts`:

```typescript
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "./parseArgs";

test("parseArgs parses a minimal agent invocation", () => {
  const parsed = parseArgs(["agent", "create a hello world file"]);
  assert.equal(parsed.subcommand, "agent");
  assert.equal(parsed.text, "create a hello world file");
  assert.equal(parsed.autoApprove, false);
  assert.equal(parsed.workspace, process.cwd());
});

test("parseArgs parses a minimal chat invocation", () => {
  const parsed = parseArgs(["chat", "hello there"]);
  assert.equal(parsed.subcommand, "chat");
  assert.equal(parsed.text, "hello there");
});

test("parseArgs reads --workspace, --model, --auto-approve, --max-steps, --config", () => {
  const parsed = parseArgs([
    "agent",
    "do the thing",
    "--workspace",
    "/tmp/myproject",
    "--model",
    "ollama-local::llama3.1",
    "--auto-approve",
    "--max-steps",
    "10",
    "--config",
    "/tmp/config.yaml",
  ]);
  assert.equal(parsed.workspace, "/tmp/myproject");
  assert.equal(parsed.model, "ollama-local::llama3.1");
  assert.equal(parsed.autoApprove, true);
  assert.equal(parsed.maxSteps, 10);
  assert.equal(parsed.configPath, "/tmp/config.yaml");
});

test("parseArgs throws a descriptive error when the subcommand is missing", () => {
  assert.throws(() => parseArgs([]), /subcommand/i);
});

test("parseArgs throws a descriptive error for an unknown subcommand", () => {
  assert.throws(() => parseArgs(["frobnicate", "text"]), /unknown subcommand/i);
});

test("parseArgs throws a descriptive error when the positional task/message text is missing", () => {
  assert.throws(() => parseArgs(["agent"]), /text/i);
});

test("parseArgs throws a descriptive error for an unrecognized flag", () => {
  assert.throws(() => parseArgs(["agent", "task", "--bogus-flag"]), /unknown (option|flag)/i);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `extensions/cli`): `node --import tsx --test src/parseArgs.test.ts`
Expected: FAIL — `./parseArgs` doesn't exist yet.

- [ ] **Step 3: Implement `parseArgs.ts`**

Create `extensions/cli/src/parseArgs.ts`:

```typescript
// Hand-rolled argument parsing for the `xprei` CLI — no dependency, the
// surface is small (one positional argument plus five flags across two
// subcommands).

export interface ParsedArgs {
  subcommand: "agent" | "chat";
  text: string;
  workspace: string;
  model?: string;
  autoApprove: boolean;
  maxSteps?: number;
  configPath?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [subcommandRaw, ...rest] = argv;
  if (!subcommandRaw) {
    throw new Error("Missing subcommand. Usage: xprei <agent|chat> \"<text>\" [options]");
  }
  if (subcommandRaw !== "agent" && subcommandRaw !== "chat") {
    throw new Error(`Unknown subcommand "${subcommandRaw}". Expected "agent" or "chat".`);
  }
  const subcommand = subcommandRaw;

  let text: string | undefined;
  let workspace = process.cwd();
  let model: string | undefined;
  let autoApprove = false;
  let maxSteps: number | undefined;
  let configPath: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--auto-approve") {
      autoApprove = true;
      continue;
    }
    if (arg === "--workspace") {
      workspace = requireValue(rest, i, "--workspace");
      i++;
      continue;
    }
    if (arg === "--model") {
      model = requireValue(rest, i, "--model");
      i++;
      continue;
    }
    if (arg === "--max-steps") {
      const raw = requireValue(rest, i, "--max-steps");
      i++;
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`--max-steps expects a number, got "${raw}"`);
      maxSteps = n;
      continue;
    }
    if (arg === "--config") {
      configPath = requireValue(rest, i, "--config");
      i++;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown option "${arg}".`);
    }
    if (text === undefined) {
      text = arg;
    } else {
      throw new Error(`Unexpected extra positional argument "${arg}". Did you forget to quote the text?`);
    }
  }

  if (!text) {
    throw new Error(`Missing task/message text. Usage: xprei ${subcommand} "<text>" [options]`);
  }

  return { subcommand, text, workspace, model, autoApprove, maxSteps, configPath };
}

function requireValue(rest: string[], i: number, flag: string): string {
  const value = rest[i + 1];
  if (value === undefined) throw new Error(`${flag} requires a value.`);
  return value;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `extensions/cli`): `node --import tsx --test src/parseArgs.test.ts`
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Write the failing `cliConfig` tests**

Create `extensions/cli/src/cliConfig.test.ts`:

```typescript
import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { apiKeyEnvVar, loadCliConfig } from "./cliConfig";

test("apiKeyEnvVar uppercases and normalizes non-alphanumeric characters", () => {
  assert.equal(apiKeyEnvVar("my-provider"), "XPREI_APIKEY_MY_PROVIDER");
  assert.equal(apiKeyEnvVar("OpenAI"), "XPREI_APIKEY_OPENAI");
  assert.equal(apiKeyEnvVar("provider.v2"), "XPREI_APIKEY_PROVIDER_V2");
});

test("loadCliConfig reads a real config file at a given path", async () => {
  const tmp = path.join(os.tmpdir(), `xprei-cli-test-${Date.now()}.yaml`);
  await fs.writeFile(
    tmp,
    "providers:\n  - id: test-provider\n    kind: ollama\n    label: Test\n    baseUrl: http://localhost:11434\n" +
      "activeModel: test-provider::llama3.1\n",
    "utf8",
  );
  try {
    const config = await loadCliConfig(tmp);
    assert.equal(config.providers.length, 1);
    assert.equal(config.providers[0].id, "test-provider");
    assert.equal(config.activeModel, "test-provider::llama3.1");
  } finally {
    await fs.rm(tmp, { force: true });
  }
});

test("loadCliConfig throws a clear error when the config file doesn't exist", async () => {
  const missingPath = path.join(os.tmpdir(), `xprei-cli-test-missing-${Date.now()}.yaml`);
  await assert.rejects(() => loadCliConfig(missingPath), /No config found/);
});
```

- [ ] **Step 6: Run the tests to verify they fail**

Run (from `extensions/cli`): `node --import tsx --test src/cliConfig.test.ts`
Expected: FAIL — `./cliConfig` doesn't exist yet.

- [ ] **Step 7: Implement `cliConfig.ts`**

Create `extensions/cli/src/cliConfig.ts`:

```typescript
// Reads the shared ~/.xpreiide/config.yaml (or an explicit --config
// path) and resolves openai-compat API keys from environment variables
// — the CLI has no OS-keychain equivalent to VS Code's SecretStorage.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseConfig, XpreiConfig } from "@xprei/core";

export function defaultConfigPath(): string {
  return path.join(os.homedir(), ".xpreiide", "config.yaml");
}

// Unlike VS Code's loadConfig() (which silently defaults to an empty/
// default config when the file is missing), the CLI has no UI to
// configure providers itself — a missing config is a clear, actionable
// error, not a silently-empty provider list.
export async function loadCliConfig(configPath?: string): Promise<XpreiConfig> {
  const p = configPath ?? defaultConfigPath();
  let content: string;
  try {
    content = await fs.readFile(p, "utf8");
  } catch {
    throw new Error(
      `No config found at ${p}. Run the VS Code extension once to create it, or write one by hand.`,
    );
  }
  return parseConfig(content).config;
}

// "my-provider" -> "XPREI_APIKEY_MY_PROVIDER"
export function apiKeyEnvVar(providerId: string): string {
  return `XPREI_APIKEY_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run (from `extensions/cli`): `node --import tsx --test src/cliConfig.test.ts`
Expected: PASS — all 3 tests green.

- [ ] **Step 9: Run both test files together and typecheck**

Run (from `extensions/cli`): `npm test`
Expected: PASS — 10 tests total (7 `parseArgs.test.ts` + 3
`cliConfig.test.ts`).

Run: `npm run typecheck -w xprei-cli`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add extensions/cli/src/parseArgs.ts extensions/cli/src/parseArgs.test.ts extensions/cli/src/cliConfig.ts extensions/cli/src/cliConfig.test.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(cli): add argument parsing and shared-config loading"
```

---

### Task 3: `terminalApprover.ts`

**Files:**
- Create: `extensions/cli/src/terminalApprover.ts`

**Interfaces:**
- Consumes: `Approver`, `Tool` from `@xprei/core`.
- Produces: `class TerminalApprover implements Approver` — Task 4
  consumes this.

**Note:** no unit test for this file — it does real terminal I/O
(`process.stdin`/`process.stdout` via `readline`), which this project's
convention (established for every VS Code-layer UI file) doesn't unit
test. It's exercised by Task 5's end-to-end test instead (via
`--auto-approve`, which bypasses the prompt entirely, and a
no-`--auto-approve` case piping a scripted `n` answer to stdin).

- [ ] **Step 1: Implement `terminalApprover.ts`**

Create `extensions/cli/src/terminalApprover.ts`:

```typescript
// Terminal approval gate for mutating agent tool calls. Prints the tool
// name and arguments, reads a y/n line from stdin — unless
// --auto-approve was passed, in which case every call is approved
// without prompting (required for non-interactive CI use, where
// there's no TTY to read from).

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

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck -w xprei-cli`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add extensions/cli/src/terminalApprover.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(cli): add TerminalApprover for interactive/non-interactive approval"
```

---

### Task 4: `cli.ts` — the entrypoint

**Files:**
- Create: `extensions/cli/src/cli.ts`

**Interfaces:**
- Consumes: `parseArgs` (Task 2), `loadCliConfig`/`apiKeyEnvVar` (Task
  2), `TerminalApprover` (Task 3); `NodeAgentHost`, `Agent`,
  `AgentEvents`, `OllamaProvider`, `OpenAICompatProvider`, `Provider`,
  `ProviderConfig` from `@xprei/core`.
- Produces: the `xprei` bin entrypoint — no other task consumes this
  directly (it's the leaf that wires everything together).

**Note:** no unit test for this file — it's the entrypoint itself,
driving real process I/O (`process.argv`, `process.exit`, `console`);
exercised end-to-end by Task 5.

- [ ] **Step 1: Implement `cli.ts`**

Create `extensions/cli/src/cli.ts`:

```typescript
#!/usr/bin/env node

import { Agent, AgentEvents, NodeAgentHost, OllamaProvider, OpenAICompatProvider, Provider, ProviderConfig } from "@xprei/core";
import { apiKeyEnvVar, loadCliConfig } from "./cliConfig";
import { parseArgs } from "./parseArgs";
import { TerminalApprover } from "./terminalApprover";

function buildProvider(cfg: ProviderConfig): Provider {
  if (cfg.kind === "ollama") return new OllamaProvider(cfg);
  const key = process.env[apiKeyEnvVar(cfg.id)] ?? "";
  return new OpenAICompatProvider(cfg, key);
}

function parsePointer(pointer: string): { providerId: string; model: string } | undefined {
  const sep = pointer.indexOf("::");
  if (sep < 0) return undefined;
  const providerId = pointer.slice(0, sep);
  const model = pointer.slice(sep + 2);
  if (!providerId || !model) return undefined;
  return { providerId, model };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const config = await loadCliConfig(parsed.configPath);

  const pointer = parsed.model ?? config.activeModel;
  const resolved = parsePointer(pointer);
  if (!resolved) {
    throw new Error(
      `No usable model. Pass --model providerId::model, or set activeModel in the config file.`,
    );
  }
  const cfg = config.providers.find((c) => c.id === resolved.providerId);
  if (!cfg) {
    throw new Error(`Unknown provider "${resolved.providerId}" in ${pointer}.`);
  }
  const provider = buildProvider(cfg);

  if (parsed.subcommand === "chat") {
    for await (const chunk of provider.chatStream({
      model: resolved.model,
      messages: [{ role: "user", content: parsed.text }],
    })) {
      process.stdout.write(chunk.delta);
      if (chunk.done) break;
    }
    process.stdout.write("\n");
    return;
  }

  // subcommand === "agent"
  const host = new NodeAgentHost(parsed.workspace);
  let failed = false;
  const events: AgentEvents = {
    onStep: (n) => console.log(`\n[step ${n}]`),
    onThought: (text) => console.log(`thought: ${text}`),
    onTool: (name, args) => console.log(`tool: ${name} ${JSON.stringify(args)}`),
    onObservation: (text) => console.log(`observation: ${text}`),
    onFinal: (text) => console.log(`\nfinal: ${text}`),
    onError: (text) => {
      failed = true;
      console.error(`error: ${text}`);
    },
    onProtocolError: (attempt, maxAttempts, reason) =>
      console.log(`protocol error (attempt ${attempt}/${maxAttempts}): ${reason}`),
  };

  const agent = new Agent({
    provider,
    model: resolved.model,
    host,
    approver: new TerminalApprover(parsed.autoApprove),
    events,
    maxSteps: parsed.maxSteps,
  });

  await agent.run(parsed.text);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck -w xprei-cli`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add extensions/cli/src/cli.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(cli): wire the xprei agent/chat entrypoint"
```

---

### Task 5: Bundle + end-to-end tests against the real bundled artifact

**Files:**
- Create: `extensions/cli/src/_fakeOllama.ts` (test-only helper — this
  package's own fake Ollama server, NOT imported from
  `packages/core`'s test internals; see this plan's Global Constraints)
- Create: `extensions/cli/src/cli.e2e.test.ts`
- Modify: `extensions/cli/package.json` (register the new test file)

**Interfaces:**
- Consumes: the bundled `dist/cli.cjs` (built by this task's own Step
  1), spawned as a real child process.

- [ ] **Step 1: Build the bundle**

Run (from `extensions/cli`): `npm run build:cli`
Expected: produces `extensions/cli/dist/cli.cjs`.

- [ ] **Step 2: Write `_fakeOllama.ts`, a minimal fake Ollama daemon**

Create `extensions/cli/src/_fakeOllama.ts`:

```typescript
// Test-only fake Ollama daemon, local to this package (deliberately not
// imported from packages/core's test internals — see this plan's Global
// Constraints on cross-package test-helper imports). Serves GET
// /api/tags and POST /api/chat (NDJSON), replaying a queue of scripted
// assistant replies.

import * as http from "node:http";

export function startFakeOllama(replies: string[]): Promise<{ url: string; close: () => Promise<void> }> {
  let call = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/api/tags") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "fake-model" }] }));
      return;
    }
    if (req.url === "/api/chat") {
      const reply = replies[Math.min(call++, replies.length - 1)];
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(JSON.stringify({ message: { role: "assistant", content: reply }, done: false }) + "\n");
      res.end(JSON.stringify({ message: { role: "assistant", content: "" }, done: true }) + "\n");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
```

- [ ] **Step 3: Write the end-to-end tests**

Create `extensions/cli/src/cli.e2e.test.ts`:

```typescript
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startFakeOllama } from "./_fakeOllama";

const execFileAsync = promisify(execFile);
const cliPath = path.join(__dirname, "..", "dist", "cli.cjs");

async function tmpWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "xprei-cli-e2e-"));
}

async function writeConfig(baseUrl: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xprei-cli-config-"));
  const p = path.join(dir, "config.yaml");
  await fs.writeFile(
    p,
    `providers:\n  - id: fake\n    kind: ollama\n    label: Fake\n    baseUrl: ${baseUrl}\n` +
      `activeModel: fake::fake-model\n`,
    "utf8",
  );
  return p;
}

test("xprei chat streams the reply to stdout and exits 0", async () => {
  const ollama = await startFakeOllama(["Hello from the CLI!"]);
  const configPath = await writeConfig(ollama.url);
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      cliPath,
      "chat",
      "hi",
      "--config",
      configPath,
    ]);
    assert.match(stdout, /Hello from the CLI!/);
  } finally {
    await ollama.close();
  }
});

test("xprei agent --auto-approve writes a file and exits 0", async () => {
  const ollama = await startFakeOllama([
    JSON.stringify({ tool: "create_file", args: { path: "hello.txt", content: "from the cli" } }),
    JSON.stringify({ final: "done" }),
  ]);
  const configPath = await writeConfig(ollama.url);
  const ws = await tmpWorkspace();
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      cliPath,
      "agent",
      "create hello.txt",
      "--config",
      configPath,
      "--workspace",
      ws,
      "--auto-approve",
    ]);
    assert.match(stdout, /final: done/);
    const written = await fs.readFile(path.join(ws, "hello.txt"), "utf8");
    assert.equal(written, "from the cli");
  } finally {
    await ollama.close();
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("xprei agent without --auto-approve does not write when the user answers 'n'", async () => {
  const ollama = await startFakeOllama([
    JSON.stringify({ tool: "create_file", args: { path: "hello.txt", content: "from the cli" } }),
    JSON.stringify({ final: "done" }),
  ]);
  const configPath = await writeConfig(ollama.url);
  const ws = await tmpWorkspace();
  try {
    const child = execFileAsync(process.execPath, [
      cliPath,
      "agent",
      "create hello.txt",
      "--config",
      configPath,
      "--workspace",
      ws,
    ]);
    child.child.stdin?.write("n\n");
    child.child.stdin?.end();
    await child;
    await assert.rejects(() => fs.readFile(path.join(ws, "hello.txt"), "utf8"));
  } finally {
    await ollama.close();
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("xprei agent with a broken --config exits non-zero with a clear message, not a stack trace", async () => {
  const ws = await tmpWorkspace();
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [
        cliPath,
        "agent",
        "do something",
        "--config",
        path.join(ws, "does-not-exist.yaml"),
        "--workspace",
        ws,
      ]),
      (err: unknown) => {
        const e = err as { code?: number; stderr?: string };
        return e.code === 1 && typeof e.stderr === "string" && /No config found/.test(e.stderr);
      },
    );
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `extensions/cli`):
`node --import tsx --test src/cli.e2e.test.ts`
Expected: PASS — all 4 tests green. If the third test (piping `n\n`)
fails because `child.child` isn't accessible on the promisified
`execFileAsync` result the way assumed above, adjust to use plain
`child_process.execFile` directly (not promisified) for that one test,
writing to `.stdin` and wrapping the callback in a `new Promise` — the
promisified form's `.child` property availability depends on the exact
Node version's `util.promisify` behavior for `child_process.execFile`,
so verify this against the actual test run rather than assuming.

- [ ] **Step 5: Register the new test file**

In `extensions/cli/package.json`, update the `test` script to:

```json
"test": "node --import tsx --test src/parseArgs.test.ts src/cliConfig.test.ts src/cli.e2e.test.ts"
```

- [ ] **Step 6: Run the full package test suite**

Run (from `extensions/cli`): `npm test`
Expected: PASS — 14 tests total (7 `parseArgs.test.ts` + 3
`cliConfig.test.ts` + 4 `cli.e2e.test.ts`).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck -w xprei-cli`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add extensions/cli/src/_fakeOllama.ts extensions/cli/src/cli.e2e.test.ts extensions/cli/package.json
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "test(cli): add end-to-end tests against the real bundled dist/cli.cjs"
```

---

### Task 6: User-facing docs

**Files:**
- Create: `extensions/cli/README.md`
- Modify: `README.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Create `extensions/cli/README.md`**

```markdown
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
```

- [ ] **Step 2: Add a CLI mention to root `README.md`**

Find the description of the multi-IDE layout (search for `IntelliJ` or
`Eclipse` near the top of the file, describing the supported hosts) and
add a short mention of the CLI alongside them — the exact insertion
point depends on the current wording, so read the file first rather
than assuming an exact anchor string.

- [ ] **Step 3: Proofread both files**

Read both back in full and confirm no broken Markdown and that the
`--auto-approve` CI requirement is clearly stated.

- [ ] **Step 4: Commit**

```bash
git add extensions/cli/README.md README.md
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "docs: add extensions/cli README, mention the CLI host in root README"
```

---

### Task 7: Final verification

**Files:** none (verification only).

**Interfaces:** none — consumes everything built in Tasks 1-6.

- [ ] **Step 1: Run the full core test suite (confirm no regression)**

Run: `npm test -w @xprei/core`
Expected: PASS — 263 tests (unchanged by this phase — the CLI is a new,
independent workspace package; it doesn't modify `@xprei/core`).

- [ ] **Step 2: Typecheck core**

Run: `npm run typecheck -w @xprei/core`
Expected: PASS.

- [ ] **Step 3: Typecheck and compile the VS Code extension (confirm no regression)**

Run: `npm run typecheck -w xpreiIDE-ai` then
`npm run compile -w xpreiIDE-ai`
Expected: both PASS.

- [ ] **Step 4: Run the CLI package's own test suite**

Run: `npm test -w xprei-cli`
Expected: PASS — 14 tests.

- [ ] **Step 5: Typecheck the CLI package**

Run: `npm run typecheck -w xprei-cli`
Expected: PASS.

- [ ] **Step 6: Rebuild the CLI bundle fresh, confirm it's self-contained**

Run (from `extensions/cli`): `rm -rf dist && npm run build:cli`
Then confirm `dist/cli.cjs` exists and is a single file (no
`node_modules` directory created alongside it):

Run: `ls extensions/cli/dist`
Expected: exactly `cli.cjs`, nothing else.

- [ ] **Step 7: Manual smoke test with a real Ollama daemon**

With a real `ollama serve` running locally and a real
`~/.xpreiide/config.yaml`:

1. `node extensions/cli/dist/cli.cjs chat "say hello"` — confirm a real
   streamed reply appears and the process exits 0.
2. `node extensions/cli/dist/cli.cjs agent "list the files in this directory" --auto-approve`
   in a real project directory — confirm the agent actually runs a tool
   and reports a final summary, exit code 0.
3. Repeat step 2 without `--auto-approve`, confirm the approval prompt
   appears and behaves correctly for both `y` and `n` answers.

This step requires a real Ollama installation and is not something that
can be driven from an automated test — run it manually and report any
discrepancy.
