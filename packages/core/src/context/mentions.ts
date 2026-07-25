// Parse @-mentions out of a chat message. Pure module — no vscode.
//   @codebase          → run semantic retrieval over the index
//   @file:src/a.ts     → inline that exact file
//   @path/to/file.ts   → shorthand for @file when it has an extension/slash
// The remaining prose (mentions stripped) is what we embed for retrieval.

export interface Mentions {
  codebase: boolean;
  files: string[];
  // Message with mention tokens removed, used as the retrieval query.
  cleaned: string;
}

const CODEBASE_RE = /(^|\s)@codebase\b/gi;
const FILE_RE = /(^|\s)@file:(\S+)/gi;
// Bare @path shorthand: token containing a slash or a dotted extension.
const BARE_PATH_RE = /(^|\s)@((?:[\w.\-]+\/)+[\w.\-]+|[\w.\-]+\.[\w]+)/g;

export function parseMentions(text: string): Mentions {
  const files: string[] = [];
  let codebase = false;
  let cleaned = text;

  cleaned = cleaned.replace(CODEBASE_RE, (_m, pre) => {
    codebase = true;
    return pre;
  });

  cleaned = cleaned.replace(FILE_RE, (_m, pre: string, path: string) => {
    files.push(path);
    return pre;
  });

  cleaned = cleaned.replace(BARE_PATH_RE, (_m, pre: string, path: string) => {
    files.push(path);
    return pre;
  });

  return {
    codebase,
    files: [...new Set(files)],
    cleaned: cleaned.replace(/\s+/g, " ").trim(),
  };
}

export function hasContextRequest(m: Mentions): boolean {
  return m.codebase || m.files.length > 0;
}
