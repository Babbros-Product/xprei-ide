# Feature roadmap — post-P5 additions

Date: 2026-07-25

## Context

Following a Continue.dev architecture/feature survey (see conversation history
— no code was read or copied, only their README and directory/file names;
naming is xprei-branded throughout, e.g. `.xpreiignore` not
`.continueignore`) plus the "local LLM support is core to the product"
priority, this is the sequenced backlog of everything identified as worth
building. Confirmed compatible with Ollama/local-model support throughout —
none of these require native function-calling; everything routes through the
existing universal prompt-based JSON tool protocol
(`packages/core/src/agent/protocol.ts`), the same mechanism `read_file`/
`grep`/etc. already use.

Each phase gets its own brainstorm → design spec → implementation plan →
subagent-driven-development cycle when work on it starts (same process used
for `diff-preview-before-apply` and `weak-model-protocol-retry` — see
`docs/superpowers/specs/`). This document is the sequencing and rationale,
not the implementation detail.

## Two nuances that shape the ordering below

1. **Context-window budgeting doesn't exist yet.** `Provider.capabilities.
   contextWindow` is already modeled (`packages/core/src/providers/
   provider.ts:31`) and set per-adapter — Ollama defaults to `8192`
   (`ollama.ts:30`), OpenAI-compatible to `128000` (`openai-compat.ts:25`)
   — but nothing in the codebase reads it to size injected context. Every
   richer-context feature below (repo-map, `@terminal`, `@diff`, etc.) makes
   this gap worse the more context it adds; a small local model's window
   overflows far sooner than a hosted model's. This needs building **before**
   the context-provider phase, not discovered as a bug after.
2. **Weak local models handle complex tool-call JSON less reliably.**
   `multi_edit` (multiple find/replace pairs in one call) is more failure-prone
   for a small model than our existing single-edit tools. The just-shipped
   protocol-retry feature (`xpreiIDE.agent.protocolRetries`) already
   mitigates the "invalid JSON envelope" failure class; `multi_edit` is safe
   to build now precisely because that safety net exists.

## Phases

### Phase 1 — Quick agent-tool wins
**Scope: small. No dependencies.**

- `read_file_range` tool — read a line range instead of a whole file.
  Token-efficiency win, most valuable on small-context local models.
- `glob_search` tool — glob-based file finding, complements `grep`/`list_dir`.
- `view_diff` tool — surface the current git diff as agent context.

All three are additive entries in `packages/core/src/agent/tools.ts`, each
independently testable the same way existing tools are
(`packages/core/src/agent/tools.test.ts`), each reached through the existing
`AgentHost` seam so no host-specific work is needed.

### Phase 1b — user-editable ignore file
**Scope: medium (NOT a quick win — see below). No dependencies.**

A user-editable `.gitignore`-syntax ignore file for the RAG indexer,
replacing the hardcoded dir list in `packages/core/src/context/exclude.ts`.
Fixes an already-logged gap in `CLAUDE.md` ("Indexer uses an exclude-glob,
not true `.gitignore` parsing").

Originally grouped into Phase 1 as a fourth "quick win"; separated after a
codebase check showed it is materially bigger than the three tool additions
and shares none of their shape:

- **`SCAN_EXCLUDE` is a single static glob string** (`exclude.ts:21`)
  consumed directly by `vscode.workspace.findFiles()`
  (`contextEngine.ts:75,171`). Real `.gitignore` semantics — negation (`!`),
  anchoring, nested ignore files, precedence — cannot be expressed as one
  static glob. Either the findFiles fast path is dropped, or the design is
  a hybrid: coarse glob for the scan, precise per-path filter after.
- **`exclude.ts` is deliberately pure** (vscode-free, in `@xprei/core`) and
  has consumers on *both* sides of the seam: `nodeHost.ts:93` (core, for
  the sidecar's grep) and `contextEngine.ts:129` (VS Code). Reading a file
  is I/O, which that module currently has none of. The likely shape is a
  pure parse/match function that takes file *contents*, with each host doing
  its own read — mirroring how `.xpreiIDErules` is handled today
  (`extensions/vscode/src/context/projectRules.ts`, VS Code-side I/O only).
- **Cache invalidation** — the parsed ignore rules need refreshing when the
  file itself changes, which the current constant-array design never had to
  consider.

**Open decision — filename.** The shipped project-instructions dotfile is
`.xpreiIDErules`. A matching `.xpreiIDEignore` keeps that convention;
`.xpreiignore` (the name used when this was first proposed) breaks it and
also collides awkwardly on the doubled `i` (`xprei` + `ignore`). Decide
before implementation — renaming a user-facing dotfile after release is a
breaking change.

### Phase 2 — Local-first core UX
**Scope: medium. No dependency on Phase 1 or 1b — those are agent-tool and
indexer work respectively, this is provider/settings work touching a
different part of the codebase entirely. Sequenced here on priority
("local LLM support is core"), not on any technical ordering constraint;
could run before Phase 1 if preferred.**

- **Local model auto-discovery** — on first activation, detect a running
  Ollama daemon at the default port and its installed models, offer
  one-click setup instead of requiring manual Add Provider. Zero-config
  onboarding for the flagship local-first path.
- **Per-role models** — separate model selection for chat vs. completions
  vs. agent vs. embeddings, so a small fast local model can drive
  completions while a larger one drives chat/agent. Already flagged as
  open in `CLAUDE.md`'s P5 status.

These were the other two items (alongside weak-model handling, already
shipped) from the original local-first trio — prioritized early per your
explicit "local LLM support is core" direction, ahead of the
Continue-derived breadth items.

### Phase 3 — Context-window budgeting (infrastructure)
**Scope: small-medium. Blocks Phase 4.**

A pure utility in `@xprei/core` that sizes an injected context block against
`provider.capabilities.contextWindow` — truncating/prioritizing rather than
blindly concatenating. Consumed by `context/contextEngine.ts`'s existing
`buildContext()` path today (retrofit) and by every new context provider in
Phase 4. No user-facing feature on its own; a foundation phase, like Phase 0
of the multi-IDE plan.

### Phase 4 — Richer context providers
**Scope: medium-large. Depends on Phase 3.**

New `@`-mention providers alongside the existing `@codebase`/`@file`:
`@terminal` (recent terminal output), `@problems` (diagnostics), `@diff`
(git diff), `@open` (currently open files), `@url` (fetch a URL), and a
repo-map (aider-style architecture overview). Each is a context-block
builder consumed the same way `retrieval.ts`'s existing formatters are —
model-agnostic, but each must run through Phase 3's budgeting before
injection.

### Phase 5 — `multi_edit` tool
**Scope: small-medium. Depends on Phase 1 for tool-registration conventions
already established; benefits from the already-shipped protocol-retry
safety net (see nuance #2 above).**

Batch multiple find/replace edits into one tool call instead of
one-edit-per-step. Connects to the approved-but-unimplemented
`diff-preview-before-apply` design
(`docs/superpowers/specs/2026-07-24-diff-preview-before-apply-design.md`) —
worth sequencing consideration against that spec when this phase starts,
since a batched-edit tool and a batched-preview UI are complementary.

### Phase 6 — Shared YAML config format
**Scope: large. Cross-cutting — touches VS Code, and the (currently
uncompiled) IntelliJ/Eclipse plugin scaffolds.**

One config schema/parser (new `@xprei/core` module) reused across all three
hosts, replacing three independent implementations of the same
provider-list concept that exist today: VS Code's `xpreiIDE.providers`
setting, `extensions/JetBrains/.../XpreiSettingsState.kt`, and
`extensions/eclipse/.../XpreiSettings.java`. Sequenced before Phase 7
because MCP server definitions (command, args, env) need a sane config home
across all three hosts too — better to land the shared format once than
build MCP config storage on VS Code settings JSON and then migrate it.

### Phase 7 — MCP support
**Scope: large. Depends on Phase 6 for config storage. Highest strategic
value of the remaining backlog.**

MCP servers as both a context-provider source and a tool source. Because
tool-calling here is entirely prompt-based JSON (not native function-calling),
MCP tools get exposed to the model through the exact same mechanism as
`read_file`/`grep`/the Phase 1 tools — usable even by a small local model,
which is not guaranteed true of MCP integrations built on native
function-calling elsewhere. This is the single biggest gap versus the
current AI-assistant ecosystem norm.

### Phase 8 — True FIM autocomplete
**Scope: medium. Ollama-specific quality win — depends on nothing above,
sequenced late because it's an existing-feature *upgrade* (ghost-text
completions already ship) rather than new capability, and because it needs
the per-provider capability-detection groundwork that's easier to reason
about once Phase 6's config work has landed.**

Ollama natively supports fill-in-the-middle via `/api/generate`'s `suffix`
param on FIM-capable models (codellama, deepseek-coder, qwen2.5-coder,
etc.) — genuinely better completion quality on local code models than the
current `chatStream`-based hack (`completion/inlineCompletionProvider.ts`).
Needs per-model capability detection (does this provider/model support real
FIM) with a fallback to the existing chat-based approach where it doesn't.

### Phase 9 — CLI extension
**Scope: large. New host entirely — sequenced last because it benefits
most from everything above being stable (shared config, MCP, richer
context) rather than being built against a moving target.**

`extensions/cli`, mirroring Continue's shape: headless usage of the same
`@xprei/core` sidecar, useful for CI or no-IDE workflows. Reuses the
sidecar almost as-is (`packages/core/src/server/session.ts` /
`sidecarBundle.test.ts` already prove it runs standalone via plain `node`).

## Explicitly out of scope (from the original survey)

Continue's cloud/hub config-sharing and telemetry layers — doesn't fit the
local-first/BYO-model philosophy this product is built on.

## Working through this list

Each phase starts with `Skill(superpowers:brainstorming)` the same way the
two features already shipped did — this document fixes the *order* and the
*why*, not the per-phase implementation choices, which still need their own
design pass (approaches, tradeoffs, your approval) before any code gets
written.
