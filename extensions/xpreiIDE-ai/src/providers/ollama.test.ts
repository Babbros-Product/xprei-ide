import assert from "node:assert/strict";
import { test } from "node:test";
import { OllamaProvider } from "./ollama";
import { isAbortError, ProviderConfig, ProviderError } from "./provider";
import { abortError, collect, jsonResponse, mockFetch, streamResponse } from "./_testutil";

const cfg: ProviderConfig = {
  id: "ollama-local",
  kind: "ollama",
  label: "Ollama",
  baseUrl: "http://localhost:11434",
};

function req() {
  return { model: "llama3.1", messages: [{ role: "user" as const, content: "hi" }] };
}

// Recorded /api/chat NDJSON stream (three token lines + final done line).
const NDJSON =
  `{"message":{"role":"assistant","content":"Hel"},"done":false}\n` +
  `{"message":{"role":"assistant","content":"lo"},"done":false}\n` +
  `{"message":{"role":"assistant","content":"!"},"done":false}\n` +
  `{"message":{"role":"assistant","content":""},"done":true}\n`;

test("ollama concatenates NDJSON deltas and signals done", async () => {
  const restore = mockFetch(async () => streamResponse(NDJSON));
  try {
    const chunks = await collect(new OllamaProvider(cfg).chatStream(req()));
    const text = chunks.map((c) => c.delta).join("");
    assert.equal(text, "Hello!");
    assert.equal(chunks.at(-1)?.done, true);
  } finally {
    restore();
  }
});

test("ollama surfaces an error line as ProviderError", async () => {
  const restore = mockFetch(async () =>
    streamResponse(`{"error":"model 'ghost' not found"}\n`),
  );
  try {
    await assert.rejects(
      () => collect(new OllamaProvider(cfg).chatStream(req())),
      (e) => e instanceof ProviderError && /not found/.test(e.message),
    );
  } finally {
    restore();
  }
});

test("ollama includes body text on non-OK chat response", async () => {
  const restore = mockFetch(async () => streamResponse("boom detail", { status: 500 }));
  try {
    await assert.rejects(
      () => collect(new OllamaProvider(cfg).chatStream(req())),
      (e) => e instanceof ProviderError && /500/.test(e.message) && /boom detail/.test(e.message),
    );
  } finally {
    restore();
  }
});

test("ollama rethrows AbortError unwrapped (not 'is it running')", async () => {
  const restore = mockFetch(async () => {
    throw abortError();
  });
  try {
    await assert.rejects(
      () => collect(new OllamaProvider(cfg).chatStream(req())),
      (e) => isAbortError(e),
    );
  } finally {
    restore();
  }
});

test("ollama lists model names from /api/tags", async () => {
  const restore = mockFetch(async () =>
    jsonResponse({ models: [{ name: "llama3.1" }, { name: "qwen2.5" }] }),
  );
  try {
    const models = await new OllamaProvider(cfg).listModels();
    assert.deepEqual(models, ["llama3.1", "qwen2.5"]);
  } finally {
    restore();
  }
});
