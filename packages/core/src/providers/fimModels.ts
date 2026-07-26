// Static, hand-maintained allowlist of Ollama model-name patterns known
// to be FIM (fill-in-the-middle)-trained. Not exhaustive — extend as
// new code-model families ship. Matched case-insensitively against the
// bare model name (the part before any ":tag"). See
// docs/superpowers/specs/2026-07-26-phase8-true-fim-design.md.

const FIM_CAPABLE_PATTERNS = [
  /^codellama/,
  /^deepseek-coder/,
  /^starcoder/,
  /^qwen2\.5-coder/,
  /^codegemma/,
  /^codestral/,
  /^granite-code/,
];

export function isFimCapableModel(model: string): boolean {
  const name = model.split(":")[0].toLowerCase();
  return FIM_CAPABLE_PATTERNS.some((re) => re.test(name));
}
