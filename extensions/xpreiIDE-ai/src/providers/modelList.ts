// Pure aggregation logic for the model picker: given configured providers and
// a way to build each one, resolve every available model name. Kept vscode-free
// so it's directly unit-testable; ProviderRegistry.listAllModels() is the thin
// vscode-config-reading wrapper around this.

import { Provider, ProviderConfig } from "./provider";

export interface ModelEntry {
  providerId: string;
  providerLabel: string;
  model: string;
  active: boolean;
}

export async function aggregateModels(
  configs: ProviderConfig[],
  buildProvider: (cfg: ProviderConfig) => Promise<Provider>,
  activePointer: string,
): Promise<ModelEntry[]> {
  const out: ModelEntry[] = [];
  for (const cfg of configs) {
    let models: string[];
    try {
      const provider = await buildProvider(cfg);
      models = await provider.listModels();
    } catch {
      models = cfg.model ? [cfg.model] : [];
    }
    for (const model of models) {
      out.push({
        providerId: cfg.id,
        providerLabel: cfg.label,
        model,
        active: `${cfg.id}::${model}` === activePointer,
      });
    }
  }
  return out;
}
