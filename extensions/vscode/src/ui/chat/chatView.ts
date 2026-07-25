// Chat sidebar. A WebviewViewProvider that renders the chat UI and bridges
// user messages to the active provider's streaming API.

import * as vscode from "vscode";
import { Checkpoint } from "@xprei/core";
import { AgentMode, ApprovalChoice, ApprovalDiff, runAgent } from "../../agent/runner";
import { ContextEngine } from "../../context/contextEngine";
import { parseMentions } from "@xprei/core";
import { ChatMessage, isAbortError, ProviderConfig } from "@xprei/core";
import { ProviderRegistry } from "../../providers/registry";
import { uniqueProviderId } from "@xprei/core";
import { loadProjectRules } from "../../context/projectRules";

// Plan mode has no file-editing tools at all (plain chat), so the model is
// told explicitly not to claim it changed anything — Edit/Agent modes get
// their tool list (and its description) straight from the agent loop.
const PLAN_SYSTEM_PROMPT =
  "You are xpreiIDE in Plan mode: a concise coding assistant embedded in the " +
  "user's IDE. Analyze and propose an approach in prose or code snippets. " +
  "You have no file-editing tools in this mode — never claim to have created " +
  "or modified a file; suggest switching to Edit or Agent mode for that.";

export type QuickActionKind = "explain" | "fix" | "tests" | "comments" | "refactor";

const QUICK_ACTION_INSTRUCTIONS: Record<QuickActionKind, string> = {
  explain: "Explain this code.",
  fix: "Find and fix the bug(s) in this code. Show the corrected code and explain the fix.",
  tests: "Write unit tests for this code, covering the main cases and edge cases.",
  comments: "Add clear, concise comments to this code explaining non-obvious parts. Show the commented version.",
  refactor: "Refactor this code for clarity and maintainability, without changing its behavior. Show the refactored version and explain the changes.",
};

function buildQuickActionPrompt(kind: QuickActionKind, code: string, languageId: string): string {
  return `${QUICK_ACTION_INSTRUCTIONS[kind]}\n\n\`\`\`${languageId}\n${code}\n\`\`\``;
}

function slugify(label: string, fallback: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || fallback;
}

// Named chat sessions (Plan-mode history only — agent runs are transcript-only
// and were never persisted across reloads even before sessions existed).
const SESSIONS_KEY = "xpreiIDE.chatSessions";
const SESSION_TITLE_LEN = 48;

interface StoredSession {
  id: string;
  title: string;
  history: ChatMessage[];
  updatedAt: number;
}

function makeSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function newSession(): StoredSession {
  return { id: makeSessionId(), title: "New chat", history: [], updatedAt: Date.now() };
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "xpreiIDE.chat";

  private view?: vscode.WebviewView;
  private history: ChatMessage[] = [];
  private inflight?: AbortController;
  private lastCheckpoint?: Checkpoint;
  private pendingApproval?: (choice: ApprovalChoice) => void;
  private webviewReady = false;
  private pendingSeed?: string;
  private sessions: StoredSession[];
  private currentSessionId: string;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly registry: ProviderRegistry,
    private readonly context: ContextEngine,
    private readonly workspaceState: vscode.Memento,
  ) {
    this.sessions = this.workspaceState.get<StoredSession[]>(SESSIONS_KEY, []);
    if (this.sessions.length === 0) this.sessions.push(newSession());
    this.currentSessionId = this.sessions[this.sessions.length - 1].id;
    this.history = [...this.currentSession().history];
  }

  private currentSession(): StoredSession {
    return this.sessions.find((s) => s.id === this.currentSessionId) ?? this.sessions[0];
  }

  private persistSessions(): void {
    void this.workspaceState.update(SESSIONS_KEY, this.sessions);
  }

  // Snapshot `this.history` into the current session record and persist —
  // called at the natural end of every mutation to `this.history`.
  private saveCurrentSession(): void {
    const s = this.currentSession();
    s.history = this.history;
    s.updatedAt = Date.now();
    if (s.title === "New chat") {
      const firstUser = this.history.find((m) => m.role === "user");
      if (firstUser) s.title = firstUser.content.slice(0, SESSION_TITLE_LEN);
    }
    this.persistSessions();
  }

  private async sendSessions(): Promise<void> {
    const items = [...this.sessions]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => ({ id: s.id, title: s.title, active: s.id === this.currentSessionId }));
    this.post({ type: "sessions", items });
  }

  private startNewSession(): void {
    if (this.inflight) return;
    const s = newSession();
    this.sessions.push(s);
    this.currentSessionId = s.id;
    this.history = [];
    this.persistSessions();
    this.post({ type: "clearTranscript" });
    void this.sendSessions();
  }

  private switchSession(id: string): void {
    if (this.inflight || id === this.currentSessionId) return;
    const s = this.sessions.find((x) => x.id === id);
    if (!s) return;
    this.currentSessionId = id;
    this.history = [...s.history];
    this.post({ type: "clearTranscript" });
    this.rehydrate();
    void this.sendSessions();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === "send") {
        const mode = msg.mode === "edit" || msg.mode === "agent" ? msg.mode : "plan";
        if (mode === "plan") void this.onSend(String(msg.text ?? ""));
        else void this.onAgent(String(msg.text ?? ""), mode);
      } else if (msg?.type === "stop") this.inflight?.abort();
      else if (msg?.type === "reset") {
        this.history = [];
        this.saveCurrentSession();
      } else if (msg?.type === "ready") {
        this.webviewReady = true;
        this.rehydrate();
        void this.sendModels();
        void this.sendSessions();
        if (this.pendingSeed !== undefined) {
          this.post({ type: "seed", text: this.pendingSeed });
          this.pendingSeed = undefined;
        }
      } else if (msg?.type === "newChat") this.startNewSession();
      else if (msg?.type === "switchSession") this.switchSession(String(msg.id ?? ""));
      else if (msg?.type === "selectModel") void this.onSelectModel(String(msg.pointer ?? ""));
      else if (msg?.type === "getProviders") void this.sendProviders();
      else if (msg?.type === "saveProvider") void this.onSaveProvider(msg.cfg, String(msg.apiKey ?? ""));
      else if (msg?.type === "removeProvider") void this.onRemoveProvider(String(msg.id ?? ""));
      else if (msg?.type === "approvalResponse") {
        this.pendingApproval?.(msg.choice === "approve-all" || msg.choice === "reject" ? msg.choice : "approve");
        this.pendingApproval = undefined;
      } else if (msg?.type === "copyToClipboard") void vscode.env.clipboard.writeText(String(msg.text ?? ""));
      else if (msg?.type === "insertAtCursor") void insertAtCursor(String(msg.text ?? ""), false);
      else if (msg?.type === "applyEdit") void insertAtCursor(String(msg.text ?? ""), true);
      else if (msg?.type === "editLastUser") this.truncateLastUserTurn();
      else if (msg?.type === "regenerate") void this.regenerate();
    });
  }

  // Drop the last Plan-mode exchange (assistant reply + the user turn that
  // triggered it) so a resent/edited version doesn't double up in history.
  private truncateLastUserTurn(): void {
    if (this.history[this.history.length - 1]?.role === "assistant") this.history.pop();
    if (this.history[this.history.length - 1]?.role === "user") this.history.pop();
    this.saveCurrentSession();
  }

  // "Regenerate": drop the last assistant reply and re-run onSend with the
  // same user text, producing a fresh streamed answer.
  private async regenerate(): Promise<void> {
    if (this.inflight) return;
    if (this.history[this.history.length - 1]?.role === "assistant") this.history.pop();
    const prior = this.history[this.history.length - 1];
    if (prior?.role !== "user") return;
    this.history.pop();
    await this.onSend(prior.content);
  }

  // Ask the chat webview (not a native modal) to approve a mutating tool
  // call — renders inline as part of the transcript, Copilot/Claude-chat
  // style, with a before/after diff preview when the tool provides one.
  private requestApproval(tool: string, summary: string, diff?: ApprovalDiff): Promise<ApprovalChoice> {
    return new Promise((resolve) => {
      this.pendingApproval = resolve;
      this.post({
        type: "agent",
        kind: "approval",
        tool,
        text: summary,
        before: diff?.before,
        after: diff?.after,
      });
    });
  }

  // Replay stored turns after the webview (re)loads, so a hidden-then-shown
  // panel matches the extension-side history instead of coming back blank.
  private rehydrate(): void {
    for (const m of this.history) {
      if (m.role === "user" || m.role === "assistant") {
        this.post({ type: "restore", role: m.role, text: m.content });
      }
    }
  }

  // Push the current cross-provider model list to the webview, e.g. on load
  // or after a selection/add-provider round trip changes what's available.
  private async sendModels(): Promise<void> {
    const items = await this.registry.listAllModels();
    this.post({ type: "models", items });
  }

  private async onSelectModel(pointer: string): Promise<void> {
    if (!pointer) return;
    await vscode.workspace
      .getConfiguration("xpreiIDE")
      .update("activeModel", pointer, vscode.ConfigurationTarget.Global);
    await this.sendModels();
  }

  // Push the full provider config list (no secrets) to the settings panel.
  private async sendProviders(): Promise<void> {
    this.post({ type: "providers", items: this.registry.getConfigs() });
  }

  // Settings-panel "Save provider": validate, assign a unique id, persist
  // the config, store the key (if any), then refresh both panels.
  private async onSaveProvider(
    rawCfg: unknown,
    apiKey: string,
  ): Promise<void> {
    const cfg = rawCfg as Partial<ProviderConfig> | undefined;
    const kind = cfg?.kind === "ollama" ? "ollama" : "openai-compat";
    const label = String(cfg?.label ?? "").trim();
    const baseUrl = String(cfg?.baseUrl ?? "").trim();
    const model = String(cfg?.model ?? "").trim();
    if (!baseUrl) {
      this.post({ type: "error", text: "Provider needs a base URL." });
      return;
    }

    const existing = this.registry.getConfigs();
    const id = uniqueProviderId(
      slugify(label, kind),
      existing.map((c) => c.id),
    );
    const finalLabel = label || id;

    await this.registry.addConfig({
      id,
      kind,
      label: finalLabel,
      baseUrl,
      ...(model ? { model } : {}),
    });
    if (kind === "openai-compat" && apiKey) {
      await this.registry.setApiKey(id, apiKey);
    }

    this.post({ type: "info", text: `Added provider ${finalLabel}.` });
    await this.sendProviders();
    await this.sendModels();
  }

  private async onRemoveProvider(id: string): Promise<void> {
    if (!id) return;
    await this.registry.removeConfig(id);
    await this.sendProviders();
    await this.sendModels();
  }

  private post(msg: unknown): void {
    void this.view?.webview.postMessage(msg);
  }

  private async onSend(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    // Reject overlapping sends; one stream at a time keeps history consistent.
    if (this.inflight) return;

    const resolved = await this.registry.resolveActive();
    if (!resolved) {
      this.post({
        type: "error",
        text: "No model selected. Run 'xpreiIDE: Select Model' first.",
      });
      return;
    }

    this.history.push({ role: "user", content: trimmed });

    // Resolve @codebase / @file mentions into a context block. Failures here
    // (e.g. embed model unset) degrade gracefully to a plain chat.
    let contextBlock = "";
    try {
      contextBlock = await this.context.buildContext(parseMentions(trimmed));
    } catch (err) {
      this.post({ type: "info", text: `Context skipped: ${errText(err)}` });
    }

    this.post({ type: "start" });

    const rules = await loadProjectRules();
    const messages: ChatMessage[] = [
      { role: "system", content: PLAN_SYSTEM_PROMPT },
      ...(rules ? [{ role: "system" as const, content: `Project instructions:\n${rules}` }] : []),
      ...(contextBlock ? [{ role: "system" as const, content: contextBlock }] : []),
      ...this.history,
    ];

    this.inflight = new AbortController();
    let assistant = "";
    try {
      for await (const chunk of resolved.provider.chatStream({
        model: resolved.model,
        messages,
        signal: this.inflight.signal,
      })) {
        if (chunk.delta) {
          assistant += chunk.delta;
          this.post({ type: "delta", text: chunk.delta });
        }
        if (chunk.done) break;
      }
      this.history.push({ role: "assistant", content: assistant });
      this.post({ type: "done" });
    } catch (err) {
      if (isAbortError(err)) {
        // User hit Stop: keep whatever streamed as a real turn, end cleanly.
        this.history.push({ role: "assistant", content: assistant });
        this.post({ type: "done" });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        // Roll back the user turn so a retry doesn't double-send.
        this.history.pop();
        this.post({ type: "error", text: message });
      }
    } finally {
      this.inflight = undefined;
      this.saveCurrentSession();
    }
  }

  // Edit/Agent mode: run the tool loop for a task (Edit drops shell access).
  // Streams step/tool/observation events into the transcript; keeps a
  // checkpoint for revert.
  private async onAgent(text: string, mode: AgentMode): Promise<void> {
    const task = text.trim();
    if (!task || this.inflight) return;

    this.inflight = new AbortController();
    this.post({ type: "agent", kind: "start" });
    try {
      const rules = await loadProjectRules();
      const run = await runAgent(
        this.registry,
        task,
        (m) => this.post(m),
        this.inflight.signal,
        mode,
        (tool, summary, diff) => this.requestApproval(tool, summary, diff),
        rules,
      );
      this.lastCheckpoint = run.checkpoint;
      await run.done;
    } catch (err) {
      this.post({ type: "agent", kind: "error", text: errText(err) });
    } finally {
      this.post({ type: "agent", kind: "end" });
      this.inflight = undefined;
    }
  }

  // Right-click quick actions (Explain/Fix/Add Tests/Add Comments/Refactor):
  // reveal the chat panel and seed the composer with a prompt built from the
  // selection, auto-sent in Plan mode (Q&A, no direct edits — matches
  // Copilot/Claude-chat "quick action -> chat panel" behavior).
  async runQuickAction(kind: QuickActionKind, code: string, languageId: string): Promise<void> {
    await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
    const prompt = buildQuickActionPrompt(kind, code, languageId);
    if (this.webviewReady) this.post({ type: "seed", text: prompt });
    else this.pendingSeed = prompt;
  }

  // Inline chat (Ctrl+I): a free-typed prompt, optionally with the current
  // selection attached, seeded into the chat panel the same way.
  async askFreeform(prompt: string, code?: string, languageId?: string): Promise<void> {
    await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
    const text = code ? `${prompt}\n\n\`\`\`${languageId ?? ""}\n${code}\n\`\`\`` : prompt;
    if (this.webviewReady) this.post({ type: "seed", text });
    else this.pendingSeed = text;
  }

  // Undo the file changes from the most recent agent run.
  async revertLastRun(): Promise<void> {
    const cp = this.lastCheckpoint;
    if (!cp || cp.touched.length === 0) {
      vscode.window.showInformationMessage("No agent changes to revert.");
      return;
    }
    await cp.revert();
    this.lastCheckpoint = undefined;
    this.post({ type: "agent", kind: "observation", text: "Reverted agent changes." });
    vscode.window.showInformationMessage(`Reverted ${cp.touched.length} file(s).`);
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const bridgeUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "bridge.js"),
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "chat.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "chat.css"),
    );
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
</head>
<body>
  <div id="chatHeader" class="chatHeader">
    <span class="title">xpreiIDE</span>
    <div class="headerActions">
      <button type="button" id="newChatBtn" class="iconBtn" title="New chat" aria-label="New chat">+</button>
      <button type="button" id="historyBtn" class="iconBtn" title="Chat history" aria-label="Chat history">🕓</button>
      <button type="button" id="gearBtn" class="iconBtn" title="Model settings" aria-label="Model settings">⚙</button>
    </div>
  </div>
  <div id="historyPanel" class="settingsPanel hidden">
    <div class="settingsSection">
      <div class="settingsSectionTitle">Chats</div>
      <div id="sessionList" class="providerList"></div>
    </div>
  </div>
  <div id="settingsPanel" class="settingsPanel hidden">
    <div class="settingsSection">
      <div class="settingsSectionTitle">Providers</div>
      <div id="providerList" class="providerList"></div>
    </div>
    <div class="settingsSection">
      <div class="settingsSectionTitle">Add provider</div>
      <form id="addProviderForm" class="addProviderForm">
        <label class="field">
          <span>Kind</span>
          <select id="cfgKind" aria-label="Provider kind">
            <option value="openai-compat">OpenAI-compatible (OpenAI, Gemini, …)</option>
            <option value="ollama">Ollama (local)</option>
          </select>
        </label>
        <label class="field">
          <span>Label</span>
          <input id="cfgLabel" type="text" placeholder="e.g. OpenAI" />
        </label>
        <label class="field">
          <span>Base URL</span>
          <input id="cfgBaseUrl" type="text" placeholder="https://api.openai.com/v1" />
        </label>
        <label class="field">
          <span>Default model <em>(optional)</em></span>
          <input id="cfgModel" type="text" placeholder="e.g. gpt-4o-mini" />
        </label>
        <label class="field" id="cfgApiKeyField">
          <span>API key</span>
          <input id="cfgApiKey" type="password" placeholder="sk-…" autocomplete="off" />
        </label>
        <button type="submit" id="saveProviderBtn" class="primary">Save provider</button>
      </form>
    </div>
  </div>
  <div id="messages"></div>
  <form id="composer">
    <div class="inputWrap">
      <textarea id="input" rows="3" placeholder="Ask xpreiIDE…  (Enter to send, Shift+Enter for newline)"></textarea>
      <button type="submit" id="sendBtn" class="sendIconBtn" title="Send" aria-label="Send">➤</button>
    </div>
    <div class="row toolbarRow">
      <div class="modelPicker" id="modelPicker">
        <button type="button" id="modelTrigger" class="modelTrigger" aria-haspopup="listbox" aria-expanded="false" title="Select model">
          <span class="modelTriggerLabel" id="modelTriggerLabel">Select model</span>
          <span class="modelTriggerCaret" aria-hidden="true">▾</span>
        </button>
        <div class="modelPopup hidden" id="modelPopup" role="dialog" aria-label="Select model">
          <input type="text" id="modelSearch" class="modelSearch" placeholder="Search models…" aria-label="Search models" autocomplete="off" spellcheck="false" />
          <div class="modelList" id="modelList" role="listbox" aria-label="Models"></div>
        </div>
      </div>
      <button type="button" id="addModelBtn" class="iconBtn addModelBtn" title="Add provider" aria-label="Add provider">+</button>
      <div class="modeSelector" role="radiogroup" aria-label="Mode">
        <button type="button" class="modeBtn active" data-mode="plan">Plan</button>
        <button type="button" class="modeBtn" data-mode="edit">Edit</button>
        <button type="button" class="modeBtn" data-mode="agent">Agent</button>
      </div>
      <span class="spacer"></span>
      <button type="button" id="stopBtn" class="ghostBtn" disabled>Stop</button>
      <button type="button" id="resetBtn" class="ghostBtn">Reset</button>
    </div>
  </form>
  <script nonce="${nonce}" src="${bridgeUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

// "Insert" (at cursor, collapsing any selection) / "Apply" (replace the
// current selection) actions under a chat code block.
async function insertAtCursor(text: string, replaceSelection: boolean): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage("No active editor to insert into.");
    return;
  }
  const target = replaceSelection && !editor.selection.isEmpty ? editor.selection : editor.selection.active;
  await editor.edit((b) => {
    if (target instanceof vscode.Selection) b.replace(target, text);
    else b.insert(target, text);
  });
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}
