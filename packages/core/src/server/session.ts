// SidecarSession — transport-agnostic JSON-RPC handler that exposes the core
// (chat streaming + the agent loop) to a host process. The stdio wrapper
// (./stdio.ts) feeds it parsed messages and writes whatever it emits; tests feed
// it directly with a fake provider. This is the contract the future JetBrains /
// Eclipse plugins speak instead of reimplementing the agent brain.
//
// Wire shape (line-delimited JSON):
//   client → server request:  { id, method, params }
//   server → client response: { id, result } | { id, error }
//   server → client event:    { method, params }   (no id — streaming notification)

import { ChatMessage, Provider } from "../providers/provider";
import { AgentHost } from "../agent/host";
import { NodeAgentHost } from "../host/nodeHost";
import { Agent, AgentEvents, Approver } from "../agent/orchestrator";
import { Checkpoint } from "../agent/checkpoint";
import { Tool, TOOLS } from "../agent/tools";

export interface ResolvedModel {
  provider: Provider;
  model: string;
}

export interface SessionDeps {
  // Push a response or streaming event to the client.
  emit: (msg: unknown) => void;
  // Resolve a model pointer ("providerId::model") to a live provider + model.
  // The stdio server builds this from the initialize config; tests inject a fake.
  resolveModel: (pointer: string) => ResolvedModel | undefined;
  // Build the agent's file/exec host for a workspace root. Defaults to NodeAgentHost.
  makeHost?: (root: string) => AgentHost;
}

interface Request {
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

const EDIT_MODE_TOOLS = TOOLS.filter((t) => t.name !== "run_terminal");

export class SidecarSession {
  private workspaceRoot = process.cwd();
  private readonly inflightChats = new Map<string, AbortController>();
  private readonly inflightAgents = new Map<string, AbortController>();
  private readonly pendingApprovals = new Map<string, (choice: string) => void>();
  private lastCheckpoint?: Checkpoint;
  private approvalSeq = 0;

  constructor(private readonly deps: SessionDeps) {}

  // Entry point: handle one parsed client message.
  async handle(msg: Request): Promise<void> {
    try {
      switch (msg.method) {
        case "initialize":
          return this.onInitialize(msg);
        case "chat.send":
          return await this.onChatSend(msg);
        case "chat.stop":
          return this.onChatStop(msg);
        case "agent.run":
          return await this.onAgentRun(msg);
        case "agent.approve":
          return this.onAgentApprove(msg);
        case "agent.stop":
          return this.onAgentStop(msg);
        case "agent.revert":
          return await this.onAgentRevert(msg);
        default:
          this.respondError(msg.id, `unknown method: ${msg.method}`);
      }
    } catch (err) {
      this.respondError(msg.id, err instanceof Error ? err.message : String(err));
    }
  }

  private onInitialize(msg: Request): void {
    const root = msg.params?.workspaceRoot;
    if (typeof root === "string" && root) this.workspaceRoot = root;
    this.respond(msg.id, {
      capabilities: { chat: true, agent: true, tools: TOOLS.map((t) => t.name) },
    });
  }

  private async onChatSend(msg: Request): Promise<void> {
    const requestId = String(msg.params?.requestId ?? msg.id ?? "");
    const pointer = String(msg.params?.model ?? "");
    const messages = (msg.params?.messages as ChatMessage[]) ?? [];
    const resolved = this.deps.resolveModel(pointer);
    if (!resolved) return this.respondError(msg.id, `unknown model: ${pointer}`);

    const ac = new AbortController();
    this.inflightChats.set(requestId, ac);
    this.respond(msg.id, { started: true });
    try {
      for await (const chunk of resolved.provider.chatStream({
        model: resolved.model,
        messages,
        signal: ac.signal,
      })) {
        if (chunk.delta) this.emit("chat.delta", { requestId, delta: chunk.delta });
        if (chunk.done) break;
      }
      this.emit("chat.done", { requestId });
    } catch (err) {
      this.emit("chat.error", { requestId, message: err instanceof Error ? err.message : String(err) });
    } finally {
      this.inflightChats.delete(requestId);
    }
  }

