// File chunking. Splits a text file into overlapping line windows so each
// chunk is small enough to embed while keeping enough context to be useful.
// Pure module — no vscode, unit-testable.

export interface Chunk {
  id: string; // stable: `${path}#${startLine}`
  path: string; // workspace-relative POSIX path
  startLine: number; // 1-based, inclusive
  endLine: number; // 1-based, inclusive
  text: string;
}

export interface ChunkOptions {
  windowLines: number; // lines per chunk
  overlapLines: number; // lines shared with the previous chunk
  maxCharsPerChunk: number; // hard cap to bound embedding cost
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  windowLines: 60,
  overlapLines: 10,
  maxCharsPerChunk: 4000,
};

const NUL = String.fromCharCode(0);

// Heuristic binary sniff: a NUL byte in the first slice means "not text".
export function looksBinary(content: string): boolean {
  return content.slice(0, 4096).includes(NUL);
}

export function chunkFile(
  path: string,
  content: string,
  opts: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): Chunk[] {
  if (!content.trim() || looksBinary(content)) return [];

  const lines = content.split(/\r?\n/);
  const step = Math.max(1, opts.windowLines - opts.overlapLines);
  const chunks: Chunk[] = [];

  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(lines.length, start + opts.windowLines);
    let text = lines.slice(start, end).join("\n");
    if (!text.trim()) {
      if (end >= lines.length) break;
      continue;
    }
    if (text.length > opts.maxCharsPerChunk) {
      text = text.slice(0, opts.maxCharsPerChunk);
    }
    chunks.push({
      id: `${path}#${start + 1}`,
      path,
      startLine: start + 1,
      endLine: end,
      text,
    });
    if (end >= lines.length) break;
  }
  return chunks;
}
