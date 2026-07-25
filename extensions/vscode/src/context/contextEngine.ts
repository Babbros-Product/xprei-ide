// Context engine. Owns the vector index and turns @-mentions into a context
// block for the chat. Scans the workspace, embeds chunks via the configured
// embed model, persists the index to extension storage, and updates
// incrementally as files change.

import * as vscode from "vscode";
import { lookup } from "node:dns/promises";
import { ProviderRegistry } from "../providers/registry";
import { getGitApi } from "../git/gitApi";
import { chunkFile, Chunk } from "@xprei/core";
import { hasContextRequest, Mentions } from "@xprei/core";
import {
  buildContextMessage,
  budgetContext,
  FileContext,
  formatDiff,
  formatFiles,
  formatHits,
  formatProblems,
  formatTerminal,
  formatUrl,
  isBlockedAddress,
  isSafeUrl,
  MIN_SCORE,
  ProblemInfo,
  SegmentTier,
  stripHtml,
  TRUNCATION_MARKER,
} from "@xprei/core";
import { VectorStore, SearchHit } from "@xprei/core";
import { isExcludedPath, SCAN_EXCLUDE } from "@xprei/core";

const INDEX_FILE = "index.json";
const EMBED_BATCH = 64;
const MAX_FILE_BYTES = 200 * 1024;
const MAX_FILE_CHARS = 8000;
const RETRIEVE_K = 6;
const MAX_TERMINAL_CHARS = 8000;
const TERMINAL_EXEC_TIMEOUT_MS = 120_000;
// Separate, shorter bound just for "does this terminal even support
// shell integration" — if it hasn't attached in this long, it's not
// going to (some shells/environments never enable it), so there's no
// reason to burn the full 120s exec budget waiting for it.
const SHELL_INTEGRATION_TIMEOUT_MS = 5_000;
const MAX_URL_BYTES = 500_000;
const URL_FETCH_TIMEOUT_MS = 10_000;
const MAX_URL_REDIRECTS = 5;

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
  // ("skip", compact and actionable) > @diff ("break", one segment) >
  // @terminal ("break", one segment, confirmation-gated) > @url
  // ("break", one segment, SSRF-checked) > @open ("break", bulkier,
  // ordered like files) > @codebase hits ("skip", a relevance guess).
  // Every tier is built unconditionally (even when empty) —
  // budgetContext's return value is positionally aligned with the input
  // tier array.
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
    const diff = mentions.diff ? await this.readDiff() : "";
    const terminalOutput = mentions.terminalCommand
      ? await this.runTerminalCommand(mentions.terminalCommand)
      : "";
    const urlContent = mentions.url ? await this.fetchUrl(mentions.url) : "";

    const fileTier: SegmentTier = {
      segments: files.map((f) => ({ text: f.content, data: f })),
      strategy: "break",
    };
    const problemTier: SegmentTier = {
      segments: problems.map((p) => ({ text: formatProblems([p]), data: p })),
      strategy: "skip",
    };
    const diffTier: SegmentTier = {
      segments: diff ? [{ text: formatDiff(diff), data: null }] : [],
      strategy: "break",
    };
    const terminalTier: SegmentTier = {
      segments: terminalOutput
        ? [{ text: formatTerminal(mentions.terminalCommand!, terminalOutput), data: null }]
        : [],
      strategy: "break",
    };
    const urlTier: SegmentTier = {
      segments: urlContent ? [{ text: formatUrl(mentions.url!, urlContent), data: null }] : [],
      strategy: "break",
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

    const [
      keptFileSegs,
      keptProblemSegs,
      keptDiffSegs,
      keptTerminalSegs,
      keptUrlSegs,
      keptOpenSegs,
      keptHitSegs,
    ] = budgetContext(
      [fileTier, problemTier, diffTier, terminalTier, urlTier, openTier, hitTier],
      contextWindow,
    );

    const budgetedFiles: FileContext[] = keptFileSegs.map((seg) => ({
      ...(seg.data as FileContext),
      content: seg.text,
    }));
    // "skip" never truncates a whole diagnostic (each one is its own
    // segment), so seg.data is used raw.
    const budgetedProblems: ProblemInfo[] = keptProblemSegs.map((seg) => seg.data as ProblemInfo);
    // "break" may have truncated this — always reconstruct from seg.text,
    // not from the original (untruncated) diff string.
    const budgetedDiff: string | undefined = keptDiffSegs[0]?.text;
    // "break" may have truncated this — always reconstruct from seg.text,
    // not from the original (unbudgeted) command output.
    const budgetedTerminal: string | undefined = keptTerminalSegs[0]?.text;
    // "break" may have truncated this — always reconstruct from seg.text,
    // not from the original (unbudgeted) fetched content.
    const budgetedUrl: string | undefined = keptUrlSegs[0]?.text;
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
      diff: budgetedDiff,
      terminal: budgetedTerminal,
      url: budgetedUrl,
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

  // The current working-tree state, staged and unstaged changes reported
  // separately (each vs. its own base — index vs HEAD for staged, working
  // tree vs index for unstaged) since vscode.git's API has no single call
  // that returns a whole-tree-vs-HEAD patch string. "" if there's no git
  // repo, nothing has changed, or the vscode.git extension isn't available.
  private async readDiff(): Promise<string> {
    try {
      const api = await getGitApi();
      const repo = api?.repositories[0];
      if (!repo) return "";
      const [unstaged, staged] = await Promise.all([repo.diff(false), repo.diff(true)]);
      return [
        staged.trim() ? `// Staged changes (index vs HEAD):\n${staged}` : "",
        unstaged.trim() ? `// Unstaged changes (working tree vs index):\n${unstaged}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
    } catch {
      return ""; // no repo / unborn HEAD / git failure — @diff contributes nothing
    }
  }

  // Waits for shell integration to attach to a freshly created terminal
  // (it isn't available immediately — the shell needs to load its
  // integration script first). Resolves to undefined if it doesn't
  // attach within timeoutMs, which covers shells/environments that never
  // enable shell integration at all. Always cleans up its listener,
  // whether it resolves via the event or via the timeout.
  private waitForShellIntegration(
    terminal: vscode.Terminal,
    timeoutMs: number,
  ): Promise<vscode.TerminalShellIntegration | undefined> {
    if (terminal.shellIntegration) return Promise.resolve(terminal.shellIntegration);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        disposable.dispose();
        resolve(undefined);
      }, timeoutMs);
      const disposable = vscode.window.onDidChangeTerminalShellIntegration((e) => {
        if (e.terminal === terminal) {
          clearTimeout(timer);
          disposable.dispose();
          resolve(e.shellIntegration);
        }
      });
    });
  }

  // Executes command in terminal and reads its output, bounded by an
  // absolute wall-clock deadline. If the deadline passes mid-command
  // (the command is still producing output, or producing none at all),
  // returns whatever was captured so far with a truncation marker rather
  // than hanging indefinitely or discarding partial progress. Each
  // iteration of the read loop races the next chunk against the
  // remaining time budget, since a `for await` loop would otherwise
  // block indefinitely waiting for a chunk that may never come (e.g. a
  // command that produces no output for a long time before exiting).
  private async executeAndRead(
    terminal: vscode.Terminal,
    command: string,
    deadlineMs: number,
  ): Promise<string> {
    const integration = await this.waitForShellIntegration(terminal, SHELL_INTEGRATION_TIMEOUT_MS);
    if (!integration) return "";

    const execution = integration.executeCommand(command);
    const iterator = execution.read()[Symbol.asyncIterator]();
    let output = "";
    let timedOut = false;

    while (true) {
      const remaining = deadlineMs - Date.now();
      if (remaining <= 0) {
        timedOut = true;
        break;
      }

      const next = await Promise.race([
        iterator.next().then((result) => ({ timedOut: false as const, result })),
        new Promise<{ timedOut: true }>((resolve) => setTimeout(() => resolve({ timedOut: true }), remaining)),
      ]);

      if (next.timedOut) {
        timedOut = true;
        break;
      }
      if (next.result.done) break; // command finished normally
      output += next.result.value;
      if (output.length > MAX_TERMINAL_CHARS) {
        return output.slice(0, MAX_TERMINAL_CHARS) + TRUNCATION_MARKER;
      }
    }

    return timedOut && output ? output + TRUNCATION_MARKER : output;
  }

  // Runs a shell command in a visible terminal, after user confirmation
  // (the one mutating mention — every other mention is read-only). "" on
  // decline, on any failure, or if shell integration never attaches; the
  // created terminal is left open (not disposed) so the user can see/
  // interact with what actually ran.
  private async runTerminalCommand(command: string): Promise<string> {
    const confirmed = await vscode.window.showWarningMessage(
      `Run '${command}' in your terminal?`,
      "Run",
      "Cancel",
    );
    if (confirmed !== "Run") return "";

    try {
      const terminal = vscode.window.createTerminal({ name: "xpreiIDE" });
      terminal.show();
      return await this.executeAndRead(terminal, command, Date.now() + TERMINAL_EXEC_TIMEOUT_MS);
    } catch {
      return "";
    }
  }

  // Resolves hostname to every address it maps to and blocks the whole
  // URL if ANY of them is private/loopback/link-local — a hostname that
  // resolves to multiple addresses (some public, some not) is treated as
  // unsafe rather than picking one. Fails closed: an unresolvable
  // hostname is also treated as blocked, since there's nothing safe to
  // fetch.
  private async isHostnameBlocked(hostname: string): Promise<boolean> {
    try {
      const addresses = await lookup(hostname, { all: true });
      return addresses.length === 0 || addresses.some((a) => isBlockedAddress(a.address));
    } catch {
      return true;
    }
  }

  // Follows redirects manually (never trusts fetch's own redirect
  // following), re-validating scheme and resolved-address safety at
  // EVERY hop — a public URL redirecting to a blocked target must not
  // bypass the check. Shares one AbortSignal across every fetch() call
  // in the loop, so the 10s deadline covers the whole chain of
  // redirects, not each hop individually.
  private async fetchUrlWithRedirects(address: string, signal: AbortSignal): Promise<string> {
    let current = address;
    for (let hop = 0; hop <= MAX_URL_REDIRECTS; hop++) {
      let parsed: URL;
      try {
        parsed = new URL(current);
      } catch {
        return "";
      }
      if (!isSafeUrl(parsed)) return "";
      if (await this.isHostnameBlocked(parsed.hostname)) return "";

      const res = await fetch(parsed.toString(), { redirect: "manual", signal });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) return "";
        current = new URL(location, parsed).toString();
        continue; // loop back to the top — re-validates the redirect target
      }

      if (!res.ok || !res.body) return "";

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = "";
      let bytesRead = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          bytesRead += value.byteLength;
          if (bytesRead > MAX_URL_BYTES) {
            text += TRUNCATION_MARKER;
            break;
          }
          text += decoder.decode(value, { stream: true });
        }
      } finally {
        reader.releaseLock();
      }

      const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
      return contentType.includes("html") ? stripHtml(text) : text;
    }
    return ""; // too many redirects
  }

  // Fetches a URL, scheme- and IP-range-checked (never file:// or a
  // private/loopback/link-local target, at every redirect hop), within a
  // single 10-second deadline for the whole operation. "" on any
  // failure: blocked target, network error, timeout, non-2xx response,
  // or too many redirects.
  private async fetchUrl(address: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS);
    try {
      return await this.fetchUrlWithRedirects(address, controller.signal);
    } catch {
      return "";
    } finally {
      clearTimeout(timer);
    }
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
