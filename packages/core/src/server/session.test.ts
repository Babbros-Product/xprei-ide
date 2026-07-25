import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatChunk, ChatRequest, Provider } from "../providers/provider";
import { FakeHost } from "../agent/_fakehost";
import { SidecarSession, ResolvedModel } from "./session";

// Fake provider: streams a fixed list of deltas, or replays a scripted set of
// assistant turns (one per chatStream call) for the agent loop.
class FakeProvider implements Provider {
  readonly id = "p";
  readonly label = "P";
  readonly capabilities = { tools: false, embeddings: false, contextWindow: 8192 };
  private i = 0;
  constructor(
    private readonly deltas?: string[],
    private readonly script?: string[],
  ) {}
  async listModels(): Promise<string[]> {
    return ["m"];
  }
  async *chatStream(_req: ChatRequest): AsyncIterable<ChatChunk> {
    if (this.script) {
      yield { delta: this.script[Math.min(this.i++, this.script.length - 1)], done: true };
      return;
    }
    for (const d of this.deltas ?? []) yield { delta: d, done: false };
    yield { delta: "", done: true };
  }
}

function resolver(provider: Provider): (p: string) => ResolvedModel | undefined {
  return (pointer) => (pointer === "p::m" ? { provider, model: "m" } : undefined);
}

test("chat.send streams deltas as chat.delta events then chat.done", async () => {
  const emitted: any[] = [];
  const session = new SidecarSession({
    emit: (m) => emitted.push(m),
    resolveModel: resolver(new FakeProvider(["Hel", "lo", "!"])),
  });
  await session.handle({ id: 1, method: "chat.send", params: { requestId: "r1", model: "p::m", messages: [] } });

  const deltas = emitted.filter((m) => m.method === "chat.delta").map((m) => m.params.delta);
  assert.deepEqual(deltas, ["Hel", "lo", "!"]);
  assert.ok(emitted.some((m) => m.method === "chat.done" && m.params.requestId === "r1"));
});

test("chat.send with an unknown model returns an error response", async () => {
  const emitted: any[] = [];
  const session = new SidecarSession({
    emit: (m) => emitted.push(m),
    resolveModel: resolver(new FakeProvider([])),
  });
  await session.handle({ id: 7, method: "chat.send", params: { requestId: "r", model: "nope::x", messages: [] } });
  assert.ok(emitted.some((m) => m.id === 7 && m.error));
});

test("agent.run drives the loop, gates a write on approval, and writes the file", async () => {
  const host = new FakeHost();
  const emitted: any[] = [];
  const session = new SidecarSession({
    emit: (m: any) => {
      emitted.push(m);
      // Auto-approve any approval request the agent raises.
      if (m.method === "agent.approvalRequest") {
        setImmediate(() =>
          session.handle({ method: "agent.approve", params: { approvalId: m.params.approvalId, choice: "approve" } }),
        );
      }
    },
    resolveModel: resolver(
      new FakeProvider(undefined, [
        '{"tool":"create_file","args":{"path":"new.ts","content":"x"}}',
        '{"final":"created"}',
      ]),
    ),
    makeHost: () => host,
  });

  await session.handle({ method: "initialize", params: { workspaceRoot: "/ws" } });
  await session.handle({ id: 2, method: "agent.run", params: { requestId: "a1", model: "p::m", task: "make a file", mode: "agent" } });

  assert.equal(host.files.get("new.ts"), "x");
  assert.ok(emitted.some((m) => m.method === "agent.approvalRequest"));
  assert.ok(emitted.some((m) => m.method === "agent.final" && m.params.text === "created"));
});

test("agent.revert without a prior run returns an error", async () => {
  const emitted: any[] = [];
  const session = new SidecarSession({
    emit: (m) => emitted.push(m),
    resolveModel: resolver(new FakeProvider([])),
  });
  await session.handle({ id: 9, method: "agent.revert" });
  assert.ok(emitted.some((m) => m.id === 9 && m.error));
});
