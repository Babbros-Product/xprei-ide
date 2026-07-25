// Parse @-mentions out of a chat message. Pure module — no vscode.
//   @codebase          → run semantic retrieval over the index
//   @file:src/a.ts     → inline that exact file
//   @path/to/file.ts   → shorthand for @file when it has an extension/slash
//   @open              → inline every currently-open editor tab
//   @problems          → inline error/warning diagnostics from open files
//   @diff              → inline the current staged + unstaged git diff
//   @url:<address>     → fetch a public URL and inline its content
//   @terminal:<cmd>    → run a shell command (with confirmation) and
//                        inline its output; must be the LAST thing in
//                        the message — everything after "@terminal:" to
//                        the end of the text is the command verbatim
// The remaining prose (mentions stripped) is what we embed for retrieval.

export interface Mentions {
  codebase: boolean;
  open: boolean;
  problems: boolean;
  diff: boolean;
  terminalCommand: string | undefined;
  url: string | undefined;
  files: string[];
  // Message with mention tokens removed, used as the retrieval query.
  cleaned: string;
}

// Anchored to end-of-string ($), non-global (only one @terminal: makes
// sense per message), captures everything after "@terminal:" to the end
// of the text. Must run BEFORE every other mention regex in
// parseMentions() below — otherwise those regexes would try to parse
// pieces of the command text (e.g. a path-looking token inside
// "npm run build src/index.ts") as separate mentions before @terminal
// ever claims the trailing span.
const TERMINAL_RE = /(^|\s)@terminal:(.+)$/i;

const CODEBASE_RE = /(^|\s)@codebase\b/gi;
const OPEN_RE = /(^|\s)@open\b/gi;
const PROBLEMS_RE = /(^|\s)@problems\b/gi;
const DIFF_RE = /(^|\s)@diff\b/gi;
const URL_RE = /(^|\s)@url:(\S+)/gi;
const FILE_RE = /(^|\s)@file:(\S+)/gi;
// Bare @path shorthand: token containing a slash or a dotted extension.
const BARE_PATH_RE = /(^|\s)@((?:[\w.\-]+\/)+[\w.\-]+|[\w.\-]+\.[\w]+)/g;

export function parseMentions(text: string): Mentions {
  const files: string[] = [];
  let codebase = false;
  let open = false;
  let problems = false;
  let diff = false;
  let terminalCommand: string | undefined;
  let url: string | undefined;
  let cleaned = text;

  cleaned = cleaned.replace(TERMINAL_RE, (_m, pre: string, command: string) => {
    terminalCommand = command;
    return pre;
  });

  cleaned = cleaned.replace(CODEBASE_RE, (_m, pre) => {
    codebase = true;
    return pre;
  });

  cleaned = cleaned.replace(OPEN_RE, (_m, pre) => {
    open = true;
    return pre;
  });

  cleaned = cleaned.replace(PROBLEMS_RE, (_m, pre) => {
    problems = true;
    return pre;
  });

  cleaned = cleaned.replace(DIFF_RE, (_m, pre) => {
    diff = true;
    return pre;
  });

  cleaned = cleaned.replace(URL_RE, (_m, pre: string, address: string) => {
    url = address;
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
    open,
    problems,
    diff,
    terminalCommand,
    url,
    files: [...new Set(files)],
    cleaned: cleaned.replace(/\s+/g, " ").trim(),
  };
}

export function hasContextRequest(m: Mentions): boolean {
  return (
    m.codebase ||
    m.open ||
    m.problems ||
    m.diff ||
    m.terminalCommand !== undefined ||
    m.url !== undefined ||
    m.files.length > 0
  );
}
