// In-memory vector store with brute-force cosine search and JSON persistence.
// Dependency-free on purpose: no native LanceDB/sqlite-vss binary to bundle in
// the extension. Brute force is fine for typical project sizes (a few thousand
// chunks); swap in an ANN index later if corpora grow. Pure module — no vscode.

import { Chunk } from "./chunking";

export interface StoredRecord {
  chunk: Chunk;
  // Pre-normalized (unit-length) embedding, so search is a plain dot product.
  vector: number[];
}

interface Persisted {
  version: 1;
  embedKey: string; // provider::model used to build this index
  dim: number;
  records: StoredRecord[];
}

function norm(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const len = Math.sqrt(sum);
  if (len === 0) return v.slice();
  return v.map((x) => x / len);
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export interface SearchHit {
  chunk: Chunk;
  score: number; // cosine similarity in [-1, 1]
}

export class VectorStore {
  private records = new Map<string, StoredRecord>(); // keyed by chunk.id
  private embedKey = "";
  private dim = 0;

  get size(): number {
    return this.records.size;
  }

  get modelKey(): string {
    return this.embedKey;
  }

  // Switching embed model or dimension invalidates everything: vectors from
  // different models are not comparable. Callers must re-index after this.
  configure(embedKey: string, dim: number): void {
    if (this.embedKey && (this.embedKey !== embedKey || this.dim !== dim)) {
      this.records.clear();
    }
    this.embedKey = embedKey;
    this.dim = dim;
  }

  upsert(chunks: Chunk[], vectors: number[][]): void {
    for (let i = 0; i < chunks.length; i++) {
      this.records.set(chunks[i].id, { chunk: chunks[i], vector: norm(vectors[i]) });
    }
  }

  removeByPath(path: string): void {
    for (const [id, rec] of this.records) {
      if (rec.chunk.path === path) this.records.delete(id);
    }
  }

  clear(): void {
    this.records.clear();
  }

  search(queryVector: number[], k: number): SearchHit[] {
    const q = norm(queryVector);
    const hits: SearchHit[] = [];
    for (const rec of this.records.values()) {
      hits.push({ chunk: rec.chunk, score: dot(q, rec.vector) });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }

  toJSON(): Persisted {
    return {
      version: 1,
      embedKey: this.embedKey,
      dim: this.dim,
      records: [...this.records.values()],
    };
  }

  static fromJSON(raw: unknown): VectorStore {
    const store = new VectorStore();
    const data = raw as Partial<Persisted> | null;
    if (!data || data.version !== 1 || !Array.isArray(data.records)) return store;
    store.embedKey = data.embedKey ?? "";
    store.dim = data.dim ?? 0;
    for (const rec of data.records) {
      if (rec?.chunk?.id) store.records.set(rec.chunk.id, rec);
    }
    return store;
  }
}
