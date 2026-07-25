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

// A provider whose stream hangs after one delta until the caller's signal is
// aborted, then rejects with a real AbortError — same shape a real fetch()
// throws when its AbortSignal fires (see ollama.ts / openai-compat.ts).
class HangingProvider implements Provider {
  readonly id = "p";
  readonly label = "P";
  readonly capabilities = { tools: false, embeddings: false, contextWindow: 8192 };
  async listModels(): Promise<string[]> {
    return ["m"];
  }
  async *chatStream(req: ChatRequest): AsyncIterable<ChatChunk> {
    yield { delta: "partial", done: false };
    await new Promise<never>((_resolve, reject) => {
      const abort = () => {
        const e = new Error("The operation was aborted");
        e.name = "AbortError";
        reject(e);
      };
      if (req.signal?.aborted) return abort();
      req.signal?.addEventListener("abort", abort);
    });
  }
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

test("chat.stop aborts the stream and ends it with chat.done, not chat.error", async () => {
  const emitted: any[] = [];
  const session = new SidecarSession({
    emit: (m) => emitted.push(m),
    resolveModel: resolver(new HangingProvider()),
  });

  const sendDone = session.handle({
    id: 1,
    method: "chat.send",
    params: { requestId: "r1", model: "p::m", messages: [] },
  });
  // Wait for the first delta so we know the stream is actually mid-flight,
  // then stop it.
  await new Promise((resolve) => setTimeout(resolve, 10));
  await session.handle({ id: 2, method: "chat.stop", params: { requestId: "r1" } });
  await sendDone;

  assert.ok(emitted.some((m) => m.method === "chat.done" && m.params.requestId === "r1"));
  assert.ok(!emitted.some((m) => m.method === "chat.error"), "a user Stop must not surface as an error");
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

test("models.list forwards to the listModels dep and returns its items", async () => {
  const emitted: any[] = [];
  const items = [{ providerId: "p", providerLabel: "P", model: "m", active: true }];
  const session = new SidecarSession({
    emit: (m) => emitted.push(m),
    resolveModel: resolver(new FakeProvider([])),
    listModels: async (activePointer) => {
      assert.equal(activePointer, "p::m");
      return items;
    },
  });
  await session.handle({ id: 5, method: "models.list", params: { activePointer: "p::m" } });
  assert.deepEqual(emitted, [{ id: 5, result: { items } }]);
});

test("models.list with no listModels dep configured returns an empty list", async () => {
  const emitted: any[] = [];
  const session = new SidecarSession({
    emit: (m) => emitted.push(m),
    resolveModel: resolver(new FakeProvider([])),
  });
  await session.handle({ id: 6, method: "models.list", params: {} });
  assert.deepEqual(emitted, [{ id: 6, result: { items: [] } }]);
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
