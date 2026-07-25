# Phase 3: context-window budgeting — design

Date: 2026-07-25

## Context

Foundation phase from `docs/feature-roadmap.md`: "Context-window budgeting
(infrastructure)", explicitly blocking Phase 4 (richer context providers).
No user-facing feature on its own.

**Problem:** `Provider.capabilities.contextWindow`
(`packages/core/src/providers/provider.ts:28-32`) is already modeled and
set per-adapter (Ollama defaults to 8192, `ollama.ts:30`; OpenAI-compatible
to 128000, `openai-compat.ts:25`) — these are token counts, inferred from
their magnitude (matching Ollama's `num_ctx` default and GPT-4-class 128K
windows respectively), though nothing in the code states the unit
explicitly. Nothing anywhere reads this value to size what gets injected
into a prompt. Every piece of the context block is either unbounded or
bounded by an unrelated flat constant:

| Piece | Current bound |
|---|---|
| `@codebase` retrieved chunks | per-chunk ~4000 chars (`chunking.ts:22`), per-query 6 hits (`contextEngine.ts:22`) — **no aggregate cap** |
| `@file:`-inlined files | 8000 chars/file (`retrieval.ts:24`, a `formatFiles` default param) — **no cap on file count** |
| `.xpreiIDErules` | **unbounded** |
| chat history | **unbounded**, grows every turn (already tracked separately in `CLAUDE.md`'s "Deferred / known gaps") |

No tokenizer dependency exists anywhere in the repo (`packages/core/package.json`
has zero runtime dependencies) — the only sizing precedent is a flat
char-count heuristic (`packages/core/src/agent/tools.ts:8`,
`MAX_OBS = 8000`).

## Decisions

- **Scope: `contextEngine.ts`'s `buildContext()` only.** True whole-prompt
  budgeting would require measuring system prompt + `.xpreiIDErules` +
  chat history too, which means touching `chatView.ts`'s send flow and
  edges into chat-history trimming — a separately-tracked, larger gap.
  This phase reserves a flat, conservative fraction of the window for
  "everything else" instead of measuring it precisely, matching the
  roadmap's exact framing ("consumed by `context/contextEngine.ts`'s
  existing `buildContext()` path").
- **Char-count heuristic, no tokenizer dependency.** `CHARS_PER_TOKEN = 4`
  — a standard rough average for English/code — converts `contextWindow`
  (tokens) into a char budget. Matches the project's dependency-free
  philosophy and the existing `MAX_OBS` precedent; not adding a real BPE
  tokenizer for a token count that's already imprecise input data (the
  roadmap's own framing treats `contextWindow` as a size to budget
  against, not a value requiring perfect accounting).
- **50% of the (converted) window for the context block.** Generous
  enough to be useful even on Ollama's default 8192-token window (~16K
  chars for the context block), while leaving real headroom for system
  prompt, rules, history, and the response — conservative given none of
  that is measured this phase.
- **Files always win over chunks.** `@file:` is an explicit, deliberate
  user request; `@codebase` hits are a relevance guess. When budget is
  tight, all requested files get priority (in mention order) over any
  retrieved chunk, however high its score.
- **Skip-and-continue, not stop-at-first-miss**, when fitting hits.
  Hits are already score-sorted descending (`vectorstore.ts:86`). A
  lower-scored hit that happens to be smaller can still fit after a
  larger higher-scored one didn't — checking every remaining hit makes
  better use of the budget than bailing out at the first one that
  doesn't fit.
- **`budgetContext` is the sole truncation authority going forward.**
  `retrieval.ts`'s `formatFiles`/`formatHits` keep their current
  signatures and tests untouched — `contextEngine.ts`'s retrofit calls
  `formatFiles` with `Number.POSITIVE_INFINITY` as the `maxChars`
  override so its old 8000-char default can't double-truncate a file
  `budgetContext` already sized correctly.

## Architecture

New pure module, `packages/core/src/context/budget.ts`:

```typescript
import { FileContext, MIN_SCORE } from "./retrieval";
import { SearchHit } from "./vectorstore";

export const CHARS_PER_TOKEN = 4;
export const CONTEXT_BLOCK_FRACTION = 0.5;

export interface BudgetedContext {
  files: FileContext[];
  hits: SearchHit[];
}

// Fits @file:-inlined files and @codebase hits into a char budget derived
// from the provider's token-count contextWindow. Files always win over
// hits (explicit user request beats a relevance guess); the first file
// that overflows the remaining budget is truncated and any files after it
// are dropped. Remaining budget (if any) goes to hits in their existing
// score-sorted order, skipping (not stopping at) any hit too large to fit
// so a smaller lower-scored hit still gets a chance.
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
```

### Retrofit: `extensions/vscode/src/context/contextEngine.ts`

`buildContext(mentions: Mentions)` (currently `contextEngine.ts:136-155`)
gains a second parameter and calls the new utility:

```typescript
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

(`SearchHit` needs importing into this file if not already; `formatHits`'s
own `MIN_SCORE` re-filter on the already-filtered `budgeted.hits` is a
harmless no-op.)

### Retrofit: `extensions/vscode/src/ui/chat/chatView.ts`

The single call site (currently line 338) passes the already-resolved
provider's capability — `resolved` is resolved at line 323, before this
call, so no reordering is needed:

```typescript
contextBlock = await this.context.buildContext(parseMentions(trimmed), resolved.provider.capabilities.contextWindow);
```

## Out of scope

- Chat history size, `.xpreiIDErules` size, and system-prompt size are
  not measured — the 50% reserve is a flat placeholder for all of them
  combined, not a precise calculation. Unbounded chat history remains its
  own, separately-tracked deferred gap.
- Any change to `chunking.ts`'s per-chunk 4000-char cap or
  `contextEngine.ts`'s `RETRIEVE_K = 6` hit count — those stay as
  upstream shaping, orthogonal to this phase's budgeting step.
- A real tokenizer / token-exact accounting — the char-per-token heuristic
  is intentionally approximate.
- Any change to the agent loop's tool-observation truncation (`tools.ts`'s
  `MAX_OBS`) or the inline-edit prompt builder (`edit/prompt.ts`) — the
  roadmap scopes this phase to the chat `@codebase`/`@file:` context path
  specifically; Phase 4's future context providers are expected to reuse
  this same `budget.ts` module rather than each inventing their own cap.

## Testing

`budget.ts` is a pure `@xprei/core` module — full unit coverage in
`budget.test.ts`:
- Files fit entirely within budget → all returned unchanged.
- A file overflows the remaining budget → truncated with the
  `\n…(truncated)` suffix, subsequent files dropped.
- Files alone consume the entire budget → hits array comes back empty.
- Hits: a higher-scored hit too large to fit is skipped, a smaller
  lower-scored hit after it still gets included.
- Hits below `MIN_SCORE` are excluded regardless of size/budget.
- Empty `files`/`hits` inputs → empty outputs, no division/edge-case
  errors.
- A `contextWindow` of 0 → both outputs empty (budget is 0).

`contextEngine.ts`'s retrofit is extension-layer code with no unit tests
by existing convention — verified by `npm run typecheck -w xpreiIDE-ai`
and `npm run compile -w xpreiIDE-ai`, plus a manual smoke test: run
`@codebase` and `@file:` in chat against both a small-window (Ollama) and
large-window (OpenAI-compat) provider and confirm the context block size
visibly scales with the configured `contextWindow`.
