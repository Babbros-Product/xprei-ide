# Phase 8: True FIM Autocomplete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real Ollama fill-in-the-middle completions (`/api/generate`
with `suffix`) for FIM-trained code models, falling back to the existing
`chatStream`-based hack for everything else.

**Architecture:** A new pure allowlist function
(`packages/core/src/providers/fimModels.ts`) detects FIM-capable model
names. `Provider` gains an optional `fillInMiddle()` method, implemented
only by `OllamaProvider`. `inlineCompletionProvider.ts` branches on
`provider.fillInMiddle && isFimCapableModel(model)` before falling back
to its existing chat-based path.

**Tech Stack:** TypeScript, Node's built-in `node:test` + `assert/strict`.

## Global Constraints

- **Ollama-only** — `fillInMiddle` is optional on `Provider`, like
  `embed?`; only `OllamaProvider` implements it.
- **Non-streaming** (`stream: false`) — the existing chat-based hack
  already just concatenates every chunk before use.
- **Graceful fallback, not a hard switch** — anything without
  `fillInMiddle`, or with a non-FIM-trained model, uses the unchanged
  existing path.
- **Per-model, not per-provider, capability detection** — a standalone
  allowlist function, not a new `ProviderCapabilities` field.
- **Commits:** author `xpreiIDE <mbsajay1@gmail.com>` — pass it
  explicitly, e.g. `git -c user.name="xpreiIDE" -c
  user.email="mbsajay1@gmail.com" commit -m "..."`. **Do NOT add a
  `Co-Authored-By` footer or any other footer.** Conventional Commit
  prefixes (feat/docs/etc).
- **No new unit tests for `inlineCompletionProvider.ts`** — none exist
  today for this file (VS Code-layer), consistent with this project's
  established convention. Typecheck + compile + manual smoke test only.

---

### Task 1: `fimModels.ts` — pure, fully unit tested

**Files:**
- Create: `packages/core/src/providers/fimModels.ts`
- Create: `packages/core/src/providers/fimModels.test.ts`
- Modify: `packages/core/package.json` (register the new test file)
- Modify: `packages/core/src/index.ts` (barrel-export the new module)

**Interfaces:**
- Produces: `isFimCapableModel(model: string): boolean` — Task 3
  consumes this.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/providers/fimModels.test.ts`:

```typescript
import assert from "node:assert/strict";
import { test } from "node:test";
import { isFimCapableModel } from "./fimModels";

test("isFimCapableModel recognizes every listed FIM-trained family", () => {
  assert.equal(isFimCapableModel("codellama:7b-instruct"), true);
  assert.equal(isFimCapableModel("deepseek-coder-v2"), true);
  assert.equal(isFimCapableModel("starcoder2:15b"), true);
  assert.equal(isFimCapableModel("qwen2.5-coder:14b"), true);
  assert.equal(isFimCapableModel("codegemma:7b"), true);
  assert.equal(isFimCapableModel("codestral:22b"), true);
  assert.equal(isFimCapableModel("granite-code:8b"), true);
});

test("isFimCapableModel rejects non-FIM-trained models", () => {
  assert.equal(isFimCapableModel("llama3.1"), false);
  assert.equal(isFimCapableModel("mistral:7b"), false);
  assert.equal(isFimCapableModel("some-made-up-model-xyz"), false);
});

test("isFimCapableModel is case-insensitive", () => {
  assert.equal(isFimCapableModel("CodeLlama:13b"), true);
  assert.equal(isFimCapableModel("DEEPSEEK-CODER:6.7b"), true);
});

