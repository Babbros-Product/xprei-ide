// In-memory AgentHost for tests. Backs files with a Map; records exec calls.

import { AgentHost, ExecResult, GrepHit } from "./host";

export class FakeHost implements AgentHost {
  readonly cwd = "/work";
  readonly files: Map<string, string>;
  readonly execCalls: string[] = [];
  execResult: ExecResult = { stdout: "", stderr: "", code: 0 };

  constructor(initial: Record<string, string> = {}) {
    this.files = new Map(Object.entries(initial));
  }

  async readFile(path: string): Promise<string> {
    const v = this.files.get(path);
    if (v === undefined) throw new Error("ENOENT");
    return v;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async deleteFile(path: string): Promise<void> {
    this.files.delete(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async listDir(path: string): Promise<string[]> {
    const prefix = path === "." || path === "" ? "" : path.replace(/\/$/, "") + "/";
    const out = new Set<string>();
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf("/");
      out.add(slash < 0 ? rest : rest.slice(0, slash) + "/");
    }
    return [...out];
  }

  async grep(query: string, path?: string): Promise<GrepHit[]> {
    const hits: GrepHit[] = [];
    const needle = query.toLowerCase();
    for (const [file, content] of this.files) {
      if (path && !file.startsWith(path)) continue;
      content.split(/\r?\n/).forEach((text, i) => {
        if (text.toLowerCase().includes(needle)) hits.push({ file, line: i + 1, text });
      });
    }
    return hits;
  }

  async exec(command: string): Promise<ExecResult> {
    this.execCalls.push(command);
    return this.execResult;
  }
}
