import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NodeAgentHost } from "./nodeHost";

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "xprei-nodehost-"));
}

test("writeFile creates parent dirs, readFile round-trips", async () => {
  const root = await tmpRoot();
  const host = new NodeAgentHost(root);
  await host.writeFile("a/b/c.txt", "hello");
  assert.equal(await host.readFile("a/b/c.txt"), "hello");
  assert.equal(await host.exists("a/b/c.txt"), true);
  assert.equal(await host.exists("nope.txt"), false);
});

test("listDir marks directories with a trailing slash", async () => {
  const root = await tmpRoot();
  const host = new NodeAgentHost(root);
  await host.writeFile("dir/inner.txt", "x");
  await host.writeFile("top.txt", "y");
  const entries = (await host.listDir(".")).sort();
  assert.deepEqual(entries, ["dir/", "top.txt"]);
});

test("deleteFile removes a file and is idempotent", async () => {
  const root = await tmpRoot();
  const host = new NodeAgentHost(root);
  await host.writeFile("gone.txt", "x");
  await host.deleteFile("gone.txt");
  assert.equal(await host.exists("gone.txt"), false);
  await host.deleteFile("gone.txt"); // no throw on already-gone
});

test("grep finds matches, reports rel path + 1-based line, skips excluded dirs", async () => {
  const root = await tmpRoot();
  const host = new NodeAgentHost(root);
  await host.writeFile("src/a.ts", "const x = 1;\nfindme here\n");
  await host.writeFile("src/b.ts", "nothing\n");
  await host.writeFile("node_modules/pkg/index.js", "findme in deps");
  const hits = await host.grep("findme");
  assert.equal(hits.length, 1, "node_modules match is excluded");
  assert.equal(hits[0].file, "src/a.ts");
  assert.equal(hits[0].line, 2);
  assert.match(hits[0].text, /findme/);
});

test("path traversal outside the root is rejected", async () => {
  const root = await tmpRoot();
  const host = new NodeAgentHost(root);
  await assert.rejects(() => host.readFile("../escape.txt"));
});

test("exec returns stdout and a zero exit code for a successful command", async () => {
  const root = await tmpRoot();
  const host = new NodeAgentHost(root);
  const r = await host.exec(process.platform === "win32" ? "echo hi" : "printf hi");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /hi/);
});

test("exec surfaces a non-zero exit code instead of throwing", async () => {
  const root = await tmpRoot();
  const host = new NodeAgentHost(root);
  const r = await host.exec(process.platform === "win32" ? "exit /b 3" : "exit 3");
  assert.notEqual(r.code, 0);
});
