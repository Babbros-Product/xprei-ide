import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "./parseArgs";

test("parseArgs parses a minimal agent invocation", () => {
  const parsed = parseArgs(["agent", "create a hello world file"]);
  assert.equal(parsed.subcommand, "agent");
  assert.equal(parsed.text, "create a hello world file");
  assert.equal(parsed.autoApprove, false);
  assert.equal(parsed.workspace, process.cwd());
});

test("parseArgs parses a minimal chat invocation", () => {
  const parsed = parseArgs(["chat", "hello there"]);
  assert.equal(parsed.subcommand, "chat");
  assert.equal(parsed.text, "hello there");
});

test("parseArgs reads --workspace, --model, --auto-approve, --max-steps, --config", () => {
  const parsed = parseArgs([
    "agent",
    "do the thing",
    "--workspace",
    "/tmp/myproject",
    "--model",
    "ollama-local::llama3.1",
    "--auto-approve",
    "--max-steps",
    "10",
    "--config",
    "/tmp/config.yaml",
  ]);
  assert.equal(parsed.workspace, "/tmp/myproject");
  assert.equal(parsed.model, "ollama-local::llama3.1");
  assert.equal(parsed.autoApprove, true);
  assert.equal(parsed.maxSteps, 10);
  assert.equal(parsed.configPath, "/tmp/config.yaml");
});

test("parseArgs throws a descriptive error when the subcommand is missing", () => {
  assert.throws(() => parseArgs([]), /subcommand/i);
});

test("parseArgs throws a descriptive error for an unknown subcommand", () => {
  assert.throws(() => parseArgs(["frobnicate", "text"]), /unknown subcommand/i);
});

test("parseArgs throws a descriptive error when the positional task/message text is missing", () => {
  assert.throws(() => parseArgs(["agent"]), /text/i);
});

test("parseArgs throws a descriptive error for an unrecognized flag", () => {
  assert.throws(() => parseArgs(["agent", "task", "--bogus-flag"]), /unknown (option|flag)/i);
});
