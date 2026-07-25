import assert from "node:assert/strict";
import { test } from "node:test";
import { isIgnoredByPatterns, matchesIgnorePattern, parseIgnorePatterns } from "./ignoreFile";

test("parseIgnorePatterns strips comments and blank lines", () => {
  const content = "# comment\n\nnode_modules\n  \ndist/\n*.log\n";
  assert.deepEqual(parseIgnorePatterns(content), ["node_modules", "dist/", "*.log"]);
});

test("parseIgnorePatterns trims trailing whitespace from each pattern", () => {
  assert.deepEqual(parseIgnorePatterns("build/  \n"), ["build/"]);
});

test("matchesIgnorePattern: no-slash pattern matches at any depth by segment", () => {
  assert.equal(matchesIgnorePattern("coverage/lcov.info", "coverage"), true);
  assert.equal(matchesIgnorePattern("src/deep/coverage/x.js", "coverage"), true);
  assert.equal(matchesIgnorePattern("src/coverage-report.js", "coverage"), false);
});

test("matchesIgnorePattern: slash-containing pattern is anchored to the root", () => {
  assert.equal(matchesIgnorePattern("build/output.js", "build/output.js"), true);
  assert.equal(matchesIgnorePattern("src/build/output.js", "build/output.js"), false);
});

test("matchesIgnorePattern: '*' matches within one segment only", () => {
  assert.equal(matchesIgnorePattern("a.log", "*.log"), true);
  assert.equal(matchesIgnorePattern("dir/a.log", "*.log"), true);
  assert.equal(matchesIgnorePattern("dir/a/b.log", "dir/*.log"), false);
});

test("matchesIgnorePattern: '**' matches across segments", () => {
  assert.equal(matchesIgnorePattern("build/a.js", "build/**"), true);
  assert.equal(matchesIgnorePattern("build/sub/a.js", "build/**"), true);
  assert.equal(matchesIgnorePattern("other/a.js", "build/**"), false);
});

test("matchesIgnorePattern: trailing slash is stripped before matching", () => {
  assert.equal(matchesIgnorePattern("vendor/lib.js", "vendor/"), true);
});

test("isIgnoredByPatterns is true if any pattern matches", () => {
  assert.equal(isIgnoredByPatterns("a.tmp", ["*.log", "*.tmp"]), true);
  assert.equal(isIgnoredByPatterns("a.ts", ["*.log", "*.tmp"]), false);
});

test("isIgnoredByPatterns is false for an empty patterns array", () => {
  assert.equal(isIgnoredByPatterns("anything.ts", []), false);
});
