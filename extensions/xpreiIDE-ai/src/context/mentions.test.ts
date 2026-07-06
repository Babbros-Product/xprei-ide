import assert from "node:assert/strict";
import { test } from "node:test";
import { hasContextRequest, parseMentions } from "./mentions";

test("@codebase sets the flag and is stripped from the query", () => {
  const m = parseMentions("explain the auth flow @codebase please");
  assert.equal(m.codebase, true);
  assert.equal(m.cleaned, "explain the auth flow please");
  assert.ok(hasContextRequest(m));
});

test("@file:path captures explicit files", () => {
  const m = parseMentions("what does @file:src/providers/ollama.ts do?");
  assert.deepEqual(m.files, ["src/providers/ollama.ts"]);
  assert.equal(m.cleaned, "what does do?");
});

test("bare @path shorthand captures slashed or dotted tokens", () => {
  const m = parseMentions("compare @src/a.ts and @b.py");
  assert.deepEqual(m.files, ["src/a.ts", "b.py"]);
});

test("plain email-like @handle is not treated as a file", () => {
  const m = parseMentions("ping @teammate about this");
  assert.deepEqual(m.files, []);
  assert.equal(m.codebase, false);
  assert.equal(hasContextRequest(m), false);
});

test("duplicate file mentions are de-duplicated", () => {
  const m = parseMentions("@file:a.ts and again @a.ts");
  assert.deepEqual(m.files, ["a.ts"]);
});
