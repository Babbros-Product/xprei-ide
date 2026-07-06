// Extension entry point. Wires the chat view and model/key management commands.

import * as vscode from "vscode";
import { ProviderConfig } from "./providers/provider";
import { ProviderRegistry } from "./providers/registry";
import { ChatViewProvider } from "./ui/chat/chatView";

export function activate(context: vscode.ExtensionContext): void {
  const registry = new ProviderRegistry(context.secrets);

  const chat = new ChatViewProvider(context.extensionUri, registry);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chat, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("xpreiIDE.selectModel", () =>
      selectModel(registry),
    ),
    vscode.commands.registerCommand("xpreiIDE.setApiKey", () =>
      setApiKey(registry),
    ),
  );
}

export function deactivate(): void {
  /* no-op */
}

// Two-step QuickPick: choose a provider, then a model it reports. The choice is
// persisted to xpreiIDE.activeModel as "providerId::model".
async function selectModel(registry: ProviderRegistry): Promise<void> {
  const configs = registry.getConfigs();
  if (configs.length === 0) {
    vscode.window.showWarningMessage(
      "No providers configured. Add one under Settings → xpreiIDE.providers.",
    );
    return;
  }

  const pickedProvider = await pickProvider(configs, "Select a provider");
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

  const model = await vscode.window.showQuickPick(models, { placeHolder: "Select a model" });
  if (!model) return;

  await vscode.workspace
    .getConfiguration("xpreiIDE")
    .update(
      "activeModel",
      ProviderRegistry.formatActive(pickedProvider.id, model),
      vscode.ConfigurationTarget.Global,
    );
  vscode.window.showInformationMessage(`xpreiIDE model: ${pickedProvider.label} / ${model}`);
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

async function pickProvider(
  configs: ProviderConfig[],
  placeHolder: string,
): Promise<ProviderConfig | undefined> {
  if (configs.length === 1) return configs[0];
  const items = configs.map((c) => ({ label: c.label, description: c.kind, cfg: c }));
  const chosen = await vscode.window.showQuickPick(items, { placeHolder });
  return chosen?.cfg;
}
