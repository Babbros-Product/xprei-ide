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
