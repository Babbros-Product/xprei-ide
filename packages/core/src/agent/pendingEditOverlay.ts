// PendingEditOverlay — an AgentHost decorator that buffers writes/deletes in
// memory instead of touching the real host. Reads see the buffered content;
// the real host is only touched by flush(). Lets the agent run a full turn
// against consistent, undo-able in-memory state before the user reviews and
// commits (or discards) the batch of edits.

import { AgentHost, ExecResult, GrepHit } from "./host";
import { matchGlob } from "./glob";

export interface PendingEdit {
  path: string;
  before: string;
  existed: boolean;
  after: string;
  deleted?: boolean;
}

export interface FlushResult {
  flushed: PendingEdit[];
  failed: { path: string; error: string }[];
}

export class PendingEditOverlay implements AgentHost {
  private readonly entries = new Map<string, PendingEdit>();

  constructor(private readonly real: AgentHost) {}

  get cwd(): string {
    return this.real.cwd;
  }

  get pending(): PendingEdit[] {
    return [...this.entries.values()];
  }

  async readFile(path: string): Promise<string> {
    const entry = this.entries.get(path);
    if (entry) {
      if (entry.deleted) throw new Error(`ENOENT: ${path}`);
      return entry.after;
    }
    return this.real.readFile(path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    const existing = this.entries.get(path);
    if (existing) {
      existing.after = content;
      existing.deleted = false;
      return;
    }
    const { before, existed } = await this.captureBefore(path);
    this.entries.set(path, { path, before, existed, after: content });
  }

  async deleteFile(path: string): Promise<void> {
    const existing = this.entries.get(path);
    if (existing) {
      if (!existing.existed) {
        // Overlay-only creation being deleted again: net zero, never touches real disk.
        this.entries.delete(path);
        return;
      }
      existing.after = "";
      existing.deleted = true;
      return;
    }
    const { before, existed } = await this.captureBefore(path);
    if (!existed) return;
    this.entries.set(path, { path, before, existed: true, after: "", deleted: true });
  }

  async exists(path: string): Promise<boolean> {
    const entry = this.entries.get(path);
    if (entry) return !entry.deleted;
    return this.real.exists(path);
  }

  async listDir(path: string): Promise<string[]> {
    const out = new Set(await this.real.listDir(path));
    const prefix = path === "." || path === "" ? "" : path.replace(/\/$/, "") + "/";
    for (const entry of this.entries.values()) {
      if (!entry.path.startsWith(prefix)) continue;
      const rest = entry.path.slice(prefix.length);
      const slash = rest.indexOf("/");
      const name = slash < 0 ? rest : rest.slice(0, slash) + "/";
      if (entry.deleted) out.delete(name);
      else out.add(name);
    }
    return [...out];
  }

  async grep(query: string, path?: string): Promise<GrepHit[]> {
    const real = await this.real.grep(query, path);
    const filtered = real.filter((hit) => !this.entries.has(hit.file));
    const needle = query.toLowerCase();
    const overlayHits: GrepHit[] = [];
    for (const entry of this.entries.values()) {
      if (entry.deleted) continue;
      if (path && !entry.path.startsWith(path)) continue;
      entry.after.split(/\r?\n/).forEach((text, i) => {
        if (text.toLowerCase().includes(needle)) overlayHits.push({ file: entry.path, line: i + 1, text });
      });
    }
    return [...filtered, ...overlayHits];
  }

  async glob(pattern: string, path?: string): Promise<string[]> {
    const real = await this.real.glob(pattern, path);
    const filtered = real.filter((file) => !this.entries.has(file));
    const overlayFiles: string[] = [];
    for (const entry of this.entries.values()) {
      if (entry.deleted) continue;
      if (path && !entry.path.startsWith(path)) continue;
      if (matchGlob(pattern, entry.path)) overlayFiles.push(entry.path);
    }
    return [...filtered, ...overlayFiles];
  }

  async exec(command: string): Promise<ExecResult> {
    return this.real.exec(command);
  }

  async flush(path?: string): Promise<FlushResult> {
    const target = path ? this.entries.get(path) : undefined;
    const targets = path ? (target ? [target] : []) : [...this.entries.values()];
    const flushed: PendingEdit[] = [];
    const failed: { path: string; error: string }[] = [];
    for (const entry of targets) {
      try {
        if (entry.deleted) await this.real.deleteFile(entry.path);
        else await this.real.writeFile(entry.path, entry.after);
        this.entries.delete(entry.path);
        flushed.push(entry);
      } catch (err) {
        failed.push({ path: entry.path, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { flushed, failed };
  }

  discard(path: string): void {
    this.entries.delete(path);
  }

  private async captureBefore(path: string): Promise<{ before: string; existed: boolean }> {
    try {
      return { before: await this.real.readFile(path), existed: true };
    } catch {
      return { before: "", existed: false };
    }
  }
}
