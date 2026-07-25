import assert from "node:assert/strict";
import { test } from "node:test";
import { matchGlob, collectGlobMatches, DirEntry } from "./glob";

test("matchGlob: * matches within one path segment only", () => {
  assert.equal(matchGlob("src/*.ts", "src/a.ts"), true);
  assert.equal(matchGlob("src/*.ts", "src/sub/a.ts"), false);
});

test("matchGlob: ** matches across any depth", () => {
  assert.equal(matchGlob("src/**/*.ts", "src/a.ts"), true);
  assert.equal(matchGlob("src/**/*.ts", "src/sub/deep/a.ts"), true);
  assert.equal(matchGlob("**/*.ts", "a.ts"), true);
});

test("matchGlob: ? matches exactly one character", () => {
  assert.equal(matchGlob("a?.ts", "ab.ts"), true);
  assert.equal(matchGlob("a?.ts", "abc.ts"), false);
});

test("matchGlob: literal dots and other regex-special chars are literal", () => {
  assert.equal(matchGlob("a.ts", "aXts"), false);
  assert.equal(matchGlob("a.ts", "a.ts"), true);
});

test("matchGlob: no match returns false", () => {
  assert.equal(matchGlob("*.ts", "a.js"), false);
});

function fakeFs(tree: Record<string, string[]>): {
  readDir: (dir: string) => Promise<DirEntry[]>;
} {
  // `tree` maps an absolute dir path to its child names; a name ending in
  // '/' is a directory, otherwise a file.
  return {
    async readDir(dir: string): Promise<DirEntry[]> {
      const children = tree[dir] ?? [];
      return children.map((name) =>
        name.endsWith("/")
          ? { name: name.slice(0, -1), isDirectory: true }
          : { name, isDirectory: false },
      );
    },
  };
}

test("collectGlobMatches walks recursively and matches by pattern", async () => {
  const { readDir } = fakeFs({
    "/root": ["src/", "top.ts"],
    "/root/src": ["a.ts", "b.js"],
  });
  const out = await collectGlobMatches(
    "**/*.ts",
    "/root",
    readDir,
    (abs) => abs.replace("/root/", "").replace("/root", ""),
    (a, b) => `${a}/${b}`,
    () => false,
    200,
  );
  assert.deepEqual(out.sort(), ["src/a.ts", "top.ts"]);
});

test("collectGlobMatches skips excluded paths", async () => {
  const { readDir } = fakeFs({
    "/root": ["node_modules/", "src/"],
    "/root/node_modules": ["pkg.ts"],
    "/root/src": ["a.ts"],
  });
  const out = await collectGlobMatches(
    "**/*.ts",
    "/root",
    readDir,
    (abs) => abs.replace("/root/", "").replace("/root", ""),
    (a, b) => `${a}/${b}`,
    (rel) => rel.split("/").includes("node_modules"),
    200,
  );
  assert.deepEqual(out, ["src/a.ts"]);
});

test("collectGlobMatches stops at maxResults", async () => {
  const { readDir } = fakeFs({
    "/root": ["a.ts", "b.ts", "c.ts"],
  });
  const out = await collectGlobMatches(
    "*.ts",
    "/root",
    readDir,
    (abs) => abs.replace("/root/", "").replace("/root", ""),
    (a, b) => `${a}/${b}`,
    () => false,
    2,
  );
  assert.equal(out.length, 2);
});
