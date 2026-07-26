// User-defined slash commands: each ".xpreiIDE/prompts/<name>.md"
// becomes "/<name>" in the chat composer, expanding exactly like the
// built-in slash commands. Loaded when the webview posts "ready" — no
// watcher; edits require reopening the panel (documented v1
// limitation).

import * as vscode from "vscode";

export interface CustomPrompt {
  name: string;
  template: string;
}

export async function loadCustomPrompts(): Promise<CustomPrompt[]> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return [];
  try {
    const dirUri = vscode.Uri.joinPath(folder.uri, ".xpreiIDE", "prompts");
    const entries = await vscode.workspace.fs.readDirectory(dirUri);
    const out: CustomPrompt[] = [];
    for (const [fileName, type] of entries) {
      if (type !== vscode.FileType.File || !fileName.endsWith(".md")) continue;
      const name = fileName.slice(0, -3).toLowerCase();
      if (!/^[a-z0-9-]+$/.test(name)) continue;
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dirUri, fileName));
        const template = Buffer.from(bytes).toString("utf8").trim();
        if (template) out.push({ name, template });
      } catch {
        // unreadable — skip
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}
