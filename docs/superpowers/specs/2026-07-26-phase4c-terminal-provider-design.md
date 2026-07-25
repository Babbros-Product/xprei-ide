# Phase 4c: @terminal context provider — design

Date: 2026-07-26

## Context

Fourth provider sub-project of Phase 4 ("Richer context providers") from
`docs/feature-roadmap.md`. Flagged in the roadmap's own decomposition as
needing a feasibility check before design, because VS Code has no clean
official API for reading terminal output history.

**Feasibility check result:** the roadmap's original framing — "recent
terminal output," i.e. surface what the user already ran/saw in their
terminal — is **not buildable** in a real, Marketplace-published
extension. Two APIs exist and neither fits:

- `TerminalShellExecution.read()` — stable since VS Code 1.93, but only
  captures output for commands the **extension itself launches** via
  `shellIntegration.executeCommand()`. It cannot retrieve output from
  commands the user already ran before the mention.
- `window.onDidWriteTerminalData` — captures live output going forward,
  but is a **proposed API** requiring `--enable-proposed-api`, works only
  in dev/F5 mode, not in a packaged extension — a hard no given
  `CLAUDE.md`'s locked "no core patches, ship to Marketplace/Open VSX"
  decision.
- Retrieving pre-existing terminal buffer/scrollback content at all has
  been an open, unresolved upstream VS Code issue since 2018
  (`microsoft/vscode#55720`).

**Scope redefinition (approved):** `@terminal:<command>` runs a shell
command via the stable `executeCommand()` API and injects **that
command's own output** — a different feature than "see terminal
history," but genuinely buildable and still useful (e.g.
`why did this fail @terminal:npm test`).

## Decisions

- **Takes an argument, unlike `@open`/`@problems`/`@diff`.** A bare
  `@terminal` has nothing to inject — there's no history to fall back to.
  Syntax is `@terminal:<command>`, matching `@file:<path>`'s existing
  argument shape.
- **Command captures to end of message.** `@terminal:<command>` must be
  the last thing typed — everything after `@terminal:` to the end of the
  text is the command verbatim, with no quoting required. Shell commands
  routinely contain spaces (`npm test`, `git status -sb`), which a
  `\S+`-style capture (as `@file:` uses) can't handle; requiring the
  mention to be trailing avoids inventing a quoting/escaping scheme for
  the common case.
- **The one mutating mention — requires confirmation.** Every other
  mention (`@open`/`@problems`/`@diff`/`@codebase`/`@file:`) is read-only.
  `@terminal` executes a shell command as a side effect of sending a
  chat message. A `vscode.window.showWarningMessage("Run '<command>' in
  your terminal?", "Run", "Cancel")` gate is required before execution —
  matching this project's existing convention of approval gates for
  anything that runs a shell command (the agent loop's `run_terminal`
  tool already requires approval). Declining degrades to `""` (silent,
  not an error) — matching every other mention's graceful-empty
  behavior; declining isn't a failure.
- **Stable shell-integration API only** — `terminal.shellIntegration
  .executeCommand()` + `TerminalShellExecution.read()` +
  `onDidEndTerminalShellExecution` for the exit code. No proposed API,
  no `child_process`.
- **Single segment, `"break"` strategy** — a command's output is one
  blob, same reasoning as `@diff`: can't be usefully split into
  independent pieces the way files or diagnostics can.
- **Tier priority: immediately after `@diff`, before `@open`.** Groups
  the two "run something, show me the result" single-segment tiers
  together. Full order, highest to lowest: `@file:` (`"break"`) →
  `@problems` (`"skip"`) → `@diff` (`"break"`) → `@terminal` (`"break"`)
  → `@open` (`"break"`) → `@codebase` hits (`"skip"`).
- **120-second timeout, 8000-char output cap** — matching the agent
  loop's existing `run_terminal` conventions (`EXEC_TIMEOUT_MS = 120_000`
  in `extensions/vscode/src/agent/host.ts`, `MAX_OBS = 8000` in
  `packages/core/src/agent/tools.ts`) rather than inventing new numbers.

## Architecture

### `packages/core/src/context/mentions.ts`

Unlike the other three new flags, `@terminal` carries a value, not a
boolean:

