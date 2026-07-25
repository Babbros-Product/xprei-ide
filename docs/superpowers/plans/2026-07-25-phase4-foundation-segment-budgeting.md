# Phase 4 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize `budgetContext` from hardcoded `files`/`hits`
parameters into a provider-agnostic tier/segment model, and retrofit the
two existing providers (`@codebase`, `@file:`) onto it with zero user-
visible behavior change, per
`docs/superpowers/specs/2026-07-25-phase4-foundation-segment-budgeting-design.md`.

**Architecture:** `budget.ts` becomes generic over `WeightedSegment`/
`SegmentTier` instead of `FileContext`/`SearchHit`, with two fill
strategies (`"break"`, `"skip"`) replacing the two hardcoded behaviors.
`contextEngine.ts`'s `buildContext()` builds two tiers from what it
already gathers today and reconstructs its existing output from the
budgeted result.

**Tech Stack:** TypeScript. No new dependencies.

## Global Constraints

- **This phase ships no user-facing feature** — it's a pure internal
  refactor (the foundation Phase 4a-4e build on). Per `CLAUDE.md`'s
  docs convention, no `extensions/vscode/README.md` or root `README.md`
  update is needed — there's no new command, setting, or visible
  behavior to document. (Matches Phase 3's plan, which made the same
  call for the same reason.)
- **Byte-identical output required.** Every existing `@codebase`/`@file:`
  scenario must produce the exact same context block after this refactor
  as before it — this is not an opportunity to also fix the parked
  double-truncation-marker cosmetic edge case from Phase 3's final
  review; that stays parked, untouched.
- **`MIN_SCORE` filtering moves to `contextEngine.ts`.** `budget.ts` must
  no longer import `MIN_SCORE`, `SearchHit`, or `FileContext` — it only
  knows about `WeightedSegment`/`SegmentTier`.
- **Two fill strategies only** — `"break"` and `"skip"`. Do not add a
  third strategy speculatively.
- `packages/core` is source-only; `budget.test.ts` is rewritten (not
  extended) against the new signature — every new test file (none, in
  this plan) still needs registering in `packages/core/package.json`'s
  `test` script, but this plan modifies an existing already-registered
  file.
- `extensions/vscode` has no unit tests by existing convention — its one
  task is verified by `npm run typecheck -w xpreiIDE-ai` +
  `npm run compile -w xpreiIDE-ai`.
- **Commits:** author `xpreiIDE <mbsajay1@gmail.com>` — pass it explicitly,
  e.g. `git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "..."`.
  **Do NOT add a `Co-Authored-By` footer or any other footer.** Conventional
  Commit prefixes (feat/refactor/test/etc).

---

### Task 1: Generalize `budget.ts` to the tier/segment model

**Files:**
- Modify: `packages/core/src/context/budget.ts`
- Modify: `packages/core/src/context/budget.test.ts`

**Interfaces:**
- Produces: `TRUNCATION_MARKER: string`, `interface WeightedSegment { text: string; data: unknown }`,
  `type FillStrategy = "break" | "skip"`, `interface SegmentTier { segments: WeightedSegment[]; strategy: FillStrategy }`,
  `budgetContext(tiers: SegmentTier[], contextWindow: number): WeightedSegment[][]`
  — Task 2 consumes this exact signature.
- Consumes: nothing from other tasks (this task starts the plan).

- [ ] **Step 1: Write the failing tests (full rewrite of `budget.test.ts`)**

Replace the entire contents of `packages/core/src/context/budget.test.ts`
with:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test src/context/budget.test.ts` (from
`packages/core`)
Expected: FAIL — `budgetContext` still has the old 3-argument
`(files, hits, contextWindow)` signature; TypeScript/runtime errors on
every test call.

- [ ] **Step 3: Rewrite `budget.ts`**

Replace the entire contents of `packages/core/src/context/budget.ts` with:

```typescript
// Fits an ordered list of tiers into a char budget derived from the
// provider's token-count contextWindow. No tokenizer dependency —
// CHARS_PER_TOKEN is a hand-written heuristic, matching this repo's
// dependency-free philosophy (see tools.ts's MAX_OBS for the same
// pattern). Tier order is priority: the first tier's segments are
// considered before any later tier gets a share of the remaining budget.
// Each tier picks one of two fill strategies — "break" truncates the
// first segment that overflows and drops everything after it in that
// tier (but later tiers still get whatever budget remains); "skip"
// skips any oversized segment and keeps checking smaller ones after it.
// Segments carry an opaque `data` payload so any provider (files, search
// hits, or a future Phase 4 provider) can round-trip its own shape
// through this generic utility — callers downcast `data` back to their
// own type immediately after budgeting.

