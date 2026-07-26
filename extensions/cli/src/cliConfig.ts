// Reads the shared ~/.xpreiide/config.yaml (or an explicit --config
// path) and resolves openai-compat API keys from environment variables
// — the CLI has no OS-keychain equivalent to VS Code's SecretStorage.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseConfig, XpreiConfig } from "@xprei/core";

export function defaultConfigPath(): string {
  return path.join(os.homedir(), ".xpreiide", "config.yaml");
}

// Unlike VS Code's loadConfig() (which silently defaults to an empty/
// default config when the file is missing), the CLI has no UI to
// configure providers itself — a missing config is a clear, actionable
// error, not a silently-empty provider list.
export async function loadCliConfig(configPath?: string): Promise<XpreiConfig> {
  const p = configPath ?? defaultConfigPath();
  let content: string;
  try {
    content = await fs.readFile(p, "utf8");
  } catch {
    throw new Error(
      `No config found at ${p}. Run the VS Code extension once to create it, or write one by hand.`,
    );
  }
  return parseConfig(content).config;
}

// "my-provider" -> "XPREI_APIKEY_MY_PROVIDER"
export function apiKeyEnvVar(providerId: string): string {
  return `XPREI_APIKEY_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}
