// Project-level instructions, Cursor .cursorrules / Copilot instructions-file
// style: a plain-text ".xpreiIDErules" at the workspace root, injected as an
// extra system-prompt block for every chat/edit/agent turn.

import * as vscode from "vscode";

const RULES_FILENAME = ".xpreiIDErules";

export async function loadProjectRules(): Promise<string> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return "";
  const uri = vscode.Uri.joinPath(folder.uri, RULES_FILENAME);
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString("utf8").trim();
  } catch {
    return "";
  }
}
