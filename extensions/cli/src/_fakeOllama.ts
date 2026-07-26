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
