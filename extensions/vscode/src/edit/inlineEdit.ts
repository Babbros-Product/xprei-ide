// Inline (Cmd-K) edit controller. Rewrites the selected code via the active
// model and presents the result as an inline red(old)/green(new) diff that the
// user accepts (Enter) or rejects (Esc).

import * as vscode from "vscode";
import { ProviderRegistry } from "../providers/registry";
import { buildEditMessages, stripCodeFences } from "@xprei/core";

const CONTEXT_KEY = "xpreiIDE.inlineEditActive";
const CONTEXT_LINES = 20;

interface Pending {
  uri: vscode.Uri;
  version: number; // document version right after we applied the diff
  startLine: number;
  origCount: number;
  newCount: number;
}

export class InlineEditController {
  private pending?: Pending;
  private status?: vscode.StatusBarItem;

  private readonly oldDeco = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: "rgba(255, 80, 80, 0.15)",
    textDecoration: "line-through",
  });
  private readonly newDeco = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: "rgba(80, 200, 120, 0.15)",
  });

  constructor(private readonly registry: ProviderRegistry) {}

  dispose(): void {
    this.oldDeco.dispose();
    this.newDeco.dispose();
    this.status?.dispose();
  }

  async run(): Promise<void> {
    if (this.pending) {
      vscode.window.showInformationMessage(
        "Resolve the current inline edit first (Enter to accept, Esc to reject).",
      );
      return;
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const range = fullLineRange(editor);
    const original = editor.document.getText(range);
    if (!original.trim()) {
      vscode.window.showInformationMessage("Select some code to edit.");
      return;
    }

    const instruction = await vscode.window.showInputBox({
      prompt: "Edit instruction (Cmd-K)",
      placeHolder: "e.g. add error handling, convert to async, add types",
      ignoreFocusOut: true,
    });
    if (!instruction) return;

    let generated: string;
    try {
      generated = await this.generate(editor, range, original, instruction);
    } catch (err) {
      vscode.window.showErrorMessage(err instanceof Error ? err.message : "Edit failed.");
      return;
    }
    const replacement = stripCodeFences(generated);
    if (!replacement.trim()) {
      vscode.window.showInformationMessage("Model returned no replacement.");
      return;
    }

    await this.applyDiff(editor, range, original, replacement);
  }

  private async generate(
    editor: vscode.TextEditor,
    range: vscode.Range,
    original: string,
    instruction: string,
  ): Promise<string> {
    const resolved = await this.registry.resolveInlineEdit();
    if (!resolved) {
      throw new Error("No model selected. Run 'xpreiIDE: Select Model' first.");
    }
    const doc = editor.document;
    const before = doc.getText(
      new vscode.Range(Math.max(0, range.start.line - CONTEXT_LINES), 0, range.start.line, 0),
    );
    const afterEnd = Math.min(doc.lineCount - 1, range.end.line + CONTEXT_LINES);
    const after = doc.getText(
      new vscode.Range(range.end.line + 1, 0, afterEnd, doc.lineAt(afterEnd).text.length),
    );

    const messages = buildEditMessages({
      instruction,
      languageId: doc.languageId,
      selection: original,
      path: vscode.workspace.asRelativePath(doc.uri, false),
      before: before.trim() || undefined,
      after: after.trim() || undefined,
    });

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "xpreiIDE: generating edit…",
        cancellable: true,
      },
      async (_p, token) => {
        const ac = new AbortController();
        token.onCancellationRequested(() => ac.abort());
        let out = "";
        for await (const chunk of resolved.provider.chatStream({
          model: resolved.model,
          messages,
          signal: ac.signal,
        })) {
          out += chunk.delta;
          if (chunk.done) break;
        }
        return out;
      },
    );
  }

  // Replace the selection with "original\nnew", then decorate the two halves.
  private async applyDiff(
    editor: vscode.TextEditor,
    range: vscode.Range,
    original: string,
    replacement: string,
  ): Promise<void> {
    const startLine = range.start.line;
    const origCount = original.split(/\r?\n/).length;
    const newCount = replacement.split(/\r?\n/).length;

    const ok = await editor.edit((b) => b.replace(range, original + "\n" + replacement));
    if (!ok) {
      vscode.window.showErrorMessage("Could not apply the edit.");
      return;
    }

    this.pending = {
      uri: editor.document.uri,
      version: editor.document.version,
      startLine,
      origCount,
      newCount,
    };
    this.decorate(editor);
    void vscode.commands.executeCommand("setContext", CONTEXT_KEY, true);
    this.showStatus();
  }

  private decorate(editor: vscode.TextEditor): void {
    const p = this.pending!;
    const oldRange = new vscode.Range(p.startLine, 0, p.startLine + p.origCount - 1, 0);
    const greenStart = p.startLine + p.origCount;
    const newRange = new vscode.Range(greenStart, 0, greenStart + p.newCount - 1, 0);
    editor.setDecorations(this.oldDeco, [oldRange]);
    editor.setDecorations(this.newDeco, [newRange]);
  }

  async accept(): Promise<void> {
    await this.resolve(true);
  }

  async reject(): Promise<void> {
    await this.resolve(false);
  }

  // accept=true keeps the new lines (deletes the old); false restores original.
  private async resolve(accept: boolean): Promise<void> {
    const p = this.pending;
    if (!p) return;
    const editor = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.toString() === p.uri.toString(),
    );
    if (!editor) {
      this.clear();
      return;
    }
    const doc = editor.document;
    if (doc.version !== p.version) {
      // Document changed under us; bail without touching it.
      this.clear(editor);
      vscode.window.showWarningMessage("Inline edit dismissed: the document changed.");
      return;
    }

    const delRange = accept
      ? new vscode.Range(p.startLine, 0, p.startLine + p.origCount, 0)
      : lastCharsRange(doc, p.startLine + p.origCount - 1, p.startLine + p.origCount + p.newCount - 1);

    await editor.edit((b) => b.delete(delRange));
    this.clear(editor);
  }

  private showStatus(): void {
    this.status?.dispose();
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
    this.status.text = "$(check) Enter: accept   $(x) Esc: reject";
    this.status.tooltip = "xpreiIDE inline edit";
    this.status.show();
  }

  private clear(editor?: vscode.TextEditor): void {
    const target =
      editor ??
      vscode.window.visibleTextEditors.find(
        (e) => e.document.uri.toString() === this.pending?.uri.toString(),
      );
    target?.setDecorations(this.oldDeco, []);
    target?.setDecorations(this.newDeco, []);
    this.status?.dispose();
    this.status = undefined;
    this.pending = undefined;
    void vscode.commands.executeCommand("setContext", CONTEXT_KEY, false);
  }
}

// Expand the selection to whole lines; empty selection → the current line.
function fullLineRange(editor: vscode.TextEditor): vscode.Range {
  const sel = editor.selection;
  let endLine = sel.end.line;
  if (endLine > sel.start.line && sel.end.character === 0) endLine -= 1;
  const endLen = editor.document.lineAt(endLine).text.length;
  return new vscode.Range(sel.start.line, 0, endLine, endLen);
}

// Range covering the "\n<new>" tail: from end of the last original line to the
// end of the last new line. Deleting it restores the original text.
function lastCharsRange(
  doc: vscode.TextDocument,
  lastOrigLine: number,
  lastNewLine: number,
): vscode.Range {
  const startCol = doc.lineAt(lastOrigLine).text.length;
  const endCol = doc.lineAt(lastNewLine).text.length;
  return new vscode.Range(lastOrigLine, startCol, lastNewLine, endCol);
}
