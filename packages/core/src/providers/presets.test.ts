import assert from "node:assert/strict";
import { test } from "node:test";
import { PRESETS, uniqueProviderId } from "./presets";

test("PRESETS includes OpenAI and Gemini with correct base URLs", () => {
  const openai = PRESETS.find((p) => p.id === "openai");
  const gemini = PRESETS.find((p) => p.id === "gemini");
  assert.ok(openai, "openai preset missing");
  assert.equal(openai?.baseUrl, "https://api.openai.com/v1");
  assert.equal(openai?.kind, "openai-compat");
  assert.ok(gemini, "gemini preset missing");
  assert.equal(gemini?.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
  assert.equal(gemini?.kind, "openai-compat");
});

test("uniqueProviderId returns the base id when it is free", () => {
  assert.equal(uniqueProviderId("openai", []), "openai");
  assert.equal(uniqueProviderId("openai", ["gemini"]), "openai");
});

test("uniqueProviderId appends -2 when the base id is taken", () => {
  assert.equal(uniqueProviderId("openai", ["openai"]), "openai-2");
});

test("uniqueProviderId skips already-taken numbered suffixes", () => {
  assert.equal(uniqueProviderId("openai", ["openai", "openai-2"]), "openai-3");
});
