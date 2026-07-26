// Project-level instructions: the legacy global ".xpreiIDErules" plus
// glob-scoped rule files under ".xpreiIDE/rules/*.md" (frontmatter
// `globs:` — see @xprei/core's rules.ts). Scoped rules apply when the
// ACTIVE EDITOR's path matches; global ones always. Read fresh on
// every call, no caching.

import * as vscode from "vscode";
import { parseRuleFile, ruleApplies } from "@xprei/core";

const RULES_FILENAME = ".xpreiIDErules";

export async function loadProjectRules(activeRelPath?: string): Promise<string> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return "";
  const parts: string[] = [];

  try {
    const bytes = await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(folder.uri, RULES_FILENAME),
    );
    const text = Buffer.from(bytes).toString("utf8").trim();
    if (text) parts.push(text);
  } catch {
    // no legacy rules file
  }

  try {
    const dirUri = vscode.Uri.joinPath(folder.uri, ".xpreiIDE", "rules");
    const entries = await vscode.workspace.fs.readDirectory(dirUri);
    const names = entries
      .filter(([name, type]) => type === vscode.FileType.File && name.endsWith(".md"))
      .map(([name]) => name)
      .sort();
    for (const name of names) {
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dirUri, name));
        const { globs, body } = parseRuleFile(Buffer.from(bytes).toString("utf8"));
        if (body.trim() && ruleApplies(globs, activeRelPath)) parts.push(body.trim());
      } catch {
        // unreadable rule file — skip
      }
    }
  } catch {
    // no rules directory
  }

  return parts.join("\n\n");
}
