import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenAICompatProvider } from "./openai-compat";
import { ProviderConfig, ProviderError } from "./provider";
import { collect, jsonResponse, mockFetch, streamResponse } from "./_testutil";

const cfg: ProviderConfig = {
  id: "openai",
  kind: "openai-compat",
  label: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
};

function req() {
  return { model: "gpt-4o-mini", messages: [{ role: "user" as const, content: "hi" }] };
}

// Recorded /v1/chat/completions SSE stream.
const SSE =
  `data: {"choices":[{"delta":{"content":"Hel"}}]}\n` +
  `data: {"choices":[{"delta":{"content":"lo"}}]}\n` +
  `data: {"choices":[{"delta":{"content":"!"}}]}\n` +
  `data: [DONE]\n`;

test("openai-compat parses SSE deltas and stops on [DONE]", async () => {
  const restore = mockFetch(async () => streamResponse(SSE));
  try {
    const chunks = await collect(new OpenAICompatProvider(cfg, "key").chatStream(req()));
    assert.equal(chunks.map((c) => c.delta).join(""), "Hello!");
    assert.equal(chunks.at(-1)?.done, true);
  } finally {
    restore();
  }
});

test("openai-compat sends Authorization header when key present", async () => {
  let seen = "";
  const restore = mockFetch(async (_url, init) => {
    seen = String((init?.headers as Record<string, string>)["Authorization"] ?? "");
    return streamResponse(SSE);
  });
  try {
    await collect(new OpenAICompatProvider(cfg, "sk-abc").chatStream(req()));
    assert.equal(seen, "Bearer sk-abc");
  } finally {
    restore();
  }
});

test("openai-compat listModels error keeps status, no double-wrap", async () => {
  const restore = mockFetch(async () => jsonResponse({}, { status: 401 }));
  try {
    await assert.rejects(
      () => new OpenAICompatProvider(cfg, "").listModels(),
      (e) => e instanceof ProviderError && /401/.test(e.message) && !/Cannot list/.test(e.message),
    );
  } finally {
    restore();
  }
});
