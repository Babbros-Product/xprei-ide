// Stdio JSON-RPC entrypoint for the xprei-core sidecar. A host process (a
// JetBrains/Eclipse plugin, or a CLI harness) spawns this and speaks
// line-delimited JSON over stdin/stdout. All the logic lives in SidecarSession;
// this file only does I/O framing and builds live providers from the config the
// client passes at `initialize`.
//
//   node dist/server/stdio.js      (or via tsx during dev)

import * as readline from "node:readline";
import { Provider, ProviderConfig } from "../providers/provider";
import { OllamaProvider } from "../providers/ollama";
import { OpenAICompatProvider } from "../providers/openai-compat";
import { ResolvedModel, SidecarSession } from "./session";

interface InitProviders {
  providers?: ProviderConfig[];
  // providerId → API key (held in memory only, never persisted by the sidecar).
  apiKeys?: Record<string, string>;
}

function buildProvider(cfg: ProviderConfig, apiKey: string): Provider {
  return cfg.kind === "ollama"
    ? new OllamaProvider(cfg)
    : new OpenAICompatProvider(cfg, apiKey);
}

export function startStdioServer(): void {
  let configs: ProviderConfig[] = [];
  let keys: Record<string, string> = {};

  const resolveModel = (pointer: string): ResolvedModel | undefined => {
    const [providerId, ...rest] = pointer.split("::");
    const model = rest.join("::");
    const cfg = configs.find((c) => c.id === providerId);
    if (!cfg || !model) return undefined;
    return { provider: buildProvider(cfg, keys[providerId] ?? ""), model };
  };

  const emit = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");
  const session = new SidecarSession({ emit, resolveModel });

  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    let msg: { method?: string; params?: InitProviders & Record<string, unknown> };
    try {
      msg = JSON.parse(text);
    } catch {
      emit({ error: { message: "invalid JSON" } });
      return;
    }
    // Capture provider config from initialize before the session handles it.
    if (msg.method === "initialize" && msg.params) {
      if (Array.isArray(msg.params.providers)) configs = msg.params.providers;
      if (msg.params.apiKeys && typeof msg.params.apiKeys === "object") {
        keys = msg.params.apiKeys as Record<string, string>;
      }
    }
    void session.handle(msg as { method: string });
  });
}

// Run when invoked directly (node/tsx), not when imported by a test.
if (require.main === module) startStdioServer();
