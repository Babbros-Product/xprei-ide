// Extension entry point. Wires the chat view and model/key management commands.

import * as vscode from "vscode";
import { ContextEngine } from "./context/contextEngine";
import { InlineEditController } from "./edit/inlineEdit";
import { ProviderConfig } from "@xprei/core";
import { ProviderRegistry } from "./providers/registry";
import { runAddProviderFlow } from "./providers/addProviderFlow";
import { ChatViewProvider, QuickActionKind } from "./ui/chat/chatView";
import { generateCommitMessage } from "./git/commitMessage";
import { InlineCompletionProvider } from "./completion/inlineCompletionProvider";

const QUICK_ACTIONS: { kind: QuickActionKind; command: string }[] = [
  { kind: "explain", command: "xpreiIDE.explainSelection" },
  { kind: "fix", command: "xpreiIDE.fixSelection" },
  { kind: "tests", command: "xpreiIDE.generateTests" },
  { kind: "comments", command: "xpreiIDE.addComments" },
  { kind: "refactor", command: "xpreiIDE.refactorSelection" },
];

export function activate(context: vscode.ExtensionContext): void {
  const registry = new ProviderRegistry(context.secrets);
  const log = vscode.window.createOutputChannel("xpreiIDE");
  const engine = new ContextEngine(registry, context.storageUri, log);

  const chat = new ChatViewProvider(context.extensionUri, registry, engine, context.workspaceState);
  const inlineEdit = new InlineEditController(registry);

  // Keep the index fresh as the user edits. Debounce per-path so a burst of
  // saves (or a bulk operation like `npm install`) collapses into one re-embed
  // per file; the engine itself skips excluded dirs (node_modules/.git/…).
  const watcher = vscode.workspace.createFileSystemWatcher("**/*");
  const updateTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const WATCH_DEBOUNCE_MS = 500;
  const scheduleUpdate = (uri: vscode.Uri) => {
    const key = uri.toString();
    clearTimeout(updateTimers.get(key));
    updateTimers.set(
      key,
      setTimeout(() => {
        updateTimers.delete(key);
        void engine.updateFile(uri);
      }, WATCH_DEBOUNCE_MS),
    );
  };
  watcher.onDidCreate(scheduleUpdate);
  watcher.onDidChange(scheduleUpdate);
  watcher.onDidDelete((uri) => {
    const key = uri.toString();
    clearTimeout(updateTimers.get(key)); // cancel any pending re-embed
    updateTimers.delete(key);
    void engine.removeFile(uri);
  });

  context.subscriptions.push(
    log,
    watcher,
    inlineEdit,
    vscode.languages.registerInlineCompletionItemProvider(
      // Real editable documents only — not diff views, output panels, the
      // settings editor, or other read-only/virtual schemes.
      [{ scheme: "file" }, { scheme: "untitled" }],
      new InlineCompletionProvider(registry),
    ),
    vscode.commands.registerCommand("xpreiIDE.inlineEdit", () => inlineEdit.run()),
    vscode.commands.registerCommand("xpreiIDE.inlineEdit.accept", () => inlineEdit.accept()),
    vscode.commands.registerCommand("xpreiIDE.inlineEdit.reject", () => inlineEdit.reject()),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chat, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("xpreiIDE.selectModel", () =>
      selectModel(registry, "activeModel", "chat"),
    ),
    vscode.commands.registerCommand("xpreiIDE.selectEmbedModel", () =>
      selectModel(registry, "embedModel", "embedding"),
    ),
    vscode.commands.registerCommand("xpreiIDE.setApiKey", () =>
      setApiKey(registry),
    ),
    vscode.commands.registerCommand("xpreiIDE.addProvider", () =>
      runAddProviderFlow(registry),
    ),
    vscode.commands.registerCommand("xpreiIDE.rebuildIndex", () =>
      rebuildIndex(engine),
    ),
    vscode.commands.registerCommand("xpreiIDE.revertAgentRun", () =>
      chat.revertLastRun(),
    ),
    vscode.commands.registerCommand("xpreiIDE.inlineChat", () => void inlineChat(chat)),
    vscode.commands.registerCommand("xpreiIDE.generateCommitMessage", () =>
      generateCommitMessage(registry),
    ),
    ...QUICK_ACTIONS.map(({ kind, command }) =>
      vscode.commands.registerCommand(command, () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selection.isEmpty) {
          vscode.window.showInformationMessage("Select some code first.");
          return;
        }
        void chat.runQuickAction(
          kind,
          editor.document.getText(editor.selection),
          editor.document.languageId,
        );
      }),
    ),
  );

  void engine.load();

  // Chat lives in its own Activity Bar container — open it on startup so
  // it's not hidden behind an icon the user has to discover. (Users can
  // drag the view to the Secondary Side Bar themselves if they prefer —
  // VS Code has no stable extension-contribution API for that placement.)
  void vscode.commands.executeCommand("workbench.view.extension.xpreiIDE");
}

