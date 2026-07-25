// Checkpoint — git-free revert for an agent run. On first write to a path we
// snapshot its prior content (or mark it as newly created). revert() restores
// every touched file to that snapshot, so a bad run is one call to undo.

import { AgentHost } from "./host";

export interface Snapshot {
  existed: boolean;
  content: string; // prior content when existed; "" when new
}

export class Checkpoint {
  private readonly snaps = new Map<string, Snapshot>();

  constructor(private readonly host: AgentHost) {}

  get touched(): string[] {
    return [...this.snaps.keys()];
  }

  // Prior content captured for `path` (the first-touch snapshot), if any —
  // used to build an after-the-write diff for gutter decorations.
  getSnapshot(path: string): Snapshot | undefined {
    return this.snaps.get(path);
  }

  // Record a path's prior state exactly once, before the first write to it.
  async note(path: string): Promise<void> {
    if (this.snaps.has(path)) return;
    const existed = await this.host.exists(path);
    const content = existed ? await this.host.readFile(path).catch(() => "") : "";
    this.snaps.set(path, { existed, content });
  }

  // Restore all touched files to their snapshot: prior content for files that
  // existed, deletion for ones the run newly created.
  async revert(): Promise<void> {
    for (const [path, snap] of this.snaps) {
      if (snap.existed) await this.host.writeFile(path, snap.content);
      else await this.host.deleteFile(path);
    }
  }
}
