# Phase 7: MCP Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MCP (Model Context Protocol) servers as a tool source for the
agent loop, in both VS Code and the sidecar (serving IntelliJ/Eclipse/a
future CLI).

**Architecture:** `packages/core/src/mcp/mcpClient.ts` speaks the real
MCP wire protocol (JSON-RPC 2.0, newline-delimited over a spawned
child's stdio) to one configured server. `mcpManager.ts` spawns every
configured server lazily, caches the connections+tools for its own
lifetime, and wraps each discovered tool as this project's own `Tool`
interface (`mcp__<server>__<tool>`, always `mutating: true`). Both VS
Code's `runner.ts` and the sidecar's `session.ts` concatenate MCP tools
onto the static `TOOLS` array before constructing `Agent` — no new
sidecar RPC method needed.

**Tech Stack:** TypeScript, `node:child_process`, `node:readline`, Node's
built-in `node:test` + `assert/strict`.

## Global Constraints

- **The orchestrator prerequisite fix is already done.** Phase 5 (commit
  `21ee3fc`) already changed `orchestrator.ts`'s `runTool()` to
  `this.tools.find((t) => t.name === action.tool)` — confirmed by
  reading the current file. `AgentDeps.tools` is already a true
  override, not just a filter. Nothing to do here.
- **Tool naming: `mcp__<server>__<tool>`.**
- **Every wrapped MCP tool is `mutating: true`** — no side-effect
  metadata exists to know otherwise.
- **No JSON-Schema validation of arguments** — the raw `inputSchema` is
  passed through as the `args` string; the server validates.
- **Real MCP wire protocol** (JSON-RPC 2.0, newline-delimited stdio):
  `initialize` → `notifications/initialized` → `tools/list` →
  `tools/call`. Distinct from and unrelated to this project's own
  bespoke sidecar protocol (`server/stdio.ts`/`server/session.ts`).
- **Static tool list per connection** — no dynamic re-listing.
- **Lazy spawn, cached for the manager's lifetime.**
- **One bad server config never blocks the others.**
- **Timeouts: 10s handshake, 30s per-call** (both overridable via
  constructor options, so tests can use short timeouts).
- **No settings UI for adding MCP servers** — `mcpServers` is configured
  by hand-editing `~/.xpreiide/config.yaml` (Phase 6's shared file). It
  is stored in that file's raw preserved map, NOT one of `XpreiConfig`'s
  7 typed fields.
- **No new sidecar RPC method** — `agent.run` already accepts a tool
  list; MCP tools are concatenated onto it transparently.
- **Commits:** author `xpreiIDE <mbsajay1@gmail.com>` — pass it
  explicitly, e.g. `git -c user.name="xpreiIDE" -c
  user.email="mbsajay1@gmail.com" commit -m "..."`. **Do NOT add a
  `Co-Authored-By` footer or any other footer.** Conventional Commit
  prefixes (feat/docs/etc).
- **No new unit tests for VS Code-layer files** (`runner.ts`,
  `extension.ts`, `chatView.ts`) — none exist today for these files,
  consistent with this project's established convention. Typecheck +
  compile + manual smoke test only.

---

### Task 1: `mcpClient.ts` — one MCP server connection, tested against a real spawned fake server

**Files:**
- Create: `packages/core/src/mcp/mcpClient.ts`
- Create: `packages/core/src/mcp/_fakeMcpServer.ts` (test-only helper, NOT
  registered in `package.json`'s `test` script — it's a script the test
  spawns, not a test file itself)
- Create: `packages/core/src/mcp/mcpClient.test.ts`
- Modify: `packages/core/package.json` (register `mcpClient.test.ts`)
- Modify: `packages/core/src/index.ts` (barrel-export the module)

**Interfaces:**
- Produces: `McpServerConfig { command: string; args: string[]; env?:
  Record<string, string> }`, `McpToolInfo { name: string; description:
  string; inputSchema: unknown }`, `McpCallResult { text: string;
  isError: boolean }`, `class McpClient { constructor(config:
  McpServerConfig, opts?: { handshakeTimeoutMs?: number; callTimeoutMs?:
  number }); connect(): Promise<McpToolInfo[]>; callTool(name: string,
  args: Record<string, unknown>): Promise<McpCallResult>; dispose(): void
  }` — Task 2 consumes all of these.

- [ ] **Step 1: Write the fake MCP server test helper**

Create `packages/core/src/mcp/_fakeMcpServer.ts`:

```typescript
// Test-only fake MCP server, spawned as a real child process by
// mcpClient.test.ts — genuinely exercises the real JSON-RPC framing and
// handshake, not a mocked transport. Mode selected via argv[2]:
//   "ok"         — normal initialize -> tools/list -> tools/call round trip
//   "hang-init"  — never responds to "initialize" (tests handshake timeout)
//   "exit-now"   — exits immediately (tests connect() catching a dead process)
//   "hang-call"  — responds to initialize/tools/list normally, never
//                  responds to tools/call (tests per-call timeout)
//   "error-call" — tools/call responds with isError: true

import * as readline from "node:readline";

const mode = process.argv[2] ?? "ok";

if (mode === "exit-now") {
  process.exit(1);
}

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let msg: { id?: number; method?: string; params?: Record<string, unknown> };
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }

  if (msg.method === "initialize") {
    if (mode === "hang-init") return;
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake", version: "0.0.1" } },
    });
    return;
  }

  if (msg.method === "notifications/initialized") {
    return;
  }

  if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echoes back its input",
            inputSchema: { type: "object", properties: { text: { type: "string" } } },
          },
        ],
      },
    });
    return;
  }

  if (msg.method === "tools/call") {
    if (mode === "hang-call") return;
    if (mode === "error-call") {
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "simulated failure" }], isError: true } });
      return;
    }
    const args = (msg.params?.arguments as Record<string, unknown>) ?? {};
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { content: [{ type: "text", text: `echo: ${JSON.stringify(args)}` }], isError: false },
    });
    return;
  }
});
```

- [ ] **Step 2: Write the failing tests**

Create `packages/core/src/mcp/mcpClient.test.ts`:

```typescript
import assert from "node:assert/strict";
import { test } from "node:test";
import * as path from "node:path";
import { McpClient } from "./mcpClient";

const fakeServerPath = path.join(__dirname, "_fakeMcpServer.ts");

function client(
  mode: string,
  opts?: { handshakeTimeoutMs?: number; callTimeoutMs?: number },
): McpClient {
  return new McpClient(
    { command: process.execPath, args: ["--import", "tsx", fakeServerPath, mode] },
    opts,
  );
}

test("McpClient connects, lists tools, and calls a tool successfully", async () => {
  const c = client("ok");
  try {
    const tools = await c.connect();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "echo");
    const result = await c.callTool("echo", { text: "hi" });
    assert.equal(result.isError, false);
    assert.match(result.text, /echo:.*hi/);
  } finally {
    c.dispose();
  }
});

test("McpClient.connect() times out if the server never responds to initialize", async () => {
  const c = client("hang-init", { handshakeTimeoutMs: 300 });
  try {
    await assert.rejects(() => c.connect(), /timed out/);
  } finally {
    c.dispose();
  }
});

test("McpClient.connect() rejects (not hangs forever) when the server process exits immediately", async () => {
  const c = client("exit-now", { handshakeTimeoutMs: 2000 });
  try {
    await assert.rejects(() => c.connect());
  } finally {
    c.dispose();
  }
});

test("McpClient.callTool() times out if the server never responds", async () => {
  const c = client("hang-call", { callTimeoutMs: 300 });
  try {
    await c.connect();
    await assert.rejects(() => c.callTool("echo", {}), /timed out/);
  } finally {
    c.dispose();
  }
});

test("McpClient.callTool() resolves normally (not throws) when the server reports isError: true", async () => {
  const c = client("error-call");
  try {
    await c.connect();
    const result = await c.callTool("echo", {});
    assert.equal(result.isError, true);
    assert.equal(result.text, "simulated failure");
  } finally {
    c.dispose();
  }
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run (from `packages/core`): `node --import tsx --test src/mcp/mcpClient.test.ts`
Expected: FAIL — `./mcpClient` doesn't exist yet.

- [ ] **Step 4: Implement `mcpClient.ts`**

Create `packages/core/src/mcp/mcpClient.ts`:

```typescript
// One connection to one configured MCP (Model Context Protocol) server.
// Speaks the real MCP wire protocol (JSON-RPC 2.0, newline-delimited
// over stdio) — distinct from and unrelated to this project's own
// bespoke sidecar protocol (server/stdio.ts). See
// docs/superpowers/specs/2026-07-26-phase7-mcp-support-design.md.

import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import * as readline from "node:readline";

export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface McpCallResult {
  text: string;
  isError: boolean;
}

const HANDSHAKE_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 30_000;

interface PendingEntry {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

export class McpClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, PendingEntry>();
  private readonly handshakeTimeoutMs: number;
  private readonly callTimeoutMs: number;

  constructor(
    private readonly config: McpServerConfig,
    opts?: { handshakeTimeoutMs?: number; callTimeoutMs?: number },
  ) {
    this.handshakeTimeoutMs = opts?.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
    this.callTimeoutMs = opts?.callTimeoutMs ?? CALL_TIMEOUT_MS;
  }

  // Spawns the server, performs initialize -> notifications/initialized
  // -> tools/list. Throws on handshake timeout or an immediate process
  // exit — callers (McpManager) catch and skip this server.
  async connect(): Promise<McpToolInfo[]> {
    this.child = spawn(this.config.command, this.config.args, {
      env: { ...process.env, ...(this.config.env ?? {}) },
    });
    const child = this.child;

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => this.handleLine(line));
    child.once("exit", () => this.rejectAllPending(new Error("MCP server process exited")));
    child.once("error", (err) => this.rejectAllPending(err));

    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "xpreiIDE", version: "0.0.1" },
    }, this.handshakeTimeoutMs);

    this.notify("notifications/initialized", {});

    const listResult = (await this.request(
      "tools/list",
      {},
      this.handshakeTimeoutMs,
    )) as { tools?: McpToolInfo[] };
    return listResult.tools ?? [];
  }

  // Sends a tools/call request. Throws on a per-call timeout. Resolves
  // normally even for a tool-level error (isError: true is a valid MCP
  // response, not a transport failure) — only transport/timeout failures
  // throw.
  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = (await this.request(
      "tools/call",
      { name, arguments: args },
      this.callTimeoutMs,
    )) as { content?: { type: string; text?: string }[]; isError?: boolean };
    const text = (result.content ?? [])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("\n");
    return { text, isError: !!result.isError };
  }

  // Kills the child process. Idempotent.
  dispose(): void {
    this.child?.kill();
  }

  private handleLine(line: string): void {
    const text = line.trim();
    if (!text) return;
    let msg: { id?: number; result?: unknown; error?: { message: string } };
    try {
      msg = JSON.parse(text);
    } catch {
      return; // ignore malformed/non-JSON output
    }
    if (msg.id === undefined) return; // a server-to-client notification — ignored in v1
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    if (msg.error) entry.reject(new Error(msg.error.message));
    else entry.resolve(msg.result);
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (!this.child) throw new Error("MCP client not connected");
    const id = this.nextId++;
    const child = this.child;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  private notify(method: string, params: unknown): void {
    this.child?.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  private rejectAllPending(err: unknown): void {
    for (const [id, entry] of this.pending) {
      entry.reject(err);
      this.pending.delete(id);
    }
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run (from `packages/core`): `node --import tsx --test src/mcp/mcpClient.test.ts`
Expected: PASS — all 5 tests green. This spawns real child processes
(`tsx` running `_fakeMcpServer.ts`), so it's slower than the rest of this
package's tests (a few hundred ms per timeout-testing test) — that's
expected, not a bug.

- [ ] **Step 6: Register the test file and barrel-export the module**

In `packages/core/package.json`, add `src/mcp/mcpClient.test.ts` to the
`test` script's file list, immediately after `src/config/schema.test.ts`.
Do NOT add `_fakeMcpServer.ts` — it isn't a test file, it's a helper the
test spawns.

In `packages/core/src/index.ts`, add immediately after
`export * from "./config/schema";`:

```typescript
export * from "./mcp/mcpClient";
```

- [ ] **Step 7: Run the full core suite to confirm nothing broke**

Run (from `packages/core`): `npm test`
Expected: PASS — 251 tests total (246 before this plan + 5 new
`mcpClient.test.ts`).

- [ ] **Step 8: Typecheck core**

Run: `npm run typecheck -w @xprei/core`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/mcp/mcpClient.ts packages/core/src/mcp/_fakeMcpServer.ts packages/core/src/mcp/mcpClient.test.ts packages/core/package.json packages/core/src/index.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(core): add McpClient, a real MCP JSON-RPC client over spawned stdio"
```

---

### Task 2: `mcpManager.ts` — spawn every configured server, wrap tools

**Files:**
- Create: `packages/core/src/mcp/mcpManager.ts`
- Create: `packages/core/src/mcp/mcpManager.test.ts`
- Modify: `packages/core/package.json` (register `mcpManager.test.ts`)
- Modify: `packages/core/src/index.ts` (barrel-export the module)

**Interfaces:**
- Consumes: `McpClient`, `McpServerConfig`, `McpToolInfo` from
  `./mcpClient` (Task 1); `Tool` from `../agent/tools`.
- Produces: `class McpManager { getTools(servers: Record<string,
  McpServerConfig>): Promise<Tool[]>; lastErrors(): Record<string,
  string>; dispose(): void }` — Tasks 3 and 4 both consume this.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/mcp/mcpManager.test.ts`:

```typescript
import assert from "node:assert/strict";
import { test } from "node:test";
import * as path from "node:path";
import { McpManager } from "./mcpManager";
import { McpServerConfig } from "./mcpClient";

const fakeServerPath = path.join(__dirname, "_fakeMcpServer.ts");

function goodServerConfig(mode = "ok"): McpServerConfig {
  return { command: process.execPath, args: ["--import", "tsx", fakeServerPath, mode] };
}

test("getTools() returns tools from a working server, prefixed with mcp__<server>__", async () => {
  const manager = new McpManager();
  try {
    const tools = await manager.getTools({ myserver: goodServerConfig() });
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "mcp__myserver__echo");
    assert.equal(tools[0].mutating, true);
  } finally {
    manager.dispose();
  }
});

test("getTools() skips a broken server (bad command) without throwing, and records the error", async () => {
  const manager = new McpManager();
  try {
    const tools = await manager.getTools({
      broken: { command: "definitely-not-a-real-command-xyz", args: [] },
      good: goodServerConfig(),
    });
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "mcp__good__echo");
    assert.ok(manager.lastErrors().broken);
    assert.ok(!manager.lastErrors().good);
  } finally {
    manager.dispose();
  }
});

test("getTools() reuses the cached result on a second call (does not respawn)", async () => {
  const manager = new McpManager();
  try {
    const first = await manager.getTools({ myserver: goodServerConfig() });
    const second = await manager.getTools({ myserver: goodServerConfig() });
    assert.equal(first, second); // same array reference — proves it was cached, not recomputed
  } finally {
    manager.dispose();
  }
});

test("a wrapped MCP tool's run() calls the tool and returns its text as the observation", async () => {
  const manager = new McpManager();
  try {
    const tools = await manager.getTools({ myserver: goodServerConfig() });
    const echoTool = tools[0];
    const result = await echoTool.run({ text: "hello" }, undefined as never);
    assert.match(result.observation, /echo:.*hello/);
  } finally {
    manager.dispose();
  }
});

test("a wrapped MCP tool's run() prefixes an isError result with 'Error: '", async () => {
  const manager = new McpManager();
  try {
    const tools = await manager.getTools({ myserver: goodServerConfig("error-call") });
    const echoTool = tools[0];
    const result = await echoTool.run({}, undefined as never);
    assert.equal(result.observation, "Error: simulated failure");
  } finally {
    manager.dispose();
  }
});
```

Note: `undefined as never` for the unused `AgentHost` parameter in the
`run()` calls above — MCP tools never touch the host (see Task 2's
implementation below), so a real `AgentHost` fake isn't needed for this
test.

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `packages/core`): `node --import tsx --test src/mcp/mcpManager.test.ts`
Expected: FAIL — `./mcpManager` doesn't exist yet.

- [ ] **Step 3: Implement `mcpManager.ts`**

Create `packages/core/src/mcp/mcpManager.ts`:

```typescript
// Spawns and connects every configured MCP server, wraps each
// discovered tool as this project's own Tool interface, and caches the
// result for the manager's lifetime. One server failing to connect
// never blocks the others. See
// docs/superpowers/specs/2026-07-26-phase7-mcp-support-design.md.

import { AgentHost } from "../agent/host";
import { Tool, ToolResult } from "../agent/tools";
import { McpClient, McpServerConfig, McpToolInfo } from "./mcpClient";

export class McpManager {
  private clients: McpClient[] = [];
  private cachedTools?: Tool[];
  private errors: Record<string, string> = {};

  // Spawns every configured server on first call (lazy), caching the
  // resulting Tool[] for subsequent calls — a second call with
  // different `servers` still returns the first call's cached result,
  // matching this project's "config doesn't change mid-session" v1
  // scope. A server that fails to connect is skipped, never thrown.
  async getTools(servers: Record<string, McpServerConfig>): Promise<Tool[]> {
    if (this.cachedTools) return this.cachedTools;

    const out: Tool[] = [];
    this.errors = {};
    for (const [name, cfg] of Object.entries(servers)) {
      const client = new McpClient(cfg);
      try {
        const infos = await client.connect();
        this.clients.push(client);
        for (const info of infos) {
          out.push(this.wrapTool(name, info, client));
        }
      } catch (err) {
        this.errors[name] = err instanceof Error ? err.message : String(err);
        client.dispose();
      }
    }
    this.cachedTools = out;
    return out;
  }

  // Every skipped-server reason from the most recent getTools() call,
  // keyed by server name.
  lastErrors(): Record<string, string> {
    return this.errors;
  }

  // Kills every spawned McpClient. Idempotent.
  dispose(): void {
    for (const client of this.clients) client.dispose();
    this.clients = [];
    this.cachedTools = undefined;
  }

  private wrapTool(serverName: string, info: McpToolInfo, client: McpClient): Tool {
    return {
      name: `mcp__${serverName}__${info.name}`,
      description: info.description,
      args: JSON.stringify(info.inputSchema),
      mutating: true,
      async run(args: Record<string, unknown>, _host: AgentHost): Promise<ToolResult> {
        try {
          const result = await client.callTool(info.name, args);
          return { observation: result.isError ? `Error: ${result.text}` : result.text };
        } catch (err) {
          return {
            observation: `Error calling ${info.name}: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `packages/core`): `node --import tsx --test src/mcp/mcpManager.test.ts`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Register the test file and barrel-export the module**

In `packages/core/package.json`, add `src/mcp/mcpManager.test.ts` to the
`test` script's file list, immediately after `src/mcp/mcpClient.test.ts`.

In `packages/core/src/index.ts`, add immediately after
`export * from "./mcp/mcpClient";`:

```typescript
export * from "./mcp/mcpManager";
```

- [ ] **Step 6: Run the full core suite to confirm nothing broke**

Run (from `packages/core`): `npm test`
Expected: PASS — 256 tests total (251 after Task 1 + 5 new
`mcpManager.test.ts`).

- [ ] **Step 7: Typecheck core**

Run: `npm run typecheck -w @xprei/core`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/mcp/mcpManager.ts packages/core/src/mcp/mcpManager.test.ts packages/core/package.json packages/core/src/index.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(core): add McpManager, spawning configured servers and wrapping their tools"
```

---

### Task 3: VS Code wiring (`runner.ts`, `extension.ts`, `chatView.ts`)

**Files:**
- Modify: `extensions/vscode/src/agent/runner.ts`
- Modify: `extensions/vscode/src/extension.ts`
- Modify: `extensions/vscode/src/ui/chat/chatView.ts`

**Interfaces:**
- Consumes: `McpManager`, `McpServerConfig` from `@xprei/core` (Task 2);
  `loadConfig` from `./config/configStore` (already exists, Phase 6).
- Produces: `runAgent()` gains a new `mcpManager: McpManager` parameter
  — no other task consumes this (VS Code is a leaf in this plan; Task 4
  is the sidecar's independent wiring).

- [ ] **Step 1: Add `parseMcpServers()` and widen `runAgent()` in `runner.ts`**

Read the current `extensions/vscode/src/agent/runner.ts` in full first —
it already has a `multi_edit` branch in `summarize()`/`buildDiffPreview()`
from Phase 5; this task adds `mcp__` branches alongside those, and widens
`runAgent()`.

Add this import:

```typescript
import { loadConfig } from "../config/configStore";
import { McpManager, McpServerConfig } from "@xprei/core";
```

Add this function near the top of the file (after the existing
`EDIT_MODE_TOOLS` constant, before `ChatApprover`):

```typescript
// Reads mcpServers from the shared config file's raw preserved map (it's
// not one of XpreiConfig's 7 typed fields — see Phase 6's
// schema.ts/configStore.ts). Defensive: a malformed entry is dropped,
// not thrown.
function parseMcpServers(raw: unknown): Record<string, McpServerConfig> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    const command = typeof v.command === "string" ? v.command : undefined;
    if (!command) continue;
    const args = Array.isArray(v.args) ? v.args.filter((a): a is string => typeof a === "string") : [];
    const envEntries =
      v.env && typeof v.env === "object"
        ? Object.entries(v.env as Record<string, unknown>).filter(
            (e): e is [string, string] => typeof e[1] === "string",
          )
        : [];
    out[name] = { command, args, ...(envEntries.length ? { env: Object.fromEntries(envEntries) } : {}) };
  }
  return out;
}
```

Add `mcp__` branches to `summarize()` and `buildDiffPreview()`, each
immediately before that function's final fallback line:

```typescript
  if (tool.startsWith("mcp__")) {
    const parts = tool.split("__");
    const server = parts[1] ?? "?";
    const toolName = parts.slice(2).join("__") || "?";
    return `MCP: ${toolName} (${server})`;
  }
