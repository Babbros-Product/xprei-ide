import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildContextMessage,
  FileContext,
  formatDiff,
  formatFiles,
  formatHits,
  formatProblems,
  formatRepoMap,
  formatTerminal,
  formatUrl,
  ProblemInfo,
} from "./retrieval";
import { FileSymbols } from "./repomap";
import { SearchHit } from "./vectorstore";

test("formatFiles renders each file with a FILE header, joined by blank lines", () => {
  const files: FileContext[] = [
    { path: "a.ts", content: "const a = 1;" },
    { path: "b.ts", content: "const b = 2;" },
  ];
  const out = formatFiles(files);
  assert.equal(out, "// FILE: a.ts\nconst a = 1;\n\n// FILE: b.ts\nconst b = 2;");
});

test("formatFiles truncates content longer than maxChars", () => {
  const files: FileContext[] = [{ path: "big.ts", content: "x".repeat(20) }];
  const out = formatFiles(files, 10);
  assert.match(out, /^\/\/ FILE: big\.ts\nx{10}\n…\(truncated\)$/);
});

test("formatFiles returns an empty string for an empty array", () => {
  assert.equal(formatFiles([]), "");
});

test("formatHits renders each hit with a location/score header, drops hits below minScore", () => {
  const hits: SearchHit[] = [
    { score: 0.9, chunk: { id: "a#1", path: "a.ts", startLine: 1, endLine: 2, text: "code a" } },
    { score: 0.1, chunk: { id: "b#1", path: "b.ts", startLine: 1, endLine: 1, text: "code b" } },
  ];
  const out = formatHits(hits);
  assert.match(out, /a\.ts:1-2 \(score 0\.90\)/);
  assert.doesNotMatch(out, /b\.ts/);
});

test("formatHits returns an empty string when every hit is below minScore", () => {
  const hits: SearchHit[] = [
    { score: 0.05, chunk: { id: "a#1", path: "a.ts", startLine: 1, endLine: 1, text: "x" } },
  ];
  assert.equal(formatHits(hits), "");
});

test("formatProblems renders one line per diagnostic with path, line, severity, message", () => {
  const problems: ProblemInfo[] = [
    { path: "a.ts", line: 12, severity: "error", message: "Type 'string' is not assignable to type 'number'." },
    { path: "b.ts", line: 3, severity: "warning", message: "Unused variable 'x'." },
  ];
  const out = formatProblems(problems);
  assert.equal(
    out,
    "// a.ts:12 (error) Type 'string' is not assignable to type 'number'.\n" +
      "// b.ts:3 (warning) Unused variable 'x'.",
  );
});

test("formatProblems returns an empty string for an empty array", () => {
  assert.equal(formatProblems([]), "");
});

test("buildContextMessage assembles files, problems, and retrieved sections in that order", () => {
  const out = buildContextMessage({
    files: "// FILE: a.ts\ncontent",
    problems: "// a.ts:1 (error) bad",
    retrieved: "// a.ts:1-2 (score 0.90)\ncode",
  });
  assert.equal(
    out,
    "The user referenced workspace context. Use it to answer.\n\n" +
      "// FILE: a.ts\ncontent\n\n" +
      "// a.ts:1 (error) bad\n\n" +
      "// Relevant code from the workspace:\n// a.ts:1-2 (score 0.90)\ncode",
  );
});

test("buildContextMessage returns an empty string when every part is empty", () => {
  assert.equal(buildContextMessage({}), "");
});

test("formatDiff wraps the diff text with a header comment", () => {
  const out = formatDiff("diff --git a/x.ts b/x.ts\n+added line");
  assert.equal(out, "// Current git diff:\ndiff --git a/x.ts b/x.ts\n+added line");
});

test("buildContextMessage assembles files, problems, diff, and retrieved in that order", () => {
  const out = buildContextMessage({
    files: "// FILE: a.ts\ncontent",
    problems: "// a.ts:1 (error) bad",
    diff: "// Current git diff:\ndiff --git a/x.ts b/x.ts",
    retrieved: "// a.ts:1-2 (score 0.90)\ncode",
  });
  assert.equal(
    out,
    "The user referenced workspace context. Use it to answer.\n\n" +
      "// FILE: a.ts\ncontent\n\n" +
      "// a.ts:1 (error) bad\n\n" +
      "// Current git diff:\ndiff --git a/x.ts b/x.ts\n\n" +
      "// Relevant code from the workspace:\n// a.ts:1-2 (score 0.90)\ncode",
  );
});

test("buildContextMessage with only diff present produces just the diff section", () => {
  const out = buildContextMessage({ diff: "// Current git diff:\nsome diff" });
  assert.equal(
    out,
    "The user referenced workspace context. Use it to answer.\n\n// Current git diff:\nsome diff",
  );
});

