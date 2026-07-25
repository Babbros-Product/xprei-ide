# Weak-model protocol retry — design

Date: 2026-07-25

## Problem

xpreiIDE's agent loop speaks a universal prompt-based JSON tool protocol
(`agent/protocol.ts`) instead of relying on native function-calling, because
native tool-calling is unreliable or absent on smaller open-source models —
this is the entire point of the "bring your own local model" pitch (see
`CLAUDE.md`: "Agent tool-calling: a universal prompt-based JSON tool
protocol, not native function-calling — unreliable on OSS models"). But the
protocol layer itself has no tolerance for a model that fails to follow the
format: `parseAction()` tries to extract one JSON object from the reply, and
if that fails for any reason, it silently treats the entire raw reply as a
`final` answer. The run just ends. There is no retry, no corrective feedback
to the model, and no signal to the user distinguishing "the agent finished"
from "the model ignored the response contract and the run gave up."

This is the opposite of what "local LLM support is core to the product"
requires: local models (7B-13B range particularly) are exactly the case most
likely to drift out of the JSON contract under load, and today that failure
mode is invisible and silent. Tool-*execution* errors already self-correct
(an error observation is fed back as the next turn, letting the model retry
with better arguments — see `edit_file`'s "find text not found" /
"matches multiple times" messages in `agent/tools.ts`); parse failures at
the protocol layer get no equivalent treatment.

## Scope

In scope:
1. `protocol.ts`: a third `Action` outcome, `protocolError`, replacing the
   current silent-fallback-to-final behavior for genuinely unparseable
   output, with two distinct, specific corrective messages.
2. `orchestrator.ts`: retry loop with a configurable cap
   (`AgentDeps.protocolRetries`, default 2 → 3 attempts total), a
   consecutive-failure counter that resets on any successful parse, a new
   optional `AgentEvents.onProtocolError` event, and a clear terminal
   `onError` once the cap is exhausted.
3. `server/session.ts` / `server/stdio.ts`: pass `protocolRetries` through
   `agent.run`'s params (optional, sidecar-side default applies if
   omitted), and forward a new `agent.protocolError` event — cheap, keeps
   IntelliJ/Eclipse in parity once compiled, no plugin-side work required
   this pass.
4. VS Code: new `xpreiIDE.agent.protocolRetries` setting, `runner.ts`
   wiring, a new webview message kind, and a `chat.js` rendering of it as a
   visible, distinct transcript line — otherwise this feature is invisible
   to the person it's meant to help.

Out of scope:
- Any change to how tool-*execution* errors are handled (already correct,
  already self-correcting via the observation feedback loop).
- IntelliJ/Eclipse UI to configure `protocolRetries` (the plugins aren't
  compiled yet; the sidecar wiring alone gets them a sane default for free).
- Detecting/handling multiple JSON objects in one reply, or other more
  exotic malformations beyond "no JSON found" and "JSON found but missing
  both `tool` and `final`" — YAGNI; these two categories cover the
  overwhelming majority of real weak-model failures (truncation, prose
  wrapping, wrong key names) without over-fitting the parser to
  hypothetical cases.

## Architecture

### `protocol.ts`

```ts
export type Action =
  | { kind: "tool"; tool: string; args: Record<string, unknown>; thought?: string }
  | { kind: "final"; text: string; thought?: string }
  | { kind: "protocolError"; reason: string; thought?: string };
```

`parseAction()` changes:
- If `extractJsonObject()` returns a parsed object but it has neither a
  string `final` key nor a string `tool` key, return `protocolError` with
  reason: `Your JSON object had neither a "tool" nor a "final" key. To
  call a tool: {"tool": "<name>", "args": {...}}. To finish: {"final":
  "<summary>"}.` — `thought` is still extracted and carried if present,
  matching today's extraction (currently discarded on this fallthrough
  path; this spec fixes that as a side effect).
- If `extractJsonObject()` returns nothing at all (no balanced,
  JSON-parseable object found), return `protocolError` with reason: `Your
  reply did not contain a JSON object. Respond with exactly one JSON
  object: either a tool call {"tool": "<name>", "args": {...}} or
  {"final": "<summary>"}. No prose outside the JSON.`
- The `tool`/`final` success paths are unchanged.

`extractJsonObject()` itself is unchanged — its brace-matching, fence-strip,
first-object-wins behavior is already reasonable; only what `parseAction`
does with a "nothing extracted" result changes.

### `orchestrator.ts`

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
  onEdit?(path: string, before: string, after: string): void;
}

export interface AgentDeps {
  // ...unchanged fields...
  // Consecutive parse failures tolerated before giving up. Default 2 (3
  // attempts total). Resets to 0 on any successfully-parsed action, so a
  // model that's flaky once every several turns never approaches the cap
  // over a long run.
  protocolRetries?: number;
}