test("isFimCapableModel matches with or without a ':tag' suffix", () => {
  assert.equal(isFimCapableModel("codellama"), true);
  assert.equal(isFimCapableModel("codellama:latest"), true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `packages/core`): `node --import tsx --test src/providers/fimModels.test.ts`
Expected: FAIL — `./fimModels` doesn't exist yet.

- [ ] **Step 3: Implement `fimModels.ts`**

Create `packages/core/src/providers/fimModels.ts`:

```typescript
// Static, hand-maintained allowlist of Ollama model-name patterns known
// to be FIM (fill-in-the-middle)-trained. Not exhaustive — extend as
// new code-model families ship. Matched case-insensitively against the
// bare model name (the part before any ":tag"). See
// docs/superpowers/specs/2026-07-26-phase8-true-fim-design.md.

const FIM_CAPABLE_PATTERNS = [
  /^codellama/,
  /^deepseek-coder/,
  /^starcoder/,
  /^qwen2\.5-coder/,
  /^codegemma/,
  /^codestral/,
  /^granite-code/,
];

export function isFimCapableModel(model: string): boolean {
  const name = model.split(":")[0].toLowerCase();
  return FIM_CAPABLE_PATTERNS.some((re) => re.test(name));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `packages/core`): `node --import tsx --test src/providers/fimModels.test.ts`
Expected: PASS — all 4 tests green (covering 13 individual assertions).

- [ ] **Step 5: Register the test file and barrel-export the module**

In `packages/core/package.json`, add
`src/providers/fimModels.test.ts` to the `test` script's file list,
immediately after `src/mcp/mcpManager.test.ts`.

In `packages/core/src/index.ts`, add immediately after
`export * from "./mcp/mcpManager";`:

```typescript
export * from "./providers/fimModels";
```

- [ ] **Step 6: Run the full core suite to confirm nothing broke**

Run (from `packages/core`): `npm test`
Expected: PASS — 260 tests total (256 before this plan + 4 new
`fimModels.test.ts`).

- [ ] **Step 7: Typecheck core**

Run: `npm run typecheck -w @xprei/core`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/providers/fimModels.ts packages/core/src/providers/fimModels.test.ts packages/core/package.json packages/core/src/index.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(core): add isFimCapableModel, a static FIM-capability allowlist"
```

---

### Task 2: `Provider.fillInMiddle` + `OllamaProvider` implementation

**Files:**
- Modify: `packages/core/src/providers/provider.ts`
- Modify: `packages/core/src/providers/ollama.ts`
- Modify: `packages/core/src/providers/ollama.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `Provider.fillInMiddle?(prefix: string, suffix: string,
  model: string, signal?: AbortSignal): Promise<string>` —
  `OllamaProvider` implements it; Task 3 consumes it via
  `resolved.provider.fillInMiddle`.

- [ ] **Step 1: Write the failing tests**

Read `packages/core/src/providers/ollama.test.ts` and
`packages/core/src/providers/_testutil.ts` first to confirm the exact
`jsonResponse`/`mockFetch` helper signatures, then append at the end of
`ollama.test.ts`:

```typescript
test("ollama fillInMiddle sends stream:false with prompt/suffix and returns the response field", async () => {
  let capturedBody: unknown;
  const restore = mockFetch(async (_url, init) => {
    capturedBody = JSON.parse(String(init?.body));
    return jsonResponse({ response: "console.log('mid');" });
  });
  try {
    const out = await new OllamaProvider(cfg).fillInMiddle("const x = ", ";", "codellama:7b");
    assert.equal(out, "console.log('mid');");
    assert.deepEqual(capturedBody, {
      model: "codellama:7b",
      prompt: "const x = ",
      suffix: ";",
      stream: false,
    });
  } finally {
    restore();
  }
});

test("ollama fillInMiddle throws ProviderError with the response body on a non-OK response", async () => {
  const restore = mockFetch(async () => jsonResponse({ error: "model not found" }, { status: 404 }));
  try {
    await assert.rejects(
      () => new OllamaProvider(cfg).fillInMiddle("prefix", "suffix", "codellama:7b"),
      (e) => e instanceof ProviderError && /404/.test(e.message),
    );
  } finally {
    restore();
  }
});

test("ollama fillInMiddle rethrows AbortError unwrapped", async () => {
  const restore = mockFetch(async () => {
    throw abortError();
  });
  try {
    await assert.rejects(
      () => new OllamaProvider(cfg).fillInMiddle("prefix", "suffix", "codellama:7b"),
      (e) => isAbortError(e),
    );
  } finally {
    restore();
  }
});
```

Check `mockFetch`'s callback signature in `_testutil.ts` before writing
this — if it doesn't receive `(url, init)` as two arguments (some
lightweight mock helpers only pass one combined object), adjust the
`capturedBody` extraction to match whatever shape it actually provides;
the goal is just to inspect the JSON body of the request `fillInMiddle`
sends.

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `packages/core`): `node --import tsx --test src/providers/ollama.test.ts`
Expected: FAIL — `OllamaProvider` has no `fillInMiddle` method yet.

- [ ] **Step 3: Widen `Provider` in `provider.ts`**

Read `packages/core/src/providers/provider.ts` first to find the exact
current `Provider` interface, then add this member immediately after
the existing `embed?` member:

```typescript
  // Real fill-in-the-middle completion: given the text before and after
  // the cursor, returns the text to insert. Optional — only providers
  // with a native FIM endpoint implement this; callers check for its
  // presence (and, separately, isFimCapableModel(model)) before using
  // it.
  fillInMiddle?(prefix: string, suffix: string, model: string, signal?: AbortSignal): Promise<string>;
```

- [ ] **Step 4: Implement `fillInMiddle` in `ollama.ts`**

Read `packages/core/src/providers/ollama.ts` first to confirm the exact
current shape of `chatStream`'s error handling (the `unreachable()`
helper, the `ProviderError` construction pattern), then add this method
to the `OllamaProvider` class, immediately after `chatStream`:

```typescript
  async fillInMiddle(prefix: string, suffix: string, model: string, signal?: AbortSignal): Promise<string> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({ model, prompt: prefix, suffix, stream: false }),
      });
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw new ProviderError(this.unreachable(), err);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ProviderError(
        `Ollama /api/generate failed: ${res.status} ${res.statusText} ${body}`.trim(),
      );
    }
    const data = (await res.json()) as { response?: string };
    return data.response ?? "";
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run (from `packages/core`): `node --import tsx --test src/providers/ollama.test.ts`
Expected: PASS — all tests green (existing tests + 3 new).

