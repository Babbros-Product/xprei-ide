import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { apiKeyEnvVar, loadCliConfig } from "./cliConfig";

test("apiKeyEnvVar uppercases and normalizes non-alphanumeric characters", () => {
  assert.equal(apiKeyEnvVar("my-provider"), "XPREI_APIKEY_MY_PROVIDER");
  assert.equal(apiKeyEnvVar("OpenAI"), "XPREI_APIKEY_OPENAI");
  assert.equal(apiKeyEnvVar("provider.v2"), "XPREI_APIKEY_PROVIDER_V2");
});

test("loadCliConfig reads a real config file at a given path", async () => {
  const tmp = path.join(os.tmpdir(), `xprei-cli-test-${Date.now()}.yaml`);
  await fs.writeFile(
    tmp,
    "providers:\n  - id: test-provider\n    kind: ollama\n    label: Test\n    baseUrl: http://localhost:11434\n" +
      "activeModel: test-provider::llama3.1\n",
    "utf8",
  );
  try {
    const config = await loadCliConfig(tmp);
    assert.equal(config.providers.length, 1);
    assert.equal(config.providers[0].id, "test-provider");
    assert.equal(config.activeModel, "test-provider::llama3.1");
  } finally {
    await fs.rm(tmp, { force: true });
  }
});

test("loadCliConfig throws a clear error when the config file doesn't exist", async () => {
  const missingPath = path.join(os.tmpdir(), `xprei-cli-test-missing-${Date.now()}.yaml`);
  await assert.rejects(() => loadCliConfig(missingPath), /No config found/);
});
