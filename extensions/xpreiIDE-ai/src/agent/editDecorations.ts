// Brief green gutter highlight on an agent-written file, editor-side echo of
// a tool call that already passed approval (same visual language as the
// Cmd-K inline-edit green, but flash-only — no accept/reject; Checkpoint owns
// undo for agent runs).

import * as vscode from "vscode";
import { resolveWorkspacePath } from "@xprei/core";

const FLASH_MS = 2500;

const deco = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  backgroundColor: "rgba(80, 200, 120, 0.15)",
});

// First-through-last changed line via a plain prefix/suffix line diff — good
// enough for a highlight, no need for a full LCS diff here.
function changedLineRange(before: string, after: string): [number, number] {
  const b = before.split(/\r?\n/);
  const a = after.split(/\r?\n/);
  let start = 0;
  while (start < b.length && start < a.length && b[start] === a[start]) start++;
  let bEnd = b.length - 1;
  let aEnd = a.length - 1;
  while (bEnd >= start && aEnd >= start && b[bEnd] === a[aEnd]) {
    bEnd--;
    aEnd--;
  }
  if (aEnd < start) aEnd = start;
  return [start, Math.max(start, aEnd)];
}

// No-op if the file isn't open in a visible editor — this is a nice-to-have
// echo, not the source of truth for what changed.
export function flashAgentEdit(rootFsPath: string, path: string, before: string, after: string): void {
  const resolved = resolveWorkspacePath(rootFsPath, path);
  if ("error" in resolved) return;
  const uri = vscode.Uri.joinPath(vscode.Uri.file(rootFsPath), resolved.relPath);
  const editor = vscode.window.visibleTextEditors.find(
    (e) => e.document.uri.toString() === uri.toString(),
  );
  if (!editor) return;

  const [start, end] = changedLineRange(before, after);
  const lastLine = Math.min(end, editor.document.lineCount - 1);
  const range = new vscode.Range(start, 0, lastLine, editor.document.lineAt(lastLine).text.length);
  editor.setDecorations(deco, [range]);
  setTimeout(() => {
    const stillOpen = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.toString() === uri.toString(),
    );
    stillOpen?.setDecorations(deco, []);
  }, FLASH_MS);
}