```typescript
export interface Mentions {
  codebase: boolean;
  open: boolean;
  problems: boolean;
  diff: boolean;
  terminalCommand: string | undefined; // new
  files: string[];
  cleaned: string;
}

// Anchored to end-of-string ($) and non-global (only one @terminal: per
// message makes sense) — captures everything after "@terminal:" to the
// end of the text, so it must run BEFORE every other mention regex:
// otherwise those regexes would try to parse pieces of the command text
// (e.g. a path-looking token inside "npm run build src/index.ts") as
// separate mentions before @terminal ever claims the trailing span.
const TERMINAL_RE = /(^|\s)@terminal:(.+)$/i;
```

`parseMentions()` runs `TERMINAL_RE` first, before `CODEBASE_RE`/
`OPEN_RE`/etc., precisely so it claims the whole trailing command text
before any other regex gets a chance to misinterpret part of it.
`hasContextRequest()` gains `|| m.terminalCommand !== undefined`.

### `packages/core/src/context/retrieval.ts`

```typescript
export function formatTerminal(command: string, output: string): string {
  return `// $ ${command}\n${output}`;
}
```

`buildContextMessage` gains a fifth optional parameter, `terminal?: string`,
assembled at the locked tier position (after `diff`, before `retrieved`).

### `extensions/vscode/src/context/contextEngine.ts`

One new private method, using the terminal shell-integration API:

```typescript
private async runTerminalCommand(command: string): Promise<string> {
  const confirmed = await vscode.window.showWarningMessage(
    `Run '${command}' in your terminal?`,
    "Run",
    "Cancel",
  );
  if (confirmed !== "Run") return "";

  const terminal = vscode.window.createTerminal({ name: "xpreiIDE" });
  try {
    const integration = await waitForShellIntegration(terminal); // helper: races onDidChangeTerminalShellIntegration against a short timeout
    if (!integration) return "";

    const execution = integration.executeCommand(command);
    let output = "";
    for await (const chunk of execution.read()) {
      output += chunk;
      if (output.length > MAX_TERMINAL_CHARS) break; // bounded read, not just bounded output string
    }
    return output.length > MAX_TERMINAL_CHARS
      ? output.slice(0, MAX_TERMINAL_CHARS) + TRUNCATION_MARKER
      : output;
  } catch {
    return "";
  }
}
```

(Exact timeout/race-against-`onDidEndTerminalShellExecution` mechanics are
left to the implementation plan — the design-level commitment is: stable
API only, bounded time, bounded output, silent-empty on any failure.)

`buildContext()` grows a sixth tier at the locked position, built
unconditionally like every other tier:

```typescript
const terminalOutput = mentions.terminalCommand
  ? await this.runTerminalCommand(mentions.terminalCommand)
  : "";

const terminalTier: SegmentTier = {
  segments: terminalOutput
    ? [{ text: formatTerminal(mentions.terminalCommand!, terminalOutput), data: null }]
    : [],
  strategy: "break",
};
```

inserted into the `budgetContext([...])` array and the positional
destructure between `diffTier`/`keptDiffSegs` and `openTier`/`keptOpenSegs`.

## Out of scope

- No reading of pre-existing terminal output/scrollback — established
  infeasible above.
- No multi-command / pipeline syntax beyond whatever the shell itself
  interprets in the single command string passed to `executeCommand()`.
- No change to the agent loop's `run_terminal` tool or its own approval
  flow — `@terminal` (chat mention) and `run_terminal` (agent tool) are
  independent features on independent code paths, like `@diff` and
  `view_diff` before it.
- No persistent/reusable terminal across multiple `@terminal` mentions in
  the same session — each invocation creates its own terminal instance,
  matching the "one command, show its output" framing (not a REPL).

## Testing

- `mentions.ts`: extend `mentions.test.ts` with `@terminal:<command>`
  parsing, the end-of-string capture behavior (including a case proving
  trailing prose becomes PART of the command, not separate text), and
  that it must run before/doesn't corrupt the other mention regexes.
- `retrieval.ts`: extend `retrieval.test.ts` with `formatTerminal` and the
  widened `buildContextMessage`'s five-section ordering.
- `contextEngine.ts`: extension-layer, VS Code-API-dependent — no unit
  tests, verified by `npm run typecheck -w xpreiIDE-ai` +
  `npm run compile -w xpreiIDE-ai`, plus a manual smoke test: send
  `@terminal:npm test` in this repo, confirm the confirmation dialog
  appears and accepting runs it with output captured; decline the dialog
  and confirm silent no-op; run a command that exits non-zero and confirm
  its output (not just success cases) is captured; run a command with
  a space in it and confirm it isn't truncated to the first word.
