// Format retrieved chunks / files / diagnostics into a context block for
// the model prompt. Pure module — no vscode.

import { SearchHit } from "./vectorstore";
import { TRUNCATION_MARKER } from "./budget";

export interface FileContext {
  path: string;
  content: string;
}

export interface ProblemInfo {
  path: string;
  line: number; // 1-based
  severity: "error" | "warning";
  message: string;
}

// Drop hits below this cosine score — weak matches add noise, not signal.
export const MIN_SCORE = 0.2;

export function formatHits(hits: SearchHit[], minScore = MIN_SCORE): string {
  const kept = hits.filter((h) => h.score >= minScore);
  if (kept.length === 0) return "";
  const blocks = kept.map((h) => {
    const loc = `${h.chunk.path}:${h.chunk.startLine}-${h.chunk.endLine}`;
    return `// ${loc} (score ${h.score.toFixed(2)})\n${h.chunk.text}`;
  });
  return blocks.join("\n\n");
}

export function formatFiles(files: FileContext[], maxChars = 8000): string {
  const blocks = files.map((f) => {
    const body = f.content.length > maxChars ? f.content.slice(0, maxChars) + TRUNCATION_MARKER : f.content;
    return `// FILE: ${f.path}\n${body}`;
  });
  return blocks.join("\n\n");
}

export function formatProblems(problems: ProblemInfo[]): string {
  return problems
    .map((p) => `// ${p.path}:${p.line} (${p.severity}) ${p.message}`)
    .join("\n");
}

// Assemble the final context message the chat prepends before the user turn.
export function buildContextMessage(parts: {
  retrieved?: string;
  files?: string;
  problems?: string;
}): string {
  const sections: string[] = [];
  if (parts.files) sections.push(parts.files);
  if (parts.problems) sections.push(parts.problems);
  if (parts.retrieved) sections.push("// Relevant code from the workspace:\n" + parts.retrieved);
  if (sections.length === 0) return "";
  return (
    "The user referenced workspace context. Use it to answer.\n\n" +
    sections.join("\n\n")
  );
}
