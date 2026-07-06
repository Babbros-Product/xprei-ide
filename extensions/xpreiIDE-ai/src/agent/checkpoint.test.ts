import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeHost } from "./_fakehost";
import { Checkpoint } from "./checkpoint";

test("revert restores prior content of an edited file", async () => {
  const host = new FakeHost({ "a.ts": "original" });
  const cp = new Checkpoint(host);
  await cp.note("a.ts");
  await host.writeFile("a.ts", "changed");
  await cp.revert();
  assert.equal(host.files.get("a.ts"), "original");
});

test("revert deletes a newly created file", async () => {
  const host = new FakeHost();
  const cp = new Checkpoint(host);
  await cp.note("new.ts");
  await host.writeFile("new.ts", "hi");
  await cp.revert();
  assert.equal(host.files.has("new.ts"), false);
});

test("note snapshots each path only once (first state wins)", async () => {
  const host = new FakeHost({ "a.ts": "v1" });
  const cp = new Checkpoint(host);
  await cp.note("a.ts");
  await host.writeFile("a.ts", "v2");
  await cp.note("a.ts"); // no-op; should not capture v2
  await host.writeFile("a.ts", "v3");
  await cp.revert();
  assert.equal(host.files.get("a.ts"), "v1");
  assert.deepEqual(cp.touched, ["a.ts"]);
});
