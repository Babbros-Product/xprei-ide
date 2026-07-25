// Agent tool protocol (pure, no vscode). The crux of P4.
//
// Native function-calling is unreliable across open-source models, so the agent
// speaks a single text protocol that ANY chat model can follow: each turn the
// model emits ONE JSON object — either a tool call or a final answer. We parse
// it out of whatever prose the model wraps around it.

export interface ToolSpec {
  name: string;
  description: string;
  // Human-readable arg description shown in the prompt, e.g. `{ "path": string }`.
  args: string;
  // Mutating tools (writes, shell) pass through an approval gate.
  mutating: boolean;
}

export type Action =
  | { kind: "tool"; tool: string; args: Record<string, unknown>; thought?: string }
  | { kind: "final"; text: string; thought?: string }
  | { kind: "protocolError"; reason: string; thought?: string };

// System prompt: describes the tools and pins the exact response contract.
export function buildAgentSystemPrompt(tools: ToolSpec[], cwd: string): string {
  const lines = tools.map(
    (t) => `- ${t.name}: ${t.description}\n    args: ${t.args}`,
  );
  return [
    "You are xpreiIDE Agent, an autonomous coding agent working inside the user's IDE.",
    `Workspace root: ${cwd}`,
    "",
    "You complete the user's task by taking ONE action per turn using the tools below.",
    "",
    "Tools:",
    ...lines,
    "",
    "Response contract — reply with EXACTLY ONE JSON object and nothing else:",
    "",
    "To call a tool:",
    '  {"thought": "why this step", "tool": "<name>", "args": { ... }}',
    "",
    "To finish (task complete or you need the user):",
    '  {"thought": "why done", "final": "summary of what you did for the user"}',
    "",
    "Rules:",
    "- Output raw JSON only. No markdown fences, no text before or after.",
    "- One action per turn. Wait for the tool result before the next step.",
    "- Read files before editing them. Prefer small, targeted edits.",
    "- After making changes, verify (e.g. run tests) before finishing.",
    "- Paths are relative to the workspace root.",
  ].join("\n");
}

const NO_JSON_REASON =
  'Your reply did not contain a JSON object. Respond with exactly one JSON ' +
  'object: either a tool call {"tool": "<name>", "args": {...}} or ' +
  '{"final": "<summary>"}. No prose outside the JSON.';

const MISSING_KEY_REASON =
  'Your JSON object had neither a "tool" nor a "final" key. To call a tool: ' +
  '{"tool": "<name>", "args": {...}}. To finish: {"final": "<summary>"}.';

// Extract the model's action from a raw completion. Tolerant of fenced blocks
// and surrounding prose. If nothing parses as an action, return a
// protocolError (a retry-eligible protocol violation) rather than silently
// treating the reply as a final answer — callers (the orchestrator) retry up
// to a configurable cap before giving up.
export function parseAction(raw: string): Action {
  const text = raw.trim();
  const obj = extractJsonObject(text);

  if (obj && typeof obj === "object") {
    const rec = obj as Record<string, unknown>;
    const thought = typeof rec.thought === "string" ? rec.thought : undefined;

    if (typeof rec.final === "string") {
      return { kind: "final", text: rec.final, thought };
    }
    if (typeof rec.tool === "string" && rec.tool) {
      const args =
        rec.args && typeof rec.args === "object"
          ? (rec.args as Record<string, unknown>)
          : {};
      return { kind: "tool", tool: rec.tool, args, thought };
    }
    // Valid JSON, but neither a tool call nor a final answer.
    return { kind: "protocolError", reason: MISSING_KEY_REASON, thought };
  }

  // No parseable JSON object at all — a protocol violation the model can
  // correct on retry, not a legitimate final answer (a real answer already
  // comes wrapped as {"final": "..."}).
  return { kind: "protocolError", reason: NO_JSON_REASON };
}

// Find the first balanced {...} that JSON-parses. Strips ```json fences first.
// Scans brace-by-brace (respecting strings/escapes) so trailing prose is ignored.
function extractJsonObject(input: string): unknown {
  let s = input;
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  const start = s.indexOf("{");
  if (start < 0) return undefined;

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = s.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}
