// Chat sidebar. A WebviewViewProvider that renders the chat UI and bridges
// user messages to the active provider's streaming API.

import * as vscode from "vscode";
import { Checkpoint } from "../../agent/checkpoint";
import { AgentMode, runAgent } from "../../agent/runner";
import { ContextEngine } from "../../context/contextEngine";
import { parseMentions } from "../../context/mentions";
import { ChatMessage, isAbortError, ProviderConfig } from "../../providers/provider";
import { ProviderRegistry } from "../../providers/registry";
import { runAddProviderFlow } from "../../providers/addProviderFlow";
import { uniqueProviderId } from "../../providers/presets";

// Plan mode has no file-editing tools at all (plain chat), so the model is
// told explicitly not to claim it changed anything — Edit/Agent modes get
// their tool list (and its description) straight from the agent loop.
const PLAN_SYSTEM_PROMPT =
  "You are xpreiIDE in Plan mode: a concise coding assistant embedded in the " +
  "user's IDE. Analyze and propose an approach in prose or code snippets. " +
  "You have no file-editing tools in this mode — never claim to have created " +
  "or modified a file; suggest switching to Edit or Agent mode for that.";

function slugify(label: string, fallback: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || fallback;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "xpreiIDE.chat";

  private view?: vscode.WebviewView;
  private history: ChatMessage[] = [];
  private inflight?: AbortController;
  private lastCheckpoint?: Checkpoint;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly registry: ProviderRegistry,
    private readonly context: ContextEngine,
  ) {}

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
      else if (msg?.type === "reset") this.history = [];
      else if (msg?.type === "ready") {
        this.rehydrate();
        void this.sendModels();
      } else if (msg?.type === "selectModel") void this.onSelectModel(String(msg.pointer ?? ""));
      else if (msg?.type === "addProvider") void this.onAddProvider();
      else if (msg?.type === "getProviders") void this.sendProviders();
      else if (msg?.type === "saveProvider") void this.onSaveProvider(msg.cfg, String(msg.apiKey ?? ""));
      else if (msg?.type === "removeProvider") void this.onRemoveProvider(String(msg.id ?? ""));
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

  private async onAddProvider(): Promise<void> {
    await runAddProviderFlow(this.registry);
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

    const messages: ChatMessage[] = [
      { role: "system", content: PLAN_SYSTEM_PROMPT },
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
      const run = await runAgent(
        this.registry,
        task,
        (m) => this.post(m),
        this.inflight.signal,
        mode,
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
    <button type="button" id="gearBtn" class="iconBtn" title="Model settings" aria-label="Model settings">⚙</button>
  </div>
  <div id="settingsPanel" class="settingsPanel hidden">
    <div id="providerList" class="providerList"></div>
    <form id="addProviderForm" class="addProviderForm">
      <select id="cfgKind" aria-label="Provider kind">
        <option value="openai-compat">OpenAI-compatible (OpenAI, Gemini, …)</option>
        <option value="ollama">Ollama (local)</option>
      </select>
      <input id="cfgLabel" type="text" placeholder="Label (e.g. OpenAI)" />
      <input id="cfgBaseUrl" type="text" placeholder="Base URL (e.g. https://api.openai.com/v1)" />
      <input id="cfgModel" type="text" placeholder="Default model (optional)" />
      <input id="cfgApiKey" type="password" placeholder="API key" autocomplete="off" />
      <button type="submit" id="saveProviderBtn">Save provider</button>
    </form>
  </div>
  <div id="messages"></div>
  <form id="composer">
    <textarea id="input" rows="3" placeholder="Ask xpreiIDE…  (Enter to send, Shift+Enter for newline)"></textarea>
    <div class="row">
      <select id="modelSelect" aria-label="Model"></select>
      <div class="modeSelector" role="radiogroup" aria-label="Mode">
        <button type="button" class="modeBtn active" data-mode="plan">Plan</button>
        <button type="button" class="modeBtn" data-mode="edit">Edit</button>
        <button type="button" class="modeBtn" data-mode="agent">Agent</button>
      </div>
    </div>
    <div class="row">
      <button type="submit" id="sendBtn">Send</button>
      <button type="button" id="stopBtn" disabled>Stop</button>
      <button type="button" id="resetBtn">Reset</button>
    </div>
  </form>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
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
