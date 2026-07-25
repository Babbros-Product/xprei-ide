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

const DEFAULT_TIMEOUT_MS = 8000;

// Races a provider's listModels() against a timeout so one hung endpoint
// (TCP-connected but never responding) can't stall the whole picker, even if
// the provider itself doesn't honor the abort signal.
function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export async function aggregateModels(
  configs: ProviderConfig[],
  buildProvider: (cfg: ProviderConfig) => Promise<Provider>,
  activePointer: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ModelEntry[]> {
  const perProvider = await Promise.all(
    configs.map(async (cfg) => {
      let models: string[];
      try {
        const provider = await buildProvider(cfg);
        const controller = new AbortController();
        models = await withTimeout(
          provider.listModels(controller.signal),
          timeoutMs,
          () => controller.abort(),
        );
      } catch {
        models = cfg.model ? [cfg.model] : [];
      }
      return models.map((model) => ({
        providerId: cfg.id,
        providerLabel: cfg.label,
        model,
        active: `${cfg.id}::${model}` === activePointer,
      }));
    }),
  );
  return perProvider.flat();
}
