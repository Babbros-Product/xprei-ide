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

test("ollama embed batches the whole input to /api/embed in one request", async () => {
  const urls: string[] = [];
  const restore = mockFetch(async (input) => {
    urls.push(String(input));
    return jsonResponse({ embeddings: [[1, 0], [0, 1]] });
  });
  try {
    const out = await new OllamaProvider(cfg).embed(["a", "b"], "nomic-embed-text");
    assert.deepEqual(out, [[1, 0], [0, 1]]);
    assert.equal(urls.length, 1, "one round-trip for the batch");
    assert.match(urls[0], /\/api\/embed$/);
  } finally {
    restore();
  }
});

test("ollama embed falls back to per-text /api/embeddings on 404", async () => {
  const urls: string[] = [];
  const restore = mockFetch(async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith("/api/embed")) return jsonResponse({}, { status: 404 });
    return jsonResponse({ embedding: [7, 8] });
  });
  try {
    const out = await new OllamaProvider(cfg).embed(["a", "b"], "nomic-embed-text");
    assert.deepEqual(out, [[7, 8], [7, 8]]);
    assert.equal(urls[0].endsWith("/api/embed"), true);
    assert.equal(urls.filter((u) => u.endsWith("/api/embeddings")).length, 2);
  } finally {
    restore();
  }
});

test("ollama embed returns [] for empty input without hitting the network", async () => {
  let called = false;
  const restore = mockFetch(async () => {
    called = true;
    return jsonResponse({});
  });
  try {
    const out = await new OllamaProvider(cfg).embed([], "nomic-embed-text");
    assert.deepEqual(out, []);
    assert.equal(called, false);
  } finally {
    restore();
  }
});
