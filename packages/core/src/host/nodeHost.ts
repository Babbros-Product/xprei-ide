// Node implementation of the AgentHost seam — the standalone-sidecar counterpart
// to the extension's VscodeAgentHost. Binds the agent's file/exec tools to
// node:fs / child_process, rooted at a workspace directory, with the same
// path-safety (resolveWorkspacePath) and index-exclusion rules the rest of the
// core uses. Pure Node, no editor dependency.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { exec as execCb } from "node:child_process";
import { AgentHost, ExecResult, GrepHit } from "../agent/host";
import { resolveWorkspacePath } from "../agent/pathResolve";
import { isExcludedPath } from "../context/exclude";

const execAsync = promisify(execCb);

const MAX_GREP_HITS = 50;
const MAX_GREP_FILE_BYTES = 200_000;
const EXEC_TIMEOUT_MS = 120_000;
const EXEC_MAX_BUFFER = 4 * 1024 * 1024;

export class NodeAgentHost implements AgentHost {
  constructor(private readonly root: string) {}

  get cwd(): string {
    return this.root;
  }

  // Resolve a model-supplied (possibly absolute/Windows) path to an absolute
  // path guaranteed to stay inside the workspace root.
  private resolve(rel: string): string {
    const resolved = resolveWorkspacePath(this.root, rel);
    if ("error" in resolved) throw new Error(resolved.error);
    return path.join(this.root, resolved.relPath);
  }

  private toRel(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join("/");
  }

  async readFile(p: string): Promise<string> {
    return fs.readFile(this.resolve(p), "utf8");
  }

  async writeFile(p: string, content: string): Promise<void> {
    const abs = this.resolve(p);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
  }

  async deleteFile(p: string): Promise<void> {
    try {
      await fs.rm(this.resolve(p), { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  }

  async exists(p: string): Promise<boolean> {
    try {
      await fs.stat(this.resolve(p));
      return true;
    } catch {
      return false;
    }
  }

  async listDir(p: string): Promise<string[]> {
    const entries = await fs.readdir(this.resolve(p || "."), { withFileTypes: true });
    return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
  }

  async grep(query: string, p?: string): Promise<GrepHit[]> {
    const start = this.resolve(p || ".");
    const hits: GrepHit[] = [];
    const needle = query.toLowerCase();
    await this.walk(start, hits, needle);
    return hits;
  }

  private async walk(dir: string, hits: GrepHit[], needle: string): Promise<void> {
    if (hits.length >= MAX_GREP_HITS) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (hits.length >= MAX_GREP_HITS) return;
      const abs = path.join(dir, e.name);
      const rel = this.toRel(abs);
      if (isExcludedPath(rel)) continue;
      if (e.isDirectory()) {
        await this.walk(abs, hits, needle);
        continue;
      }
      if (!e.isFile()) continue;
      let content: string;
      try {
        const stat = await fs.stat(abs);
        if (stat.size > MAX_GREP_FILE_BYTES) continue;
        content = await fs.readFile(abs, "utf8");
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length && hits.length < MAX_GREP_HITS; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          hits.push({ file: rel, line: i + 1, text: lines[i].trim().slice(0, 200) });
        }
      }
    }
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
