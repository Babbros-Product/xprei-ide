# Phase 8: True FIM autocomplete — design

Date: 2026-07-26

## Context

Phase 8 of `docs/feature-roadmap.md`. Ollama natively supports
fill-in-the-middle via `/api/generate`'s `suffix` parameter on
FIM-trained code models — genuinely better completion quality than the
current `chatStream`-based hack (`inlineCompletionProvider.ts`), which
asks a chat model to role-play a completion engine via a system prompt.
This phase adds real FIM as the preferred path when the configured
completion model supports it, falling back to the existing hack
otherwise — an upgrade to an existing shipped feature, not new
capability surface.

## Decisions

- **Per-model capability detection, not per-provider.** `ProviderCapabilities`
  today is declared once per provider connection (`OllamaProvider`'s
  constructor), but FIM support genuinely varies by *model* — `codellama`/
  `deepseek-coder`/`qwen2.5-coder`/`starcoder` families support it,
  `llama3.1` and other general chat models don't (Ollama's `/api/generate`
  endpoint would still accept the call, just produce poor-quality output
  since the model was never trained for infill). Detection is a static
  name-pattern allowlist against the model string, not a provider-level
  flag. This is the first per-model capability check in this codebase;
  `CLAUDE.md`'s "static per-provider capabilities (no per-model tool
  detection)" gap remains for everything else (tool-calling, etc.).
- **Ollama-only.** `OpenAICompatProvider` has no equivalent native FIM
  endpoint in scope — the `Provider.fillInMiddle` method is optional
  (like `embed?`), implemented only by `OllamaProvider`.
- **Non-streaming request.** VS Code's `InlineCompletionItem` takes a
  complete string, not a token stream — the existing chat-based hack
  already just concatenates every `chatStream` chunk before use, never
  renders progressively. `/api/generate` is called with `stream: false`,
  simplifying the response handling to a single JSON parse.
- **Graceful fallback, not a hard switch.** The completion provider
  checks `provider.fillInMiddle && isFimCapableModel(model)` before using
  real FIM; anything else (no `fillInMiddle` implementation, or a
  non-FIM-trained model) uses the existing `chatStream`-based path,
  completely unchanged. Both paths converge on the same post-processing
  (`stripCodeFences`, line-clipping, one-entry cache).

## Architecture

### `packages/core/src/providers/fimModels.ts` (new, pure)

```typescript
// Static, hand-maintained allowlist of Ollama model-name patterns known
// to be FIM-trained. Not exhaustive — extend as new code-model families
// ship. Matched case-insensitively against the bare model name (the part
// before any ":tag").
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

### `packages/core/src/providers/provider.ts` (modified)

```typescript
export interface Provider {
  readonly id: string;
  readonly label: string;
  readonly capabilities: ProviderCapabilities;
  listModels(signal?: AbortSignal): Promise<string[]>;
  chatStream(req: ChatRequest): AsyncIterable<ChatChunk>;
  embed?(texts: string[], model: string, signal?: AbortSignal): Promise<number[][]>;
  // Real fill-in-the-middle completion: given the text before and after
  // the cursor, returns the text to insert. Optional — only providers
  // with a native FIM endpoint implement this; callers check for its
  // presence (and, separately, isFimCapableModel(model)) before using it.
  fillInMiddle?(prefix: string, suffix: string, model: string, signal?: AbortSignal): Promise<string>;
}
```

### `packages/core/src/providers/ollama.ts` (modified)

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
    throw new ProviderError(`Ollama /api/generate failed: ${res.status} ${res.statusText} ${body}`.trim());
  }
  const data = (await res.json()) as { response?: string };
  return data.response ?? "";
}
```

### `extensions/vscode/src/completion/inlineCompletionProvider.ts` (modified)

After resolving `resolved.provider`/`resolved.model` and computing
`prefix`/`suffix` (unchanged), branch before the existing `chatStream`
call:

```typescript
let out = "";
try {
  if (resolved.provider.fillInMiddle && isFimCapableModel(resolved.model)) {
    out = await resolved.provider.fillInMiddle(prefix, suffix, resolved.model, ac.signal);
  } else {
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
  return undefined;
} finally {
  clearTimeout(timeout);
}
```

`userContent` is only computed/used on the fallback branch — moved
inside the `else` (or left as a no-op string when the FIM branch is
taken; exact placement decided at implementation time to avoid computing
it needlessly on the FIM path). Everything after this block (`clip`,
`stripCodeFences`, cache write, return) is unchanged and shared by both
branches.

## Out of scope

- FIM support for `OpenAICompatProvider` or any other adapter — Ollama
  only, per the roadmap's own framing.
- Streaming FIM responses — VS Code's inline-completion API doesn't use
  progressive rendering here regardless.
- A settings toggle to force the chat-based hack even for a FIM-capable
  model — not requested; the allowlist is the only gate.
- Expanding `ProviderCapabilities` itself (the per-provider, not
  per-model, capability object) — this phase's detection lives in a
  standalone function, not a new capability field, since capability
  varies by model, not by provider connection.

## Testing

- `fimModels.test.ts` (new, pure): known-capable names across every
  listed family (with and without a `:tag` suffix,
  e.g. `codellama:7b-instruct`), known-incapable names (`llama3.1`,
  `mistral`, an arbitrary made-up name), case-insensitivity
  (`CodeLlama:13b`).
- `ollama.test.ts` (extend, using the existing `mockFetch`/`jsonResponse`
  helpers from `_testutil.ts`, matching the `/api/tags` test's
  non-streaming style): `fillInMiddle` sends `stream: false` with
  `prompt`/`suffix` in the request body and returns the response's
  `response` field; a non-OK response throws `ProviderError` with the
  response body included, mirroring `chatStream`'s existing error
  handling.
- `inlineCompletionProvider.ts`: no unit test (VS Code-layer, none exist
  for this file today) — verified by
  `npm run typecheck -w xpreiIDE-ai` + `npm run compile -w xpreiIDE-ai`,
  plus the manual smoke test described above (FIM-capable model hits
  `/api/generate`; non-FIM model still hits `/api/chat` unchanged).

## User-facing docs

`extensions/vscode/README.md`'s ghost-text-completions section gains a
note that FIM-trained code models (codellama, deepseek-coder,
qwen2.5-coder, etc.) get genuine fill-in-the-middle completions
automatically when selected as the completion model, with other models
continuing to use the existing chat-based approach — no user action
required, purely a quality improvement for compatible models.
