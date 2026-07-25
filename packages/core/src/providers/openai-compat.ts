// OpenAI-compatible adapter. Covers OpenAI, vLLM, LM Studio, OpenRouter,
// Together, and anything exposing /v1/chat/completions.
// Chat: POST /v1/chat/completions with stream=true → Server-Sent Events (SSE).
// Models: GET /v1/models. Embeddings: POST /v1/embeddings.

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

// The API key is injected at construction (loaded from SecretStorage by the
// registry), never persisted in plaintext settings.
export class OpenAICompatProvider implements Provider {
  readonly id: string;
  readonly label: string;
  readonly capabilities: ProviderCapabilities = {
    tools: true,
    embeddings: true,
    contextWindow: 128000,
  };

  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(cfg: ProviderConfig, apiKey: string) {
    this.id = cfg.id;
    this.label = cfg.label;
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/models`, { headers: this.headers(), signal });
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw new ProviderError(`Cannot reach endpoint at ${this.baseUrl}.`, err);
    }
    if (!res.ok) {
      throw new ProviderError(`GET /models: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as { data?: { id: string }[] };
    return (data.data ?? []).map((m) => m.id);
  }

  async *chatStream(req: ChatRequest): AsyncIterable<ChatChunk> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        signal: req.signal,
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          stream: true,
          temperature: req.temperature,
        }),
      });
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw new ProviderError(`Cannot reach endpoint at ${this.baseUrl}.`, err);
    }
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      throw new ProviderError(
        `chat/completions failed: ${res.status} ${res.statusText} ${body}`.trim(),
      );
    }

    // SSE frames are "data: {...}" lines, terminated by "data: [DONE]".
    for await (const line of readLines(res.body)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") {
        yield { delta: "", done: true };
        return;
      }
      let obj: {
        choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
        error?: { message?: string };
      };
      try {
        obj = JSON.parse(payload);
      } catch {
        continue;
      }
      if (obj.error) throw new ProviderError(`Endpoint: ${obj.error.message ?? "error"}`);
      const delta = obj.choices?.[0]?.delta?.content ?? "";
      if (delta) yield { delta, done: false };
    }
    yield { delta: "", done: true };
  }

  async embed(texts: string[], model: string, signal?: AbortSignal): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: this.headers(),
      signal,
      body: JSON.stringify({ model, input: texts }),
    });
    if (!res.ok) throw new ProviderError(`/embeddings: ${res.status}`);
    const data = (await res.json()) as { data: { embedding: number[] }[] };
    return data.data.map((d) => d.embedding);
  }
}
