// Test helpers: build fake fetch Responses from recorded stream text, and
// swap the global fetch during a test.

export function streamResponse(
  text: string,
  init: { status?: number } = {},
): Response {
  const status = init.status ?? 200;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(body, { status });
}

export function jsonResponse(obj: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(obj), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

export function abortError(): Error {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}

type FetchFn = typeof fetch;

// Replace global fetch for the duration of a test; returns a restore fn.
export function mockFetch(impl: FetchFn): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => {
    globalThis.fetch = original;
  };
}

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}
