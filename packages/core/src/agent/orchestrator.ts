// Agent orchestrator — the "complete your project" loop.
//
//   build messages → stream one step → parse action
//     → tool:  approval gate (mutating only) → execute → observe → loop
//     → final: report summary and stop
//
// Decoupled from the UI: emits typed events and asks an Approver for consent, so
// it runs headless in tests with a fake provider/host/approver.

import { ChatMessage, Provider } from "../providers/provider";
import { Checkpoint } from "./checkpoint";
import { AgentHost } from "./host";
import { PendingEdit, PendingEditOverlay } from "./pendingEditOverlay";
import { Action, buildAgentSystemPrompt, parseAction } from "./protocol";
import { Tool, TOOLS } from "./tools";

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
  // Fired once at end-of-run (final or maxSteps exhaustion) when file
  // edits are still pending: the host UI shows a batch review and
  // resolves per-file decisions. Optional — when absent, every pending
  // edit is accepted (keeps headless tests and the sidecar unchanged).
  onBatch?(entries: PendingEdit[]): Promise<BatchDecision[]>;
}

export interface BatchDecision {
  path: string;
  accept: boolean;
}

export interface Approver {
  // Resolve true to run the mutating tool, false to skip it.
  approve(tool: Tool, args: Record<string, unknown>): Promise<boolean>;
}

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

const DEFAULT_MAX_STEPS = 0; // 0 = unlimited (bounded only by Stop/abort or the model finishing)
const DEFAULT_PROTOCOL_RETRIES = 2;

export class Agent {
  private readonly tools: Tool[];
  readonly checkpoint: Checkpoint;

  constructor(private readonly deps: AgentDeps) {
    this.tools = deps.tools ?? TOOLS;
    this.checkpoint = new Checkpoint(deps.host);
  }

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
    // Fresh overlay per run: file writes buffer here and land on disk
    // only at a pre-terminal flush or the end-of-run batch review.
    const overlay = new PendingEditOverlay(this.deps.host);

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
          const attemptWord = protocolFailures === 1 ? "attempt" : "attempts";
          this.deps.events.onError(
            `Model did not return a valid response after ${protocolFailures} ${attemptWord} ` +
              `(${action.reason}). Try a different/larger model, or raise xpreiIDE.agent.protocolRetries.\n` +
              `Last reply: ${raw.slice(0, 300)}`,
          );
          return;
        }
        this.deps.events.onProtocolError?.(protocolFailures, protocolRetries + 1, action.reason);
        messages.push({ role: "user", content: `Protocol error: ${action.reason}` });
        continue;
      }
      protocolFailures = 0;

      if (action.kind === "final") {
        await this.settleBatch(overlay);
        this.deps.events.onFinal(action.text);
        return;
      }

      const observation = await this.runTool(action, overlay);
      this.deps.events.onObservation(observation);
      // Feed the result back as the next user turn (universal across models;
      // avoids relying on a "tool" role many OSS backends ignore).
      messages.push({ role: "user", content: `Observation:\n${observation}` });
    }

    await this.settleBatch(overlay);
    this.deps.events.onFinal(
      `Stopped after ${maxSteps} steps without finishing. Refine the task or raise xpreiIDE.agent.maxSteps.`,
    );
  }

  private async runTool(
    action: Extract<Action, { kind: "tool" }>,
    overlay: PendingEditOverlay,
  ): Promise<string> {
    const tool = this.tools.find((t) => t.name === action.tool);
    if (!tool) {
      return `Error: unknown tool "${action.tool}". Available: ${this.tools
        .map((t) => t.name)
        .join(", ")}.`;
    }
    this.deps.events.onTool(tool.name, action.args);

    // Tools that touch the real world outside the AgentHost seam must
    // see consistent real files — flush pending edits first. These edits
    // were each already individually approved at their own step; only
    // the write was deferred. (run_terminal per the spec; mcp__* is a
    // deliberate extension for the same reason.)
    let flushWarning: string | undefined;
    if (tool.name === "run_terminal" || tool.name.startsWith("mcp__")) {
      flushWarning = await this.flushPending(overlay);
    }

    if (tool.mutating) {
      const ok = await this.deps.approver.approve(tool, action.args);
      if (!ok) return "User rejected this action. Choose a different step.";
    }

    try {
      const result = await tool.run(action.args, overlay);
      return flushWarning ? `${flushWarning}\n${result.observation}` : result.observation;
    } catch (err) {
      return `Error running ${tool.name}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // Checkpoint-note + flush every pending edit (pre-terminal/MCP flush
  // site). Returns a warning line when any entry failed to write, else
  // undefined. note() reads the REAL host, which the buffered write
  // hasn't touched yet, so noting here still captures pre-run content
  // (first-snapshot-wins makes repeats harmless).
  private async flushPending(overlay: PendingEditOverlay): Promise<string | undefined> {
    const pending = overlay.pending;
    if (pending.length === 0) return undefined;
    for (const e of pending) await this.checkpoint.note(e.path);
    const { flushed, failed } = await overlay.flush();
    for (const f of flushed) this.deps.events.onEdit?.(f.path, f.before, f.after);
    if (failed.length > 0) {
      return `Warning: failed to write pending edit(s): ${failed
        .map((f) => `${f.path} (${f.error})`)
        .join(", ")}`;
    }
    return undefined;
  }

  // End-of-run batch review: ask onBatch (or accept everything when the
  // host doesn't implement it), then flush accepted entries and discard
  // rejected ones. Paths missing from the decisions are treated as
  // rejected (defensive).
  private async settleBatch(overlay: PendingEditOverlay): Promise<void> {
    const pending = overlay.pending;
    if (pending.length === 0) return;
    const decisions = this.deps.events.onBatch
      ? await this.deps.events.onBatch(pending)
      : pending.map((e) => ({ path: e.path, accept: true }));
    const accepted = new Set(decisions.filter((d) => d.accept).map((d) => d.path));
    for (const entry of pending) {
      if (!accepted.has(entry.path)) {
        overlay.discard(entry.path);
        continue;
      }
      await this.checkpoint.note(entry.path);
      const { flushed, failed } = await overlay.flush(entry.path);
      for (const f of flushed) this.deps.events.onEdit?.(f.path, f.before, f.after);
      if (failed.length > 0) {
        this.deps.events.onError(
          `Failed to write accepted edit(s): ${failed.map((f) => `${f.path} (${f.error})`).join(", ")}`,
        );
      }
    }
  }

  private async streamStep(messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
    let out = "";
    for await (const chunk of this.deps.provider.chatStream({
      model: this.deps.model,
      messages,
      signal,
    })) {
      out += chunk.delta;
      if (chunk.done) break;
    }
    return out;
  }
}
