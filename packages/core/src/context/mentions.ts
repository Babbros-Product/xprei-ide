// Parse @-mentions out of a chat message. Pure module — no vscode.
//   @codebase          → run semantic retrieval over the index
//   @file:src/a.ts     → inline that exact file
//   @path/to/file.ts   → shorthand for @file when it has an extension/slash
//   @open              → inline every currently-open editor tab
//   @problems          → inline error/warning diagnostics from open files
//   @diff              → inline the current staged + unstaged git diff
//   @url:<address>     → fetch a public URL and inline its content
//   @repomap           → inline a lightweight per-file symbol map
//                        (exported/public top-level names) across the
//                        workspace — TypeScript/JavaScript + Python only
//   @terminal:<cmd>    → run a shell command (with confirmation) and
//                        inline its output; must be the LAST thing in
//                        the message — everything after "@terminal:" to
//                        the end of the text is the command verbatim
//   @currentFile       → inline the active editor's live buffer
//   @symbol:<name>     → inline a symbol's full source range (up to 3
//                        matches, workspace-symbol lookup)
//   @os                → inline one line of platform/arch/OS-release info
//   @commits           → inline the last 10 commits' metadata
//   @search:<text>     → inline up to 50 workspace hits for a substring
// The remaining prose (mentions stripped) is what we embed for retrieval.

export interface Mentions {
  codebase: boolean;
  open: boolean;
  problems: boolean;
  diff: boolean;
  terminalCommand: string | undefined;
  url: string | undefined;
  repomap: boolean;
  files: string[];
  currentFile: boolean;
  os: boolean;
  commits: boolean;
  symbol: string | undefined;
  search: string | undefined;
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
const REPOMAP_RE = /(^|\s)@repomap\b/gi;
const CURRENT_FILE_RE = /(^|\s)@currentFile\b/gi;
const OS_RE = /(^|\s)@os\b/gi;
const COMMITS_RE = /(^|\s)@commits\b/gi;
const SYMBOL_RE = /(^|\s)@symbol:(\S+)/gi;
const SEARCH_RE = /(^|\s)@search:(\S+)/gi;
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
  let repomap = false;
  let currentFile = false;
  let os = false;
  let commits = false;
  let symbol: string | undefined;
  let search: string | undefined;
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

  cleaned = cleaned.replace(REPOMAP_RE, (_m, pre) => {
    repomap = true;
    return pre;
  });

  cleaned = cleaned.replace(CURRENT_FILE_RE, (_m, pre) => {
    currentFile = true;
    return pre;
  });

  cleaned = cleaned.replace(OS_RE, (_m, pre) => {
    os = true;
    return pre;
  });

  cleaned = cleaned.replace(COMMITS_RE, (_m, pre) => {
    commits = true;
    return pre;
  });

  cleaned = cleaned.replace(SYMBOL_RE, (_m, pre: string, name: string) => {
    symbol = name;
    return pre;
  });

  cleaned = cleaned.replace(SEARCH_RE, (_m, pre: string, query: string) => {
    search = query;
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
    repomap,
    files: [...new Set(files)],
    currentFile,
    os,
    commits,
    symbol,
    search,
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
    m.repomap ||
    m.files.length > 0 ||
    m.currentFile ||
    m.os ||
    m.commits ||
    m.symbol !== undefined ||
    m.search !== undefined
  );
}
