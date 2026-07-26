import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatChunk, ChatRequest, Provider } from "../providers/provider";
import { FakeHost } from "./_fakehost";
import { Agent, AgentEvents, Approver } from "./orchestrator";
import { PendingEdit } from "./pendingEditOverlay";
import { Tool, TOOLS } from "./tools";

// Provider that replays a fixed script of assistant turns, one per chatStream call.
class ScriptedProvider implements Provider {
  readonly id = "scripted";
  readonly label = "Scripted";
  readonly capabilities = { tools: false, embeddings: false, contextWindow: 8192 };
  private i = 0;
  constructor(private readonly script: string[]) {}
  async listModels(): Promise<string[]> {
    return ["m"];
  }
  async *chatStream(_req: ChatRequest): AsyncIterable<ChatChunk> {
    // Repeat the last scripted turn once exhausted (so a lone tool-call turn
    // drives an unbounded loop for maxSteps testing).
    const text = this.script[Math.min(this.i++, this.script.length - 1)];
    yield { delta: text, done: true };
  }
}

function recorder(): { events: AgentEvents; log: string[] } {
  const log: string[] = [];
  const events: AgentEvents = {
    onStep: (n) => log.push(`step:${n}`),
    onThought: (t) => log.push(`thought:${t}`),
    onTool: (name) => log.push(`tool:${name}`),
    onObservation: (t) => log.push(`obs:${t.slice(0, 20)}`),
    onFinal: (t) => log.push(`final:${t}`),
    onError: (t) => log.push(`error:${t}`),
  };
  return { events, log };
}

const yes: Approver = { async approve() { return true; } };
const no: Approver = { async approve() { return false; } };

test("agent reads a file then finishes", async () => {
  const host = new FakeHost({ "a.ts": "hello" });
  const { events, log } = recorder();
  const agent = new Agent({
    provider: new ScriptedProvider([
      '{"tool":"read_file","args":{"path":"a.ts"}}',
      '{"final":"done reading"}',
    ]),
    model: "m",
    host,
    approver: yes,
    events,
  });
  await agent.run("read a.ts");
  assert.ok(log.includes("tool:read_file"));
  assert.ok(log.includes("final:done reading"));
});

test("agent creates a file through the approval gate and it's revertible", async () => {
  const host = new FakeHost();
  const { events } = recorder();
  const agent = new Agent({
    provider: new ScriptedProvider([
      '{"tool":"create_file","args":{"path":"new.ts","content":"x"}}',
      '{"final":"created"}',
    ]),
    model: "m",
    host,
    approver: yes,
    events,
  });
  await agent.run("make a file");
  assert.equal(host.files.get("new.ts"), "x");
  assert.deepEqual(agent.checkpoint.touched, ["new.ts"]);
  await agent.checkpoint.revert();
  assert.equal(host.files.has("new.ts"), false);
});

test("rejected mutating tool does not write and feeds a rejection observation", async () => {
  const host = new FakeHost();
  const { events, log } = recorder();
  const agent = new Agent({
    provider: new ScriptedProvider([
      '{"tool":"create_file","args":{"path":"new.ts","content":"x"}}',
      '{"final":"gave up"}',
    ]),
    model: "m",
    host,
    approver: no,
    events,
  });
  await agent.run("make a file");
  assert.equal(host.files.has("new.ts"), false);
  assert.ok(log.some((l) => l.startsWith("obs:User rejected")));
});

test("unknown tool yields an error observation, not a crash", async () => {
  const host = new FakeHost();
  const { events, log } = recorder();
  const agent = new Agent({
    provider: new ScriptedProvider([
      '{"tool":"frobnicate","args":{}}',
      '{"final":"ok"}',
    ]),
    model: "m",
    host,
    approver: yes,
    events,
  });
  await agent.run("do a thing");
  assert.ok(log.some((l) => l.startsWith("obs:Error: unknown tool")));
});

test("agent stops after maxSteps when the model never finishes", async () => {
  const host = new FakeHost({ "a.ts": "x" });
  const { events, log } = recorder();
  const agent = new Agent({
    provider: new ScriptedProvider(['{"tool":"read_file","args":{"path":"a.ts"}}']),
    model: "m",
    host,
    approver: yes,
    events,
    maxSteps: 3,
  });
  await agent.run("loop forever");
  assert.ok(log.some((l) => l.startsWith("final:Stopped after 3 steps")));
});

