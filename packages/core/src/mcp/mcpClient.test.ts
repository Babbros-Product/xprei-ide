import assert from "node:assert/strict";
import { test } from "node:test";
import * as path from "node:path";
import { McpClient } from "./mcpClient";

const fakeServerPath = path.join(__dirname, "_fakeMcpServer.ts");

function client(
  mode: string,
  opts?: { handshakeTimeoutMs?: number; callTimeoutMs?: number },
): McpClient {
  return new McpClient(
    { command: process.execPath, args: ["--import", "tsx", fakeServerPath, mode] },
    opts,
  );
}

test("McpClient connects, lists tools, and calls a tool successfully", async () => {
  const c = client("ok");
  try {
    const tools = await c.connect();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "echo");
    const result = await c.callTool("echo", { text: "hi" });
    assert.equal(result.isError, false);
    assert.match(result.text, /echo:.*hi/);
  } finally {
    c.dispose();
  }
});

test("McpClient.connect() times out if the server never responds to initialize", async () => {
  const c = client("hang-init", { handshakeTimeoutMs: 300 });
  try {
    await assert.rejects(() => c.connect(), /timed out/);
  } finally {
    c.dispose();
  }
});

test("McpClient.connect() rejects (not hangs forever) when the server process exits immediately", async () => {
  const c = client("exit-now", { handshakeTimeoutMs: 2000 });
  try {
    await assert.rejects(() => c.connect());
  } finally {
    c.dispose();
  }
});

test("McpClient.callTool() times out if the server never responds", async () => {
  const c = client("hang-call", { callTimeoutMs: 300 });
  try {
    await c.connect();
    await assert.rejects(() => c.callTool("echo", {}), /timed out/);
  } finally {
    c.dispose();
  }
});

test("McpClient.callTool() resolves normally (not throws) when the server reports isError: true", async () => {
  const c = client("error-call");
  try {
    await c.connect();
    const result = await c.callTool("echo", {});
    assert.equal(result.isError, true);
    assert.equal(result.text, "simulated failure");
  } finally {
    c.dispose();
  }
});
