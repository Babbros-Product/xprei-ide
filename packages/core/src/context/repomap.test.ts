import assert from "node:assert/strict";
import { test } from "node:test";
import { extractSymbols } from "./repomap";

test("extractSymbols finds an exported function", () => {
  const result = extractSymbols("a.ts", "export function foo() {}\n");
  assert.deepEqual(result, { path: "a.ts", symbols: ["foo"] });
});

test("extractSymbols finds an exported async function", () => {
  const result = extractSymbols("a.ts", "export async function bar() {}\n");
  assert.deepEqual(result, { path: "a.ts", symbols: ["bar"] });
});

test("extractSymbols finds an exported class", () => {
  const result = extractSymbols("a.ts", "export class Baz {}\n");
  assert.deepEqual(result, { path: "a.ts", symbols: ["Baz"] });
});

test("extractSymbols finds an exported interface", () => {
  const result = extractSymbols("a.ts", "export interface Qux {\n  x: number;\n}\n");
  assert.deepEqual(result, { path: "a.ts", symbols: ["Qux"] });
});

test("extractSymbols finds an exported type alias", () => {
  const result = extractSymbols("a.ts", "export type Quux = string;\n");
  assert.deepEqual(result, { path: "a.ts", symbols: ["Quux"] });
});

test("extractSymbols finds an exported const and let", () => {
  const result = extractSymbols("a.ts", "export const corge = 1;\nexport let grault = 2;\n");
  assert.deepEqual(result, { path: "a.ts", symbols: ["corge", "grault"] });
});

test("extractSymbols finds multiple exports across a .js file, in source order", () => {
  const content = "export function a() {}\nexport const b = 1;\nexport class C {}\n";
  const result = extractSymbols("a.js", content);
  assert.deepEqual(result, { path: "a.js", symbols: ["a", "b", "C"] });
});

test("extractSymbols ignores non-exported top-level declarations", () => {
  const result = extractSymbols("a.ts", "function internal() {}\nconst x = 1;\n");
  assert.equal(result, undefined);
});

test("extractSymbols finds top-level Python def and class at column 0", () => {
  const content = "def foo():\n    return 1\n\nclass Bar:\n    pass\n";
  const result = extractSymbols("a.py", content);
  assert.deepEqual(result, { path: "a.py", symbols: ["foo", "Bar"] });
});

test("extractSymbols excludes underscore-prefixed Python names", () => {
  const content = "def _private():\n    pass\n\ndef public():\n    pass\n";
  const result = extractSymbols("a.py", content);
  assert.deepEqual(result, { path: "a.py", symbols: ["public"] });
});

test("extractSymbols excludes indented Python def/class inside a class body", () => {
  const content = "class Outer:\n    def method(self):\n        pass\n";
  const result = extractSymbols("a.py", content);
  assert.deepEqual(result, { path: "a.py", symbols: ["Outer"] });
});

test("extractSymbols returns undefined for an unrecognized extension", () => {
  const result = extractSymbols("README.md", "# Title\n\nSome text.\n");
  assert.equal(result, undefined);
});

test("extractSymbols returns undefined for a recognized extension with zero matches", () => {
  const result = extractSymbols("empty.ts", "// just a comment\nconst x = 1;\n");
  assert.equal(result, undefined);
});
