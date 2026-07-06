// Chat sidebar. A WebviewViewProvider that renders the chat UI and bridges
// user messages to the active provider's streaming API.

import * as vscode from "vscode";
import { ChatMessage, isAbortError } from "../../providers/provider";
import { ProviderRegistry } from "../../providers/registry";

const SYSTEM_PROMPT =
  "You are xpreiIDE, a concise coding assistant embedded in the user's IDE.";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "xpreiIDE.chat";

  private view?: vscode.WebviewView;
  private history: ChatMessage[] = [];
  private inflight?: AbortController;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly registry: ProviderRegistry,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === "send") void this.onSend(String(msg.text ?? ""));
      else if (msg?.type === "stop") this.inflight?.abort();
      else if (msg?.type === "reset") this.history = [];
      else if (msg?.type === "ready") this.rehydrate();
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
    this.post({ type: "start" });

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
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
  <div id="messages"></div>
  <form id="composer">
    <textarea id="input" rows="3" placeholder="Ask xpreiIDE…  (Enter to send, Shift+Enter for newline)"></textarea>
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

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}
