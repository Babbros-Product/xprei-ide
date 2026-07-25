# Weak-model protocol retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the agent loop's model reply doesn't parse into a valid tool-call or final-answer JSON object, retry with a specific corrective reprompt (up to a configurable cap) instead of today's silent fallback to a fake "final" answer that just ends the run.

**Architecture:** Add a third `Action` outcome (`protocolError`) to the pure `parseAction()` parser in `@xprei/core`, handle it in the orchestrator's loop with a per-step-resetting retry counter and a new optional event, thread an optional `protocolRetries` param through the sidecar's `agent.run` RPC, and wire a new setting + visible transcript indicator into the VS Code extension.

**Tech Stack:** TypeScript (`@xprei/core`, `extensions/vscode`), `node:test` for all automated tests, existing `ScriptedProvider`/`FakeHost`/`FakeProvider` test doubles.

## Global Constraints

- Default retry cap: 2 retries (3 attempts total) — from the approved spec.
- Retry counter resets to 0 on any successfully-parsed action (`tool` or `final`); it does NOT accumulate cumulatively across the whole run.
- The corrective reprompt is fed back as a `role: "user"` message (existing convention — no `tool` role, for OSS model compatibility), not a new message type.
- A retry consumes a step from `maxSteps` and fires the normal `onStep` event — not hidden in a separate budget.
- `protocolRetries` is optional everywhere it's threaded (sidecar params, VS Code setting default) — omitting it must preserve the default-2 behavior for every existing caller.
- Full spec: `docs/superpowers/specs/2026-07-25-weak-model-protocol-retry-design.md`.

---

### Task 1: Protocol layer — `protocolError` Action

**Files:**
- Modify: `packages/core/src/agent/protocol.ts`
- Modify: `packages/core/src/agent/protocol.test.ts`

**Interfaces:**
- Produces: `Action` type gains a third variant `{ kind: "protocolError"; reason: string; thought?: string }`, consumed by Task 2 (`orchestrator.ts`).

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/agent/protocol.test.ts`, replace this existing test:

```ts
test("parseAction falls back to final for non-JSON chatter", () => {
  const a = parseAction("I think the bug is in auth.ts");
  assert.equal(a.kind, "final");
  if (a.kind === "final") assert.match(a.text, /auth\.ts/);
});
```

with:

```ts
test("parseAction returns protocolError for non-JSON chatter", () => {
  const a = parseAction("I think the bug is in auth.ts");
  assert.equal(a.kind, "protocolError");
  if (a.kind === "protocolError") assert.match(a.reason, /did not contain a JSON object/);
});

test("parseAction returns protocolError when JSON has neither tool nor final", () => {
  const a = parseAction('{"thought":"hmm","action":"read_file"}');
  assert.equal(a.kind, "protocolError");
  if (a.kind === "protocolError") {
    assert.match(a.reason, /neither a "tool" nor a "final" key/);
    assert.equal(a.thought, "hmm");
  }
});
```

Every other existing test in the file is unchanged.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd D:/Claude/BABBROSIDE/packages/core
export PATH="/c/nvm4w/nodejs:$PATH"
node --import tsx --test src/agent/protocol.test.ts
```

Expected: the renamed test and the new "neither tool nor final" test both FAIL (current code still returns `kind: "final"` for both cases).

- [ ] **Step 3: Implement `protocolError`**

In `packages/core/src/agent/protocol.ts`, change the `Action` type:

```ts
export type Action =
  | { kind: "tool"; tool: string; args: Record<string, unknown>; thought?: string }
  | { kind: "final"; text: string; thought?: string }
  | { kind: "protocolError"; reason: string; thought?: string };
```

Add two reason constants above `parseAction` (after the `Action` type, before the function):

```ts
const NO_JSON_REASON =
  'Your reply did not contain a JSON object. Respond with exactly one JSON ' +
  'object: either a tool call {"tool": "<name>", "args": {...}} or ' +
  '{"final": "<summary>"}. No prose outside the JSON.';

const MISSING_KEY_REASON =
  'Your JSON object had neither a "tool" nor a "final" key. To call a tool: ' +
  '{"tool": "<name>", "args": {...}}. To finish: {"final": "<summary>"}.';
```

