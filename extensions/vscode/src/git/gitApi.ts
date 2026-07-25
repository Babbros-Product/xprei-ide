// Ambient typing for the subset of the built-in "vscode.git" extension's
// API this codebase uses — that extension ships no public .d.ts. Shared
// by commitMessage.ts (SCM commit-message generation) and
// contextEngine.ts (the @diff chat mention).

import * as vscode from "vscode";

export interface GitRepository {
  inputBox: { value: string };
  diff(cached?: boolean): Promise<string>;
}
export interface GitAPI {
  repositories: GitRepository[];
}
export interface GitExtensionExports {
  getAPI(version: 1): GitAPI;
}

export async function getGitApi(): Promise<GitAPI | undefined> {
  const ext = vscode.extensions.getExtension<GitExtensionExports>("vscode.git");
  if (!ext) return undefined;
  const exports = ext.isActive ? ext.exports : await ext.activate();
  return exports.getAPI(1);
}
