// VS Code glue for the agent: wires a real host, a modal approval gate, and
// webview event forwarding around the headless Agent orchestrator.

import * as vscode from "vscode";
import { ProviderRegistry } from "../providers/registry";
import { Agent, AgentEvents, Approver } from "./orchestrator";
import { VscodeAgentHost } from "./host";
import { Checkpoint } from "./checkpoint";
import { Tool } from "./tools";

// Approver backed by a modal dialog. "Approve all" flips auto-approve for the
// rest of the run; a config default can pre-approve everything.
class ModalApprover implements Approver {
  private auto: boolean;
  constructor(autoDefault: boolean) {
    this.auto = autoDefault;
  }

  async approve(tool: Tool, args: Record<string, unknown>): Promise<boolean> {
    if (this.auto) return true;
    const detail = summarize(tool.name, args);
    const choice = await vscode.window.showWarningMessage(
      `Agent wants to run: ${tool.name}`,
      { modal: true, detail },
      "Approve",
      "Approve all",
    );
    if (choice === "Approve all") {
      this.auto = true;
      return true;
    }
    return choice === "Approve";
  }
}

function summarize(tool: string, args: Record<string, unknown>): string {
  if (tool === "run_terminal") return `$ ${String(args.command ?? "")}`;
  const path = typeof args.path === "string" ? args.path : "?";
  if (tool === "create_file") {
    const len = typeof args.content === "string" ? args.content.length : 0;
    return `Create ${path} (${len} bytes)`;
  }
  if (tool === "edit_file") {
    return args.find === undefined ? `Overwrite ${path}` : `Edit ${path}`;
  }
  return path;
}

export interface AgentRun {
  checkpoint: Checkpoint;
  done: Promise<void>;
}

// Start an agent run for `task`, forwarding events to `post` (webview channel).
// Returns the checkpoint (for revert) and a promise that settles when the run ends.
export async function runAgent(
  registry: ProviderRegistry,
  task: string,
  post: (msg: unknown) => void,
  signal: AbortSignal,
): Promise<AgentRun> {
  const resolved = await registry.resolveActive();
  if (!resolved) throw new Error("No model selected. Run 'xpreiIDE: Select Model' first.");

  const host = VscodeAgentHost.create();
  const autoApprove = vscode.workspace
    .getConfiguration("xpreiIDE")
    .get<boolean>("agent.autoApprove", false);
  const maxSteps = vscode.workspace
    .getConfiguration("xpreiIDE")
    .get<number>("agent.maxSteps", 20);

  const events: AgentEvents = {
    onStep: (n) => post({ type: "agent", kind: "step", n }),
    onThought: (t) => post({ type: "agent", kind: "thought", text: t }),
    onTool: (name, args) => post({ type: "agent", kind: "tool", text: summarize(name, args), name }),
    onObservation: (t) => post({ type: "agent", kind: "observation", text: t }),
    onFinal: (t) => post({ type: "agent", kind: "final", text: t }),
    onError: (t) => post({ type: "agent", kind: "error", text: t }),
  };

  const agent = new Agent({
    provider: resolved.provider,
    model: resolved.model,
    host,
    approver: new ModalApprover(autoApprove),
    events,
    maxSteps,
  });

  const done = agent.run(task, signal);
  return { checkpoint: agent.checkpoint, done };
}
