// VS Code glue for the agent: wires a real host, a chat-inline approval gate,
// and webview event forwarding around the headless Agent orchestrator.

import * as vscode from "vscode";
import { ProviderRegistry } from "../providers/registry";
import { Agent, AgentEvents, Approver } from "@xprei/core";
import { VscodeAgentHost } from "./host";
import { Checkpoint } from "@xprei/core";
import { Tool, TOOLS } from "@xprei/core";
import { flashAgentEdit } from "./editDecorations";

export type AgentMode = "edit" | "agent";
export type ApprovalChoice = "approve" | "approve-all" | "reject";
export interface ApprovalDiff {
  before?: string;
  after?: string;
}
export type RequestApproval = (
  tool: string,
  summary: string,
  diff?: ApprovalDiff,
) => Promise<ApprovalChoice>;

// Edit mode drops shell access — file read/create/edit tools only, no
// run_terminal — so "Edit" can't run arbitrary commands, only "Agent" can.
const EDIT_MODE_TOOLS = TOOLS.filter((t) => t.name !== "run_terminal");

// Approver backed by an inline chat-transcript prompt (Copilot/Claude-chat
// style) instead of a blocking native modal. "Approve all" flips auto-approve
// for the rest of the run; a config default can pre-approve everything.
class ChatApprover implements Approver {
  private auto: boolean;
  constructor(
    autoDefault: boolean,
    private readonly ask: RequestApproval,
  ) {
    this.auto = autoDefault;
  }

  async approve(tool: Tool, args: Record<string, unknown>): Promise<boolean> {
    if (this.auto) return true;
    const summary = summarize(tool.name, args);
    const diff = buildDiffPreview(tool.name, args);
    const choice = await this.ask(tool.name, summary, diff);
    if (choice === "approve-all") {
      this.auto = true;
      return true;
    }
    return choice === "approve";
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

const MAX_PREVIEW = 800;
function clip(s: string): string {
  return s.length > MAX_PREVIEW ? s.slice(0, MAX_PREVIEW) + "\n… (truncated)" : s;
}

// find/replace on edit_file (and content on create_file) already ARE a diff
// — no need to read the file back to build the approval preview.
function buildDiffPreview(tool: string, args: Record<string, unknown>): ApprovalDiff | undefined {
  if (tool === "create_file") {
    const content = typeof args.content === "string" ? args.content : "";
    return { after: clip(content) };
  }
  if (tool === "edit_file") {
    const find = typeof args.find === "string" ? args.find : undefined;
    const replace = typeof args.replace === "string" ? args.replace : "";
    return find === undefined ? { after: clip(replace) } : { before: clip(find), after: clip(replace) };
  }
  return undefined;
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
  mode: AgentMode = "agent",
  requestApproval: RequestApproval,
  projectRules?: string,
): Promise<AgentRun> {
  const resolved = await registry.resolveActive();
  if (!resolved) throw new Error("No model selected. Run 'xpreiIDE: Select Model' first.");

  const host = VscodeAgentHost.create();
  const autoApprove = vscode.workspace
    .getConfiguration("xpreiIDE")
    .get<boolean>("agent.autoApprove", false);
  const maxSteps = vscode.workspace
    .getConfiguration("xpreiIDE")
    .get<number>("agent.maxSteps", 0);
  const protocolRetries = vscode.workspace
    .getConfiguration("xpreiIDE")
    .get<number>("agent.protocolRetries", 2);

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

  const done = agent.run(task, signal);
  return { checkpoint: agent.checkpoint, done };
}
