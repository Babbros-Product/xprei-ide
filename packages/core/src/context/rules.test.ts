import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRuleFile, ruleApplies } from "./rules";

test("parseRuleFile reads a single glob from frontmatter", () => {
  const r = parseRuleFile("---\nglobs: *.tsx\n---\nUse function components.");
  assert.deepEqual(r.globs, ["*.tsx"]);
  assert.equal(r.body, "Use function components.");
});

test("parseRuleFile splits comma-separated globs and trims them", () => {
  const r = parseRuleFile("---\nglobs: *.ts, src/components/** , *.tsx\n---\nbody");
  assert.deepEqual(r.globs, ["*.ts", "src/components/**", "*.tsx"]);
});

test("parseRuleFile without frontmatter returns the whole content as body", () => {
  const r = parseRuleFile("Just a global rule.\nSecond line.");
  assert.equal(r.globs, undefined);
  assert.equal(r.body, "Just a global rule.\nSecond line.");
});

test("parseRuleFile treats unterminated frontmatter as plain body", () => {
  const content = "---\nglobs: *.ts\nno closing fence";
  assert.equal(parseRuleFile(content).body, content);
});

test("parseRuleFile ignores unknown frontmatter keys", () => {
  const r = parseRuleFile("---\nname: whatever\nglobs: *.py\n---\nbody");
  assert.deepEqual(r.globs, ["*.py"]);
});

test("ruleApplies: no globs means always applies", () => {
  assert.equal(ruleApplies(undefined, "src/a.ts"), true);
  assert.equal(ruleApplies(undefined, undefined), true);
  assert.equal(ruleApplies([], undefined), true);
});

test("ruleApplies: globs present but no active path means not applicable", () => {
  assert.equal(ruleApplies(["*.ts"], undefined), false);
});

test("ruleApplies matches bare patterns at any depth and anchored ones from the root", () => {
  assert.equal(ruleApplies(["*.tsx"], "src/deep/App.tsx"), true);
  assert.equal(ruleApplies(["src/components/**"], "src/components/Button.tsx"), true);
  assert.equal(ruleApplies(["src/components/**"], "lib/components/Button.tsx"), false);
  assert.equal(ruleApplies(["*.py"], "src/a.ts"), false);
});
