import assert from "node:assert/strict";
import { test } from "node:test";
import { parseYamlLite, stringifyYamlLite } from "./yamlLite";

test("parseYamlLite parses a flat mapping of scalars", () => {
  const out = parseYamlLite("activeModel: ollama-local::llama3.1\nembedModel: \"\"\n");
  assert.deepEqual(out, { activeModel: "ollama-local::llama3.1", embedModel: "" });
});

test("parseYamlLite parses a sequence of scalars", () => {
  const out = parseYamlLite("args:\n  - -y\n  - server-name\n");
  assert.deepEqual(out, { args: ["-y", "server-name"] });
});

test("parseYamlLite parses a sequence of mappings, each with multiple keys", () => {
  const content =
    "providers:\n" +
    "  - id: ollama-local\n" +
    "    kind: ollama\n" +
    "    label: Ollama (local)\n" +
    "    baseUrl: http://localhost:11434\n" +
    "  - id: openai\n" +
    "    kind: openai-compat\n" +
    "    label: OpenAI\n" +
    "    baseUrl: https://api.openai.com/v1\n" +
    "    model: gpt-4o-mini\n";
  const out = parseYamlLite(content);
  assert.deepEqual(out, {
    providers: [
      { id: "ollama-local", kind: "ollama", label: "Ollama (local)", baseUrl: "http://localhost:11434" },
      {
        id: "openai",
        kind: "openai-compat",
        label: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
      },
    ],
  });
});

test("parseYamlLite parses a nested mapping of mappings", () => {
  const content =
    "mcpServers:\n" +
    "  filesystem:\n" +
    "    command: npx\n" +
    "    args:\n" +
    "      - -y\n" +
    "      - server-name\n";
  const out = parseYamlLite(content);
  assert.deepEqual(out, {
    mcpServers: {
      filesystem: { command: "npx", args: ["-y", "server-name"] },
    },
  });
});

test("parseYamlLite strips comments, including a full-line comment and a trailing one", () => {
  const content = "# a full-line comment\nactiveModel: foo # trailing comment\n";
  const out = parseYamlLite(content);
  assert.deepEqual(out, { activeModel: "foo" });
});

test("parseYamlLite does not treat a '#' inside a quoted scalar as a comment", () => {
  const out = parseYamlLite('label: "issue #42 support"\n');
  assert.deepEqual(out, { label: "issue #42 support" });
});

test("parseYamlLite strips wrapping quotes from quoted scalars", () => {
  const out = parseYamlLite('activeModel: "ollama-local::llama3.1"\n');
  assert.deepEqual(out, { activeModel: "ollama-local::llama3.1" });
});

test("parseYamlLite treats a colon inside an unquoted value (a URL) as part of the value, not a new key", () => {
  const out = parseYamlLite("baseUrl: http://localhost:11434\n");
  assert.deepEqual(out, { baseUrl: "http://localhost:11434" });
});

test("parseYamlLite returns {} for empty content", () => {
  assert.deepEqual(parseYamlLite(""), {});
  assert.deepEqual(parseYamlLite("\n\n"), {});
});

test("stringifyYamlLite/parseYamlLite round-trip a representative config document", () => {
  const value = {
    providers: [
      { id: "ollama-local", kind: "ollama", label: "Ollama (local)", baseUrl: "http://localhost:11434" },
      { id: "openai", kind: "openai-compat", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
    ],
    activeModel: "ollama-local::llama3.1",
    embedModel: "",
    mcpServers: {
      filesystem: { command: "npx", args: ["-y", "server-name"] },
    },
  };
  const out = parseYamlLite(stringifyYamlLite(value));
  assert.deepEqual(out, value);
});

test("stringifyYamlLite quotes an empty string and a numeric-looking string", () => {
  const out = stringifyYamlLite({ activeModel: "", weird: "123" });
  assert.match(out, /activeModel: ""/);
  assert.match(out, /weird: "123"/);
});
