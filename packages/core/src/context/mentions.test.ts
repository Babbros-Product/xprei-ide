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

test("@terminal:<command> captures everything to the end of the message", () => {
  const m = parseMentions("why did this fail @terminal:npm test");
  assert.equal(m.terminalCommand, "npm test");
  assert.equal(m.cleaned, "why did this fail");
  assert.ok(hasContextRequest(m));
});

test("@terminal:<command> with a multi-word command including flags", () => {
  const m = parseMentions("@terminal:git status -sb");
  assert.equal(m.terminalCommand, "git status -sb");
});

test("@terminal is undefined when absent", () => {
  const m = parseMentions("just a normal question");
  assert.equal(m.terminalCommand, undefined);
  assert.equal(hasContextRequest(m), false);
});

test("@terminal:<command> runs before other mention regexes and doesn't let them steal from it", () => {
  // Without the "runs first, claims to end-of-string" rule, FILE_RE or
  // BARE_PATH_RE could try to parse "src/index.ts" out of the command
  // text as a separate @file: mention. It must not.
  const m = parseMentions("@terminal:npm run build src/index.ts");
  assert.equal(m.terminalCommand, "npm run build src/index.ts");
  assert.deepEqual(m.files, []);
});

test("@terminal combines with other mention types when they precede it", () => {
  const m = parseMentions("@codebase @diff explain @terminal:npm test");
  assert.equal(m.codebase, true);
  assert.equal(m.diff, true);
  assert.equal(m.terminalCommand, "npm test");
  assert.equal(m.cleaned, "explain");
});

test("@url:<address> captures the address and is stripped from the query", () => {
  const m = parseMentions("summarize @url:https://example.com/page please");
  assert.equal(m.url, "https://example.com/page");
  assert.equal(m.cleaned, "summarize please");
  assert.ok(hasContextRequest(m));
});

test("@url is undefined when absent", () => {
  const m = parseMentions("just a normal question");
  assert.equal(m.url, undefined);
});

test("@url combines with the other mention types", () => {
  const m = parseMentions("@url:https://example.com @diff @problems check this");
  assert.equal(m.url, "https://example.com");
  assert.equal(m.diff, true);
  assert.equal(m.problems, true);
  assert.equal(m.cleaned, "check this");
});

test("@url does not consume a trailing @terminal: mention", () => {
  // @terminal:'s end-of-string capture runs first and claims everything
  // after it — @url: must still work when it appears BEFORE @terminal:.
  const m = parseMentions("@url:https://example.com/x @terminal:npm test");
  assert.equal(m.url, "https://example.com/x");
  assert.equal(m.terminalCommand, "npm test");
});

test("@repomap sets the flag and is stripped from the query", () => {
  const m = parseMentions("give me an overview @repomap of the project");
  assert.equal(m.repomap, true);
  assert.equal(m.cleaned, "give me an overview of the project");
  assert.ok(hasContextRequest(m));
});

test("@repomap is false when absent", () => {
  const m = parseMentions("just a normal question");
  assert.equal(m.repomap, false);
});

test("@repomap combines with the other mention types", () => {
  const m = parseMentions("@repomap @diff @url:https://example.com explain this");
  assert.equal(m.repomap, true);
  assert.equal(m.diff, true);
  assert.equal(m.url, "https://example.com");
  assert.equal(m.cleaned, "explain this");
});