export function deactivate(): void {
  /* no-op */
}

// Two-step QuickPick: choose a provider, then a model it reports. Persisted to
// the given setting ("activeModel" or "embedModel") as "providerId::model".
async function selectModel(
  registry: ProviderRegistry,
  setting: "activeModel" | "embedModel",
  role: string,
): Promise<void> {
  const configs = registry.getConfigs();
  if (configs.length === 0) {
    vscode.window.showWarningMessage(
      "No providers configured. Add one under Settings → xpreiIDE.providers.",
    );
    return;
  }

  const pickedProvider = await pickProvider(configs, `Select a provider for ${role}`);
  if (!pickedProvider) return;

  let models: string[];
  try {
    const provider = await registry.build(pickedProvider);
    models = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Loading models…" },
      () => provider.listModels(),
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      err instanceof Error ? err.message : "Failed to list models.",
    );
    return;
  }

  if (models.length === 0) {
    vscode.window.showWarningMessage(
      `No models found for ${pickedProvider.label}. Pull one (e.g. 'ollama pull llama3.1').`,
    );
    return;
  }

  const model = await vscode.window.showQuickPick(models, {
    placeHolder: `Select a ${role} model`,
  });
  if (!model) return;

  await vscode.workspace
    .getConfiguration("xpreiIDE")
    .update(
      setting,
      ProviderRegistry.formatActive(pickedProvider.id, model),
      vscode.ConfigurationTarget.Global,
    );
  vscode.window.showInformationMessage(
    `xpreiIDE ${role} model: ${pickedProvider.label} / ${model}`,
  );
}

// Full workspace (re)index with progress + cancellation.
async function rebuildIndex(engine: ContextEngine): Promise<void> {
  try {
    const count = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "xpreiIDE: indexing workspace…",
        cancellable: true,
      },
      (_p, token) => engine.rebuild(token),
    );
    vscode.window.showInformationMessage(`xpreiIDE indexed ${count} chunks.`);
  } catch (err) {
    vscode.window.showErrorMessage(
      err instanceof Error ? err.message : "Indexing failed.",
    );
  }
}

// Store an API key in SecretStorage for an OpenAI-compatible provider.
async function setApiKey(registry: ProviderRegistry): Promise<void> {
  const configs = registry.getConfigs().filter((c) => c.kind === "openai-compat");
  if (configs.length === 0) {
    vscode.window.showWarningMessage(
      "No OpenAI-compatible providers configured. Ollama needs no key.",
    );
    return;
  }
  const picked = await pickProvider(configs, "Provider to set API key for");
  if (!picked) return;

  const key = await vscode.window.showInputBox({
    prompt: `API key for ${picked.label}`,
    password: true,
    ignoreFocusOut: true,
  });
  if (key == null) return;

  await registry.setApiKey(picked.id, key);
  vscode.window.showInformationMessage(`Stored API key for ${picked.label}.`);
}

// Ctrl+I: a native input box (no floating-widget infra needed) that seeds a
// free-typed question into the chat panel, with the current selection (if
// any) attached as context — Cmd-K's ask-only sibling.
async function inlineChat(chat: ChatViewProvider): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const hasSelection = !!editor && !editor.selection.isEmpty;
  const prompt = await vscode.window.showInputBox({
    prompt: hasSelection ? "Ask xpreiIDE about the selection" : "Ask xpreiIDE",
    placeHolder: "e.g. what does this function do, how would I test this",
    ignoreFocusOut: true,
  });
  if (!prompt) return;
  if (hasSelection && editor) {
    await chat.askFreeform(prompt, editor.document.getText(editor.selection), editor.document.languageId);
  } else {
    await chat.askFreeform(prompt);
  }
}

async function pickProvider(
  configs: ProviderConfig[],
  placeHolder: string,
): Promise<ProviderConfig | undefined> {
  if (configs.length === 1) return configs[0];
  const items = configs.map((c) => ({ label: c.label, description: c.kind, cfg: c }));
  const chosen = await vscode.window.showQuickPick(items, { placeHolder });
  return chosen?.cfg;
}