export const CHARS_PER_TOKEN = 4;
export const CONTEXT_BLOCK_FRACTION = 0.5;
export const TRUNCATION_MARKER = "\n…(truncated)";

export interface WeightedSegment {
  text: string;
  data: unknown;
}

export type FillStrategy = "break" | "skip";

export interface SegmentTier {
  segments: WeightedSegment[];
  strategy: FillStrategy;
}

export function budgetContext(tiers: SegmentTier[], contextWindow: number): WeightedSegment[][] {
  const rawBudget = contextWindow * CHARS_PER_TOKEN * CONTEXT_BLOCK_FRACTION;
  let remaining = Number.isFinite(rawBudget) ? Math.max(0, Math.floor(rawBudget)) : 0;

  return tiers.map((tier) => {
    const kept: WeightedSegment[] = [];
    for (const seg of tier.segments) {
      if (remaining <= 0) break;
      if (seg.text.length <= remaining) {
        kept.push(seg);
        remaining -= seg.text.length;
      } else if (tier.strategy === "break") {
        kept.push({ text: seg.text.slice(0, remaining) + TRUNCATION_MARKER, data: seg.data });
        remaining = 0;
        break;
      }
      // "skip" strategy: oversized segment is simply not pushed; loop continues.
    }
    return kept;
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test src/context/budget.test.ts` (from
`packages/core`)
Expected: all 13 tests PASS.

- [ ] **Step 5: Run the full core suite**

Run: `npm test -w @xprei/core`
Expected: PASS. The current suite (before this task) is 131 tests total,
of which `budget.test.ts` contributes 9 — every other file is unaffected
by this task, so the new total is `(131 - 9) + 13 = 135`. Verify the
printed `# pass` line reads exactly `135`.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/context/budget.ts packages/core/src/context/budget.test.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "refactor(core): generalize budgetContext to a provider-agnostic tier model"
```

---

### Task 2: Retrofit `contextEngine.ts`'s `buildContext()`

**Files:**
- Modify: `extensions/vscode/src/context/contextEngine.ts`

**Interfaces:**
- Consumes: `budgetContext(tiers: SegmentTier[], contextWindow: number): WeightedSegment[][]`,
  `SegmentTier`, `WeightedSegment` from `@xprei/core` (Task 1).
- Produces: no change to `buildContext(mentions: Mentions, contextWindow: number): Promise<string>`'s
  public signature — this task changes only the method's internals.

- [ ] **Step 1: Update the imports**

In `extensions/vscode/src/context/contextEngine.ts`, the imports currently
read (lines 6-18):

```typescript
import * as vscode from "vscode";
import { ProviderRegistry } from "../providers/registry";
import { chunkFile, Chunk } from "@xprei/core";
import { hasContextRequest, Mentions } from "@xprei/core";
import {
  buildContextMessage,
  budgetContext,
  FileContext,
  formatFiles,
  formatHits,
} from "@xprei/core";
import { VectorStore, SearchHit } from "@xprei/core";
import { isExcludedPath, SCAN_EXCLUDE } from "@xprei/core";
```

Replace with (adds `MIN_SCORE`, `SegmentTier`; everything else unchanged):

```typescript
import * as vscode from "vscode";
import { ProviderRegistry } from "../providers/registry";
import { chunkFile, Chunk } from "@xprei/core";
import { hasContextRequest, Mentions } from "@xprei/core";
import {
  buildContextMessage,
  budgetContext,
  FileContext,
  formatFiles,
  formatHits,
  MIN_SCORE,
  SegmentTier,
} from "@xprei/core";
import { VectorStore, SearchHit } from "@xprei/core";
import { isExcludedPath, SCAN_EXCLUDE } from "@xprei/core";
```

- [ ] **Step 2: Replace `buildContext()`'s body**

Replace the existing method (currently lines 137-162):

```typescript
  // Turn parsed mentions into a context message, or "" if nothing to add.
  // contextWindow is the resolved provider's token-count capability — used
  // to size the context block via budgetContext() instead of blindly
  // concatenating everything the mentions resolved to.
  async buildContext(mentions: Mentions, contextWindow: number): Promise<string> {
    if (!hasContextRequest(mentions)) return "";
    await this.load();

    const files = await this.readFiles(mentions.files);
    let hits: SearchHit[] = [];

    if (mentions.codebase && this.store.size > 0 && mentions.cleaned) {
      const embedder = await this.embedder();
      if (embedder && embedder.key === this.store.modelKey) {
        const [qv] = await embedder.embed([mentions.cleaned]);
        if (qv) hits = this.store.search(qv, RETRIEVE_K);
      }
    }

    const budgeted = budgetContext(files, hits, contextWindow);

    return buildContextMessage({
      files: budgeted.files.length ? formatFiles(budgeted.files, Number.POSITIVE_INFINITY) : undefined,
      retrieved: budgeted.hits.length ? formatHits(budgeted.hits) : undefined,
    });
  }
```

with:

```typescript
  // Turn parsed mentions into a context message, or "" if nothing to add.
  // contextWindow is the resolved provider's token-count capability — used
  // to size the context block via budgetContext() instead of blindly
  // concatenating everything the mentions resolved to. Files are a
  // higher-priority "break" tier (explicit user request, truncate-and-stop
  // on overflow); @codebase hits are a lower-priority "skip" tier
  // (relevance guess, skip oversized hits and keep checking smaller ones).
  async buildContext(mentions: Mentions, contextWindow: number): Promise<string> {
    if (!hasContextRequest(mentions)) return "";
    await this.load();

    const files = await this.readFiles(mentions.files);
    let hits: SearchHit[] = [];

    if (mentions.codebase && this.store.size > 0 && mentions.cleaned) {
      const embedder = await this.embedder();
      if (embedder && embedder.key === this.store.modelKey) {
        const [qv] = await embedder.embed([mentions.cleaned]);
        if (qv) hits = this.store.search(qv, RETRIEVE_K);
      }
    }

    const fileTier: SegmentTier = {
      segments: files.map((f) => ({ text: f.content, data: f })),
      strategy: "break",
    };
    const eligibleHits = hits.filter((h) => h.score >= MIN_SCORE);
    const hitTier: SegmentTier = {
      segments: eligibleHits.map((h) => ({ text: h.chunk.text, data: h })),
      strategy: "skip",
    };

    const [keptFileSegs, keptHitSegs] = budgetContext([fileTier, hitTier], contextWindow);

    const budgetedFiles: FileContext[] = keptFileSegs.map((seg) => ({
      ...(seg.data as FileContext),
      content: seg.text,
    }));
    const budgetedHits: SearchHit[] = keptHitSegs.map((seg) => seg.data as SearchHit);

    return buildContextMessage({
      files: budgetedFiles.length ? formatFiles(budgetedFiles, Number.POSITIVE_INFINITY) : undefined,
      retrieved: budgetedHits.length ? formatHits(budgetedHits) : undefined,
    });
  }
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck -w xpreiIDE-ai`
Expected: PASS.

- [ ] **Step 4: Compile**

Run: `npm run compile -w xpreiIDE-ai`
Expected: PASS, `dist/extension.js` rebuilt.

- [ ] **Step 5: Commit**

```bash
git add extensions/vscode/src/context/contextEngine.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "refactor(vscode): retrofit buildContext onto the tier-based budgetContext"
```

---

### Task 3: Final verification

**Files:** none (verification only).

**Interfaces:** none — consumes everything built in Tasks 1-2.

- [ ] **Step 1: Run the full core test suite**

Run: `npm test -w @xprei/core`
Expected: PASS — 135 tests total (122 unrelated + 13 rewritten
`budget.test.ts` tests).

- [ ] **Step 2: Typecheck core**

Run: `npm run typecheck -w @xprei/core`
Expected: PASS.

- [ ] **Step 3: Typecheck the extension**

Run: `npm run typecheck -w xpreiIDE-ai`
Expected: PASS.

- [ ] **Step 4: Compile the extension**

Run: `npm run compile -w xpreiIDE-ai`
Expected: PASS.

- [ ] **Step 5: Manual smoke test — re-run Phase 3's own scenarios and confirm identical results**

Launch the Extension Development Host (F5 in VS Code against
`extensions/vscode`), in a real workspace with `@codebase` indexed:

1. Configure a small-`contextWindow` Ollama provider as the active chat
   model. Send a chat message with `@codebase <a broad query>` plus
   `@file:` on a couple of large files. Confirm the request completes
   normally, exactly as it did after Phase 3 shipped (no crash, no new
   truncation artifacts, no behavior change visible from the outside).
2. Switch to a large-`contextWindow` OpenAI-compat provider and repeat the
   same message. Confirm more content fits, exactly as it did before this
   refactor.
3. Send a plain message with no `@codebase`/`@file:` mention and confirm
   chat still works exactly as before (empty context block, no regression).

If all three checks behave identically to Phase 3's own smoke test, no
further action needed — this task has no commit of its own.
