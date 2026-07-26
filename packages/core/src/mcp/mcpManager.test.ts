import assert from "node:assert/strict";
import { test } from "node:test";
import * as path from "node:path";
import { McpManager } from "./mcpManager";
import { McpServerConfig } from "./mcpClient";

const fakeServerPath = path.join(__dirname, "_fakeMcpServer.ts");

function goodServerConfig(mode = "ok"): McpServerConfig {
  return { command: process.execPath, args: ["--import", "tsx", fakeServerPath, mode] };
}

test("getTools() returns tools from a working server, prefixed with mcp__<server>__", async () => {
  const manager = new McpManager();
  try {
    const tools = await manager.getTools({ myserver: goodServerConfig() });
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "mcp__myserver__echo");
    assert.equal(tools[0].mutating, true);
  } finally {
    manager.dispose();
  }
});

test("getTools() skips a broken server (bad command) without throwing, and records the error", async () => {
  const manager = new McpManager();
  try {
    const tools = await manager.getTools({
      broken: { command: "definitely-not-a-real-command-xyz", args: [] },
      good: goodServerConfig(),
    });
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "mcp__good__echo");
    assert.ok(manager.lastErrors().broken);
    assert.ok(!manager.lastErrors().good);
  } finally {
    manager.dispose();
  }
});

test("getTools() reuses the cached result on a second call (does not respawn)", async () => {
  const manager = new McpManager();
  try {
    const first = await manager.getTools({ myserver: goodServerConfig() });
    const second = await manager.getTools({ myserver: goodServerConfig() });
    assert.equal(first, second); // same array reference — proves it was cached, not recomputed
  } finally {
    manager.dispose();
  }
});

test("a wrapped MCP tool's run() calls the tool and returns its text as the observation", async () => {
  const manager = new McpManager();
  try {
    const tools = await manager.getTools({ myserver: goodServerConfig() });
    const echoTool = tools[0];
    const result = await echoTool.run({ text: "hello" }, undefined as never);
    assert.match(result.observation, /echo:.*hello/);
  } finally {
    manager.dispose();
  }
});

test("a wrapped MCP tool's run() prefixes an isError result with 'Error: '", async () => {
  const manager = new McpManager();
  try {
    const tools = await manager.getTools({ myserver: goodServerConfig("error-call") });
    const echoTool = tools[0];
    const result = await echoTool.run({}, undefined as never);
    assert.equal(result.observation, "Error: simulated failure");
  } finally {
    manager.dispose();
  }
});