test("maxSteps 0 (or omitted) runs unlimited — no premature stop past the old default cap", async () => {
  const host = new FakeHost({ "a.ts": "x" });
  const { events, log } = recorder();
  const toolCalls = Array.from({ length: 25 }, () => '{"tool":"read_file","args":{"path":"a.ts"}}');
  const agent = new Agent({
    provider: new ScriptedProvider([...toolCalls, '{"final":"done after 25 steps"}']),
    model: "m",
    host,
    approver: yes,
    events,
    // maxSteps omitted — defaults to unlimited.
  });
  await agent.run("do a lot of steps");
  assert.ok(log.includes("final:done after 25 steps"));
  assert.ok(!log.some((l) => l.startsWith("final:Stopped after")));
});

test("a restricted tool set rejects tools outside it", async () => {
  const host = new FakeHost({ "a.ts": "x" });
  const readOnly: Tool[] = [
    {
      name: "read_file",
      description: "read",
      args: "{}",
      mutating: false,
      async run(_a, h) {
        return { observation: await h.readFile("a.ts") };
      },
    },
  ];
  const { events, log } = recorder();
  const agent = new Agent({
    provider: new ScriptedProvider([
      '{"tool":"run_terminal","args":{"command":"rm -rf /"}}',
      '{"final":"blocked"}',
    ]),
    model: "m",
    host,
    approver: yes,
    events,
    tools: readOnly,
  });
  await agent.run("try to run a command");
  assert.deepEqual(host.execCalls, []);
  assert.ok(log.some((l) => l.startsWith("obs:Error: unknown tool")));
});

test("agent retries on protocol errors and recovers within the cap", async () => {
  const host = new FakeHost({ "a.ts": "hello" });
  const { events, log } = recorder();
  const protocolErrors: [number, number][] = [];
  const agent = new Agent({
    provider: new ScriptedProvider([
      "garbage",
      "garbage",
      '{"tool":"read_file","args":{"path":"a.ts"}}',
      '{"final":"done"}',
    ]),
    model: "m",
    host,
    approver: yes,
    events: { ...events, onProtocolError: (a, m) => protocolErrors.push([a, m]) },
  });
  await agent.run("do it");
  assert.deepEqual(protocolErrors, [[1, 3], [2, 3]]);
  assert.ok(log.includes("tool:read_file"));
  assert.ok(log.includes("final:done"));
});

test("agent resets the protocol-failure counter after a successful parse", async () => {
  const host = new FakeHost({ "a.ts": "hello" });
  const { events, log } = recorder();
  const protocolErrors: number[] = [];
  const agent = new Agent({
    provider: new ScriptedProvider([
      "garbage",
      "garbage",
      '{"tool":"read_file","args":{"path":"a.ts"}}',
      "garbage",
      "garbage",
      '{"final":"done"}',
    ]),
    model: "m",
    host,
    approver: yes,
    events: { ...events, onProtocolError: (attempt) => protocolErrors.push(attempt) },
  });
  await agent.run("do it");
  // Two independent 1,2 pairs prove the counter reset after the successful
  // tool call rather than accumulating — a cumulative counter would have
  // hit the default cap (2 retries) on the second pair's first failure and
  // never reached "final".
  assert.deepEqual(protocolErrors, [1, 2, 1, 2]);
  assert.ok(log.includes("final:done"));
  assert.ok(!log.some((l) => l.startsWith("error:")));
});

test("agent gives up with onError after exceeding the protocol-retry cap", async () => {
  const host = new FakeHost();
  const { events, log } = recorder();
  const agent = new Agent({
    provider: new ScriptedProvider(["garbage"]), // repeats forever once exhausted
    model: "m",
    host,
    approver: yes,
    events,
  });
  await agent.run("do it");
  assert.ok(!log.includes("final:done"));
  const errorLine = log.find((l) => l.startsWith("error:"));
  assert.ok(errorLine, "expected an error: log entry");
  assert.match(errorLine!, /after 3 attempts/);
  assert.match(errorLine!, /garbage/);
});

test("a tool in deps.tools but NOT in the static TOOLS array is callable", async () => {
  const customTool: Tool = {
    name: "custom_echo",
    description: "test-only tool",
    args: "{}",
    mutating: false,
    async run() {
      return { observation: "echoed" };
    },
  };
  const host = new FakeHost();
  const { events, log } = recorder();
  const agent = new Agent({
    provider: new ScriptedProvider([
      '{"tool":"custom_echo","args":{}}',
      '{"final":"done"}',
    ]),
    model: "m",
    host,
    approver: yes,
    events,
    tools: [customTool],
  });
  await agent.run("task");
  assert.ok(log.includes("obs:echoed"));
});

