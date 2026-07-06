import assert from "node:assert/strict";
import { test } from "node:test";
import { Chunk } from "./chunking";
import { VectorStore } from "./vectorstore";

function chunk(id: string, path = "a.ts"): Chunk {
  return { id, path, startLine: 1, endLine: 1, text: id };
}

test("search ranks by cosine similarity", () => {
  const s = new VectorStore();
  s.configure("ollama::embed", 2);
  s.upsert(
    [chunk("east"), chunk("north"), chunk("west")],
    [[1, 0], [0, 1], [-1, 0]],
  );
  const hits = s.search([0.9, 0.1], 3);
  assert.equal(hits[0].chunk.id, "east");
  assert.equal(hits[2].chunk.id, "west");
  assert.ok(hits[0].score > hits[1].score);
});

test("removeByPath deletes all chunks of a file", () => {
  const s = new VectorStore();
  s.upsert([chunk("a#1", "a.ts"), chunk("a#2", "a.ts"), chunk("b#1", "b.ts")], [
    [1, 0],
    [0, 1],
    [1, 1],
  ]);
  s.removeByPath("a.ts");
  assert.equal(s.size, 1);
  assert.equal(s.search([1, 1], 1)[0].chunk.path, "b.ts");
});

test("configure clears the index when the embed model changes", () => {
  const s = new VectorStore();
  s.configure("ollama::embed-a", 2);
  s.upsert([chunk("x")], [[1, 0]]);
  assert.equal(s.size, 1);
  s.configure("ollama::embed-b", 2); // different model → incomparable vectors
  assert.equal(s.size, 0);
});

test("toJSON/fromJSON round-trips records and model key", () => {
  const s = new VectorStore();
  s.configure("ollama::embed", 2);
  s.upsert([chunk("x")], [[3, 4]]); // normalized to (0.6, 0.8)
  const back = VectorStore.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
  assert.equal(back.size, 1);
  assert.equal(back.modelKey, "ollama::embed");
  assert.ok(Math.abs(back.search([1, 0], 1)[0].score - 0.6) < 1e-9);
});

test("fromJSON rejects malformed / versionless data", () => {
  assert.equal(VectorStore.fromJSON(null).size, 0);
  assert.equal(VectorStore.fromJSON({ version: 99 }).size, 0);
});
