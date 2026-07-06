import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEditMessages, stripCodeFences } from "./prompt";

test("buildEditMessages includes instruction, selection, and context", () => {
  const msgs = buildEditMessages({
    instruction: "add types",
    languageId: "typescript",
    selection: "function f(x) { return x }",
    path: "src/a.ts",
    before: "// header",
  });
  assert.equal(msgs[0].role, "system");
  const user = msgs[1].content;
  assert.match(user, /add types/);
  assert.match(user, /function f\(x\)/);
  assert.match(user, /src\/a\.ts \(typescript\)/);
  assert.match(user, /Code before selection:/);
});

test("stripCodeFences removes a wrapping fence pair", () => {
  assert.equal(stripCodeFences("```ts\nconst a = 1;\n```"), "const a = 1;");
  assert.equal(stripCodeFences("```\nx\n```"), "x");
});

test("stripCodeFences leaves unfenced code untouched", () => {
  assert.equal(stripCodeFences("const a = 1;"), "const a = 1;");
  // Inner triple-backticks (not a wrapping pair) are preserved.
  const md = "const s = '```';";
  assert.equal(stripCodeFences(md), md);
});