test("formatTerminal wraps the command and its output", () => {
  const out = formatTerminal("npm test", "PASS  src/index.test.ts\n5 tests passed");
  assert.equal(out, "// $ npm test\nPASS  src/index.test.ts\n5 tests passed");
});

test("buildContextMessage assembles files, problems, diff, terminal, and retrieved in that order", () => {
  const out = buildContextMessage({
    files: "// FILE: a.ts\ncontent",
    problems: "// a.ts:1 (error) bad",
    diff: "// Current git diff:\nsome diff",
    terminal: "// $ npm test\nPASS",
    retrieved: "// a.ts:1-2 (score 0.90)\ncode",
  });
  assert.equal(
    out,
    "The user referenced workspace context. Use it to answer.\n\n" +
      "// FILE: a.ts\ncontent\n\n" +
      "// a.ts:1 (error) bad\n\n" +
      "// Current git diff:\nsome diff\n\n" +
      "// $ npm test\nPASS\n\n" +
      "// Relevant code from the workspace:\n// a.ts:1-2 (score 0.90)\ncode",
  );
});

test("buildContextMessage with only terminal present produces just the terminal section", () => {
  const out = buildContextMessage({ terminal: "// $ npm test\nPASS" });
  assert.equal(
    out,
    "The user referenced workspace context. Use it to answer.\n\n// $ npm test\nPASS",
  );
});

test("formatUrl wraps the fetched content with the source URL", () => {
  const out = formatUrl("https://example.com", "Page title\nSome text.");
  assert.equal(out, "// URL: https://example.com\nPage title\nSome text.");
});

test("buildContextMessage assembles all six sections in the locked order", () => {
  const out = buildContextMessage({
    files: "// FILE: a.ts\ncontent",
    problems: "// a.ts:1 (error) bad",
    diff: "// Current git diff:\nsome diff",
    terminal: "// $ npm test\nPASS",
    url: "// URL: https://example.com\ncontent",
    retrieved: "// a.ts:1-2 (score 0.90)\ncode",
  });
  assert.equal(
    out,
    "The user referenced workspace context. Use it to answer.\n\n" +
      "// FILE: a.ts\ncontent\n\n" +
      "// a.ts:1 (error) bad\n\n" +
      "// Current git diff:\nsome diff\n\n" +
      "// $ npm test\nPASS\n\n" +
      "// URL: https://example.com\ncontent\n\n" +
      "// Relevant code from the workspace:\n// a.ts:1-2 (score 0.90)\ncode",
  );
});

test("buildContextMessage with only url present produces just the url section", () => {
  const out = buildContextMessage({ url: "// URL: https://example.com\ncontent" });
  assert.equal(
    out,
    "The user referenced workspace context. Use it to answer.\n\n// URL: https://example.com\ncontent",
  );
});

test("formatRepoMap renders one line per file with path and comma-joined symbols", () => {
  const files: FileSymbols[] = [
    { path: "a.ts", symbols: ["foo", "Bar"] },
    { path: "b.py", symbols: ["baz"] },
  ];
  const out = formatRepoMap(files);
  assert.equal(out, "// a.ts: foo, Bar\n// b.py: baz");
});

test("formatRepoMap returns an empty string for an empty array", () => {
  assert.equal(formatRepoMap([]), "");
});

test("buildContextMessage assembles all eight sections in the locked order", () => {
  const out = buildContextMessage({
    files: "// FILE: a.ts\ncontent",
    problems: "// a.ts:1 (error) bad",
    diff: "// Current git diff:\nsome diff",
    terminal: "// $ npm test\nPASS",
    url: "// URL: https://example.com\ncontent",
    repomap: "// a.ts: foo, Bar",
    retrieved: "// a.ts:1-2 (score 0.90)\ncode",
  });
  assert.equal(
    out,
    "The user referenced workspace context. Use it to answer.\n\n" +
      "// FILE: a.ts\ncontent\n\n" +
      "// a.ts:1 (error) bad\n\n" +
      "// Current git diff:\nsome diff\n\n" +
      "// $ npm test\nPASS\n\n" +
      "// URL: https://example.com\ncontent\n\n" +
      "// a.ts: foo, Bar\n\n" +
      "// Relevant code from the workspace:\n// a.ts:1-2 (score 0.90)\ncode",
  );
});

test("buildContextMessage with only repomap present produces just the repomap section", () => {
  const out = buildContextMessage({ repomap: "// a.ts: foo, Bar" });
  assert.equal(
    out,
    "The user referenced workspace context. Use it to answer.\n\n// a.ts: foo, Bar",
  );
});