- [ ] **Step 6: Run the full core suite to confirm nothing broke**

Run (from `packages/core`): `npm test`
Expected: PASS — 263 tests total (260 after Task 1 + 3 new
`ollama.test.ts` tests).

- [ ] **Step 7: Typecheck core**

Run: `npm run typecheck -w @xprei/core`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/providers/provider.ts packages/core/src/providers/ollama.ts packages/core/src/providers/ollama.test.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(core): add Provider.fillInMiddle, implemented by OllamaProvider via /api/generate"
```

---

### Task 3: Wire real FIM into `inlineCompletionProvider.ts`

**Files:**
- Modify: `extensions/vscode/src/completion/inlineCompletionProvider.ts`

**Interfaces:**
- Consumes: `isFimCapableModel` from `@xprei/core` (Task 1);
  `Provider.fillInMiddle` (Task 2, via `resolved.provider.fillInMiddle`).

- [ ] **Step 1: Read the current file in full**

Read `extensions/vscode/src/completion/inlineCompletionProvider.ts`
before editing — confirm the exact current shape of
`provideInlineCompletionItems()`'s body around where `prefix`/`suffix`
are computed and where the `chatStream` loop runs, since this task
inserts a branch there rather than replacing the whole method.

- [ ] **Step 2: Add the import**

Add to the top-of-file imports, alongside the existing
`stripCodeFences` import:

```typescript
import { isFimCapableModel, stripCodeFences } from "@xprei/core";
```

(Combine with whatever the existing `@xprei/core` import line already
contains — read the file first to confirm its exact current form rather
than assuming a single-name import.)

- [ ] **Step 3: Branch on FIM capability before the completion-acquisition block**

Locate the block that currently looks like:

```typescript
    const userContent = suffix.trim()
      ? `Code before <CURSOR>:\n${prefix}<CURSOR>\nCode after <CURSOR>:\n${suffix}`
      : `Code before <CURSOR>:\n${prefix}<CURSOR>`;

    const ac = new AbortController();
    token.onCancellationRequested(() => ac.abort());
    const timeout = setTimeout(() => ac.abort(), TIMEOUT_MS);

    let out = "";
    try {
      for await (const chunk of resolved.provider.chatStream({
        model: resolved.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        signal: ac.signal,
      })) {
        out += chunk.delta;
        if (chunk.done) break;
      }
    } catch {
      return undefined; // aborted/cancelled/errored — no ghost text is the safe fallback
    } finally {
      clearTimeout(timeout);
    }
