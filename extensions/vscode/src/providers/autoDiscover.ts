// First-run convenience: if no chat model is configured yet, quietly probe
// for a local Ollama daemon and offer one-click setup. Deliberately silent
// when nothing is found — a machine without Ollama sees no UI at all.
// Only ever writes xpreiIDE.activeModel; the ollama-local provider config
// itself already ships as a package.json default.

import * as vscode from "vscode";
import { ProviderConfig } from "@xprei/core";
import { ProviderRegistry } from "./registry";

const OLLAMA_URL = "http://localhost:11434";
const PROBE_TIMEOUT_MS = 1500;

export async function tryAutoDiscoverOllama(registry: ProviderRegistry): Promise<void> {
  const settings = vscode.workspace.getConfiguration("xpreiIDE");
  // Already configured — never probe, never nag.
  if (settings.get<string>("activeModel", "")) return;

  const cfg = findLocalOllamaConfig(registry.getConfigs());
  // The default config was removed/renamed by the user; don't recreate it.
  if (!cfg) return;

  const models = await probeModels(registry, cfg);
  if (!models) return; // unreachable, timed out, or errored — stay silent

  if (models.length === 0) {
    vscode.window.showInformationMessage(
      "Ollama is running but has no models installed yet. " +
        "Try 'ollama pull llama3.1', then reload the window.",
    );
    return;
  }

  if (models.length === 1) {
    await setActiveModel(cfg.id, models[0]);
    return;
  }

  const action = await vscode.window.showInformationMessage(
    `Ollama detected with ${models.length} models — use it for chat?`,
    "Use Ollama",
  );
  if (action !== "Use Ollama") return;

  const model = await vscode.window.showQuickPick(models, {
    placeHolder: "Select a chat model",
  });
  if (!model) return;
  await setActiveModel(cfg.id, model);
}

function findLocalOllamaConfig(configs: ProviderConfig[]): ProviderConfig | undefined {
  return configs.find(
    (c) => c.kind === "ollama" && c.baseUrl.replace(/\/+$/, "") === OLLAMA_URL,
  );
}

// Returns the model list, or undefined if the daemon can't be reached in
// time (or fails any other way) — callers treat undefined as "stay silent".
async function probeModels(
  registry: ProviderRegistry,
  cfg: ProviderConfig,
): Promise<string[] | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const provider = await registry.build(cfg);
    return await provider.listModels(controller.signal);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function setActiveModel(providerId: string, model: string): Promise<void> {
  await vscode.workspace
    .getConfiguration("xpreiIDE")
    .update(
      "activeModel",
      ProviderRegistry.formatActive(providerId, model),
      vscode.ConfigurationTarget.Global,
    );
  vscode.window.showInformationMessage(
    `xpreiIDE: using Ollama's ${model}. Change anytime with 'xpreiIDE: Select Model'.`,
  );
}
