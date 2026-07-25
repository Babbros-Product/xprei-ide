// Ghost-text inline completions (Tab-complete as you type). Reuses the
// stable Provider.chatStream() interface with a completion-specific system
// prompt instead of a dedicated FIM endpoint — works with any configured
// model/adapter unchanged, at the cost of lower-quality completions than a
// true fill-in-the-middle API. Debounced and cancellation-aware so it stays
// cheap against slow local models.

import * as vscode from "vscode";
import { ProviderRegistry } from "../providers/registry";
import { stripCodeFences } from "@xprei/core";

const DEBOUNCE_MS = 400;
const MAX_PREFIX_LINES = 60;
const MAX_SUFFIX_LINES = 15;
const MAX_COMPLETION_LINES = 30;
const TIMEOUT_MS = 6000;

const SYSTEM_PROMPT =
  "You are a code-completion engine embedded in an IDE. Given the code " +
  "immediately before the cursor (marked <CURSOR>) and, optionally, the code " +
  "immediately after it, output ONLY the text that should be inserted at " +
  "<CURSOR> to continue the code naturally. No explanation, no markdown code " +
  "fences, no repeating text that already exists before or after the cursor. " +
  "If nothing sensible completes the code, output nothing.";

export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private debounceTimer?: ReturnType<typeof setTimeout>;
  // One-entry cache: VS Code re-requests completions on cursor moves and
  // re-renders; if the surrounding code is unchanged, reuse the last result
  // instead of hitting the model again (matters most for slow local models).
  private cache?: { key: string; text: string };

  constructor(private readonly registry: ProviderRegistry) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    if (!vscode.workspace.getConfiguration("xpreiIDE").get<boolean>("completions.enabled", true)) {
      return undefined;
    }

    const settled = await this.debounce(token);
    if (!settled || token.isCancellationRequested) return undefined;

    const resolved = await this.registry.resolveActive().catch(() => undefined);
    if (!resolved) return undefined;

    const prefix = prefixText(document, position);
    if (!prefix.trim()) return undefined;
    const suffix = suffixText(document, position);

    // Serve from cache when the surrounding code is byte-for-byte identical.
    const cacheKey = `${prefix}\u0000${suffix}`;
    if (this.cache?.key === cacheKey) {
      return [new vscode.InlineCompletionItem(this.cache.text, new vscode.Range(position, position))];
    }

    const userContent = suffix.trim()
      ? `Code before <CURSOR>:\n${prefix}<CURSOR>\nCode after <CURSOR>:\n${suffix}`
      : `Code before <CURSOR>:\n${prefix}<CURSOR>`;

    const ac = new AbortController();
    token.onCancellationRequested(() => ac.abort());
    const timeout = setTimeout(() => ac.abort(), TIMEOUT_MS);

    let out = "";
    try {
      for await (const chunk of resolved.provider.chatStream({
        model: resolved.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        signal: ac.signal,
      })) {
        out += chunk.delta;
        if (chunk.done) break;
      }
    } catch {
      return undefined; // aborted/cancelled/errored — no ghost text is the safe fallback
    } finally {
      clearTimeout(timeout);
    }

    if (token.isCancellationRequested) return undefined;
    const text = clip(stripCodeFences(out));
    if (!text.trim()) return undefined;

    this.cache = { key: cacheKey, text };
    return [new vscode.InlineCompletionItem(text, new vscode.Range(position, position))];
  }

  // Resolves false if superseded (VS Code cancels the token of any request a
  // newer keystroke makes obsolete) before the quiet period elapses.
  private debounce(token: vscode.CancellationToken): Promise<boolean> {
    return new Promise((resolve) => {
      clearTimeout(this.debounceTimer);
      const onCancel = token.onCancellationRequested(() => {
        clearTimeout(this.debounceTimer);
        resolve(false);
      });
      this.debounceTimer = setTimeout(() => {
        onCancel.dispose();
        resolve(true);
      }, DEBOUNCE_MS);
    });
  }
}

function prefixText(document: vscode.TextDocument, position: vscode.Position): string {
  const startLine = Math.max(0, position.line - MAX_PREFIX_LINES);
  return document.getText(new vscode.Range(startLine, 0, position.line, position.character));
}

function suffixText(document: vscode.TextDocument, position: vscode.Position): string {
  const endLine = Math.min(document.lineCount - 1, position.line + MAX_SUFFIX_LINES);
  const endLineText = document.lineAt(endLine).text;
  return document.getText(new vscode.Range(position.line, position.character, endLine, endLineText.length));
}

function clip(text: string): string {
  const lines = text.split(/\r?\n/);
  return lines.length > MAX_COMPLETION_LINES ? lines.slice(0, MAX_COMPLETION_LINES).join("\n") : text;
}
