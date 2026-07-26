import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeHost } from "./_fakehost";
import { PendingEditOverlay } from "./pendingEditOverlay";

test("readFile falls back to the real host when nothing is buffered", async () => {
  const overlay = new PendingEditOverlay(new FakeHost({ "a.ts": "real" }));
  assert.equal(await overlay.readFile("a.ts"), "real");
});

test("readFile returns buffered content after a write; real host untouched", async () => {
  const real = new FakeHost({ "a.ts": "old" });
  const overlay = new PendingEditOverlay(real);
  await overlay.writeFile("a.ts", "new");
  assert.equal(await overlay.readFile("a.ts"), "new");
  assert.equal(real.files.get("a.ts"), "old");
});

test("first write captures before/existed; a second write preserves them", async () => {
  const overlay = new PendingEditOverlay(new FakeHost({ "a.ts": "v0" }));
  await overlay.writeFile("a.ts", "v1");
  await overlay.writeFile("a.ts", "v2");
  const [e] = overlay.pending;
  assert.equal(e.before, "v0");
  assert.equal(e.existed, true);
  assert.equal(e.after, "v2");
});

test("exists is true for an overlay-created file and false after deleteFile of a real file", async () => {
  const overlay = new PendingEditOverlay(new FakeHost({ "gone.ts": "x" }));
  await overlay.writeFile("new.ts", "n");
  await overlay.deleteFile("gone.ts");
  assert.equal(await overlay.exists("new.ts"), true);
  assert.equal(await overlay.exists("gone.ts"), false);
});

test("readFile on a delete-marker throws like a missing file", async () => {
  const overlay = new PendingEditOverlay(new FakeHost({ "gone.ts": "x" }));
  await overlay.deleteFile("gone.ts");
  await assert.rejects(() => overlay.readFile("gone.ts"));
});

test("deleteFile of an overlay-only creation removes the entry entirely (net zero)", async () => {
  const overlay = new PendingEditOverlay(new FakeHost());
  await overlay.writeFile("tmp.ts", "x");
  await overlay.deleteFile("tmp.ts");
  assert.equal(overlay.pending.length, 0);
});

test("deleteFile of a real file records a delete-marker; flush deletes it for real", async () => {
  const real = new FakeHost({ "gone.ts": "bye" });
  const overlay = new PendingEditOverlay(real);
  await overlay.deleteFile("gone.ts");
  const [e] = overlay.pending;
  assert.equal(e.deleted, true);
  assert.equal(e.before, "bye");
  await overlay.flush();
  assert.equal(real.files.has("gone.ts"), false);
});

test("listDir merges overlay-created names and hides overlay-deleted ones", async () => {
  const overlay = new PendingEditOverlay(new FakeHost({ "src/a.ts": "1", "src/b.ts": "2" }));
  await overlay.writeFile("src/c.ts", "3");
  await overlay.deleteFile("src/b.ts");
  const names = await overlay.listDir("src");
  assert.ok(names.includes("a.ts"));
  assert.ok(names.includes("c.ts"));
  assert.ok(!names.includes("b.ts"));
});

test("grep sees overlay content and drops stale real-host hits for overlaid files", async () => {
  const overlay = new PendingEditOverlay(new FakeHost({ "a.ts": "needle old" }));
  await overlay.writeFile("a.ts", "nothing here");
  await overlay.writeFile("b.ts", "needle new");
  const hits = await overlay.grep("needle");
  assert.deepEqual(hits.map((h) => h.file), ["b.ts"]);
});

test("glob includes overlay-created files matching the pattern and excludes deleted ones", async () => {
  const overlay = new PendingEditOverlay(new FakeHost({ "a.ts": "1", "b.ts": "2" }));
  await overlay.writeFile("c.ts", "3");
  await overlay.deleteFile("b.ts");
  const out = await overlay.glob("*.ts");
  assert.ok(out.includes("a.ts"));
  assert.ok(out.includes("c.ts"));
  assert.ok(!out.includes("b.ts"));
});

test("flush() writes everything, clears state, and returns the flushed entries", async () => {
  const real = new FakeHost();
  const overlay = new PendingEditOverlay(real);
  await overlay.writeFile("x.ts", "X");
  await overlay.writeFile("y.ts", "Y");
  const { flushed, failed } = await overlay.flush();
  assert.equal(flushed.length, 2);
  assert.equal(failed.length, 0);
  assert.equal(overlay.pending.length, 0);
  assert.equal(real.files.get("x.ts"), "X");
  assert.equal(real.files.get("y.ts"), "Y");
});

test("flush(path) flushes one entry and leaves the rest pending", async () => {
  const real = new FakeHost();
  const overlay = new PendingEditOverlay(real);
  await overlay.writeFile("x.ts", "X");
  await overlay.writeFile("y.ts", "Y");
  await overlay.flush("x.ts");
  assert.equal(real.files.get("x.ts"), "X");
  assert.equal(real.files.has("y.ts"), false);
  assert.deepEqual(overlay.pending.map((e) => e.path), ["y.ts"]);
});

test("discard drops an entry without writing", async () => {
  const real = new FakeHost();
  const overlay = new PendingEditOverlay(real);
  await overlay.writeFile("x.ts", "X");
  overlay.discard("x.ts");
  assert.equal(overlay.pending.length, 0);
  assert.equal(real.files.has("x.ts"), false);
});

test("a write failure during flush is reported per-entry; others flush; the failed one stays pending", async () => {
  class FailingHost extends FakeHost {
    async writeFile(path: string, content: string): Promise<void> {
      if (path === "bad.ts") throw new Error("disk full");
      return super.writeFile(path, content);
    }
  }
  const real = new FailingHost();
  const overlay = new PendingEditOverlay(real);
  await overlay.writeFile("good.ts", "G");
  await overlay.writeFile("bad.ts", "B");
  const { flushed, failed } = await overlay.flush();
  assert.deepEqual(flushed.map((e) => e.path), ["good.ts"]);
  assert.deepEqual(failed.map((f) => f.path), ["bad.ts"]);
  assert.match(failed[0].error, /disk full/);
  assert.deepEqual(overlay.pending.map((e) => e.path), ["bad.ts"]);
});
