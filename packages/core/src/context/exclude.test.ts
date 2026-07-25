import assert from "node:assert/strict";
import { test } from "node:test";
import { EXCLUDED_DIRS, isExcludedPath, SCAN_EXCLUDE } from "./exclude";

test("isExcludedPath flags paths under an excluded directory at any depth", () => {
  assert.equal(isExcludedPath("node_modules/foo/index.js"), true);
  assert.equal(isExcludedPath("packages/app/node_modules/x.ts"), true);
  assert.equal(isExcludedPath("src/.git/HEAD"), true);
  assert.equal(isExcludedPath("dist/bundle.js"), true);
  assert.equal(isExcludedPath("api/__pycache__/mod.pyc"), true);
});

test("isExcludedPath allows normal source paths", () => {
  assert.equal(isExcludedPath("src/agent/tools.ts"), false);
  assert.equal(isExcludedPath("README.md"), false);
  // A file whose NAME merely contains an excluded token is not excluded.
  assert.equal(isExcludedPath("src/build-helpers.ts"), false);
  assert.equal(isExcludedPath("src/distribute.ts"), false);
});

test("SCAN_EXCLUDE glob is built from the same EXCLUDED_DIRS list", () => {
  for (const dir of EXCLUDED_DIRS) {
    assert.ok(SCAN_EXCLUDE.includes(dir), `glob should mention ${dir}`);
  }
  assert.match(SCAN_EXCLUDE, /^\*\*\/\{.*\}\/\*\*$/);
});

test("isExcludedPath is additive: built-in dirs always excluded regardless of extraPatterns", () => {
  assert.equal(isExcludedPath("node_modules/x.js", []), true);
  assert.equal(isExcludedPath("node_modules/x.js", ["*.md"]), true);
});

test("isExcludedPath excludes a path matching an extra pattern", () => {
  assert.equal(isExcludedPath("notes.md", ["*.md"]), true);
  assert.equal(isExcludedPath("notes.md"), false);
});

test("isExcludedPath's second parameter is optional and defaults to no extra patterns", () => {
  assert.equal(isExcludedPath("src/index.ts"), false);
});
