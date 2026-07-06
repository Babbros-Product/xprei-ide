import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkFile, looksBinary } from "./chunking";

test("chunkFile splits into overlapping windows with stable ids", () => {
  const lines = Array.from({ length: 130 }, (_, i) => `line ${i + 1}`).join("\n");
  const chunks = chunkFile("src/a.ts", lines, {
    windowLines: 60,
    overlapLines: 10,
    maxCharsPerChunk: 10000,
  });
  // step = 50, so starts at 1, 51, 101 → 3 chunks.
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].id, "src/a.ts#1");
  assert.equal(chunks[0].startLine, 1);
  assert.equal(chunks[0].endLine, 60);
  assert.equal(chunks[1].startLine, 51); // 10-line overlap with chunk 0
  assert.equal(chunks[2].endLine, 130);
});

test("chunkFile returns nothing for empty or binary content", () => {
  assert.deepEqual(chunkFile("x", "   \n  \n"), []);
  assert.deepEqual(chunkFile("x", "abc" + String.fromCharCode(0) + "def"), []);
});

test("chunkFile caps chunk length", () => {
  const huge = "x".repeat(9000);
  const [chunk] = chunkFile("big.txt", huge, {
    windowLines: 60,
    overlapLines: 10,
    maxCharsPerChunk: 4000,
  });
  assert.equal(chunk.text.length, 4000);
});

test("looksBinary detects NUL bytes only", () => {
  assert.equal(looksBinary("plain text file"), false);
  assert.equal(looksBinary("has a " + String.fromCharCode(0) + " nul"), true);
});
