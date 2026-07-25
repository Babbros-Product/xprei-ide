import assert from "node:assert/strict";
import { test } from "node:test";
import { budgetContext, CHARS_PER_TOKEN, CONTEXT_BLOCK_FRACTION, TRUNCATION_MARKER } from "./budget";

function seg(text: string, data: unknown = null) {
  return { text, data };
}

test("a single 'break' tier: segments that fit entirely are returned unchanged", () => {
  const tiers = [{ segments: [seg("x".repeat(100)), seg("y".repeat(100))], strategy: "break" as const }];
  const [result] = budgetContext(tiers, 10000); // huge window, no truncation expected
  assert.deepEqual(result, tiers[0].segments);
});

test("a single 'break' tier: the first segment that overflows is truncated, later segments dropped", () => {
  // contextWindow=10 tokens * 4 chars/token * 0.5 fraction = 20 char budget
  const tiers = [
    { segments: [seg("x".repeat(25)), seg("y".repeat(5)), seg("z".repeat(5))], strategy: "break" as const },
  ];
  const [result] = budgetContext(tiers, 10);
  assert.equal(result.length, 1);
  assert.equal(result[0].text, "x".repeat(20) + TRUNCATION_MARKER);
});

test("a single 'break' tier: an exact-fit segment consumes the whole budget without a marker", () => {
  const tiers = [{ segments: [seg("x".repeat(20))], strategy: "break" as const }];
  const [result] = budgetContext(tiers, 10); // budget = 20
  assert.deepEqual(result, [seg("x".repeat(20))]);
});

test("a single 'skip' tier: a segment too large to fit is skipped, a smaller one after it still fits", () => {
  // budget = 10 tokens * 4 * 0.5 = 20 chars
  const tiers = [
    { segments: [seg("x".repeat(25), "big"), seg("y".repeat(10), "small")], strategy: "skip" as const },
  ];
  const [result] = budgetContext(tiers, 10);
  assert.equal(result.length, 1);
  assert.equal(result[0].data, "small");
});

test("two tiers: the first tier (higher priority) is filled before the second gets any budget", () => {
  // budget = 20 chars total
  const tier1 = { segments: [seg("x".repeat(20))], strategy: "break" as const }; // consumes all 20
  const tier2 = { segments: [seg("y".repeat(5))], strategy: "skip" as const };
  const [kept1, kept2] = budgetContext([tier1, tier2], 10);
  assert.deepEqual(kept1, [seg("x".repeat(20))]);
  assert.deepEqual(kept2, []);
});

test("two tiers: budget remaining after tier 1 partially consumes it correctly carries into tier 2", () => {
  // budget = 20 chars. tier1 has one 15-char segment (fits whole, no
  // truncation, remaining=5). tier2 has a 10-char segment (doesn't fit in
  // remaining=5, skipped) and a 5-char segment (fits exactly) — proving
  // the shared remaining counter carries correctly across tier boundaries
  // even when tier1 didn't overflow at all.
  const tier1 = { segments: [seg("x".repeat(15))], strategy: "break" as const };
  const tier2 = {
    segments: [seg("y".repeat(10), "too-big"), seg("z".repeat(5), "fits")],
    strategy: "skip" as const,
  };
  const [kept1, kept2] = budgetContext([tier1, tier2], 10);
  assert.deepEqual(kept1, [seg("x".repeat(15))]);
  assert.equal(kept2.length, 1);
  assert.equal(kept2[0].data, "fits");
});

test("three tiers: budget exhausted by tier 1, tiers 2 and 3 both come back empty", () => {
  const tier1 = { segments: [seg("x".repeat(20))], strategy: "break" as const }; // consumes all 20
  const tier2 = { segments: [seg("a", "t2")], strategy: "skip" as const };
  const tier3 = { segments: [seg("b", "t3")], strategy: "break" as const };
  const [kept1, kept2, kept3] = budgetContext([tier1, tier2, tier3], 10);
  assert.deepEqual(kept1, [seg("x".repeat(20))]);
  assert.deepEqual(kept2, []);
  assert.deepEqual(kept3, []);
});

test("empty tiers array produces no output arrays", () => {
  const result = budgetContext([], 8192);
  assert.deepEqual(result, []);
});

test("a tier with no segments produces an empty array in its slot", () => {
  const tiers = [
    { segments: [], strategy: "break" as const },
    { segments: [seg("x")], strategy: "skip" as const },
  ];
  const [kept1, kept2] = budgetContext(tiers, 8192);
  assert.deepEqual(kept1, []);
  assert.deepEqual(kept2, [seg("x")]);
});

test("a contextWindow of 0 yields empty output for every tier", () => {
  const tiers = [
    { segments: [seg("x")], strategy: "break" as const },
    { segments: [seg("y")], strategy: "skip" as const },
  ];
  const [kept1, kept2] = budgetContext(tiers, 0);
  assert.deepEqual(kept1, []);
  assert.deepEqual(kept2, []);
});

test("a non-finite contextWindow yields empty output for every tier", () => {
  const tiers = [{ segments: [seg("x")], strategy: "break" as const }];
  const [kept1] = budgetContext(tiers, NaN);
  assert.deepEqual(kept1, []);
});

test("CHARS_PER_TOKEN and CONTEXT_BLOCK_FRACTION have the spec's exact values", () => {
  assert.equal(CHARS_PER_TOKEN, 4);
  assert.equal(CONTEXT_BLOCK_FRACTION, 0.5);
});

test("TRUNCATION_MARKER matches the exact marker text used elsewhere in the codebase", () => {
  assert.equal(TRUNCATION_MARKER, "\n…(truncated)");
});
