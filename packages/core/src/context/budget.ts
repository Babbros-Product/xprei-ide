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
//
// Returns one array per input tier, in the SAME POSITIONAL ORDER as the
// input `tiers` array — callers destructure by position
// (`const [a, b] = budgetContext([tierA, tierB], window)`), so every tier
// a caller cares about must be built and included in `tiers`
// UNCONDITIONALLY, even when empty. Conditionally omitting a tier shifts
// every later tier's index with no type error.

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
