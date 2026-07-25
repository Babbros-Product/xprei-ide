# Phase 7: MCP support — design

Date: 2026-07-26

## Context

Phase 7 of `docs/feature-roadmap.md`. MCP (Model Context Protocol)
servers as a tool source for the agent loop. Because tool-calling here is
entirely prompt-based JSON (not native function-calling), MCP tools get
exposed to the model through the exact same mechanism as
`read_file`/`grep`/the Phase 1 tools — a `Tool` entry in the array
`buildAgentSystemPrompt()` renders into the system prompt. Depends on
Phase 6 for config storage (`mcpServers` lives in
`~/.xpreiide/config.yaml`).

## Prerequisite fix (not new scope — a bug this phase exposes)

`packages/core/src/agent/orchestrator.ts`'s `runTool()` currently
resolves the called tool via the module-level `toolByName()`, which only
searches the static `TOOLS` array:

```typescript
const tool = toolByName(action.tool);
if (!tool || !this.tools.includes(tool)) { ... }
```

This means `AgentDeps.tools` (already a supported override point) can
only ever *restrict* the callable set to a subset of `TOOLS` (e.g. Edit
mode dropping `run_terminal`/`view_diff`) — it can never *add* a tool
that isn't in the static array, because the lookup itself never
consults `this.tools`. MCP tools are dynamically discovered at runtime
and are never in the static `TOOLS` array, so without this fix they
would be listed in the system prompt (if concatenated into
`deps.tools`) but rejected as "unknown tool" the moment the model tried
to call one.

**Fix:** change the lookup to `this.tools.find((t) => t.name ===
action.tool)`, dropping the separate `toolByName()` import/call from
`runTool()` (it can stay exported from `tools.ts` for other callers, if
any — `orchestrator.ts` simply stops using it). This makes
`AgentDeps.tools` a true override (superset or subset), which is what
this phase needs.

## Decisions

