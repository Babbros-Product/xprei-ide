// Prompt construction and output sanitizing for inline (Cmd-K) edits.
// Pure module — no vscode, unit-testable.

import { ChatMessage } from "../providers/provider";

export interface EditPromptInput {
  instruction: string;
  languageId: string;
  selection: string;
  path: string;
  // A few lines above/below the selection for grounding (optional).
  before?: string;
  after?: string;
}

const SYSTEM =
  "You are a precise code-editing engine. Rewrite ONLY the user's selected code " +
  "to satisfy the instruction. Output the replacement code verbatim with no " +
  "markdown fences, no commentary, and no surrounding prose. Preserve the " +
  "original indentation style.";

export function buildEditMessages(input: EditPromptInput): ChatMessage[] {
  const ctx: string[] = [`File: ${input.path} (${input.languageId})`];
  if (input.before) ctx.push(`Code before selection:\n${input.before}`);
  if (input.after) ctx.push(`Code after selection:\n${input.after}`);

  const user = [
    ctx.join("\n\n"),
    `Instruction: ${input.instruction}`,
    `Selected code to rewrite:\n${input.selection}`,
    "Return only the rewritten replacement for the selected code.",
  ].join("\n\n");

  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ];
}

// Models often wrap output in a ```lang … ``` fence despite instructions.
// Strip a single leading/trailing fence pair if present.
export function stripCodeFences(text: string): string {
  let out = text.replace(/^\s+|\s+$/g, "");
  const fenceOpen = /^```[^\n]*\n/;
  const fenceClose = /\n```$/;
  if (fenceOpen.test(out) && fenceClose.test(out)) {
    out = out.replace(fenceOpen, "").replace(fenceClose, "");
  }
  return out;
}
