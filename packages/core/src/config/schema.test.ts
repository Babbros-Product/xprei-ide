import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, parseConfig, serializeConfig, XpreiConfig } from "./schema";

test("parseConfig on empty content returns DEFAULT_CONFIG's values", () => {
  const { config } = parseConfig("");
  assert.deepEqual(config, DEFAULT_CONFIG);
});

test("parseConfig returns a config object that is NOT the literal DEFAULT_CONFIG reference", () => {
  const { config: a } = parseConfig("");
  const { config: b } = parseConfig("");
  assert.notEqual(a, DEFAULT_CONFIG);
  assert.notEqual(a, b);
  assert.notEqual(a.providers, DEFAULT_CONFIG.providers);
});

test("mutating one parseConfig('') result's providers array does not affect a later parseConfig('') call", () => {
  const { config: a } = parseConfig("");
  a.providers.push({ id: "x", kind: "ollama", label: "X", baseUrl: "http://x" });
  const { config: b } = parseConfig("");
  assert.equal(b.providers.length, DEFAULT_CONFIG.providers.length);
});

test("parseConfig reads a well-formed document's fields", () => {
  const content =
    "providers:\n" +
    "  - id: ollama-local\n" +
    "    kind: ollama\n" +
    "    label: Ollama (local)\n" +
    "    baseUrl: http://localhost:11434\n" +
    "activeModel: ollama-local::llama3.1\n" +
    "embedModel: ollama-local::nomic-embed-text\n";
  const { config } = parseConfig(content);
  assert.deepEqual(config.providers, [
    { id: "ollama-local", kind: "ollama", label: "Ollama (local)", baseUrl: "http://localhost:11434" },
  ]);
  assert.equal(config.activeModel, "ollama-local::llama3.1");
  assert.equal(config.embedModel, "ollama-local::nomic-embed-text");
  assert.equal(config.completionModel, "");
});

test("parseConfig drops a malformed provider entry (missing a required field) without crashing", () => {
  const content =
    "providers:\n" +
    "  - id: good\n" +
    "    kind: ollama\n" +
    "    label: Good\n" +
    "    baseUrl: http://good\n" +
    "  - id: bad-missing-basecurl\n" +
    "    kind: ollama\n" +
    "    label: Bad\n";
  const { config } = parseConfig(content);
  assert.deepEqual(config.providers, [
    { id: "good", kind: "ollama", label: "Good", baseUrl: "http://good" },
  ]);
});

test("parseConfig falls back to [] when 'providers' isn't an array at all", () => {
  const { config } = parseConfig("providers: not-an-array\nactiveModel: x\n");
  assert.deepEqual(config.providers, DEFAULT_CONFIG.providers);
  assert.equal(config.activeModel, "x");
});

test("serializeConfig round-trips through parseConfig", () => {
  const config: XpreiConfig = {
    providers: [
      { id: "a", kind: "ollama", label: "A", baseUrl: "http://a" },
      { id: "b", kind: "openai-compat", label: "B", baseUrl: "http://b", model: "gpt-4o-mini" },
    ],
    activeModel: "a::llama3.1",
    embedModel: "",
    completionModel: "",
    agentModel: "",
    inlineEditModel: "",
    commitMessageModel: "",
  };
  const { raw } = parseConfig("");
  const text = serializeConfig(config, raw);
  const reparsed = parseConfig(text);
  assert.deepEqual(reparsed.config, config);
});

test("serializeConfig preserves an unknown top-level key across a write", () => {
  const { raw } = parseConfig("mcpServers:\n  filesystem:\n    command: npx\n");
  const text = serializeConfig({ ...DEFAULT_CONFIG, activeModel: "a::b" }, raw);
  const reparsed = parseConfig(text);
  assert.equal(reparsed.config.activeModel, "a::b");
  assert.deepEqual(reparsed.raw.mcpServers, { filesystem: { command: "npx" } });
});
