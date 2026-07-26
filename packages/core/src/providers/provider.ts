// Provider abstraction — the "bring your own model" core.
// Every model backend (Ollama, OpenAI-compatible, future custom) implements
// this one interface, so the rest of the extension never special-cases a vendor.

export type Role = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  signal?: AbortSignal;
}

// Normalized streaming unit. Adapters translate their wire format
// (Ollama NDJSON, OpenAI SSE) into this shape.
export interface ChatChunk {
  // Incremental assistant text for this step.
  delta: string;
  // True on the final chunk of a response.
  done: boolean;
}

export interface ProviderCapabilities {
  tools: boolean;
  embeddings: boolean;
  contextWindow: number;
}

export interface Provider {
  readonly id: string;
  readonly label: string;
  readonly capabilities: ProviderCapabilities;

  // List model names available from this backend (e.g. Ollama /api/tags).
  listModels(signal?: AbortSignal): Promise<string[]>;

  // Stream a chat completion as normalized chunks.
  chatStream(req: ChatRequest): AsyncIterable<ChatChunk>;

  // Optional: produce embeddings for the RAG layer (P2).
  embed?(texts: string[], model: string, signal?: AbortSignal): Promise<number[][]>;

  // Real fill-in-the-middle completion: given the text before and after
  // the cursor, returns the text to insert. Optional — only providers
  // with a native FIM endpoint implement this; callers check for its
  // presence (and, separately, isFimCapableModel(model)) before using
  // it.
  fillInMiddle?(prefix: string, suffix: string, model: string, signal?: AbortSignal): Promise<string>;
}

// Config entry persisted in settings (xpreiIDE.providers).
export interface ProviderConfig {
  id: string;
  kind: "ollama" | "openai-compat";
  label: string;
  baseUrl: string;
  model?: string;
}

// Thrown by adapters so the UI can surface a clean message instead of a stack.
export class ProviderError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "ProviderError";
  }
}

// True when an error is a caller-initiated abort (fetch signal). Adapters use
// this to rethrow the raw AbortError instead of masking it as a network fault.
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

// Shared NDJSON/SSE line reader over a fetch Response body.
// Yields decoded text lines, buffering across chunk boundaries.
export async function* readLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trimEnd();
        buffer = buffer.slice(nl + 1);
        if (line) yield line;
      }
    }
    // Flush any bytes held back mid-multibyte-sequence, then emit the tail.
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}
