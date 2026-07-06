// Context engine. Owns the vector index and turns @-mentions into a context
// block for the chat. Scans the workspace, embeds chunks via the configured
// embed model, persists the index to extension storage, and updates
// incrementally as files change.

import * as vscode from "vscode";
import { ProviderRegistry } from "../providers/registry";
import { chunkFile, Chunk } from "./chunking";
import { hasContextRequest, Mentions } from "./mentions";
import {
  buildContextMessage,
  FileContext,
  formatFiles,
  formatHits,
} from "./retrieval";
import { VectorStore } from "./vectorstore";

const INDEX_FILE = "index.json";
const EMBED_BATCH = 64;
const MAX_FILE_BYTES = 200 * 1024;
const RETRIEVE_K = 6;
const SCAN_EXCLUDE =
  "**/{node_modules,.git,dist,out,build,.next,.turbo,coverage,vendor,.venv,__pycache__}/**";

export class ContextEngine {
  private store = new VectorStore();
  private loaded = false;

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly storageUri: vscode.Uri | undefined,
    private readonly log: vscode.OutputChannel,
  ) {}

  get indexSize(): number {
    return this.store.size;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.storageUri) return;
    try {
      const bytes = await vscode.workspace.fs.readFile(this.indexUri());
      this.store = VectorStore.fromJSON(JSON.parse(Buffer.from(bytes).toString("utf8")));
      this.log.appendLine(`[context] loaded index: ${this.store.size} chunks`);
    } catch {
      // No persisted index yet — first run.
    }
  }

  // Resolve embed model and return a callable + its key. Undefined if unset.
  private async embedder(): Promise<
    { key: string; embed: (texts: string[]) => Promise<number[][]> } | undefined
  > {
    const resolved = await this.registry.resolveEmbed();
    if (!resolved) return undefined;
    if (!resolved.provider.embed) {
      throw new Error(`Provider '${resolved.provider.label}' does not support embeddings.`);
    }
    const model = resolved.model;
    const provider = resolved.provider;
    return {
      key: ProviderRegistry.formatActive(provider.id, model),
      embed: (texts) => provider.embed!(texts, model),
    };
  }

  async rebuild(token?: vscode.CancellationToken): Promise<number> {
    await this.load();
    const embedder = await this.embedder();
    if (!embedder) {
      throw new Error("No embed model set. Run 'xpreiIDE: Select Embedding Model' first.");
    }

    const uris = await vscode.workspace.findFiles("**/*", SCAN_EXCLUDE);
    this.store.clear();

    let dimConfigured = false;
    let indexed = 0;
    const pending: Chunk[] = [];

    const flush = async () => {
      if (pending.length === 0) return;
      const batch = pending.splice(0, pending.length);
      const vectors = await embedder.embed(batch.map((c) => c.text));
      if (!dimConfigured && vectors[0]) {
        this.store.configure(embedder.key, vectors[0].length);
        dimConfigured = true;
      }
      this.store.upsert(batch, vectors);
      indexed += batch.length;
    };

    for (const uri of uris) {
      if (token?.isCancellationRequested) break;
      const chunks = await this.chunksFor(uri);
      for (const c of chunks) {
        pending.push(c);
        if (pending.length >= EMBED_BATCH) await flush();
      }
    }
    await flush();

    if (!dimConfigured) this.store.configure(embedder.key, 0);
    await this.persist();
    this.log.appendLine(`[context] rebuilt index: ${indexed} chunks from ${uris.length} files`);
    return indexed;
  }

  async updateFile(uri: vscode.Uri): Promise<void> {
    await this.load();
    if (this.store.size === 0) return; // no index built yet; skip
    const embedder = await this.embedder();
    if (!embedder || embedder.key !== this.store.modelKey) return;

    const path = this.rel(uri);
    this.store.removeByPath(path);
    const chunks = await this.chunksFor(uri);
    if (chunks.length > 0) {
      const vectors = await embedder.embed(chunks.map((c) => c.text));
      this.store.upsert(chunks, vectors);
    }
    await this.persist();
  }

  async removeFile(uri: vscode.Uri): Promise<void> {
    await this.load();
    this.store.removeByPath(this.rel(uri));
    await this.persist();
  }

  // Turn parsed mentions into a context message, or "" if nothing to add.
  async buildContext(mentions: Mentions): Promise<string> {
    if (!hasContextRequest(mentions)) return "";
    await this.load();

    const files = await this.readFiles(mentions.files);
    let retrieved = "";

    if (mentions.codebase && this.store.size > 0 && mentions.cleaned) {
      const embedder = await this.embedder();
      if (embedder && embedder.key === this.store.modelKey) {
        const [qv] = await embedder.embed([mentions.cleaned]);
        if (qv) retrieved = formatHits(this.store.search(qv, RETRIEVE_K));
      }
    }

    return buildContextMessage({
      files: files.length ? formatFiles(files) : undefined,
      retrieved: retrieved || undefined,
    });
  }

  private async chunksFor(uri: vscode.Uri): Promise<Chunk[]> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_FILE_BYTES) return [];
      const bytes = await vscode.workspace.fs.readFile(uri);
      return chunkFile(this.rel(uri), Buffer.from(bytes).toString("utf8"));
    } catch {
      return [];
    }
  }

  private async readFiles(paths: string[]): Promise<FileContext[]> {
    const out: FileContext[] = [];
    for (const p of paths) {
      const matches = await vscode.workspace.findFiles(p, SCAN_EXCLUDE, 1);
      const uri = matches[0] ?? this.resolveRel(p);
      if (!uri) continue;
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        out.push({ path: this.rel(uri), content: Buffer.from(bytes).toString("utf8") });
      } catch {
        // ignore unreadable / missing
      }
    }
    return out;
  }

  private resolveRel(p: string): vscode.Uri | undefined {
    const root = vscode.workspace.workspaceFolders?.[0];
    return root ? vscode.Uri.joinPath(root.uri, p) : undefined;
  }

  private rel(uri: vscode.Uri): string {
    return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
  }

  private indexUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.storageUri!, INDEX_FILE);
  }

  private async persist(): Promise<void> {
    if (!this.storageUri) return;
    try {
      await vscode.workspace.fs.createDirectory(this.storageUri);
      const data = Buffer.from(JSON.stringify(this.store.toJSON()), "utf8");
      await vscode.workspace.fs.writeFile(this.indexUri(), data);
    } catch (err) {
      this.log.appendLine(`[context] persist failed: ${String(err)}`);
    }
  }
}
