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
