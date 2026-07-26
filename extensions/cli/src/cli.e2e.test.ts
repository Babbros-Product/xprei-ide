import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile, execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startFakeOllama } from "./_fakeOllama";

const execFileAsync = promisify(execFile);
const cliPath = path.join(__dirname, "..", "dist", "cli.cjs");

async function tmpWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "xprei-cli-e2e-"));
}

async function writeConfig(baseUrl: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xprei-cli-config-"));
  const p = path.join(dir, "config.yaml");
  await fs.writeFile(
    p,
    `providers:\n  - id: fake\n    kind: ollama\n    label: Fake\n    baseUrl: ${baseUrl}\n` +
      `activeModel: fake::fake-model\n`,
    "utf8",
  );
  return p;
}

test("xprei chat streams the reply to stdout and exits 0", async () => {
  const ollama = await startFakeOllama(["Hello from the CLI!"]);
  const configPath = await writeConfig(ollama.url);
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      cliPath,
      "chat",
      "hi",
      "--config",
      configPath,
    ]);
    assert.match(stdout, /Hello from the CLI!/);
  } finally {
    await ollama.close();
  }
});

test("xprei agent --auto-approve writes a file and exits 0", async () => {
  const ollama = await startFakeOllama([
    JSON.stringify({ tool: "create_file", args: { path: "hello.txt", content: "from the cli" } }),
    JSON.stringify({ final: "done" }),
  ]);
  const configPath = await writeConfig(ollama.url);
  const ws = await tmpWorkspace();
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      cliPath,
      "agent",
      "create hello.txt",
      "--config",
      configPath,
      "--workspace",
      ws,
      "--auto-approve",
    ]);
    assert.match(stdout, /final: done/);
    const written = await fs.readFile(path.join(ws, "hello.txt"), "utf8");
    assert.equal(written, "from the cli");
  } finally {
    await ollama.close();
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("xprei agent without --auto-approve does not write when the user answers 'n'", async () => {
  const ollama = await startFakeOllama([
    JSON.stringify({ tool: "create_file", args: { path: "hello.txt", content: "from the cli" } }),
    JSON.stringify({ final: "done" }),
  ]);
  const configPath = await writeConfig(ollama.url);
  const ws = await tmpWorkspace();
  try {
    await new Promise<void>((resolve, reject) => {
      const child = execFileCb(
        process.execPath,
        [cliPath, "agent", "create hello.txt", "--config", configPath, "--workspace", ws],
        (err) => {
          if (err && !("code" in err)) reject(err);
          else resolve();
        },
      );
      child.stdin?.write("n\n");
      child.stdin?.end();
    });
    await assert.rejects(() => fs.readFile(path.join(ws, "hello.txt"), "utf8"));
  } finally {
    await ollama.close();
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("xprei agent with a broken --config exits non-zero with a clear message, not a stack trace", async () => {
  const ws = await tmpWorkspace();
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [
        cliPath,
        "agent",
        "do something",
        "--config",
        path.join(ws, "does-not-exist.yaml"),
        "--workspace",
        ws,
      ]),
      (err: unknown) => {
        const e = err as { code?: number; stderr?: string };
        return e.code === 1 && typeof e.stderr === "string" && /No config found/.test(e.stderr);
      },
    );
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});
