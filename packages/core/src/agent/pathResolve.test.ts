import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveWorkspacePath } from "./pathResolve";

test("plain relative path passes through unchanged", () => {
  const result = resolveWorkspacePath("d:\\test", "src/App.ts");
  assert.deepEqual(result, { relPath: "src/App.ts" });
});

test("relative path with backslashes is normalized to forward slashes", () => {
  const result = resolveWorkspacePath("d:\\test", "src\\main\\App.java");
  assert.deepEqual(result, { relPath: "src/main/App.java" });
});

test("absolute path that already points inside the workspace is rebased to relative", () => {
  // Regression: a model handed back the full absolute path instead of a
  // workspace-relative one. Previously this got glued onto the root as one
  // literal segment, producing a corrupted "d:\test\d:\test\..." mkdir target.
  const result = resolveWorkspacePath("d:\\test", "d:\\test\\src\\main\\spring-boot-app");
  assert.deepEqual(result, { relPath: "src/main/spring-boot-app" });
});

test("absolute path outside the workspace returns a corrective error", () => {
  const result = resolveWorkspacePath("d:\\test", "c:\\other\\file.txt");
  assert.ok("error" in result);
  assert.match((result as { error: string }).error, /must be relative to the workspace root/);
});

test("POSIX absolute path inside the workspace is rebased to relative", () => {
  const result = resolveWorkspacePath("/home/user/project", "/home/user/project/src/App.ts");
  assert.deepEqual(result, { relPath: "src/App.ts" });
});