Replace the body of `parseAction`:

```ts
export function parseAction(raw: string): Action {
  const text = raw.trim();
  const obj = extractJsonObject(text);

  if (obj && typeof obj === "object") {
    const rec = obj as Record<string, unknown>;
    const thought = typeof rec.thought === "string" ? rec.thought : undefined;

    if (typeof rec.final === "string") {
      return { kind: "final", text: rec.final, thought };
    }
    if (typeof rec.tool === "string" && rec.tool) {
      const args =
        rec.args && typeof rec.args === "object"
          ? (rec.args as Record<string, unknown>)
          : {};
      return { kind: "tool", tool: rec.tool, args, thought };
    }
    // Valid JSON, but neither a tool call nor a final answer.
    return { kind: "protocolError", reason: MISSING_KEY_REASON, thought };
  }

  // No parseable JSON object at all — a protocol violation the model can
  // correct on retry, not a legitimate final answer (a real answer already
  // comes wrapped as {"final": "..."}).
  return { kind: "protocolError", reason: NO_JSON_REASON };
}
```

`extractJsonObject` itself is unchanged.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd D:/Claude/BABBROSIDE/packages/core
export PATH="/c/nvm4w/nodejs:$PATH"
node --import tsx --test src/agent/protocol.test.ts
```

Expected: all tests PASS (9 total in the file: the original 7 — one of them renamed in place, still counts as 1 — plus the 2 brand-new tests).

- [ ] **Step 5: Typecheck**

```bash
cd D:/Claude/BABBROSIDE
export PATH="/c/nvm4w/nodejs:$PATH"
npm run typecheck -w @xprei/core
```

Expected: clean (no consumers of `Action` outside `protocol.ts` yet — `orchestrator.ts` is Task 2).

- [ ] **Step 6: Commit**

```bash
cd D:/Claude/BABBROSIDE
git add packages/core/src/agent/protocol.ts packages/core/src/agent/protocol.test.ts
git commit -m "$(cat <<'EOF'
feat(core): protocolError Action outcome for unparseable model replies

