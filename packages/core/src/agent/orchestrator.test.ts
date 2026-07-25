import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatChunk, ChatRequest, Provider } from "../providers/provider";
import { FakeHost } from "./_fakehost";
import { Agent, AgentEvents, Approver } from "./orchestrator";
import { Tool } from "./tools";

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
