// Provider registry. Reads provider configs from settings, resolves the active
// model, and constructs the right adapter — injecting API keys from
// SecretStorage so they never touch plaintext config.

import * as vscode from "vscode";
import { OllamaProvider } from "./ollama";
import { OpenAICompatProvider } from "./openai-compat";
import { Provider, ProviderConfig } from "./provider";

const SECRET_PREFIX = "xpreiIDE.apiKey.";

export interface ResolvedModel {
  provider: Provider;
  model: string;
}

export class ProviderRegistry {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  getConfigs(): ProviderConfig[] {
    return vscode.workspace
      .getConfiguration("xpreiIDE")
      .get<ProviderConfig[]>("providers", []);
  }

  async build(cfg: ProviderConfig): Promise<Provider> {
    if (cfg.kind === "ollama") {
      return new OllamaProvider(cfg);
    }
    const key = (await this.secrets.get(SECRET_PREFIX + cfg.id)) ?? "";
    return new OpenAICompatProvider(cfg, key);
  }

  async setApiKey(providerId: string, key: string): Promise<void> {
    await this.secrets.store(SECRET_PREFIX + providerId, key);
  }

  // Parse the "providerId::model" pointer stored in xpreiIDE.activeModel.
  async resolveActive(): Promise<ResolvedModel | undefined> {
    const active = vscode.workspace
      .getConfiguration("xpreiIDE")
      .get<string>("activeModel", "");
    const sep = active.indexOf("::");
    if (sep < 0) return undefined;
    const providerId = active.slice(0, sep);
    const model = active.slice(sep + 2); // model names may themselves contain "::"
    const cfg = this.getConfigs().find((c) => c.id === providerId);
    if (!cfg || !model) return undefined;
    return { provider: await this.build(cfg), model };
  }

  static formatActive(providerId: string, model: string): string {
    return `${providerId}::${model}`;
  }
}
