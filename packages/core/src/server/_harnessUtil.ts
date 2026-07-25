// Test-only helpers shared by harness.test.ts (spawns the sidecar via
// tsx, from source) and sidecarBundle.test.ts (spawns the esbuild-bundled
// dist/sidecar.cjs via plain node — proving the artifact real plugins will
// ship runs standalone, with no tsx/monorepo dependency at runtime).

import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import * as http from "node:http";
import * as readline from "node:readline";

// Minimal fake Ollama daemon: GET /api/tags + POST /api/chat (NDJSON), serving
// a queue of scripted assistant replies (one per /api/chat call).
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

export interface WireMsg {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { message: string };
}

// Drives a sidecar process (any command that speaks the line-delimited-JSON
// protocol on stdin/stdout) exactly as a host plugin would.
export class SidecarProcess {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, (msg: WireMsg) => void>();
  private listeners: ((msg: WireMsg) => void)[] = [];

  constructor(command: string, args: string[], cwd: string) {
    this.child = spawn(command, args, { cwd });
    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      const msg: WireMsg = JSON.parse(line);
      if (msg.id !== undefined && this.pending.has(Number(msg.id))) {
        this.pending.get(Number(msg.id))!(msg);
        this.pending.delete(Number(msg.id));
      }
      for (const l of this.listeners) l(msg);
    });
  }

  onEvent(cb: (msg: WireMsg) => void): void {
    this.listeners.push(cb);
  }

  request(method: string, params?: Record<string, unknown>): Promise<WireMsg> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.child.stdin.write(JSON.stringify({ method, params }) + "\n");
  }

  kill(): void {
    this.child.kill();
  }
}
