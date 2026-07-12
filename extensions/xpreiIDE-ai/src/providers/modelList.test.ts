import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateModels } from "./modelList";
import { Provider, ProviderCapabilities, ProviderConfig } from "./provider";

const caps: ProviderCapabilities = { tools: false, embeddings: false, contextWindow: 4096 };

function fakeProvider(id: string, models: string[] | Error): Provider {
  return {
    id,
    label: id,
    capabilities: caps,
    async listModels() {
      if (models instanceof Error) throw models;
      return models;
    },
    async *chatStream() {
      // unused by these tests
    },
  };
}

const cfgOk: ProviderConfig = { id: "a", kind: "ollama", label: "A", baseUrl: "http://a" };
const cfgFallback: ProviderConfig = {
  id: "b",
  kind: "openai-compat",
  label: "B",
  baseUrl: "http://b",
  model: "fallback-model",
};
const cfgNoFallback: ProviderConfig = { id: "c", kind: "openai-compat", label: "C", baseUrl: "http://c" };

test("aggregateModels lists models from a healthy provider and marks the active one", async () => {
  const build = async (cfg: ProviderConfig) => fakeProvider(cfg.id, ["m1", "m2"]);
  const entries = await aggregateModels([cfgOk], build, "a::m2");
  assert.deepEqual(entries, [
    { providerId: "a", providerLabel: "A", model: "m1", active: false },
    { providerId: "a", providerLabel: "A", model: "m2", active: true },
  ]);
});

test("aggregateModels falls back to cfg.model when listModels rejects", async () => {
  const build = async (cfg: ProviderConfig) => fakeProvider(cfg.id, new Error("offline"));
  const entries = await aggregateModels([cfgFallback], build, "");
  assert.deepEqual(entries, [
    { providerId: "b", providerLabel: "B", model: "fallback-model", active: false },
  ]);
});

test("aggregateModels skips a provider with no fallback but keeps others", async () => {
  const build = async (cfg: ProviderConfig) =>
    cfg.id === "c" ? fakeProvider(cfg.id, new Error("offline")) : fakeProvider(cfg.id, ["m1"]);
  const entries = await aggregateModels([cfgOk, cfgNoFallback], build, "");
  assert.deepEqual(entries, [{ providerId: "a", providerLabel: "A", model: "m1", active: false }]);
});