parseAction() previously fell back to treating any unparseable reply as a
final answer, silently ending the run. Per the protocol's own contract (one
JSON object, either a tool call or {"final":...}), unparseable output is
always a violation, not a legitimate answer — a real answer already comes
wrapped as {"final": "..."}. Two specific, distinct corrective reasons: no
JSON object found at all, or a JSON object with neither a tool nor final
key (thought is now preserved on this path too, previously discarded).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)" --author="xpreiIDE <mbsajay1@gmail.com>"
```

---

### Task 2: Orchestrator retry loop

**Files:**
- Modify: `packages/core/src/agent/orchestrator.ts`
- Modify: `packages/core/src/agent/orchestrator.test.ts`

**Interfaces:**
- Consumes: `Action` (from Task 1), specifically the `protocolError` variant's `{ reason, thought }` shape.
- Produces: `AgentDeps.protocolRetries?: number`, `AgentEvents.onProtocolError?(attempt: number, maxAttempts: number, reason: string): void` — consumed by Task 3 (`session.ts`) and Task 4 (`runner.ts`).

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/agent/orchestrator.test.ts` (after the existing tests, using the file's existing `FakeHost`, `ScriptedProvider`, `recorder`, `yes` helpers already defined at the top):

```ts
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd D:/Claude/BABBROSIDE/packages/core
export PATH="/c/nvm4w/nodejs:$PATH"
node --import tsx --test src/agent/orchestrator.test.ts
```

Expected: the 3 new tests FAIL — `onProtocolError` doesn't exist on `AgentEvents` yet (TS type error) and the loop doesn't retry (garbage today becomes an immediate `onFinal`, not `onError`/retries).

- [ ] **Step 3: Implement the retry loop**

In `packages/core/src/agent/orchestrator.ts`, add `onProtocolError` to `AgentEvents` (after `onError`, before `onEdit`):

```ts
export interface AgentEvents {
  onStep(n: number): void;
  onThought(text: string): void;
  onTool(name: string, args: Record<string, unknown>): void;
  onObservation(text: string): void;
  onFinal(text: string): void;
  onError(text: string): void;
  // Fired on each protocolError retry (not on the final give-up, which uses
  // onError instead). Optional, like onEdit, for headless/test callers.
  onProtocolError?(attempt: number, maxAttempts: number, reason: string): void;
  // Fired after a mutating tool successfully writes a file — before/after
  // content for editor-side feedback (e.g. a gutter flash). Optional so
  // headless/test callers don't need to implement it.
  onEdit?(path: string, before: string, after: string): void;
}
```

Add `protocolRetries?: number;` to `AgentDeps` (after `maxSteps?: number;`):

```ts
export interface AgentDeps {
  provider: Provider;
  model: string;
  host: AgentHost;
  approver: Approver;
  events: AgentEvents;
  tools?: Tool[];
  maxSteps?: number;
  // Consecutive parse failures tolerated before giving up. Default 2 (3
  // attempts total). Resets to 0 on any successfully-parsed action, so a
  // model that's flaky once every several turns never approaches the cap
  // over a long run.
  protocolRetries?: number;
  // Extra project-level instructions (from .xpreiIDErules) appended to the
  // system prompt, verbatim.
  projectRules?: string;
}
```

Add a new default constant next to `DEFAULT_MAX_STEPS`:

```ts
const DEFAULT_MAX_STEPS = 0; // 0 = unlimited (bounded only by Stop/abort or the model finishing)
const DEFAULT_PROTOCOL_RETRIES = 2;
```

Replace the body of `run()`:

```ts
async run(task: string, signal?: AbortSignal): Promise<void> {
  let systemPrompt = buildAgentSystemPrompt(this.tools, this.deps.host.cwd);
  if (this.deps.projectRules) {
    systemPrompt += `\n\nProject instructions:\n${this.deps.projectRules}`;
  }
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: task },
  ];
  const maxSteps = this.deps.maxSteps ?? DEFAULT_MAX_STEPS;
  const unlimited = maxSteps <= 0;
  const protocolRetries = this.deps.protocolRetries ?? DEFAULT_PROTOCOL_RETRIES;
  let protocolFailures = 0;

  for (let step = 1; unlimited || step <= maxSteps; step++) {
    if (signal?.aborted) return;
    this.deps.events.onStep(step);

    let raw: string;
    try {
      raw = await this.streamStep(messages, signal);
    } catch (err) {
      this.deps.events.onError(err instanceof Error ? err.message : String(err));
      return;
    }
    messages.push({ role: "assistant", content: raw });

    const action = parseAction(raw);
    if (action.thought) this.deps.events.onThought(action.thought);

    if (action.kind === "protocolError") {
      protocolFailures++;
      if (protocolFailures > protocolRetries) {
        this.deps.events.onError(
          `Model did not return a valid response after ${protocolFailures} attempts ` +
            `(${action.reason}). Try a different/larger model, or raise xpreiIDE.agent.protocolRetries.`,
        );
        return;
      }
      this.deps.events.onProtocolError?.(protocolFailures, protocolRetries + 1, action.reason);
      messages.push({ role: "user", content: `Protocol error: ${action.reason}` });
      continue;
    }
    protocolFailures = 0;

    if (action.kind === "final") {
      this.deps.events.onFinal(action.text);
      return;
    }

    const observation = await this.runTool(action);
    this.deps.events.onObservation(observation);
    // Feed the result back as the next user turn (universal across models;
    // avoids relying on a "tool" role many OSS backends ignore).
    messages.push({ role: "user", content: `Observation:\n${observation}` });
  }

  this.deps.events.onFinal(
    `Stopped after ${maxSteps} steps without finishing. Refine the task or raise xpreiIDE.agent.maxSteps.`,
  );
}
```

Everything else in the file (`runTool`, `streamStep`) is unchanged. Note: after the `protocolError` branch's `continue`, TypeScript narrows `action` to exclude `protocolError` for the rest of the loop body — the later `runTool(action)` call still type-checks against `Extract<Action, { kind: "tool" }>` exactly as before, since `final` is also excluded by its own `return` above it.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd D:/Claude/BABBROSIDE/packages/core
export PATH="/c/nvm4w/nodejs:$PATH"
node --import tsx --test src/agent/orchestrator.test.ts
```

Expected: all tests PASS, including all pre-existing orchestrator tests (no regressions).

- [ ] **Step 5: Typecheck**

```bash
cd D:/Claude/BABBROSIDE
export PATH="/c/nvm4w/nodejs:$PATH"
npm run typecheck -w @xprei/core
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
cd D:/Claude/BABBROSIDE
git add packages/core/src/agent/orchestrator.ts packages/core/src/agent/orchestrator.test.ts
git commit -m "$(cat <<'EOF'
feat(core): agent retries on protocolError with a per-step-resetting cap

AgentDeps.protocolRetries (default 2, 3 attempts total) and a new optional
AgentEvents.onProtocolError event. On a protocolError action, the specific
corrective reason is fed back as the next user turn (same convention as
tool-error observations) and the loop retries; the failure counter resets
to 0 on any successfully-parsed action so a model that's flaky once every
several turns never approaches the cap over a long run. Exceeding the cap
calls onError with a clear message instead of silently faking a final answer.

3 new tests: retries-then-recovers, counter-resets-not-cumulative (proven via
two independent failure pairs separated by a success), gives-up-after-cap.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)" --author="xpreiIDE <mbsajay1@gmail.com>"
```

---

### Task 3: Sidecar protocol threading

**Files:**
- Modify: `packages/core/src/server/session.ts`
- Modify: `packages/core/src/server/session.test.ts`

**Interfaces:**
- Consumes: `AgentEvents.onProtocolError`, `AgentDeps.protocolRetries` (from Task 2).
- Produces: `agent.run` RPC params gain optional `protocolRetries: number`; a new `agent.protocolError` notification shaped `{ requestId, attempt, maxAttempts, reason }`.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/server/session.test.ts` (it already has `FakeProvider`, `resolver`, and imports `FakeHost` from `"../agent/_fakehost"` — reuse those):

