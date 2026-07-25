// Proves the distributable artifact, not just the source. A JetBrains/Eclipse
// plugin cannot ship the whole monorepo + tsx — it ships one bundled JS file
// and spawns it with a bare `node`. This test runs the actual esbuild command
// from package.json's build:sidecar script, then spawns the resulting
// dist/sidecar.cjs with PLAIN node (no --import tsx, no cwd inside the repo)
// to prove it's genuinely standalone, before driving the same chat + agent
// checks harness.test.ts runs against the from-source sidecar.

import assert from "node:assert/strict";
import { test, before } from "node:test";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SidecarProcess, startFakeOllama } from "./_harnessUtil";

const coreDir = path.join(__dirname, "..", "..");
const bundlePath = path.join(coreDir, "dist", "sidecar.cjs");

before(() => {
  execFileSync(
    process.execPath,
    [
      path.join(coreDir, "node_modules", "esbuild", "bin", "esbuild"),
      path.join(coreDir, "src", "server", "stdio.ts"),
      "--bundle",
      `--outfile=${bundlePath}`,
      "--platform=node",
      "--format=cjs",
      "--target=node18",
    ],
    { cwd: coreDir },
  );
});

async function tmpWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "xprei-bundle-"));
}

// A neutral cwd, NOT inside the monorepo, so a relative-path bug (e.g.
// accidentally resolving something off process.cwd() instead of the module's
// own location) can't hide behind "well it's run from packages/core anyway".
function neutralCwd(): string {
  return os.tmpdir();
}

test("sidecar.cjs is a single self-contained file with no bundled node_modules", async () => {
  const stat = await fs.stat(bundlePath);
  assert.ok(stat.isFile());
  assert.ok(stat.size > 1000, "bundle should contain real code, not be empty");
});

test("bundled sidecar: chat.send over real stdio, spawned with plain node from outside the repo", async () => {
  const ollama = await startFakeOllama(["Hello from the bundle!"]);
  const ws = await tmpWorkspace();
  const proc = new SidecarProcess(process.execPath, [bundlePath], neutralCwd());
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

    assert.equal(deltas.join(""), "Hello from the bundle!");
  } finally {
    proc.kill();
    await ollama.close();
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("bundled sidecar: agent.run writes a file through an approval round-trip", async () => {
  const ollama = await startFakeOllama([
    JSON.stringify({ tool: "create_file", args: { path: "hello.txt", content: "from the bundle" } }),
    JSON.stringify({ final: "done" }),
  ]);
  const ws = await tmpWorkspace();
  const proc = new SidecarProcess(process.execPath, [bundlePath], neutralCwd());
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
    assert.equal(written, "from the bundle");
  } finally {
    proc.kill();
    await ollama.close();
    await fs.rm(ws, { recursive: true, force: true });
  }
});
