# Phase 4 Foundation: segment-based context budgeting — design

Date: 2026-07-25

## Context

First sub-project of Phase 4 ("Richer context providers") from
`docs/feature-roadmap.md`. Phase 4 as a whole is too large for one spec —
it bundles six genuinely distinct providers (`@terminal`, `@problems`,
`@diff`, `@open`, `@url`, repo-map) with very different data sources and
risk profiles. Decomposed into: this foundation, then one sub-project per
provider, in this order:

1. **Foundation (this spec)** — generalize `budgetContext` to a
   provider-agnostic segment model; retrofit the two existing providers
   (`@codebase`, `@file:`) onto it with zero behavior change.
2. **4a** — `@open` + `@problems` (bundled: both are simple synchronous VS
   Code API reads).
3. **4b** — `@diff` (git plumbing, similar exec pattern to Phase 1's
   `view_diff` tool).
4. **4c** — `@terminal` (needs its own feasibility check — VS Code has no
   clean official API for reading terminal output history).
5. **4d** — `@url` (network fetch — distinct security profile, isolated
   on purpose).
6. **4e** — repo-map (the outlier: static analysis over the whole repo,
   most novel algorithm, last).

**Problem:** `packages/core/src/context/budget.ts` (Phase 3) hardcodes two
content types — `FileContext[]` and `SearchHit[]` — with two different,
hardcoded fill behaviors (files: fill in order, truncate the first
overflow, drop everything after; hits: skip-and-continue through
score-sorted order). Every future Phase 4 provider needs the same kind of
budgeting, but none of them are files or search hits — a `@diff` block, a
`@problems` list, terminal output, and a repo-map are all just "some text
that needs to compete for the same budget," with no reason to add a new
hardcoded parameter to `budgetContext` for each one.

## Decisions

