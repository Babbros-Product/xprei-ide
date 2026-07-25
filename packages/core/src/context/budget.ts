// Fits @file:-inlined files and @codebase hits into a char budget derived
// from the provider's token-count contextWindow. No tokenizer dependency —
// CHARS_PER_TOKEN is a hand-written heuristic, matching this repo's
// dependency-free philosophy (see tools.ts's MAX_OBS for the same pattern).
// Files always win over hits: an explicit @file: request beats a relevance
// guess. The first file that overflows the remaining budget is truncated;
// any files after it are dropped. Remaining budget (if any) goes to hits
// in their existing score-sorted order, skipping (not stopping at) any hit
// too large to fit, so a smaller lower-scored hit still gets a chance.

import { FileContext, MIN_SCORE } from "./retrieval";
import { SearchHit } from "./vectorstore";

export const CHARS_PER_TOKEN = 4;
export const CONTEXT_BLOCK_FRACTION = 0.5;

export interface BudgetedContext {
  files: FileContext[];
  hits: SearchHit[];
}

export function budgetContext(
  files: FileContext[],
  hits: SearchHit[],
  contextWindow: number,
): BudgetedContext {
  const totalBudget = Math.floor(contextWindow * CHARS_PER_TOKEN * CONTEXT_BLOCK_FRACTION);
  let remaining = totalBudget;

  const keptFiles: FileContext[] = [];
  for (const f of files) {
    if (remaining <= 0) break;
    if (f.content.length <= remaining) {
      keptFiles.push(f);
      remaining -= f.content.length;
    } else {
      keptFiles.push({ path: f.path, content: f.content.slice(0, remaining) + "\n…(truncated)" });
      remaining = 0;
      break;
    }
  }

  const eligible = hits.filter((h) => h.score >= MIN_SCORE);
  const keptHits: SearchHit[] = [];
  for (const h of eligible) {
    const size = h.chunk.text.length;
    if (size <= remaining) {
      keptHits.push(h);
      remaining -= size;
    }
  }

  return { files: keptFiles, hits: keptHits };
}
