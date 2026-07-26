#!/usr/bin/env node

import { Agent, AgentEvents, NodeAgentHost, OllamaProvider, OpenAICompatProvider, Provider, ProviderConfig } from "@xprei/core";
import { apiKeyEnvVar, loadCliConfig } from "./cliConfig";
import { parseArgs } from "./parseArgs";
import { TerminalApprover } from "./terminalApprover";

function buildProvider(cfg: ProviderConfig): Provider {
  if (cfg.kind === "ollama") return new OllamaProvider(cfg);
  const key = process.env[apiKeyEnvVar(cfg.id)] ?? "";
  return new OpenAICompatProvider(cfg, key);
}

function parsePointer(pointer: string): { providerId: string; model: string } | undefined {
  const sep = pointer.indexOf("::");
  if (sep < 0) return undefined;
  const providerId = pointer.slice(0, sep);
  const model = pointer.slice(sep + 2);
  if (!providerId || !model) return undefined;
  return { providerId, model };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const config = await loadCliConfig(parsed.configPath);

  const pointer = parsed.model ?? config.activeModel;
  const resolved = parsePointer(pointer);
  if (!resolved) {
    throw new Error(
      `No usable model. Pass --model providerId::model, or set activeModel in the config file.`,
    );
  }
  const cfg = config.providers.find((c) => c.id === resolved.providerId);
  if (!cfg) {
    throw new Error(`Unknown provider "${resolved.providerId}" in ${pointer}.`);
  }
  const provider = buildProvider(cfg);

  if (parsed.subcommand === "chat") {
    for await (const chunk of provider.chatStream({
      model: resolved.model,
      messages: [{ role: "user", content: parsed.text }],
    })) {
      process.stdout.write(chunk.delta);
      if (chunk.done) break;
    }
    process.stdout.write("\n");
    return;
  }

  // subcommand === "agent"
  const host = new NodeAgentHost(parsed.workspace);
  let failed = false;
  const events: AgentEvents = {
    onStep: (n) => console.log(`\n[step ${n}]`),
    onThought: (text) => console.log(`thought: ${text}`),
    onTool: (name, args) => console.log(`tool: ${name} ${JSON.stringify(args)}`),
    onObservation: (text) => console.log(`observation: ${text}`),
    onFinal: (text) => console.log(`\nfinal: ${text}`),
    onError: (text) => {
      failed = true;
      console.error(`error: ${text}`);
    },
    onProtocolError: (attempt, maxAttempts, reason) =>
      console.log(`protocol error (attempt ${attempt}/${maxAttempts}): ${reason}`),
  };

  const agent = new Agent({
    provider,
    model: resolved.model,
    host,
    approver: new TerminalApprover(parsed.autoApprove),
    events,
    maxSteps: parsed.maxSteps,
  });

  await agent.run(parsed.text);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
