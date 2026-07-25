// Typed schema and defaults for the shared ~/.xpreiide/config.yaml.
// Pure module — no vscode, no file I/O. See
// docs/superpowers/specs/2026-07-26-phase6-shared-config-design.md.

import { ProviderConfig } from "../providers/provider";
import { parseYamlLite, stringifyYamlLite, YamlMap } from "./yamlLite";

export interface XpreiConfig {
  providers: ProviderConfig[];
  activeModel: string;
  embedModel: string;
  completionModel: string;
  agentModel: string;
  inlineEditModel: string;
  commitMessageModel: string;
}

export const DEFAULT_CONFIG: XpreiConfig = {
  providers: [
    { id: "ollama-local", kind: "ollama", label: "Ollama (local)", baseUrl: "http://localhost:11434" },
  ],
  activeModel: "",
  embedModel: "",
  completionModel: "",
  agentModel: "",
  inlineEditModel: "",
  commitMessageModel: "",
};

function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

// A fresh copy every time — never the shared DEFAULT_CONFIG.providers
// array reference, so a caller mutating the returned array can't
// corrupt the default for a later call in the same process.
function defaultProviders(): ProviderConfig[] {
  return DEFAULT_CONFIG.providers.map((p) => ({ ...p }));
}

function parseProviders(raw: unknown): ProviderConfig[] {
  if (!Array.isArray(raw)) return defaultProviders();
  const out: ProviderConfig[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id : undefined;
    const kind = e.kind === "ollama" || e.kind === "openai-compat" ? e.kind : undefined;
    const label = typeof e.label === "string" ? e.label : undefined;
    const baseUrl = typeof e.baseUrl === "string" ? e.baseUrl : undefined;
    if (!id || !kind || !label || !baseUrl) continue; // drop malformed entries
    const cfg: ProviderConfig = { id, kind, label, baseUrl };
    if (typeof e.model === "string" && e.model) cfg.model = e.model;
    out.push(cfg);
  }
  return out;
}

// Parses raw file content into a typed config, defensively: missing or
// malformed fields fall back to DEFAULT_CONFIG's values; each
// providers[] entry missing a required string field is dropped rather
// than crashing the whole parse. Unrecognized top-level keys are
// preserved in `raw` (not exposed on XpreiConfig) so a later
// serializeConfig() call doesn't drop them. Always returns a fresh
// XpreiConfig object — never a reference into DEFAULT_CONFIG.
export function parseConfig(content: string): { config: XpreiConfig; raw: YamlMap } {
  const raw = parseYamlLite(content);
  const config: XpreiConfig = {
    providers: parseProviders(raw.providers),
    activeModel: str(raw.activeModel, ""),
    embedModel: str(raw.embedModel, ""),
    completionModel: str(raw.completionModel, ""),
    agentModel: str(raw.agentModel, ""),
    inlineEditModel: str(raw.inlineEditModel, ""),
    commitMessageModel: str(raw.commitMessageModel, ""),
  };
  return { config, raw };
}

// Merges config's known fields over the raw map parseConfig retained
// (preserving unknown keys, e.g. a future mcpServers section), then
// stringifies via stringifyYamlLite.
export function serializeConfig(config: XpreiConfig, raw: YamlMap): string {
  const merged: YamlMap = {
    ...raw,
    providers: config.providers.map((p) => ({ ...p }) as unknown as YamlMap),
    activeModel: config.activeModel,
    embedModel: config.embedModel,
    completionModel: config.completionModel,
    agentModel: config.agentModel,
    inlineEditModel: config.inlineEditModel,
    commitMessageModel: config.commitMessageModel,
  };
  return stringifyYamlLite(merged);
}
