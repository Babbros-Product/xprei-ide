// Context engine. Owns the vector index and turns @-mentions into a context
// block for the chat. Scans the workspace, embeds chunks via the configured
// embed model, persists the index to extension storage, and updates
// incrementally as files change.

import * as vscode from "vscode";
import { ProviderRegistry } from "../providers/registry";
import { chunkFile, Chunk } from "@xprei/core";
import { hasContextRequest, Mentions } from "@xprei/core";
import {
  buildContextMessage,
  budgetContext,
  FileContext,
  formatFiles,
  formatHits,
  formatProblems,
  MIN_SCORE,
  ProblemInfo,
  SegmentTier,
  TRUNCATION_MARKER,
} from "@xprei/core";
import { VectorStore, SearchHit } from "@xprei/core";
import { isExcludedPath, SCAN_EXCLUDE } from "@xprei/core";

const INDEX_FILE = "index.json";
const EMBED_BATCH = 64;
const MAX_FILE_BYTES = 200 * 1024;
const MAX_FILE_CHARS = 8000;
const RETRIEVE_K = 6;

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
    const path = this.rel(uri);
    if (isExcludedPath(path)) return; // never index node_modules/.git/dist/...
    await this.load();
    if (this.store.size === 0) return; // no index built yet; skip
    const embedder = await this.embedder();
    if (!embedder || embedder.key !== this.store.modelKey) return;

    this.store.removeByPath(path);
    const chunks = await this.chunksFor(uri);
    if (chunks.length > 0) {
      const vectors = await embedder.embed(chunks.map((c) => c.text));
      this.store.upsert(chunks, vectors);
    }
    await this.persist();
  }

  async removeFile(uri: vscode.Uri): Promise<void> {
    const path = this.rel(uri);
    if (isExcludedPath(path)) return; // excluded paths are never in the index
    await this.load();
    this.store.removeByPath(path);
    await this.persist();
  }

  // Turn parsed mentions into a context message, or "" if nothing to add.
  // contextWindow is the resolved provider's token-count capability — used
  // to size the context block via budgetContext() instead of blindly
  // concatenating everything the mentions resolved to. Tier priority
  // (highest to lowest): @file: ("break", explicit request) > @problems
  // ("skip", compact and actionable) > @open ("break", bulkier, ordered
  // like files) > @codebase hits ("skip", a relevance guess). Every tier
  // is built unconditionally (even when empty) — budgetContext's return
  // value is positionally aligned with the input tier array.
  async buildContext(mentions: Mentions, contextWindow: number): Promise<string> {
    if (!hasContextRequest(mentions)) return "";
    await this.load();

    const files = await this.readFiles(mentions.files);
    let hits: SearchHit[] = [];

    if (mentions.codebase && this.store.size > 0 && mentions.cleaned) {
      const embedder = await this.embedder();
      if (embedder && embedder.key === this.store.modelKey) {
        const [qv] = await embedder.embed([mentions.cleaned]);
        if (qv) hits = this.store.search(qv, RETRIEVE_K);
      }
    }

    const openFiles = mentions.open
      ? await this.readOpenFiles(new Set(files.map((f) => f.path)))
      : [];
    const problems = mentions.problems ? this.readProblems() : [];

    const fileTier: SegmentTier = {
      segments: files.map((f) => ({ text: f.content, data: f })),
      strategy: "break",
    };
    const problemTier: SegmentTier = {
      segments: problems.map((p) => ({ text: formatProblems([p]), data: p })),
      strategy: "skip",
    };
    const openTier: SegmentTier = {
      segments: openFiles.map((f) => ({ text: f.content, data: f })),
      strategy: "break",
    };
    const eligibleHits = hits.filter((h) => h.score >= MIN_SCORE);
    const hitTier: SegmentTier = {
      segments: eligibleHits.map((h) => ({ text: h.chunk.text, data: h })),
      strategy: "skip",
    };

    const [keptFileSegs, keptProblemSegs, keptOpenSegs, keptHitSegs] = budgetContext(
      [fileTier, problemTier, openTier, hitTier],
      contextWindow,
    );

    const budgetedFiles: FileContext[] = keptFileSegs.map((seg) => ({
      ...(seg.data as FileContext),
      content: seg.text,
    }));
    // "skip" never truncates a whole diagnostic (each one is its own
    // segment), so seg.data is used raw.
    const budgetedProblems: ProblemInfo[] = keptProblemSegs.map((seg) => seg.data as ProblemInfo);
    const budgetedOpenFiles: FileContext[] = keptOpenSegs.map((seg) => ({
      ...(seg.data as FileContext),
      content: seg.text,
    }));
    // "skip" never truncates, so seg.text === chunk.text and data can be used raw.
    // If this tier ever becomes "break", reconstruct from seg.text like files do.
    const budgetedHits: SearchHit[] = keptHitSegs.map((seg) => seg.data as SearchHit);

    const allFiles = [...budgetedFiles, ...budgetedOpenFiles];

    return buildContextMessage({
      files: allFiles.length ? formatFiles(allFiles, Number.POSITIVE_INFINITY) : undefined,
      problems: budgetedProblems.length ? formatProblems(budgetedProblems) : undefined,
      retrieved: budgetedHits.length ? formatHits(budgetedHits, Number.NEGATIVE_INFINITY) : undefined,
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
        const raw = Buffer.from(bytes).toString("utf8");
        const content =
          raw.length > MAX_FILE_CHARS ? raw.slice(0, MAX_FILE_CHARS) + TRUNCATION_MARKER : raw;
        out.push({ path: this.rel(uri), content });
      } catch {
        // ignore unreadable / missing
      }
    }
    return out;
  }

  // Every open tab's resolved workspace-relative path, across all tab
  // groups (including background ones the user isn't currently looking
  // at). Shared by readOpenFiles() and readProblems() so both derive
  // "what's open" from one vscode.window.tabGroups.all pass.
  private openTabPaths(): { uri: vscode.Uri; path: string }[] {
    const out: { uri: vscode.Uri; path: string }[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText) {
          out.push({ uri: tab.input.uri, path: this.rel(tab.input.uri) });
        }
      }
    }
    return out;
  }

  // Read every open tab's content, excluding any path already covered by
  // an explicit @file: mention (that file is inlined once, via the file
  // tier).
  private async readOpenFiles(excludePaths: Set<string>): Promise<FileContext[]> {
    const out: FileContext[] = [];
    for (const { uri, path } of this.openTabPaths()) {
      if (isExcludedPath(path)) continue;
      if (excludePaths.has(path)) continue;
      try {
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
        const raw = doc
          ? doc.getText()
          : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
        const content =
          raw.length > MAX_FILE_CHARS ? raw.slice(0, MAX_FILE_CHARS) + TRUNCATION_MARKER : raw;
        out.push({ path, content });
      } catch {
        // ignore unreadable / missing
      }
    }
    return out;
  }

  // Error/warning diagnostics scoped to files currently open in a tab —
  // "what's broken in front of me right now," not the whole workspace.
  private readProblems(): ProblemInfo[] {
    const openPaths = new Set(this.openTabPaths().map((t) => t.path));

    const out: ProblemInfo[] = [];
    for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
      const path = this.rel(uri);
      if (!openPaths.has(path)) continue;
      for (const d of diagnostics) {
        if (d.severity === vscode.DiagnosticSeverity.Error) {
          out.push({ path, line: d.range.start.line + 1, severity: "error", message: d.message });
        } else if (d.severity === vscode.DiagnosticSeverity.Warning) {
          out.push({ path, line: d.range.start.line + 1, severity: "warning", message: d.message });
        }
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
