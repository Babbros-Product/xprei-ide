// extensions/xpreiIDE-ai/src/providers/addProviderFlow.ts
// QuickPick/InputBox wizard for adding a provider without hand-editing JSON.
// Shared by the "xpreiIDE.addProvider" command and the chat panel's
// "+ Add provider…" picker entry — one implementation, two entry points.

import * as vscode from "vscode";
import { PRESETS, ProviderConfig, uniqueProviderId } from "@xprei/core";
import { ProviderRegistry } from "./registry";

type AddChoice =
  | { label: string; kind: "custom" }
  | {
      label: string;
      kind: "ollama" | "openai-compat";
      id: string;
      baseUrl: string;
      needsKey: boolean;
    };

export async function runAddProviderFlow(registry: ProviderRegistry): Promise<void> {
  const choices: AddChoice[] = [
    ...PRESETS.map((p) => ({
      label: p.label,
      kind: p.kind,
      id: p.id,
      baseUrl: p.baseUrl,
      needsKey: true,
    })),
    {
      label: "Ollama (local)",
      kind: "ollama",
      id: "ollama-local",
      baseUrl: "http://localhost:11434",
      needsKey: false,
    },
    { label: "Custom…", kind: "custom" },
  ];

  const picked = await vscode.window.showQuickPick(
    choices.map((c) => ({ label: c.label, choice: c })),
    { placeHolder: "Add a model provider" },
  );
  if (!picked) return;
  const choice = picked.choice;

  if (choice.kind === "custom") {
    const action = await vscode.window.showInformationMessage(
      "Add a provider manually: Settings → xpreiIDE.providers (JSON array).",
      "Open Settings",
    );
    if (action === "Open Settings") {
      await vscode.commands.executeCommand("workbench.action.openSettingsJson");
    }
    return;
  }

  let apiKey = "";
  if (choice.needsKey) {
    const key = await vscode.window.showInputBox({
      prompt: `API key for ${choice.label}`,
      password: true,
      ignoreFocusOut: true,
    });
    if (key == null) return;
    apiKey = key;
  }

  const model = await vscode.window.showInputBox({
    prompt: `Default model name for ${choice.label} (optional, e.g. gpt-4o-mini)`,
    ignoreFocusOut: true,
  });
  if (model === undefined) return;

  const settings = vscode.workspace.getConfiguration("xpreiIDE");
  const existing = registry.getConfigs();
  const id = uniqueProviderId(choice.id, existing.map((c) => c.id));

  const cfg: ProviderConfig = {
    id,
    kind: choice.kind,
    label: choice.label,
    baseUrl: choice.baseUrl,
    ...(model ? { model } : {}),
  };

  if (choice.needsKey) await registry.setApiKey(id, apiKey);
  await settings.update("providers", [...existing, cfg], vscode.ConfigurationTarget.Global);

  const activePointer = settings.get<string>("activeModel", "");
  if (!activePointer && model) {
    await settings.update(
      "activeModel",
      ProviderRegistry.formatActive(id, model),
      vscode.ConfigurationTarget.Global,
    );
  }

  vscode.window.showInformationMessage(`xpreiIDE: added provider ${choice.label}.`);
}