test("file writes are buffered: onBatch decides, rejected file never lands", async () => {
  const host = new FakeHost();
  const { events } = recorder();
  let batchEntries: PendingEdit[] = [];
  events.onBatch = async (entries) => {
    batchEntries = entries;
    return entries.map((e) => ({ path: e.path, accept: e.path === "keep.ts" }));
  };
  const agent = new Agent({
    provider: new ScriptedProvider([
      '{"tool":"create_file","args":{"path":"keep.ts","content":"K"}}',
      '{"tool":"create_file","args":{"path":"drop.ts","content":"D"}}',
      '{"final":"done"}',
    ]),
    model: "m",
    host,
    approver: yes,
    events,
  });
  await agent.run("make files");
  assert.deepEqual(batchEntries.map((e) => e.path).sort(), ["drop.ts", "keep.ts"]);
  assert.equal(host.files.get("keep.ts"), "K");
  assert.equal(host.files.has("drop.ts"), false);
});

test("onEdit fires only for accepted entries, at flush time, from PendingEdit content", async () => {
  const host = new FakeHost({ "a.ts": "old" });
  const { events } = recorder();
  const edits: { path: string; before: string; after: string }[] = [];
  events.onEdit = (path, before, after) => edits.push({ path, before, after });
  events.onBatch = async (entries) =>
    entries.map((e) => ({ path: e.path, accept: e.path === "a.ts" }));
  const agent = new Agent({
    provider: new ScriptedProvider([
      '{"tool":"edit_file","args":{"path":"a.ts","find":"old","replace":"new"}}',
      '{"tool":"create_file","args":{"path":"b.ts","content":"B"}}',
      '{"final":"done"}',
    ]),
    model: "m",
    host,
    approver: yes,
    events,
  });
  await agent.run("edit");
  assert.deepEqual(edits, [{ path: "a.ts", before: "old", after: "new" }]);
});

test("run_terminal flushes pending edits to real disk before the command executes", async () => {
  class TerminalHost extends FakeHost {
    sawContent: string | undefined;
    async exec(command: string) {
      this.sawContent = this.files.get("a.txt");
      return super.exec(command);
    }
  }
  const host = new TerminalHost();
  const { events } = recorder();
  const agent = new Agent({
    provider: new ScriptedProvider([
      '{"tool":"create_file","args":{"path":"a.txt","content":"hello"}}',
      '{"tool":"run_terminal","args":{"command":"cat a.txt"}}',
      '{"final":"done"}',
    ]),
    model: "m",
    host,
    approver: yes,
    events,
  });
  await agent.run("go");
  assert.equal(host.sawContent, "hello");
});

test("an mcp__-prefixed tool also flushes pending edits before executing", async () => {
  const host = new FakeHost();
  let sawOnDisk: boolean | undefined;
  const mcpTool: Tool = {
    name: "mcp__srv__probe",
    description: "test",
    args: "{}",
    mutating: true,
    async run() {
      sawOnDisk = host.files.has("x.ts");
      return { observation: "ok" };
    },
  };
  const { events } = recorder();
  const agent = new Agent({
    provider: new ScriptedProvider([
      '{"tool":"create_file","args":{"path":"x.ts","content":"X"}}',
      '{"tool":"mcp__srv__probe","args":{}}',
      '{"final":"done"}',
    ]),
    model: "m",
    host,
    approver: yes,
    events,
    tools: [...TOOLS, mcpTool],
  });
  await agent.run("go");
  assert.equal(sawOnDisk, true);
});

test("onBatch receives only edits still pending after a mid-run terminal flush", async () => {
  const host = new FakeHost();
  const { events } = recorder();
  let batchPaths: string[] = [];
  events.onBatch = async (entries) => {
    batchPaths = entries.map((e) => e.path);
    return entries.map((e) => ({ path: e.path, accept: true }));
  };
  const agent = new Agent({
    provider: new ScriptedProvider([
      '{"tool":"create_file","args":{"path":"early.ts","content":"E"}}',
      '{"tool":"run_terminal","args":{"command":"true"}}',
      '{"tool":"create_file","args":{"path":"late.ts","content":"L"}}',
      '{"final":"done"}',
    ]),
    model: "m",
    host,
    approver: yes,
    events,
  });
  await agent.run("go");
  assert.deepEqual(batchPaths, ["late.ts"]);
  assert.equal(host.files.get("early.ts"), "E");
  assert.equal(host.files.get("late.ts"), "L");
});

test("maxSteps exhaustion settles the batch like final (missing onBatch = accept all)", async () => {
  const host = new FakeHost();
  const { events } = recorder();
  const agent = new Agent({
    provider: new ScriptedProvider(['{"tool":"create_file","args":{"path":"s.ts","content":"S"}}']),
    model: "m",
    host,
    approver: yes,
    events,
    maxSteps: 1,
  });
  await agent.run("go");
  assert.equal(host.files.get("s.ts"), "S");
});
