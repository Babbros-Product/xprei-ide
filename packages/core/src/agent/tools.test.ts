import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeHost } from "./_fakehost";
import { toolByName } from "./tools";

function tool(name: string) {
  const t = toolByName(name);
  assert.ok(t, `tool ${name} exists`);
  return t!;
}

test("read_file returns numbered content", async () => {
  const host = new FakeHost({ "a.ts": "const x = 1;\nconst y = 2;" });
  const r = await tool("read_file").run({ path: "a.ts" }, host);
  assert.match(r.observation, /1\tconst x = 1;/);
  assert.match(r.observation, /2\tconst y = 2;/);
});

test("read_file reports a missing file", async () => {
  const r = await tool("read_file").run({ path: "nope.ts" }, new FakeHost());
  assert.match(r.observation, /Error/);
});

test("create_file writes and reports the path for revert", async () => {
  const host = new FakeHost();
  const r = await tool("create_file").run({ path: "new.ts", content: "hi" }, host);
  assert.equal(host.files.get("new.ts"), "hi");
  assert.equal(r.wrote, "new.ts");
});

test("edit_file replaces a unique substring", async () => {
  const host = new FakeHost({ "a.ts": "let a = 1;" });
  const r = await tool("edit_file").run({ path: "a.ts", find: "let", replace: "const" }, host);
  assert.equal(host.files.get("a.ts"), "const a = 1;");
  assert.equal(r.wrote, "a.ts");
});

test("edit_file rejects an ambiguous match", async () => {
  const host = new FakeHost({ "a.ts": "x x" });
  const r = await tool("edit_file").run({ path: "a.ts", find: "x", replace: "y" }, host);
  assert.match(r.observation, /multiple/);
  assert.equal(host.files.get("a.ts"), "x x");
});

test("edit_file with no 'find' overwrites the whole file", async () => {
  const host = new FakeHost({ "a.ts": "old" });
  await tool("edit_file").run({ path: "a.ts", replace: "new" }, host);
  assert.equal(host.files.get("a.ts"), "new");
});

test("run_terminal surfaces exit code and streams", async () => {
  const host = new FakeHost();
  host.execResult = { stdout: "ok", stderr: "", code: 0 };
  const r = await tool("run_terminal").run({ command: "npm test" }, host);
  assert.deepEqual(host.execCalls, ["npm test"]);
  assert.match(r.observation, /exit code: 0/);
  assert.match(r.observation, /ok/);
});

test("grep formats file:line hits", async () => {
  const host = new FakeHost({ "a.ts": "foo\nbar foo" });
  const r = await tool("grep").run({ query: "foo" }, host);
  assert.match(r.observation, /a\.ts:1/);
  assert.match(r.observation, /a\.ts:2/);
});

test("read_file_range returns only the requested lines, 1-indexed", async () => {
  const host = new FakeHost({ "a.ts": "one\ntwo\nthree\nfour\nfive" });
  const r = await tool("read_file_range").run({ path: "a.ts", startLine: 2, endLine: 4 }, host);
  assert.match(r.observation, /2\ttwo/);
  assert.match(r.observation, /3\tthree/);
  assert.match(r.observation, /4\tfour/);
  assert.doesNotMatch(r.observation, /one/);
  assert.doesNotMatch(r.observation, /five/);
});

test("read_file_range clamps startLine below 1 and endLine past the file end", async () => {
  const host = new FakeHost({ "a.ts": "one\ntwo\nthree" });
  const r = await tool("read_file_range").run({ path: "a.ts", startLine: -5, endLine: 999 }, host);
  assert.match(r.observation, /1\tone/);
  assert.match(r.observation, /3\tthree/);
});

test("read_file_range errors when startLine > endLine after clamping", async () => {
  const host = new FakeHost({ "a.ts": "one\ntwo\nthree" });
  const r = await tool("read_file_range").run({ path: "a.ts", startLine: 3, endLine: 1 }, host);
  assert.match(r.observation, /Error/);
});

test("read_file_range errors on missing args", async () => {
  const host = new FakeHost({ "a.ts": "one" });
  const r = await tool("read_file_range").run({ path: "a.ts" }, host);
  assert.match(r.observation, /Error/);
});

test("read_file_range reports a missing file", async () => {
  const r = await tool("read_file_range").run({ path: "nope.ts", startLine: 1, endLine: 2 }, new FakeHost());
  assert.match(r.observation, /Error/);
});
