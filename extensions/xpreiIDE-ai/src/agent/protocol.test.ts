import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAgentSystemPrompt, parseAction } from "./protocol";
import { TOOLS } from "./tools";

test("parseAction reads a bare tool-call object", () => {
  const a = parseAction('{"thought":"look","tool":"read_file","args":{"path":"a.ts"}}');
  assert.equal(a.kind, "tool");
  if (a.kind !== "tool") return;
  assert.equal(a.tool, "read_file");
  assert.equal(a.args.path, "a.ts");
  assert.equal(a.thought, "look");
});

test("parseAction reads a final object", () => {
  const a = parseAction('{"final":"all done"}');
  assert.equal(a.kind, "final");
  if (a.kind === "final") assert.equal(a.text, "all done");
});

test("parseAction strips ```json fences and surrounding prose", () => {
  const raw = 'Sure!\n```json\n{"tool":"list_dir","args":{"path":"src"}}\n```\nDone.';
  const a = parseAction(raw);
  assert.equal(a.kind, "tool");
  if (a.kind === "tool") assert.equal(a.tool, "list_dir");
});

test("parseAction ignores trailing prose after a balanced object", () => {
  const a = parseAction('{"tool":"grep","args":{"query":"foo"}} then I will read it');
  assert.equal(a.kind, "tool");
  if (a.kind === "tool") assert.equal(a.args.query, "foo");
});

test("parseAction falls back to final for non-JSON chatter", () => {
  const a = parseAction("I think the bug is in auth.ts");
  assert.equal(a.kind, "final");
  if (a.kind === "final") assert.match(a.text, /auth\.ts/);
});

test("parseAction handles braces inside strings", () => {
  const a = parseAction('{"tool":"create_file","args":{"path":"x.json","content":"{ \\"a\\": 1 }"}}');
  assert.equal(a.kind, "tool");
  if (a.kind === "tool") assert.equal(a.args.content, '{ "a": 1 }');
});

test("system prompt lists every tool and the response contract", () => {
  const p = buildAgentSystemPrompt(TOOLS, "/work");
  for (const t of TOOLS) assert.ok(p.includes(t.name), `missing ${t.name}`);
  assert.match(p, /"final"/);
  assert.match(p, /\/work/);
});
