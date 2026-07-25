// VS Code implementation of the core AgentHost seam. The interface itself lives
// in @xprei/core so the agent brain stays platform-neutral; this binds it to
// vscode.workspace.fs / child_process. (The standalone sidecar ships its own
// Node-fs host instead.)

import * as vscode from "vscode";
import { promisify } from "node:util";
import { exec as execCb } from "node:child_process";
import { AgentHost, ExecResult, GrepHit, resolveWorkspacePath } from "@xprei/core";

const execAsync = promisify(execCb);

const MAX_GREP_HITS = 50;
const GREP_EXCLUDE = "{**/node_modules/**,**/.git/**,**/dist/**,**/out/**}";
const EXEC_TIMEOUT_MS = 120_000;
const EXEC_MAX_BUFFER = 4 * 1024 * 1024;

// VS Code-backed host rooted at the first workspace folder.
export class VscodeAgentHost implements AgentHost {
  constructor(private readonly root: vscode.Uri) {}

  get cwd(): string {
    return this.root.fsPath;
  }

  static create(): VscodeAgentHost {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) throw new Error("Agent needs an open workspace folder.");
    return new VscodeAgentHost(folder.uri);
  }

  private resolve(rel: string): vscode.Uri {
    const resolved = resolveWorkspacePath(this.root.fsPath, rel);
    if ("error" in resolved) throw new Error(resolved.error);
    return vscode.Uri.joinPath(this.root, resolved.relPath);
  }

  async readFile(path: string): Promise<string> {
    const bytes = await vscode.workspace.fs.readFile(this.resolve(path));
    return Buffer.from(bytes).toString("utf8");
  }

  async writeFile(path: string, content: string): Promise<void> {
    const uri = this.resolve(path);
    // Ensure parent dirs exist (createFile in a new folder).
    const dir = uri.with({ path: uri.path.replace(/\/[^/]+$/, "") });
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
  }

  async deleteFile(path: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(this.resolve(path));
    } catch {
      /* already gone */
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(this.resolve(path));
      return true;
    } catch {
      return false;
    }
  }

  async listDir(path: string): Promise<string[]> {
    const entries = await vscode.workspace.fs.readDirectory(this.resolve(path || "."));
    return entries.map(
      ([name, kind]) => (kind === vscode.FileType.Directory ? `${name}/` : name),
    );
  }

  async grep(query: string, path?: string): Promise<GrepHit[]> {
    const include = path ? `${path.replace(/\/$/, "")}/**/*` : "**/*";
    const uris = await vscode.workspace.findFiles(include, GREP_EXCLUDE, 2000);
    const hits: GrepHit[] = [];
    const needle = query.toLowerCase();
    for (const uri of uris) {
      if (hits.length >= MAX_GREP_HITS) break;
      let content: string;
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (bytes.length > 200_000) continue;
        content = Buffer.from(bytes).toString("utf8");
      } catch {
        continue;
      }
      const rel = vscode.workspace.asRelativePath(uri, false);
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length && hits.length < MAX_GREP_HITS; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          hits.push({ file: rel, line: i + 1, text: lines[i].trim().slice(0, 200) });
        }
      }
    }
    return hits;
  }

  async exec(command: string): Promise<ExecResult> {
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: this.cwd,
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: EXEC_MAX_BUFFER,
        windowsHide: true,
      });
      return { stdout, stderr, code: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? e.message ?? "command failed",
        code: typeof e.code === "number" ? e.code : 1,
      };
    }
  }
}
