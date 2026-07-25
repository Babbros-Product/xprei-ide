// Black-box integration test for the sidecar. Unlike session.test.ts (which
// calls SidecarSession's methods directly, in-process), this spawns the REAL
// `node --import tsx src/server/stdio.ts` child process and drives it over
// actual stdin/stdout with real line-delimited JSON — the exact thing a
// JetBrains or Eclipse plugin will do. It talks to a throwaway local HTTP
// server that speaks the Ollama wire format, so it stays fully offline and
// deterministic (no real Ollama install needed), and writes into a real temp
// directory via the real NodeAgentHost. This is the Phase 1 gate from
// docs/multi-ide-plan.md: "a CLI harness that runs a chat + an agent task
// against a temp workspace, proving MVP works with no IDE at all."

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import * as http from "node:http";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

// packages/core has no "type": "module" -> CommonJS, so __dirname is native
// (import.meta.url would throw here).
const coreDir = path.join(__dirname, "..", "..");
const stdioEntry = path.join(coreDir, "src", "server", "stdio.ts");

// Minimal fake Ollama daemon: GET /api/tags + POST /api/chat (NDJSON), serving
// a queue of scripted assistant replies (one per /api/chat call).
function startFakeOllama(replies: string[]): Promise<{ url: string; close: () => Promise<void> }> {
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

interface WireMsg {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { message: string };
}

class SidecarProcess {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, (msg: WireMsg) => void>();
  private listeners: ((msg: WireMsg) => void)[] = [];

  constructor(cwd: string) {
    this.child = spawn(process.execPath, ["--import", "tsx", stdioEntry], { cwd });
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

async function tmpWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "xprei-harness-"));
}

test("harness: chat.send over real stdio streams deltas from a real HTTP backend", async () => {
  const ollama = await startFakeOllama(["Hello from the sidecar!"]);
  const ws = await tmpWorkspace();
  const proc = new SidecarProcess(coreDir);
  try {
    await proc.request("initialize", {
      workspaceRoot: ws,
      providers: [{ id: "fake", kind: "ollama", label: "Fake", baseUrl: ollama.url }],
    });

    const deltas: string[] = [];
    const done = new Promise<void>((resolve) => {
      proc.onEvent((msg) => {
        if (msg.method === "chat.delta") deltas.push(msg.params.delta);
        if (msg.method === "chat.done") resolve();
      });
    });
    await proc.request("chat.send", {
      requestId: "r1",
      model: "fake::fake-model",
      messages: [{ role: "user", content: "hi" }],
    });
    await done;

    assert.equal(deltas.join(""), "Hello from the sidecar!");
  } finally {
    proc.kill();
    await ollama.close();
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("harness: agent.run over real stdio writes a file through an approval round-trip", async () => {
  const ollama = await startFakeOllama([
    JSON.stringify({ tool: "create_file", args: { path: "hello.txt", content: "from the agent" } }),
    JSON.stringify({ final: "done" }),
  ]);
  const ws = await tmpWorkspace();
  const proc = new SidecarProcess(coreDir);
  try {
    await proc.request("initialize", {
      workspaceRoot: ws,
      providers: [{ id: "fake", kind: "ollama", label: "Fake", baseUrl: ollama.url }],
    });

    const finalText = new Promise<string>((resolve) => {
      proc.onEvent((msg) => {
        if (msg.method === "agent.approvalRequest") {
          proc.notify("agent.approve", { approvalId: msg.params.approvalId, choice: "approve" });
        }
        if (msg.method === "agent.final") resolve(msg.params.text);
      });
    });
    await proc.request("agent.run", {
      requestId: "a1",
      model: "fake::fake-model",
      task: "create hello.txt",
      mode: "agent",
    });
    assert.equal(await finalText, "done");

    const written = await fs.readFile(path.join(ws, "hello.txt"), "utf8");
    assert.equal(written, "from the agent");
  } finally {
    proc.kill();
    await ollama.close();
    await fs.rm(ws, { recursive: true, force: true });
  }
});
