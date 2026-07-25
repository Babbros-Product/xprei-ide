// Black-box integration test for the sidecar. Unlike session.test.ts (which
// calls SidecarSession's methods directly, in-process), this spawns the REAL
// `node --import tsx src/server/stdio.ts` child process and drives it over
// actual stdin/stdout with real line-delimited JSON — from source, as a
// developer running the sidecar directly would. (sidecarBundle.test.ts covers
// the equivalent proof against the esbuild-bundled artifact a distributed
// plugin actually ships.) It talks to a throwaway local HTTP server that
// speaks the Ollama wire format, so it stays fully offline and deterministic,
// and writes into a real temp directory via the real NodeAgentHost. This is
// the Phase 1 gate from docs/multi-ide-plan.md: "a CLI harness that runs a
// chat and an agent task against a temp workspace, proving MVP works with no
// IDE at all."

import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SidecarProcess, startFakeOllama } from "./_harnessUtil";

// packages/core has no "type": "module" -> CommonJS, so __dirname is native.
const coreDir = path.join(__dirname, "..", "..");
const stdioEntry = path.join(coreDir, "src", "server", "stdio.ts");

function spawnFromSource(): SidecarProcess {
  return new SidecarProcess(process.execPath, ["--import", "tsx", stdioEntry], coreDir);
}

async function tmpWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "xprei-harness-"));
}

test("harness: chat.send over real stdio streams deltas from a real HTTP backend", async () => {
  const ollama = await startFakeOllama(["Hello from the sidecar!"]);
  const ws = await tmpWorkspace();
  const proc = spawnFromSource();
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
  const proc = spawnFromSource();
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