  private onChatStop(msg: Request): void {
    const requestId = String(msg.params?.requestId ?? "");
    this.inflightChats.get(requestId)?.abort();
    this.respond(msg.id, { stopped: true });
  }

  private async onAgentRun(msg: Request): Promise<void> {
    const requestId = String(msg.params?.requestId ?? msg.id ?? "");
    const task = String(msg.params?.task ?? "");
    const mode = msg.params?.mode === "edit" ? "edit" : "agent";
    const pointer = String(msg.params?.model ?? "");
    const projectRules = typeof msg.params?.projectRules === "string" ? msg.params.projectRules : undefined;
    const resolved = this.deps.resolveModel(pointer);
    if (!resolved) return this.respondError(msg.id, `unknown model: ${pointer}`);

    const host = (this.deps.makeHost ?? ((r) => new NodeAgentHost(r)))(this.workspaceRoot);
    const ac = new AbortController();
    this.inflightAgents.set(requestId, ac);

    const events: AgentEvents = {
      onStep: (n) => this.emit("agent.step", { requestId, n }),
      onThought: (text) => this.emit("agent.thought", { requestId, text }),
      onTool: (name, args) => this.emit("agent.tool", { requestId, name, args }),
      onObservation: (text) => this.emit("agent.observation", { requestId, text }),
      onFinal: (text) => this.emit("agent.final", { requestId, text }),
      onError: (text) => this.emit("agent.error", { requestId, text }),
      onEdit: (path, before, after) => this.emit("agent.edit", { requestId, path, before, after }),
    };

    const approver: Approver = {
      approve: (tool: Tool, args: Record<string, unknown>) =>
        this.requestApproval(requestId, tool.name, args),
    };

    const agent = new Agent({
      provider: resolved.provider,
      model: resolved.model,
      host,
      approver,
      events,
      tools: mode === "edit" ? EDIT_MODE_TOOLS : TOOLS,
      projectRules,
    });
    this.lastCheckpoint = agent.checkpoint;

    this.respond(msg.id, { started: true });
    try {
      await agent.run(task, ac.signal);
    } finally {
      this.inflightAgents.delete(requestId);
    }
  }

  // Emit an approval request and resolve once the client answers via agent.approve.
  private requestApproval(
    requestId: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<boolean> {
    const approvalId = `${requestId}:${this.approvalSeq++}`;
    return new Promise<boolean>((resolve) => {
      this.pendingApprovals.set(approvalId, (choice) => resolve(choice !== "reject"));
      this.emit("agent.approvalRequest", { requestId, approvalId, tool, args });
    });
  }

  private onAgentApprove(msg: Request): void {
    const approvalId = String(msg.params?.approvalId ?? "");
    const choice = String(msg.params?.choice ?? "approve");
    const pending = this.pendingApprovals.get(approvalId);
    if (pending) {
      this.pendingApprovals.delete(approvalId);
      pending(choice);
    }
    this.respond(msg.id, { ok: true });
  }

  private onAgentStop(msg: Request): void {
    const requestId = String(msg.params?.requestId ?? "");
    this.inflightAgents.get(requestId)?.abort();
    this.respond(msg.id, { stopped: true });
  }

  private async onAgentRevert(msg: Request): Promise<void> {
    if (!this.lastCheckpoint) return this.respondError(msg.id, "no agent run to revert");
    const touched = this.lastCheckpoint.touched.length;
    await this.lastCheckpoint.revert();
    this.respond(msg.id, { reverted: touched });
  }

  private respond(id: Request["id"], result: unknown): void {
    if (id !== undefined) this.deps.emit({ id, result });
  }
  private respondError(id: Request["id"], message: string): void {
    if (id !== undefined) this.deps.emit({ id, error: { message } });
  }
  private emit(method: string, params: unknown): void {
    this.deps.emit({ method, params });
  }
}
