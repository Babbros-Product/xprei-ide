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
import { Action, buildAgentSystemPrompt, parseAction } from "./protocol";
import { Tool, TOOLS, toolByName } from "./tools";

export interface AgentEvents {
  onStep(n: number): void;
  onThought(text: string): void;
  onTool(name: string, args: Record<string, unknown>): void;
  onObservation(text: string): void;
  onFinal(text: string): void;
  onError(text: string): void;
  // Fired after a mutating tool successfully writes a file — before/after
  // content for editor-side feedback (e.g. a gutter flash). Optional so
  // headless/test callers don't need to implement it.
  onEdit?(path: string, before: string, after: string): void;
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
  // Extra project-level instructions (from .xpreiIDErules) appended to the
  // system prompt, verbatim.
  projectRules?: string;
}

const DEFAULT_MAX_STEPS = 0; // 0 = unlimited (bounded only by Stop/abort or the model finishing)

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

      if (action.kind === "final") {
        this.deps.events.onFinal(action.text);
        return;
      }

      if (action.kind === "protocolError") {
        const observation = action.reason;
        this.deps.events.onObservation(observation);
        messages.push({ role: "user", content: `Observation:\n${observation}` });
        continue;
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

  private async runTool(action: Extract<Action, { kind: "tool" }>): Promise<string> {
    const tool = toolByName(action.tool);
    if (!tool || !this.tools.includes(tool)) {
      return `Error: unknown tool "${action.tool}". Available: ${this.tools
        .map((t) => t.name)
        .join(", ")}.`;
    }
    this.deps.events.onTool(tool.name, action.args);

    if (tool.mutating) {
      const ok = await this.deps.approver.approve(tool, action.args);
      if (!ok) return "User rejected this action. Choose a different step.";
      // Snapshot the target path before the write so the run stays revertible
      // — also the "before" half of the post-write diff for editor feedback.
      const path = typeof action.args.path === "string" ? action.args.path : undefined;
      if (path) await this.checkpoint.note(path);
    }

    try {
      const result = await tool.run(action.args, this.deps.host);
      if (tool.mutating && result.wrote && this.deps.events.onEdit) {
        const before = this.checkpoint.getSnapshot(result.wrote)?.content ?? "";
        const after = await this.deps.host.readFile(result.wrote).catch(() => "");
        this.deps.events.onEdit(result.wrote, before, after);
      }
      return result.observation;
    } catch (err) {
      return `Error running ${tool.name}: ${err instanceof Error ? err.message : String(err)}`;
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
