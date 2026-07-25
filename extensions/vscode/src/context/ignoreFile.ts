// User-editable ignore file for the RAG indexer, .gitignore-lite syntax
// (see docs/superpowers/specs/2026-07-26-phase1b-ignore-file-design.md
// for the supported subset). Mirrors projectRules.ts exactly: no
// caching, read fresh on every call.

import * as vscode from "vscode";
import { parseIgnorePatterns } from "@xprei/core";

const IGNORE_FILENAME = ".xpreiIDEignore";

export async function loadIgnorePatterns(): Promise<string[]> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return [];
  const uri = vscode.Uri.joinPath(folder.uri, IGNORE_FILENAME);
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return parseIgnorePatterns(Buffer.from(bytes).toString("utf8"));
  } catch {
    return [];
  }
}