```

Replace it with:

```typescript
    const ac = new AbortController();
    token.onCancellationRequested(() => ac.abort());
    const timeout = setTimeout(() => ac.abort(), TIMEOUT_MS);

    let out = "";
    try {
      if (resolved.provider.fillInMiddle && isFimCapableModel(resolved.model)) {
        out = await resolved.provider.fillInMiddle(prefix, suffix, resolved.model, ac.signal);
      } else {
        const userContent = suffix.trim()
          ? `Code before <CURSOR>:\n${prefix}<CURSOR>\nCode after <CURSOR>:\n${suffix}`
          : `Code before <CURSOR>:\n${prefix}<CURSOR>`;
        for await (const chunk of resolved.provider.chatStream({
          model: resolved.model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userContent },
          ],
          signal: ac.signal,
        })) {
          out += chunk.delta;
          if (chunk.done) break;
        }
      }
    } catch {
      return undefined; // aborted/cancelled/errored — no ghost text is the safe fallback
    } finally {
      clearTimeout(timeout);
    }
```

Everything after this block (`clip`, `stripCodeFences`, cache write,
return) is unchanged and shared by both branches — do not modify it.

- [ ] **Step 4: Typecheck the extension**

Run: `npm run typecheck -w xpreiIDE-ai`
Expected: PASS.

- [ ] **Step 5: Compile the extension**

Run: `npm run compile -w xpreiIDE-ai`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add extensions/vscode/src/completion/inlineCompletionProvider.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(vscode): use real Ollama FIM for completion-model-capable models"
```

---

### Task 4: User-facing docs

**Files:**
- Modify: `extensions/vscode/README.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Find the ghost-text completions section and add a note**

Search `extensions/vscode/README.md` for its ghost-text/inline-completion
documentation (likely under the "Use" section, near where per-role
models are described, or a dedicated section — read the file first to
find the exact right spot rather than assuming a heading name). Add a
short note, in place, along these lines:

```markdown
FIM-trained code models (codellama, deepseek-coder, qwen2.5-coder,
codestral, codegemma, granite-code, starcoder, and similar) get genuine
Ollama fill-in-the-middle completions automatically when selected as the
completion model — no setup needed. Other models keep using the
existing chat-based completion approach, unchanged.
```

- [ ] **Step 2: Proofread the file**

Read the full file back and confirm the new note reads naturally in
place and doesn't duplicate/contradict anything already said about
completions.

- [ ] **Step 3: Commit**

```bash
git add extensions/vscode/README.md
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "docs: note real Ollama FIM support for capable completion models"
```

---

### Task 5: Final verification

**Files:** none (verification only).

**Interfaces:** none — consumes everything built in Tasks 1-4.

- [ ] **Step 1: Run the full core test suite**

Run: `npm test -w @xprei/core`
Expected: PASS — 263 tests total (256 before this plan + 4
`fimModels.test.ts` + 3 new `ollama.test.ts` tests).

- [ ] **Step 2: Typecheck core**

Run: `npm run typecheck -w @xprei/core`
Expected: PASS.

- [ ] **Step 3: Typecheck the extension**

Run: `npm run typecheck -w xpreiIDE-ai`
Expected: PASS.

- [ ] **Step 4: Compile the extension**

Run: `npm run compile -w xpreiIDE-ai`
Expected: PASS.

- [ ] **Step 5: Manual smoke test**

Launch the Extension Development Host (F5 in VS Code against
`extensions/vscode`), with a FIM-capable model available locally (e.g.
`ollama pull codellama` or `ollama pull deepseek-coder`):

1. Select a FIM-capable model as the completion model
   (`xpreiIDE: Select Model for Role...` → Completions). Type in a code
   file and confirm ghost-text completions still appear — the
   observable behavior is unchanged, but confirm (via a network monitor
   or by temporarily adding a log line) the request goes to
   `/api/generate`, not `/api/chat`.
2. Switch the completion model to a non-FIM model (e.g. `llama3.1`) and
   confirm ghost-text completions still work, now hitting `/api/chat`
   as before.

This step requires a real Extension Development Host and a real Ollama
install and is not something that can be driven from an automated test
— run it manually and report any discrepancy.
