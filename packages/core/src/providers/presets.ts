// One-click provider setup: baseUrl presets for well-known OpenAI-compatible
// endpoints, so adding OpenAI/Gemini doesn't require hand-editing JSON.

export interface ProviderPreset {
  id: string;
  kind: "openai-compat";
  label: string;
  baseUrl: string;
}

export const PRESETS: ProviderPreset[] = [
  { id: "openai", kind: "openai-compat", label: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  {
    id: "gemini",
    kind: "openai-compat",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  },
];

// Appends a numeric suffix ("-2", "-3", ...) until the id is not in existingIds.
export function uniqueProviderId(base: string, existingIds: string[]): string {
  if (!existingIds.includes(base)) return base;
  let n = 2;
  while (existingIds.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
