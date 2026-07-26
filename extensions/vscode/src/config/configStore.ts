// Reads/writes the shared ~/.xpreiide/config.yaml. No caching — every
// call re-reads the file, matching projectRules.ts/ignoreFile.ts.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG, parseConfig, serializeConfig, XpreiConfig, YamlMap } from "@xprei/core";

export function configPath(): string {
  return path.join(os.homedir(), ".xpreiide", "config.yaml");
}

export async function loadConfig(): Promise<{ config: XpreiConfig; raw: YamlMap }> {
  try {
    const content = await fs.readFile(configPath(), "utf8");
    return parseConfig(content);
  } catch {
    // No config file yet — a fresh copy, never the literal DEFAULT_CONFIG
    // object, so a caller mutating the returned config can't corrupt the
    // shared default for a later call in this same process.
    return { config: { ...DEFAULT_CONFIG, providers: DEFAULT_CONFIG.providers.map((p) => ({ ...p })) }, raw: {} };
  }
}

export async function saveConfig(config: XpreiConfig, raw: YamlMap): Promise<void> {
  const p = configPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, serializeConfig(config, raw), "utf8");
}