- **Tiers, not fixed parameters.** `budgetContext` takes an ordered list of
  tiers — this scales to Phase 4a-4e's provider count without a
  combinatorial explosion of function parameters, and tier *order* is what
  encodes priority (today: files before hits; tomorrow: whatever priority
  each new provider needs relative to the others, decided when it's built).
- **Two fill strategies, not one per tier type.** `"break"` (truncate the
  first segment that overflows the remaining budget, drop everything
  after — today's file behavior) and `"skip"` (skip any segment too large
  to fit, keep checking smaller ones after it — today's hit behavior).
  Every future provider picks whichever strategy fits its nature; no third
  strategy is anticipated, and one isn't built speculatively — YAGNI.
- **Generic payload (`data: unknown`), not per-call generics.** A
  strongly-typed `budgetContext<T1, T2, ...>` doesn't scale past a fixed
  number of tiers without either duplicating the function per arity or an
  unreadable type signature. Each tier's segments carry `data: unknown`
  alongside the `text` that's actually measured/truncated; callers
  downcast once per tier immediately after budgeting. This is a small,
  isolated type-safety trade-off (one cast per tier, at the one call site
  that constructs each tier) for real N-provider scalability — reasonable
  for an internal utility with a handful of callers, all in this same
  well-tested module family.
- **`MIN_SCORE` filtering moves out of `budget.ts` entirely.** It's
  relevance-scoring policy specific to `@codebase` hits, not something a
  generic budgeting utility should know about. `contextEngine.ts` now
  pre-filters hits by `MIN_SCORE` itself before building the hit tier —
  this also closes a Minor finding from Phase 3's final review ("MIN_SCORE
  filtering now happens in both `budget.ts` and `formatHits`").
- **Zero behavior change for existing users.** This phase ships no new
  `@`-mention, no new provider — it's purely an internal refactor that
  must produce byte-identical `@codebase`/`@file:` context blocks to
  today. Every existing `budget.test.ts` case gets rewritten against the
  new signature but must assert the *same* outcomes.

## Architecture

`packages/core/src/context/budget.ts`'s new public API:

```typescript
export const CHARS_PER_TOKEN = 4;              // unchanged
export const CONTEXT_BLOCK_FRACTION = 0.5;     // unchanged
export const TRUNCATION_MARKER = "\n…(truncated)"; // extracted, was inline

export interface WeightedSegment {
  text: string;   // what budgetContext measures and, if needed, truncates
  data: unknown;  // caller's original object — reconstruct output with it
}

export type FillStrategy = "break" | "skip";

export interface SegmentTier {
  segments: WeightedSegment[];
  strategy: FillStrategy;
}

// Fits an ordered list of tiers into a char budget derived from the
// provider's token-count contextWindow. Tier order is priority — the
// first tier's segments are considered before any later tier gets a
// share of the remaining budget. Returns one array per input tier, same
// order, containing only the segments that survived (possibly with the
// last "break"-strategy segment's text truncated + TRUNCATION_MARKER
// appended).
export function budgetContext(
  tiers: SegmentTier[],
  contextWindow: number,
): WeightedSegment[][]
```

Internally: compute `totalBudget` exactly as today (same `CHARS_PER_TOKEN`
/ `CONTEXT_BLOCK_FRACTION` math, same `Number.isFinite` guard from Phase
3's final-review fix). Walk tiers in order, each tier consuming from one
shared `remaining` counter:
- `"break"` tier: walk its segments in order; a segment that fits is kept
  whole; the first segment that doesn't fit gets `text.slice(0, remaining) + TRUNCATION_MARKER`
  and the walk stops for *this tier* (later segments in this tier are
  dropped) — but subsequent tiers are still attempted with whatever
  `remaining` is left (0, if this tier's overflow consumed everything).
- `"skip"` tier: walk its segments in order; skip (don't drop the whole
  tier, don't stop) any segment that doesn't fit in current `remaining`,
  keep checking the rest.

### Retrofit: `extensions/vscode/src/context/contextEngine.ts`

`buildContext()`'s body changes to build two tiers instead of calling the
old two-parameter form:

```typescript
const fileTier: SegmentTier = {
  segments: files.map((f) => ({ text: f.content, data: f })),
  strategy: "break",
};
const eligibleHits = hits.filter((h) => h.score >= MIN_SCORE); // moved here from budget.ts
const hitTier: SegmentTier = {
  segments: eligibleHits.map((h) => ({ text: h.chunk.text, data: h })),
  strategy: "skip",
};

const [keptFileSegs, keptHitSegs] = budgetContext([fileTier, hitTier], contextWindow);

const budgetedFiles: FileContext[] = keptFileSegs.map((s) => ({
  ...(s.data as FileContext),
  content: s.text, // may be truncated by the "break" strategy
}));
const budgetedHits = keptHitSegs.map((s) => s.data as SearchHit); // "skip" never truncates, data is untouched

return buildContextMessage({
  files: budgetedFiles.length ? formatFiles(budgetedFiles, Number.POSITIVE_INFINITY) : undefined,
  retrieved: budgetedHits.length ? formatHits(budgetedHits) : undefined,
});
```

`MIN_SCORE` is imported from `retrieval.ts` into `contextEngine.ts` (it's
already exported there); `budget.ts` no longer imports `MIN_SCORE` or
`SearchHit`/`FileContext` at all — it only knows about `WeightedSegment`/
`SegmentTier`.

## Out of scope

- No new `@`-mention syntax or provider — `mentions.ts` is untouched.
- No change to `formatFiles`/`formatHits`/`buildContextMessage` — they
  keep consuming plain `FileContext[]`/`SearchHit[]` exactly as today;
  only what feeds them changes.
- No third fill strategy — `"break"` and `"skip"` are all that exist
  today's two providers need; a future provider that genuinely needs
  different semantics gets one added when it's actually built.
- The double-truncation-marker cosmetic edge case parked in Phase 3's
  final review (a narrow interaction between `readFiles()`'s own
  `MAX_FILE_CHARS` cap and `budgetContext`'s aggregate trim) is not
  addressed here — it's orthogonal to this generalization and stays
  parked.

## Testing

`budget.ts` is a pure `@xprei/core` module — `budget.test.ts` is rewritten
(not just extended) against the new tier-based signature, covering:
- Single "break" tier: exact-fit, overflow-truncates-and-stops,
  zero-window, non-finite-window (same cases Phase 3 already covered, now
  expressed as a one-tier call).
- Single "skip" tier: skip-and-continue past an oversized higher-priority
  segment to a smaller one after it.
- Two tiers together, replicating every one of Phase 3's original
  files+hits test cases, asserting byte-identical outcomes to prove the
  generalization didn't change behavior.
- Three-plus tiers (a scenario no current provider needs yet, but the API
  must handle it correctly) — e.g. tier 1 consumes everything, tiers 2
  and 3 both come back empty; tier 1 partially consumes, tier 2 fills the
  rest, tier 3 comes back empty.

`contextEngine.ts`'s retrofit is extension-layer code — verified by
`npm run typecheck -w xpreiIDE-ai` + `npm run compile -w xpreiIDE-ai`, plus
a manual smoke test re-running Phase 3's own smoke-test scenarios
(small-window vs. large-window `@codebase`/`@file:` sizing) and confirming
identical results to before this refactor.