- **Tool naming: `mcp__<server>__<tool>`.** Matches an already-familiar
  convention (visible in this very environment's own MCP tool naming).
  Prevents collisions between two servers exposing a same-named tool, and
  between an MCP tool and a built-in one.
- **Every MCP tool is `mutating: true`.** MCP's `tools/list` response
  gives no side-effect metadata — there's no way to know if a given tool
  is read-only or destructive. Defaulting to always-mutating means every
  MCP tool call goes through the existing approval gate; the safe
  default, consistent with this project's whole approval-first
  philosophy.
- **No JSON-Schema validation of arguments.** Consistent with the
  no-new-dependency philosophy (no schema-validator library) and with
  how this project's own tools already validate manually, per-field. The
  MCP tool's raw `inputSchema` is passed through as the `args` string in
  the system prompt (models read raw JSON Schema fine); the server
  itself validates and returns an error if the model's call doesn't
  match.
- **Real MCP wire protocol, not this project's bespoke sidecar
  protocol.** `packages/core/src/server/stdio.ts`'s NDJSON scheme is this
  project's own simplified protocol for talking to its *own* sidecar —
  unrelated to and not reusable for real third-party MCP servers, which
  speak actual MCP: JSON-RPC 2.0, newline-delimited over stdio,
  `initialize` → `notifications/initialized` → `tools/list` →
  `tools/call`. This phase implements that real handshake.
- **Static tool list per server connection — no dynamic refresh.**
  `tools/list` is called once per server per manager lifetime. MCP's
  optional "tool list changed" notification is not handled in v1 (out of
  scope below).
- **Lazy spawn, cached for the manager's lifetime.** Servers are spawned
  on first `McpManager.getTools()` call (typically the first agent run
  that needs tools), not eagerly at extension activation — MCP servers
  can be arbitrary external processes with unpredictable startup cost,
  unlike the cheap local-HTTP Ollama auto-discovery ping. Once spawned,
  connections are reused across subsequent agent runs in the same
  session; `dispose()` (extension deactivation) kills every spawned
  child process.
- **One bad server config never blocks the others.** A server that fails
  to spawn, times out during `initialize`, or exits immediately is
  skipped (logged/surfaced, not thrown) — matches the project's existing
  "never let one failure break everything" pattern
  (`listAllModels()`/provider auto-discovery).
- **Timeouts: 10s handshake, 30s per-call.** Bounded-wait-then-fallback,
  same shape as the existing `SHELL_INTEGRATION_TIMEOUT_MS` pattern in
  `contextEngine.ts`. 30s (not `run_terminal`'s 120s) because MCP tool
  calls are expected to be fast operations, not long shell scripts.
- **No dedicated "Add MCP Server" UI in v1.** `mcpServers` is configured
  by hand-editing `~/.xpreiide/config.yaml` (Phase 6's shared file). A
  QuickPick-based flow (mirroring `addProviderFlow.ts`) is a reasonable
  v2 follow-up, not built now — keeps this phase's scope bounded to the
  actual MCP client/tool-source mechanics.
- **No new sidecar RPC methods.** `session.ts`'s `agent.run` already
  accepts a tool list; both VS Code and the sidecar call the same
  `McpManager.getTools()` and concatenate the result with the static
  `TOOLS` before constructing `Agent` — MCP tools become part of the
  existing flow transparently, serving IntelliJ/Eclipse/a future CLI
  host the same way VS Code gets them.

## Architecture

### `packages/core/src/mcp/mcpClient.ts` (new)

One connection to one configured MCP server.

```typescript
export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: unknown; // raw JSON Schema, passed through opaquely
}

export interface McpCallResult {
  text: string; // flattened text-type content parts, joined
  isError: boolean;
}

export class McpClient {
  constructor(private readonly config: McpServerConfig) {}

  // Spawns the child process, performs initialize → notifications/initialized
  // → tools/list. Throws on handshake timeout (10s) or immediate process exit
  // — callers (McpManager) catch and skip this server.
  async connect(): Promise<McpToolInfo[]>

  // Sends a tools/call request, correlated by request id. Throws on a 30s
  // per-call timeout. Resolves McpCallResult even for a tool-level error
  // (isError: true is a valid MCP response, not a transport failure) —
  // only transport/timeout failures throw.
  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>

  // Kills the child process. Idempotent.
  dispose(): void
}
```

Transport: `node:child_process.spawn(command, args, { env: { ...process.env, ...env } })`,
`node:readline` over `child.stdout` (mirrors the existing
`server/stdio.ts` line-framing precedent, applied to the real MCP
message shape instead of the sidecar's own). Outgoing requests are
written as `JSON.stringify(msg) + "\n"` to `child.stdin`. A
`Map<number, { resolve, reject }>` correlates responses by `id`;
messages without an `id` (server-to-client notifications) are ignored in
v1. `initialize`'s request body:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2024-11-05",
    "capabilities": {},
    "clientInfo": { "name": "xpreiIDE", "version": "0.0.1" }
  }
}
```

followed by the no-response notification `{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}`,
then a `tools/list` request. `tools/call` requests carry
`{ "name": <tool>, "arguments": <args> }`; the response's
`result.content` array's `type: "text"` entries are joined (by `"\n"`)
into `McpCallResult.text`; other content types (e.g. images) are dropped
in v1 (the model interface here is text-only, same reasoning as every
other tool's plain-string observation).

### `packages/core/src/mcp/mcpManager.ts` (new)

```typescript
export class McpManager {
  // Spawns every configured server on first call (lazy), caching the
  // resulting Tool[] for subsequent calls. A server that fails to
  // connect (spawn error, handshake timeout, immediate exit) is skipped
  // — its failure is available via lastErrors() but never thrown.
  async getTools(servers: Record<string, McpServerConfig>): Promise<Tool[]>

  // Every skipped-server reason from the most recent getTools() call,
  // keyed by server name — surfaced so the caller can log/notify.
  lastErrors(): Record<string, string>

  // Kills every spawned McpClient. Idempotent.
  dispose(): void
}
```

Each discovered `McpToolInfo` is wrapped as this project's `Tool`:

```typescript
{
  name: `mcp__${serverName}__${info.name}`,
  description: info.description,
  args: JSON.stringify(info.inputSchema),
  mutating: true,
  async run(args, _host) {
    try {
      const result = await client.callTool(info.name, args);
      return { observation: result.isError ? `Error: ${result.text}` : result.text };
    } catch (err) {
      return { observation: `Error calling ${info.name}: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
}
```

Note the `Tool.run(args, host)` signature is unchanged — MCP tools
simply ignore the `AgentHost` parameter (they talk to their own spawned
process, not the workspace host), consistent with the interface every
other tool already implements.

### `packages/core/src/agent/orchestrator.ts` (modified — the prerequisite fix)

```typescript
private async runTool(action: Extract<Action, { kind: "tool" }>): Promise<string> {
  const tool = this.tools.find((t) => t.name === action.tool);
  if (!tool) {
    return `Error: unknown tool "${action.tool}". Available: ${this.tools
      .map((t) => t.name)
      .join(", ")}.`;
  }
  ...
```

Drops the `toolByName` import from this file (it can remain exported
from `tools.ts` for whatever else references it — confirmed at
implementation time whether anything else does; if not, it's simply
unused-export cleanup, not a breaking change).

### `extensions/vscode/src/agent/runner.ts` (modified)

`runAgent()` gains an `McpManager` instance (created once at extension
activation, passed in — mirrors how `ProviderRegistry` is already
constructed once and threaded through). Before constructing `Agent`:

```typescript
const config = await loadConfig();
const mcpTools = await mcpManager.getTools(config.raw.mcpServers ?? {});
const tools = mode === "edit" ? EDIT_MODE_TOOLS : [...TOOLS, ...mcpTools];
```

(`mcpServers` lives in the raw preserved map from Phase 6's
`parseConfig`, not on the typed `XpreiConfig` — it's not one of that
schema's 7 known fields, read directly here as an untyped pass-through
until/unless a later phase promotes it to a typed field.) Edit mode
excludes MCP tools entirely (same reasoning as excluding
`run_terminal`/`view_diff` — Edit mode is meant to be a bounded,
file-only surface).

`summarize()`/`buildDiffPreview()` gain an `mcp__` prefix branch, checked
before the existing specific-name branches:

```typescript
if (tool.startsWith("mcp__")) {
  const parts = tool.split("__");
  const server = parts[1] ?? "?";
  const toolName = parts.slice(2).join("__") || "?";
  return `MCP: ${toolName} (${server})`; // summarize()
}
```

```typescript
if (tool.startsWith("mcp__")) return undefined; // buildDiffPreview() — no
  // meaningful before/after from arbitrary MCP arguments; falls back to
  // the existing plain-summary approval card, same as any tool with no
  // diff preview today.
```

`extension.ts`'s activation creates one `McpManager`, and
`deactivate()` calls `mcpManager.dispose()`.

### `packages/core/src/server/stdio.ts` / `session.ts` (modified, for IntelliJ/Eclipse/CLI)

The sidecar's own `startStdioServer()` creates one `McpManager` for its
process lifetime and passes `mcpManager.getTools(configs.mcpServers ??
{})`'s result into the tool list `agent.run` constructs `Agent` with —
no new RPC method needed; MCP tools simply appear in the same tool set
non-VS-Code hosts already get through the existing `agent.run` message.

## Out of scope

- MCP's optional "tool list changed" notification / dynamic re-listing —
  static list per connection, v1 only.
- A settings UI for adding/editing MCP servers — hand-edit
  `~/.xpreiide/config.yaml` for now.
- MCP resources or prompts (MCP's other two capability types beyond
  tools) — tool-calling only, matching this project's actual need.
- Non-text MCP tool-result content (images, embedded resources) — text
  parts only, dropped otherwise.
- JSON-Schema validation of the model's tool-call arguments before
  sending them to the server.
- Remote/HTTP-transport MCP servers — stdio/local-process only, matching
  the "MCP servers as both a context-provider source and a tool source"
  framing's realistic v1 (every officially-documented MCP server example
  is a local stdio process).

## Testing

- `mcpClient.test.ts` (new): a tiny fake MCP server — an actual Node
  script (`_fakeMcpServer.ts`, spawned as a real child process by the
  test, not a mocked transport) that speaks real newline-delimited
  JSON-RPC 2.0 for `initialize`/`tools/list`/`tools/call`, so the framing
  and correlation logic is genuinely exercised, not assumed. Tests:
  successful full handshake + tool call round-trip; a server that never
  responds to `initialize` times out within the 10s bound (test uses a
  short override, not the real 10s, to stay fast); a server process that
  exits immediately after spawn is caught, not thrown, by `connect()`; a
  `tools/call` that never responds times out within the 30s bound (again
  overridden short in tests); `isError: true` in a tool response resolves
  normally (does not throw).
- `mcpManager.test.ts` (new): two configured servers, one deliberately
  broken (bad command) — `getTools()` returns the working server's tools
  only, `lastErrors()` reports the broken one; tool names are correctly
  prefixed `mcp__<server>__<tool>`; every returned `Tool.mutating` is
  `true`; a second `getTools()` call reuses the cached connection
  (asserted via a call counter in the fake server, not a new spawn).
- `orchestrator.test.ts` (extend): a `deps.tools` array containing a tool
  NOT in the static `TOOLS` array is now callable (proves the
  prerequisite fix) — this is a regression test for the bug this phase
  found, independent of MCP itself.
- `runner.ts`'s new branches: no unit test (VS Code-layer, UI-cosmetic,
  same convention as the rest of that file) — typecheck/compile +
  manual smoke test: configure a real small MCP server (e.g. the
  official filesystem server) in `~/.xpreiide/config.yaml`, start an
  agent run, confirm its tools appear in the system prompt and are
  callable with an approval card reading "MCP: `<tool>` (`<server>`)".

## User-facing docs

`extensions/vscode/README.md` gains a new section describing
`mcpServers` config (the exact YAML shape, one worked example), the
`mcp__<server>__<tool>` naming the user will see in approval cards, and
that every MCP tool call requires approval (no auto-approve distinction
from built-in tools). Root `README.md`'s Features list gains a short MCP
bullet.
