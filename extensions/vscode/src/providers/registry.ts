// Provider registry. Reads provider configs from the shared
// ~/.xpreiide/config.yaml (see ../config/configStore.ts), resolves the
// active model, and constructs the right adapter — injecting API keys
// from SecretStorage so they never touch plaintext config.

import * as vscode from "vscode";
import {
  aggregateModels,
  ModelEntry,
  OllamaProvider,
  OpenAICompatProvider,
  Provider,
  ProviderConfig,
  XpreiConfig,
} from "@xprei/core";
import { loadConfig, saveConfig } from "../config/configStore";

const SECRET_PREFIX = "xpreiIDE.apiKey.";

export interface ResolvedModel {
  provider: Provider;
  model: string;
}

type ModelSettingKey = keyof Omit<XpreiConfig, "providers">;

export class ProviderRegistry {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async getConfigs(): Promise<ProviderConfig[]> {
    return (await loadConfig()).config.providers;
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

  async deleteApiKey(providerId: string): Promise<void> {
    await this.secrets.delete(SECRET_PREFIX + providerId);
  }

  // Add a provider config (chat settings-panel "Save provider"). Appends to
  // the existing list; caller is responsible for a unique cfg.id.
  async addConfig(cfg: ProviderConfig): Promise<void> {
    const { config, raw } = await loadConfig();
    config.providers = [...config.providers, cfg];
    await saveConfig(config, raw);
  }

  // Remove a provider config and its stored key (chat settings-panel "Remove").
  async removeConfig(providerId: string): Promise<void> {
    const { config, raw } = await loadConfig();
    config.providers = config.providers.filter((c) => c.id !== providerId);
    await saveConfig(config, raw);
    await this.deleteApiKey(providerId);
  }

  // Parse the "providerId::model" pointer stored in the config's activeModel field.
  async resolveActive(): Promise<ResolvedModel | undefined> {
    return this.resolvePointer("activeModel");
  }

  // Resolve the embedding model (embedModel) for the RAG index.
  async resolveEmbed(): Promise<ResolvedModel | undefined> {
    return this.resolvePointer("embedModel");
  }

  // Resolve the completion model (completionModel), falling back
  // to the chat model (activeModel) when unset.
  async resolveCompletion(): Promise<ResolvedModel | undefined> {
    return this.resolvePointer("completionModel", "activeModel");
  }

  // Resolve the agent-loop model (agentModel), falling back to
  // the chat model (activeModel) when unset.
  async resolveAgent(): Promise<ResolvedModel | undefined> {
    return this.resolvePointer("agentModel", "activeModel");
  }

  // Resolve the inline-edit (Cmd/Ctrl+K) model (inlineEditModel),
  // falling back to the chat model (activeModel) when unset.
  async resolveInlineEdit(): Promise<ResolvedModel | undefined> {
    return this.resolvePointer("inlineEditModel", "activeModel");
  }

  // Resolve the commit-message model (commitMessageModel),
  // falling back to the chat model (activeModel) when unset.
  async resolveCommitMessage(): Promise<ResolvedModel | undefined> {
    return this.resolvePointer("commitMessageModel", "activeModel");
  }

  // Aggregate every model from every configured provider, for the chat
  // panel's model picker. Never throws — a provider that fails to list
  // models is skipped (or falls back to its configured default model).
  async listAllModels(): Promise<ModelEntry[]> {
    const { config } = await loadConfig();
    return aggregateModels(config.providers, (cfg) => this.build(cfg), config.activeModel);
  }

  // Reads config.<setting> as a "providerId::model" pointer. If it's
  // empty/unparseable, OR it parses but points at a provider config that
  // no longer exists (e.g. removed via "Remove provider"), and
  // fallbackSetting is given, resolves that setting instead — this is
  // how e.g. an unset (or stale) completionModel falls back to
  // activeModel. Public: extension.ts's selectModel() QuickPick previews
  // the effective (fallback-resolved) model before writing an override.
  async resolvePointer(
    setting: ModelSettingKey,
    fallbackSetting?: ModelSettingKey,
  ): Promise<ResolvedModel | undefined> {
    const { config } = await loadConfig();
    const pointer = config[setting];
    const parsed = ProviderRegistry.parsePointer(pointer);
    if (!parsed) {
      return fallbackSetting ? this.resolvePointer(fallbackSetting) : undefined;
    }
    const cfg = config.providers.find((c) => c.id === parsed.providerId);
    if (!cfg) {
      return fallbackSetting ? this.resolvePointer(fallbackSetting) : undefined;
    }
    return { provider: await this.build(cfg), model: parsed.model };
  }

  static formatActive(providerId: string, model: string): string {
    return `${providerId}::${model}`;
  }

  // "providerId::model" → parts. Model names may themselves contain "::".
  static parsePointer(pointer: string): { providerId: string; model: string } | undefined {
    const sep = pointer.indexOf("::");
    if (sep < 0) return undefined;
    const providerId = pointer.slice(0, sep);
    const model = pointer.slice(sep + 2);
    if (!providerId || !model) return undefined;
    return { providerId, model };
  }
}
