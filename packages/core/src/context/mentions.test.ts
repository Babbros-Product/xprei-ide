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

test("@open sets the flag and is stripped from the query", () => {
  const m = parseMentions("what's wrong with this @open please");
  assert.equal(m.open, true);
  assert.equal(m.cleaned, "what's wrong with this please");
  assert.ok(hasContextRequest(m));
});

test("@problems sets the flag and is stripped from the query", () => {
  const m = parseMentions("fix the errors @problems now");
  assert.equal(m.problems, true);
  assert.equal(m.cleaned, "fix the errors now");
  assert.ok(hasContextRequest(m));
});

test("@open, @problems, @codebase, and @file: can all be combined", () => {
  const m = parseMentions("@open @problems @codebase check @file:a.ts too");
  assert.equal(m.open, true);
  assert.equal(m.problems, true);
  assert.equal(m.codebase, true);
  assert.deepEqual(m.files, ["a.ts"]);
  assert.equal(m.cleaned, "check too");
});

test("neither @open nor @problems is set when absent", () => {
  const m = parseMentions("just a normal question");
  assert.equal(m.open, false);
  assert.equal(m.problems, false);
});

test("@diff sets the flag and is stripped from the query", () => {
  const m = parseMentions("what changed @diff exactly");
  assert.equal(m.diff, true);
  assert.equal(m.cleaned, "what changed exactly");
  assert.ok(hasContextRequest(m));
});

test("@diff combines with @open, @problems, @codebase, and @file:", () => {
  const m = parseMentions("@diff @open @problems @codebase check @file:a.ts too");
  assert.equal(m.diff, true);
  assert.equal(m.open, true);
  assert.equal(m.problems, true);
  assert.equal(m.codebase, true);
  assert.deepEqual(m.files, ["a.ts"]);
  assert.equal(m.cleaned, "check too");
});

test("diff flag is false when absent", () => {
  const m = parseMentions("just a normal question");
  assert.equal(m.diff, false);
});