```

(this one goes into `summarize()`, before its `return path;` fallback)

```typescript
  if (tool.startsWith("mcp__")) return undefined;
```

(this one goes into `buildDiffPreview()`, before its `return undefined;`
fallback — arbitrary MCP arguments have no meaningful before/after diff,
so this falls back to the plain-summary approval card, same as any tool
with no diff preview today)

Widen `runAgent()`'s signature and body:

```typescript
export async function runAgent(
  registry: ProviderRegistry,
  task: string,
  post: (msg: unknown) => void,
  signal: AbortSignal,
  mode: AgentMode = "agent",
  requestApproval: RequestApproval,
  mcpManager: McpManager,
  projectRules?: string,
): Promise<AgentRun> {
  const resolved = await registry.resolveAgent();
  if (!resolved) throw new Error("No model selected. Run 'xpreiIDE: Select Model' first.");

  const host = VscodeAgentHost.create();
  const autoApprove = vscode.workspace
    .getConfiguration("xpreiIDE")
    .get<boolean>("agent.autoApprove", false);
  const maxSteps = vscode.workspace
    .getConfiguration("xpreiIDE")
    .get<number>("agent.maxSteps", 0);
  const protocolRetries = vscode.workspace
    .getConfiguration("xpreiIDE")
    .get<number>("agent.protocolRetries", 2);

  const events: AgentEvents = {
    onStep: (n) => post({ type: "agent", kind: "step", n }),
    onThought: (t) => post({ type: "agent", kind: "thought", text: t }),
    onTool: (name, args) => post({ type: "agent", kind: "tool", text: summarize(name, args), name }),
    onObservation: (t) => post({ type: "agent", kind: "observation", text: t }),
    onFinal: (t) => post({ type: "agent", kind: "final", text: t }),
    onError: (t) => post({ type: "agent", kind: "error", text: t }),
    onEdit: (path, before, after) => flashAgentEdit(host.cwd, path, before, after),
    onProtocolError: (attempt, maxAttempts, reason) =>
      post({ type: "agent", kind: "protocolError", text: reason, attempt, maxAttempts }),
  };

  let agentTools: Tool[];
  if (mode === "edit") {
    agentTools = EDIT_MODE_TOOLS;
  } else {
    const { raw } = await loadConfig();
    const mcpTools = await mcpManager.getTools(parseMcpServers(raw.mcpServers));
    agentTools = [...TOOLS, ...mcpTools];
  }

  const agent = new Agent({
    provider: resolved.provider,
    model: resolved.model,
    host,
    approver: new ChatApprover(autoApprove, requestApproval),
    events,
    maxSteps,
    protocolRetries,
    tools: agentTools,
    projectRules,
  });

  const done = agent.run(task, signal);
  return { checkpoint: agent.checkpoint, done };
}
```

Note this `agentTools` restructure replaces the prior single-line
`tools: mode === "edit" ? EDIT_MODE_TOOLS : TOOLS,` — Edit mode still
gets exactly `EDIT_MODE_TOOLS` (no MCP tools, matching the design: Edit
mode is a bounded, file-only surface), Agent mode gets `TOOLS` plus
whatever `mcpManager.getTools()` resolves. `Tool` is already imported in
this file (`import { Tool, TOOLS } from "@xprei/core";`), confirmed by
reading the current file — no new import needed for the type
annotation.

- [ ] **Step 2: Widen `ChatViewProvider`'s constructor in `chatView.ts`**

Add to the top-of-file imports:

```typescript
import { McpManager } from "@xprei/core";
```

Change the constructor signature from:

```typescript
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly registry: ProviderRegistry,
    private readonly context: ContextEngine,
    private readonly workspaceState: vscode.Memento,
  ) {
```

to:

```typescript
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly registry: ProviderRegistry,
    private readonly context: ContextEngine,
    private readonly workspaceState: vscode.Memento,
    private readonly mcpManager: McpManager,
  ) {
```

In `onAgent(text, mode)`, change the `runAgent(...)` call from:

```typescript
      const run = await runAgent(
        this.registry,
        task,
        (m) => this.post(m),
        this.inflight.signal,
        mode,
        (tool, summary, diff) => this.requestApproval(tool, summary, diff),
        rules,
      );
```

to:

```typescript
      const run = await runAgent(
        this.registry,
        task,
        (m) => this.post(m),
        this.inflight.signal,
        mode,
        (tool, summary, diff) => this.requestApproval(tool, summary, diff),
        this.mcpManager,
        rules,
      );
```

- [ ] **Step 3: Wire `McpManager` into `extension.ts`'s `activate()`**

Add to the top-of-file imports:

```typescript
import { McpManager } from "@xprei/core";
```

In `activate()`, add immediately after `const engine = new
ContextEngine(registry, context.storageUri, log);`:

```typescript
  const mcpManager = new McpManager();
```

Change the `ChatViewProvider` construction from:

```typescript
  const chat = new ChatViewProvider(context.extensionUri, registry, engine, context.workspaceState);
```

to:

```typescript
  const chat = new ChatViewProvider(context.extensionUri, registry, engine, context.workspaceState, mcpManager);
```

Add `mcpManager` to the `context.subscriptions.push(...)` list — it
implements `dispose(): void`, so VS Code disposes it automatically on
deactivation the same way `log`/`watcher`/`inlineEdit`/`chat` already
are. No `deactivate()` change is needed. Change:

```typescript
  context.subscriptions.push(
    log,
    watcher,
    inlineEdit,
    chat,
```

to:

```typescript
  context.subscriptions.push(
    log,
    watcher,
    inlineEdit,
    chat,
    mcpManager,
```

- [ ] **Step 4: Typecheck the extension**

Run: `npm run typecheck -w xpreiIDE-ai`
Expected: PASS.

- [ ] **Step 5: Compile the extension**

Run: `npm run compile -w xpreiIDE-ai`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add extensions/vscode/src/agent/runner.ts extensions/vscode/src/extension.ts extensions/vscode/src/ui/chat/chatView.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(vscode): wire MCP tools into the agent loop"
```

---

### Task 4: Sidecar wiring (`session.ts`, `stdio.ts`) — for IntelliJ/Eclipse/a future CLI

**Files:**
- Modify: `packages/core/src/server/session.ts`
- Modify: `packages/core/src/server/stdio.ts`
- Modify: `packages/core/src/server/harness.test.ts` (extend, if it
  constructs `SidecarSession`/`SessionDeps` directly — see Step 1)

**Interfaces:**
- Consumes: `McpManager`, `McpServerConfig` from `../mcp/mcpManager`/
  `../mcp/mcpClient` (Tasks 1-2).
- Produces: `SessionDeps` gains an optional `getMcpServers?: () =>
  Record<string, McpServerConfig>` field.

**Note for the implementer:** read `packages/core/src/server/
harness.test.ts` first to see whether it constructs `SidecarSession`
directly with a `SessionDeps` object (in which case it needs no change,
since `getMcpServers` is optional — its tests simply get "no MCP
servers configured," which is correct default behavior for a test that
doesn't care about MCP) or does something else. This step should not
require new tests — `getMcpServers` is optional specifically so no
existing test needs updating; confirm this holds after Step 4 below.

- [ ] **Step 1: Widen `SessionDeps` and wire `McpManager` into `session.ts`**

In `packages/core/src/server/session.ts`, add to the imports:

```typescript
import { McpManager } from "../mcp/mcpManager";
import { McpServerConfig } from "../mcp/mcpClient";
```

Widen the `SessionDeps` interface — add after the existing `makeHost?`
field:

```typescript
  // Returns the currently configured MCP servers, if any. Optional so
  // tests that don't care about MCP tools can omit it — treated as "no
  // MCP servers configured."
  getMcpServers?: () => Record<string, McpServerConfig>;
```

Add a private field to `SidecarSession`, alongside its existing private
fields (`workspaceRoot`, `inflightChats`, etc.):

```typescript
  private readonly mcpManager = new McpManager();
```

In `onAgentRun()`, immediately before the `const agent = new Agent({`
line, add:

```typescript
    const mcpTools =
      mode === "edit" ? [] : await this.mcpManager.getTools(this.deps.getMcpServers?.() ?? {});
```

Then change the `Agent` constructor call's `tools:` line from:

```typescript
      tools: mode === "edit" ? EDIT_MODE_TOOLS : TOOLS,
```

to:

```typescript
      tools: mode === "edit" ? EDIT_MODE_TOOLS : [...TOOLS, ...mcpTools],
```

- [ ] **Step 2: Widen `InitProviders` and thread `mcpServers` through `stdio.ts`**

In `packages/core/src/server/stdio.ts`, add to the imports:

```typescript
import { McpServerConfig } from "../mcp/mcpClient";
```

Widen the `InitProviders` interface:

```typescript
interface InitProviders {
  providers?: ProviderConfig[];
  // providerId → API key (held in memory only, never persisted by the sidecar).
  apiKeys?: Record<string, string>;
  mcpServers?: Record<string, McpServerConfig>;
}
```

In `startStdioServer()`, add a new mutable variable alongside `configs`/
`keys`:

```typescript
  let mcpServers: Record<string, McpServerConfig> = {};
```

Pass a `getMcpServers` callback into the `SidecarSession` construction:

```typescript
  const session = new SidecarSession({ emit, resolveModel, listModels, getMcpServers: () => mcpServers });
```

In the `initialize`-handling block, add capture for `mcpServers`
alongside the existing `providers`/`apiKeys` capture:

```typescript
    if (msg.method === "initialize" && msg.params) {
      if (Array.isArray(msg.params.providers)) configs = msg.params.providers;
      if (msg.params.apiKeys && typeof msg.params.apiKeys === "object") {
        keys = msg.params.apiKeys as Record<string, string>;
      }
      if (msg.params.mcpServers && typeof msg.params.mcpServers === "object") {
        mcpServers = msg.params.mcpServers as Record<string, McpServerConfig>;
      }
    }
```

- [ ] **Step 3: Confirm `harness.test.ts` and `sidecarBundle.test.ts` still pass unmodified**

Run (from `packages/core`):
`node --import tsx --test src/server/harness.test.ts src/server/sidecarBundle.test.ts`
Expected: PASS, with no changes needed to either file — every
`SessionDeps` these tests construct omits `getMcpServers`, which is
optional and defaults (via `?.() ?? {}`) to "no MCP servers configured,"
identical to today's behavior.

- [ ] **Step 4: Run the full core suite**

Run (from `packages/core`): `npm test`
Expected: PASS — 256 tests total (same count as after Task 2 — this
task changes existing files but adds no new tests, since `getMcpServers`
being optional means no existing test needed updating).

- [ ] **Step 5: Typecheck core**

Run: `npm run typecheck -w @xprei/core`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/server/session.ts packages/core/src/server/stdio.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(core): thread MCP tools into the sidecar's agent.run for IntelliJ/Eclipse/CLI hosts"
```

---

### Task 5: User-facing docs

**Files:**
- Modify: `extensions/vscode/README.md`
- Modify: `README.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Add an "MCP servers" section to `extensions/vscode/README.md`**

Insert a new section after the "Project instructions & ignore file"
section (search for `## Inline edit (Cmd-K)`, the section that
immediately follows it, and insert before that heading):

```markdown
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
```

- [ ] **Step 2: Add a short MCP bullet to root `README.md`'s Features list**

Find the Features list (search for `**Codebase-aware context**`) and add
a new bullet after the last item in that list block (the exact insertion
point depends on what else has been added to this list by later phases —
read the file first and append after whatever the final bullet in that
list currently is):

```markdown
- **MCP servers** — configure MCP servers in the shared config file;
  their tools become available to the agent loop automatically, named
  `mcp__<server>__<tool>`.
```

- [ ] **Step 3: Proofread both files**

Read both changed files back in full and confirm: no broken Markdown,
the new content reads naturally in place, and the Agent-mode-only /
approval-required notes are clear.

- [ ] **Step 4: Commit**

```bash
git add extensions/vscode/README.md README.md
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "docs: document MCP server configuration in both user-facing READMEs"
```

---

### Task 6: Final verification

**Files:** none (verification only).

**Interfaces:** none — consumes everything built in Tasks 1-5.

- [ ] **Step 1: Run the full core test suite**

Run: `npm test -w @xprei/core`
Expected: PASS — 256 tests total (246 before this plan + 5
`mcpClient.test.ts` + 5 `mcpManager.test.ts`).

- [ ] **Step 2: Typecheck core**

Run: `npm run typecheck -w @xprei/core`
Expected: PASS.

- [ ] **Step 3: Typecheck the extension**

Run: `npm run typecheck -w xpreiIDE-ai`
Expected: PASS.

- [ ] **Step 4: Compile the extension**

Run: `npm run compile -w xpreiIDE-ai`
Expected: PASS.

- [ ] **Step 5: Manual smoke test**

Launch the Extension Development Host (F5 in VS Code against
`extensions/vscode`), ideally with a real small MCP server installed
(e.g. `npx -y @modelcontextprotocol/server-filesystem <some-dir>`
configured in `~/.xpreiide/config.yaml`'s `mcpServers`):

1. Start an Agent-mode run that would plausibly use a filesystem MCP
   tool. Confirm the tool appears in the system prompt / is callable —
   the tool-call log shows `MCP: <tool> (<server>)` and the approval
   card has no before/after diff (plain summary only).
2. Accept the approval; confirm the tool actually runs and its result
   feeds back into the conversation.
3. Switch to Edit mode and confirm MCP tools are NOT offered (Edit mode
   stays file-only).
4. Misconfigure a server (bad command) alongside a working one; confirm
   the working server's tools still appear and the agent run isn't
   blocked by the broken one.

This step requires a real Extension Development Host (and, ideally, a
real MCP server binary) and is not something that can be driven from an
automated test — run it manually and report any discrepancy.