```ts
test("agent.run threads protocolRetries and emits agent.protocolError on retry", async () => {
  const host = new FakeHost();
  const emitted: any[] = [];
  const session = new SidecarSession({
    emit: (m) => emitted.push(m),
    resolveModel: resolver(new FakeProvider(undefined, ["garbage"])),
    makeHost: () => host,
  });
  await session.handle({
    id: 3,
    method: "agent.run",
    params: { requestId: "a2", model: "p::m", task: "do it", mode: "agent", protocolRetries: 1 },
  });
  const protocolErrorEvents = emitted.filter((m) => m.method === "agent.protocolError");
  assert.equal(protocolErrorEvents.length, 1);
  assert.deepEqual(
    [protocolErrorEvents[0].params.attempt, protocolErrorEvents[0].params.maxAttempts],
    [1, 2],
  );
  assert.ok(emitted.some((m) => m.method === "agent.error" && /after 2 attempts/.test(m.params.text)));
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd D:/Claude/BABBROSIDE/packages/core
export PATH="/c/nvm4w/nodejs:$PATH"
node --import tsx --test src/server/session.test.ts
```

Expected: FAIL — `protocolRetries` param is silently ignored today (`Agent` gets no `protocolRetries`, so it uses the core default of 2, not 1; the test's `assert.deepEqual([1,2],...)` and the `/after 2 attempts/` check both fail against the default-2 behavior of 3 attempts).

- [ ] **Step 3: Implement**

In `packages/core/src/server/session.ts`, inside `onAgentRun`, add the new param read (after the existing `projectRules` read):

```ts
    const projectRules = typeof msg.params?.projectRules === "string" ? msg.params.projectRules : undefined;
    const protocolRetries =
      typeof msg.params?.protocolRetries === "number" ? msg.params.protocolRetries : undefined;
```

Add `onProtocolError` to the `events` object (after `onEdit`):

```ts
    const events: AgentEvents = {
      onStep: (n) => this.emit("agent.step", { requestId, n }),
      onThought: (text) => this.emit("agent.thought", { requestId, text }),
      onTool: (name, args) => this.emit("agent.tool", { requestId, name, args }),
      onObservation: (text) => this.emit("agent.observation", { requestId, text }),
      onFinal: (text) => this.emit("agent.final", { requestId, text }),
      onError: (text) => this.emit("agent.error", { requestId, text }),
      onEdit: (path, before, after) => this.emit("agent.edit", { requestId, path, before, after }),
      onProtocolError: (attempt, maxAttempts, reason) =>
        this.emit("agent.protocolError", { requestId, attempt, maxAttempts, reason }),
    };
```

Pass it into the `Agent` constructor call (add `protocolRetries,` after `projectRules,`):

```ts
    const agent = new Agent({
      provider: resolved.provider,
      model: resolved.model,
      host,
      approver,
      events,
      tools: mode === "edit" ? EDIT_MODE_TOOLS : TOOLS,
      projectRules,
      protocolRetries,
    });
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd D:/Claude/BABBROSIDE/packages/core
export PATH="/c/nvm4w/nodejs:$PATH"
node --import tsx --test src/server/session.test.ts
```

Expected: PASS, plus all pre-existing session tests still pass.

- [ ] **Step 5: Full core suite + typecheck**

```bash
cd D:/Claude/BABBROSIDE
export PATH="/c/nvm4w/nodejs:$PATH"
npm run typecheck -w @xprei/core
npm test -w @xprei/core
```

Expected: typecheck clean; note the printed `# tests`/`# pass` totals from the test run — write them down, needed verbatim for Task 5's doc update.

- [ ] **Step 6: Commit**

```bash
cd D:/Claude/BABBROSIDE
git add packages/core/src/server/session.ts packages/core/src/server/session.test.ts
git commit -m "$(cat <<'EOF'
feat(core): thread protocolRetries through the sidecar's agent.run RPC

Optional protocolRetries param on agent.run, forwarded to Agent's deps
(omitted -> core default of 2 applies, matching every existing caller
including the harness/bundle tests, which need no changes). New
agent.protocolError notification, same shape convention as the existing
agent.step/thought/observation events. Keeps IntelliJ/Eclipse in parity
with a sane default once compiled, with no plugin-side work needed yet.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)" --author="xpreiIDE <mbsajay1@gmail.com>"
```

---

### Task 4: VS Code wiring — setting, runner, webview UI

**Files:**
- Modify: `extensions/vscode/package.json`
- Modify: `extensions/vscode/src/agent/runner.ts`
- Modify: `webview/chat.js`
- Modify: `webview/chat.css`

**Interfaces:**
- Consumes: `AgentEvents.onProtocolError`, `AgentDeps.protocolRetries` (Task 2); webview message shape `{ type: "agent", kind: "protocolError", text: string, attempt: number, maxAttempts: number }` (this task defines and both produces-from and consumes-in this shape, VS Code side only).

- [ ] **Step 1: Add the setting**

In `extensions/vscode/package.json`, inside `contributes.configuration.properties`, add after the existing `xpreiIDE.agent.autoApprove` block:

```json
        "xpreiIDE.agent.protocolRetries": {
          "type": "number",
          "default": 2,
          "description": "How many times the agent retries when a model's reply isn't valid JSON (weaker/local models drift out of format more often) before giving up with an error. 0 = fail on the first bad reply."
        },
```

(It sits between the existing `"xpreiIDE.agent.autoApprove": { ... },` entry and `"xpreiIDE.completions.enabled": { ... }`.)

- [ ] **Step 2: Wire `runner.ts`**

In `extensions/vscode/src/agent/runner.ts`, after the existing `maxSteps` read:

```ts
  const maxSteps = vscode.workspace
    .getConfiguration("xpreiIDE")
    .get<number>("agent.maxSteps", 0);
  const protocolRetries = vscode.workspace
    .getConfiguration("xpreiIDE")
    .get<number>("agent.protocolRetries", 2);
```

Add `onProtocolError` to the `events` object (after `onEdit`):

```ts
  const events: AgentEvents = {
    onStep: (n) => post({ type: "agent", kind: "step", n }),
    onThought: (t) => post({ type: "agent", kind: "thought", text: t }),
    onTool: (name, args) => post({ type: "agent", kind: "tool", text: summarize(name, args), name }),
    onObservation: (t) => post({ type: "agent", kind: "observation", text: t }),
    onFinal: (t) => post({ type: "agent", kind: "final", text: t }),
    onError: (t) => post({ type: "agent", kind: "error", text: t }),
    onEdit: (path, before, after) => flashAgentEdit(host.cwd, path, before, after),
    onProtocolError: (attempt, maxAttempts, reason) =>
      post({ type: "agent", kind: "protocolError", text: reason, attempt, maxAttempts }),
  };
```

Pass `protocolRetries` into the `Agent` constructor call (add after `maxSteps,`):

```ts
  const agent = new Agent({
    provider: resolved.provider,
    model: resolved.model,
    host,
    approver: new ChatApprover(autoApprove, requestApproval),
    events,
    maxSteps,
    protocolRetries,
    tools: mode === "edit" ? EDIT_MODE_TOOLS : TOOLS,
    projectRules,
  });
```

- [ ] **Step 3: Render it in the webview**

In `webview/chat.js`, inside `handleAgent`'s `switch (msg.kind)`, add a new case after `case "observation":` and before `case "approval":`:

```js
      case "protocolError":
        addMessage(
          "agent-warning",
          "⚠ Model reply wasn't valid — retrying (" + msg.attempt + "/" + msg.maxAttempts + ")…",
        );
        break;
```

In `webview/chat.css`, add after the `.msg.agent-obs { ... }` block:

```css
.msg.agent-warning {
  background: var(--vscode-inputValidation-warningBackground, var(--vscode-editor-inactiveSelectionBackground));
  border-left: 2px solid var(--vscode-inputValidation-warningBorder, var(--vscode-panel-border));
  font-size: 0.85em;
  margin: 2px 14px;
  padding: 6px 10px;
  border-radius: 6px;
}
```

- [ ] **Step 4: Verify — typecheck, syntax-check, compile, package**

```bash
cd D:/Claude/BABBROSIDE
export PATH="/c/nvm4w/nodejs:/c/Users/mbsaj/AppData/Roaming/npm:$PATH"
npm run typecheck -w xpreiIDE-ai
node --check webview/chat.js
cd extensions/vscode
npm run compile
npx --yes @vscode/vsce package --no-dependencies
```

Expected: typecheck clean; `chat.js` syntax OK; compile succeeds; vsix packages cleanly (matches the existing `dist/`+`media/`-only file list, no new excluded files needed since nothing new is added to `webview/` root-level assets, only edits to existing `chat.js`/`chat.css`).

This task has no automated webview test (matches the existing convention — the webview/settings layer is verified manually throughout this codebase). Full behavioral verification of the retry indicator itself needs a live session against a genuinely unreliable model (e.g. point `xpreiIDE.activeModel` at a very small local Ollama model — under 2B parameters is usually unreliable enough — and give it an agent task); that's a manual step for whoever runs this plan interactively, not something to script here.

- [ ] **Step 5: Commit**

```bash
cd D:/Claude/BABBROSIDE
git add extensions/vscode/package.json extensions/vscode/src/agent/runner.ts webview/chat.js webview/chat.css
git commit -m "$(cat <<'EOF'
feat(vscode): wire weak-model protocol retry into the extension

New xpreiIDE.agent.protocolRetries setting (default 2), threaded through
runner.ts into the agent's deps. Retries now show as a visible warning line
in the chat transcript ("Model reply wasn't valid — retrying (n/m)…")
instead of being invisible — otherwise the feature exists but nobody
watching the transcript would ever know it happened.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)" --author="xpreiIDE <mbsajay1@gmail.com>"
```

---

### Task 5: Final verification + docs

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: nothing new — this task only verifies the prior four tasks together and updates project docs to reflect the real, measured state.

- [ ] **Step 1: Full core suite**

```bash
cd D:/Claude/BABBROSIDE
export PATH="/c/nvm4w/nodejs:$PATH"
npm test -w @xprei/core
```

Expected: all tests pass. Note the exact `# tests N` / `# pass N` line from the output — used verbatim in Step 3 below (do not guess or reuse an old count).

- [ ] **Step 2: Full typecheck + extension package, both packages**

```bash
cd D:/Claude/BABBROSIDE
export PATH="/c/nvm4w/nodejs:/c/Users/mbsaj/AppData/Roaming/npm:$PATH"
npm run typecheck -w @xprei/core
npm run typecheck -w xpreiIDE-ai
cd extensions/vscode
npm run compile
npx --yes @vscode/vsce package --no-dependencies
```

Expected: everything clean/green — this is the same verification shape used throughout the project after every feature.

- [ ] **Step 3: Update `CLAUDE.md`'s test count and P5 status**

In `CLAUDE.md`, find this line (in the `## Layout` tree, under `packages/core/`):

```
  # ALL unit tests live here now (84, run: npm test -w @xprei/core)
```

Replace `84` with the real count printed in Step 1 (e.g. if the suite printed `# tests 98`, the line becomes `# ALL unit tests live here now (98, run: npm test -w @xprei/core)`). Note: this number was already stale before this plan (core had grown to 92 by the time this plan was written, well past the "84" the line still said) — use the freshly-measured number, not 92 or any number written in this plan document, since more tests may have been added by the time this step actually runs.

Then find this block (in `## Phase status`):

```
- **P5 polish** — in progress. Done: chat lives in an Activity Bar container
  and opens automatically on startup; quick actions (Explain/Fix/Tests/Comments/
  Refactor via right-click or `/slash` commands, seeded into chat); `.xpreiIDErules`
  project-instructions file; chat code-block actions (Copy/Insert/Apply);
  Edit & resend / Regenerate on the latest turn; named/persistent chat sessions
  (Plan-mode history only); agent approval cards show a real before/after diff;
  agent-written files get a brief gutter flash if open; inline chat (Ctrl+I);
  commit-message generation from the staged diff (SCM title button); ghost-text
  inline completions (ties up any configured model via `chatStream`, not a
  dedicated FIM endpoint — quality is model-gated). Still open: per-role models,
  weak-model handling, telemetry, diff-preview-before-apply for multi-file agent
  runs (design spec written and approved:
  `docs/superpowers/specs/2026-07-24-diff-preview-before-apply-design.md` —
  implementation not started).
```

Replace with:

```
- **P5 polish** — in progress. Done: chat lives in an Activity Bar container
  and opens automatically on startup; quick actions (Explain/Fix/Tests/Comments/
  Refactor via right-click or `/slash` commands, seeded into chat); `.xpreiIDErules`
  project-instructions file; chat code-block actions (Copy/Insert/Apply);
  Edit & resend / Regenerate on the latest turn; named/persistent chat sessions
  (Plan-mode history only); agent approval cards show a real before/after diff;
  agent-written files get a brief gutter flash if open; inline chat (Ctrl+I);
  commit-message generation from the staged diff (SCM title button); ghost-text
  inline completions (ties up any configured model via `chatStream`, not a
  dedicated FIM endpoint — quality is model-gated); weak-model protocol retry
  (`xpreiIDE.agent.protocolRetries`, default 2 — corrective reprompt + visible
  retry indicator instead of silently ending the run on unparseable output;
  design: `docs/superpowers/specs/2026-07-25-weak-model-protocol-retry-design.md`).
  Still open: per-role models, telemetry, diff-preview-before-apply for
  multi-file agent runs (design spec written and approved:
  `docs/superpowers/specs/2026-07-24-diff-preview-before-apply-design.md` —
  implementation not started).
```

- [ ] **Step 4: Commit**

```bash
cd D:/Claude/BABBROSIDE
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: mark weak-model protocol retry done in P5 status, fix stale test count

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)" --author="xpreiIDE <mbsajay1@gmail.com>"
```
