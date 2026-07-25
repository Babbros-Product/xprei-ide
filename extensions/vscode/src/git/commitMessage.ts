// Generate a commit message from the staged diff via VS Code's built-in Git
// extension API and the active model, writing straight into the SCM input box.

import * as vscode from "vscode";
import { ProviderRegistry } from "../providers/registry";
import { stripCodeFences } from "@xprei/core";

// Minimal ambient typing for the subset of the built-in "vscode.git"
// extension's API this module uses — that extension ships no public .d.ts.
interface GitRepository {
  inputBox: { value: string };
  diff(cached?: boolean): Promise<string>;
}
interface GitAPI {
  repositories: GitRepository[];
}
interface GitExtensionExports {
  getAPI(version: 1): GitAPI;
}

async function getGitApi(): Promise<GitAPI | undefined> {
  const ext = vscode.extensions.getExtension<GitExtensionExports>("vscode.git");
  if (!ext) return undefined;
  const exports = ext.isActive ? ext.exports : await ext.activate();
  return exports.getAPI(1);
}

const SYSTEM_PROMPT =
  "You write concise, conventional git commit messages: a type prefix " +
  "(feat/fix/refactor/docs/test/chore/style), imperative mood, one summary " +
  "line under 72 characters, optionally a blank line then a short body. " +
  "Reply with ONLY the commit message text — no commentary, no code fences.";

const MAX_DIFF_CHARS = 6000;

export async function generateCommitMessage(registry: ProviderRegistry): Promise<void> {
  const api = await getGitApi();
  const repo = api?.repositories[0];
  if (!repo) {
    vscode.window.showWarningMessage("No git repository found in this workspace.");
    return;
  }

  const diff = await repo.diff(true);
  if (!diff.trim()) {
    vscode.window.showInformationMessage("No staged changes to summarize — stage some changes first.");
    return;
  }

  const resolved = await registry.resolveCommitMessage();
  if (!resolved) {
    vscode.window.showWarningMessage("No model selected. Run 'xpreiIDE: Select Model' first.");
    return;
  }

  const clippedDiff = diff.length > MAX_DIFF_CHARS ? diff.slice(0, MAX_DIFF_CHARS) + "\n… (truncated)" : diff;

  let message: string;
  try {
    message = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "xpreiIDE: generating commit message…",
        cancellable: true,
      },
      async (_p, token) => {
        const ac = new AbortController();
        token.onCancellationRequested(() => ac.abort());
        let out = "";
        for await (const chunk of resolved.provider.chatStream({
          model: resolved.model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: `Staged diff:\n\n${clippedDiff}` },
          ],
          signal: ac.signal,
        })) {
          out += chunk.delta;
          if (chunk.done) break;
        }
        return stripCodeFences(out);
      },
    );
  } catch (err) {
    vscode.window.showErrorMessage(err instanceof Error ? err.message : "Commit message generation failed.");
    return;
  }

  if (!message) return;
  repo.inputBox.value = message;
}
