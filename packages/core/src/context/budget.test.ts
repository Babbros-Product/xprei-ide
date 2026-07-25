import assert from "node:assert/strict";
import { test } from "node:test";
import { budgetContext, CHARS_PER_TOKEN, CONTEXT_BLOCK_FRACTION } from "./budget";
import { FileContext, MIN_SCORE } from "./retrieval";
import { SearchHit } from "./vectorstore";

function file(path: string, content: string): FileContext {
  return { path, content };
}

function hit(path: string, text: string, score: number): SearchHit {
  return { score, chunk: { id: `${path}#1`, path, startLine: 1, endLine: 1, text } };
}

test("files that fit entirely within budget are returned unchanged", () => {
  const files = [file("a.ts", "x".repeat(100)), file("b.ts", "y".repeat(100))];
  const result = budgetContext(files, [], 10000); // huge window, no truncation expected
  assert.deepEqual(result.files, files);
});

test("a file that overflows the remaining budget is truncated, files after it are dropped", () => {
  // contextWindow=10 tokens * 4 chars/token * 0.5 fraction = 20 char budget.
  // a.ts alone (25 chars) already overflows the 20-char budget, so it gets
  // truncated to fill it exactly; b.ts and c.ts never get a chance.
  const files = [file("a.ts", "x".repeat(25)), file("b.ts", "y".repeat(5)), file("c.ts", "z".repeat(5))];
  const result = budgetContext(files, [], 10);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].path, "a.ts");
  assert.equal(result.files[0].content, "x".repeat(20) + "\n…(truncated)");
});

test("files alone consuming the entire budget leave zero room for hits", () => {
  const files = [file("a.ts", "x".repeat(20))]; // exactly fills a 20-char budget
  const hits = [hit("b.ts", "z".repeat(5), 0.9)];
  const result = budgetContext(files, hits, 10); // budget = 20
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].content, "x".repeat(20));
  assert.deepEqual(result.hits, []);
});

test("a higher-scored hit too large to fit is skipped; a smaller lower-scored hit after it still fits", () => {
  // budget = 10 tokens * 4 * 0.5 = 20 chars
  const hits = [
    hit("big.ts", "x".repeat(25), 0.9), // doesn't fit, skipped
    hit("small.ts", "y".repeat(10), 0.5), // fits, included
  ];
  const result = budgetContext([], hits, 10);
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].chunk.path, "small.ts");
});

test("hits below MIN_SCORE are excluded regardless of size or budget", () => {
  const hits = [hit("a.ts", "x", MIN_SCORE - 0.01)];
  const result = budgetContext([], hits, 1000);
  assert.deepEqual(result.hits, []);
});

test("empty files and hits produce empty output with no errors", () => {
  const result = budgetContext([], [], 8192);
  assert.deepEqual(result, { files: [], hits: [] });
});

test("a contextWindow of 0 yields an empty budget for both files and hits", () => {
  // totalBudget = floor(0 * 4 * 0.5) = 0, so the files loop's very first
  // `if (remaining <= 0) break;` fires immediately — nothing is pushed,
  // not even truncated to zero length.
  const files = [file("a.ts", "x")];
  const hits = [hit("b.ts", "y", 0.9)];
  const result = budgetContext(files, hits, 0);
  assert.deepEqual(result, { files: [], hits: [] });
});

test("CHARS_PER_TOKEN and CONTEXT_BLOCK_FRACTION have the spec's exact values", () => {
  assert.equal(CHARS_PER_TOKEN, 4);
  assert.equal(CONTEXT_BLOCK_FRACTION, 0.5);
});
