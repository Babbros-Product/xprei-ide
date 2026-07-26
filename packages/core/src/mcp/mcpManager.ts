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
