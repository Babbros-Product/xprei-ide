// Ollama adapter. Talks to a local Ollama daemon (default localhost:11434).
// Chat: POST /api/chat with stream=true → newline-delimited JSON (NDJSON).
// Models: GET /api/tags. Embeddings: POST /api/embeddings.

import {
  ChatChunk,
  ChatRequest,
  isAbortError,
  Provider,
  ProviderCapabilities,
  ProviderConfig,
  ProviderError,
  readLines,
} from "./provider";

interface OllamaChatLine {
  message?: { role: string; content: string };
  done?: boolean;
  error?: string;
}

export class OllamaProvider implements Provider {
  readonly id: string;
  readonly label: string;
  readonly capabilities: ProviderCapabilities = {
    // Some Ollama models support native tools; treated conservatively here
    // until per-model capability detection lands (P4).
    tools: false,
    embeddings: true,
    contextWindow: 8192,
  };

  private readonly baseUrl: string;

  constructor(cfg: ProviderConfig) {
    this.id = cfg.id;
    this.label = cfg.label;
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/tags`, { signal });
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw new ProviderError(this.unreachable(), err);
    }
    if (!res.ok) throw new ProviderError(`Ollama /api/tags: ${res.status} ${res.statusText}`);
    const data = (await res.json()) as { models?: { name: string }[] };
    return (data.models ?? []).map((m) => m.name);
  }

  private unreachable(): string {
    return `Cannot reach Ollama at ${this.baseUrl}. Is 'ollama serve' running?`;
  }

  async *chatStream(req: ChatRequest): AsyncIterable<ChatChunk> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: req.signal,
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          stream: true,
          options:
            req.temperature != null ? { temperature: req.temperature } : undefined,
        }),
      });
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw new ProviderError(this.unreachable(), err);
    }
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      throw new ProviderError(
        `Ollama /api/chat failed: ${res.status} ${res.statusText} ${body}`.trim(),
      );
    }

    for await (const line of readLines(res.body)) {
      let obj: OllamaChatLine;
      try {
        obj = JSON.parse(line);
      } catch {
        continue; // skip malformed keep-alive lines
      }
      if (obj.error) throw new ProviderError(`Ollama: ${obj.error}`);
      const delta = obj.message?.content ?? "";
      if (delta) yield { delta, done: false };
      if (obj.done) {
        yield { delta: "", done: true };
        return;
      }
    }
  }

  async embed(texts: string[], model: string, signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0) return [];
    // Prefer the batch endpoint (/api/embed, Ollama >= 0.1.x): one round-trip
    // for the whole batch instead of one request per text. Falls back to the
    // legacy per-text /api/embeddings on an older daemon that lacks it.
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({ model, input: texts }),
      });
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw new ProviderError(this.unreachable(), err);
    }
    if (res.status === 404) return this.embedEach(texts, model, signal);
    if (!res.ok) throw new ProviderError(`Ollama /api/embed: ${res.status}`);
    const data = (await res.json()) as { embeddings?: number[][] };
    return data.embeddings ?? [];
  }

  // Legacy fallback: /api/embeddings takes a single `prompt` and returns one
  // vector, so a batch is N sequential requests.
  private async embedEach(
    texts: string[],
    model: string,
    signal?: AbortSignal,
  ): Promise<number[][]> {
    const out: number[][] = [];
    for (const prompt of texts) {
      const res = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({ model, prompt }),
      });
      if (!res.ok) throw new ProviderError(`Ollama /api/embeddings: ${res.status}`);
      const data = (await res.json()) as { embedding: number[] };
      out.push(data.embedding);
    }
    return out;
  }
}