const DEFAULT_PROTOCOL_RETRIES = 2;
```

Inside `run()`'s loop, immediately after `parseAction`:

```ts
if (action.kind === "protocolError") {
  protocolFailures++;
  if (protocolFailures > (this.deps.protocolRetries ?? DEFAULT_PROTOCOL_RETRIES)) {
    this.deps.events.onError(
      `Model did not return a valid response after ${protocolFailures} attempts ` +
      `(${action.reason}). Try a different/larger model, or raise xpreiIDE.agent.protocolRetries.`,
    );
    return;
  }
  this.deps.events.onProtocolError?.(
    protocolFailures,
    (this.deps.protocolRetries ?? DEFAULT_PROTOCOL_RETRIES) + 1,
    action.reason,
  );
  messages.push({ role: "user", content: `Protocol error: ${action.reason}` });
  continue;
}
protocolFailures = 0;
```

`protocolFailures` is declared once, before the `for` loop, alongside
`messages`. A retry consumes a `step` from `maxSteps` and is shown via the
normal `onStep` call at the top of the loop — deliberately not hidden in a
separate budget, since it's a real model call that costs tokens and time;
the person watching the transcript should see it happen. The corrective
message is pushed as a `role: "user"` turn, matching the existing
`Observation:\n...` convention used for tool-execution errors (per
`CLAUDE.md`'s documented choice: "Agent feeds observations as user turns,
not a tool role, for OSS compatibility") — no new message role introduced.

### `server/session.ts` / `server/stdio.ts`

`onAgentRun`'s params gain an optional `protocolRetries` (number), forwarded
into the `Agent` constructor's deps. `AgentEvents.onProtocolError` maps to a
new `agent.protocolError` notification:
`{ requestId, attempt, maxAttempts, reason }` — same shape convention as the
existing `agent.step`/`agent.thought`/`agent.observation` events.

### VS Code (`extensions/vscode`)

- `package.json`: new setting `xpreiIDE.agent.protocolRetries` (number,
  default `2`, description explaining what it controls), read in
  `agent/runner.ts` alongside the existing `agent.autoApprove`/
  `agent.maxSteps` reads and passed into `runAgent`'s `AgentDeps`.
- `agent/runner.ts`'s `events` object gains `onProtocolError: (attempt,
  maxAttempts, reason) => post({ type: "agent", kind: "protocolError",
  attempt, maxAttempts, text: reason })`.
- `webview/chat.js`: a new `case "protocolError":` alongside the existing
  `case "step"` / `"thought"` / etc. inside the `"agent"` message switch,
  rendering a small warning-styled transcript line, e.g. "⚠ Model response
  wasn't valid JSON — retrying (`attempt`/`maxAttempts`)…". Styled distinctly
  from a normal thought/observation line (existing `.ghostBtn`/error-styling
  CSS vocabulary already in `chat.css` covers this — no new CSS classes
  anticipated beyond one `.protocolWarning` rule mirroring the existing
  error-message style).

## Data flow (weak model, recovers on retry 1)

1. Agent step 1: model replies with prose, no JSON → `parseAction` returns
   `protocolError` → `protocolFailures = 1` → `onProtocolError(1, 3, ...)`
   fires → webview shows "retrying (1/3)" → corrective message pushed as
   the next user turn.
2. Agent step 2: model replies `{"tool":"read_file","args":{"path":"a.ts"}}`
   → parses fine → `protocolFailures` resets to 0 → tool runs normally,
   loop continues as today.

## Data flow (model never recovers)

1-3. Three consecutive `protocolError` results (default cap: 2 retries + the
initial attempt = 3 total). On the third, `protocolFailures` (3) exceeds
`protocolRetries` (2) → `onError` fires with a clear message citing the
last failure's specific reason → run stops. The webview shows this the same
way it shows any other agent error today — no new UI path needed for the
give-up case, only for the in-progress retries.

## Error handling

- A `protocolError` never throws — it's a normal `Action` variant flowing
  through the same control path as `tool`/`final`, so no new try/catch is
  needed in `run()`.
- `onProtocolError` is optional; omitting it (as existing headless tests
  do for `onEdit`) simply means no retry notification fires, but retry
  behavior itself is unaffected — tests that don't care about the UI signal
  don't need to implement it.
- The sidecar's `protocolRetries` param is optional and additive — a client
  that doesn't send it gets `DEFAULT_PROTOCOL_RETRIES` behavior, identical
  to today's (well, today's *fixed* behavior; see the explicit behavior
  change called out in the Problem section) for every existing caller,
  including the harness/bundle tests, without needing updates.

## Testing

- `protocol.test.ts` (extend): "no JSON at all → protocolError with the
  no-JSON reason"; "JSON with neither tool nor final → protocolError with
  the missing-key reason, thought preserved if present"; existing
  tool/final-path tests unchanged (still pass, confirming no regression).
- `orchestrator.test.ts` (extend):
  - **Retries then recovers:** script `["garbage", "garbage",
    '{"tool":"read_file","args":{"path":"a.ts"}}', '{"final":"done"}']`
    against a `FakeHost` with `a.ts` present. Asserts exactly 2
    `onProtocolError` calls (`(1,3,...)` then `(2,3,...)`), the tool runs
    and `onFinal("done")` fires (proving recovery within the default cap),
    and the corrective message text appears in the `messages` array passed
    to the third `chatStream` call.
  - **Counter resets on success, not cumulative across the run:** script
    `["garbage", "garbage", '{"tool":"read_file","args":{"path":"a.ts"}}',
    "garbage", "garbage", '{"final":"done"}']` (two failures, a recovery,
    then two *more* failures) — this only reaches `final` if the second
    pair of failures is independently under the cap, which is only true if
    `protocolFailures` reset to 0 after the successful tool call rather
    than continuing to accumulate (a cumulative counter would have hit the
    cap — 3 total garbage replies with `protocolRetries: 2` — on the second
    pair's first failure and given up instead of recovering). Asserts 4
    total `onProtocolError` calls and a final `onFinal("done")`.
  - **Gives up after the cap:** an all-garbage script, asserting `onError`
    fires (not `onFinal`) after exactly `protocolRetries + 1` attempts,
    with the give-up message mentioning the attempt count and the specific
    last-failure reason.
- `session.test.ts` (extend): `agent.run` with a scripted-garbage
  `FakeProvider` and an explicit `protocolRetries: 1` param, asserting one
  `agent.protocolError` event then a terminal error response — confirms the
  sidecar-level param threading, independent of the VS Code wiring (which
  has no automated test, consistent with the rest of the webview/settings
  layer — verified manually per the project's existing convention).
