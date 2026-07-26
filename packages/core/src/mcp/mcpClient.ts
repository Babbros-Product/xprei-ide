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
