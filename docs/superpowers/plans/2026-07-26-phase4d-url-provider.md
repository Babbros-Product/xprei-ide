# Phase 4d URL Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `@url:<address>` (fetch a public URL, strip HTML, inject the
result) as a new chat context mention, per
`docs/superpowers/specs/2026-07-26-phase4d-url-provider-design.md`.

**Architecture:** Two new pure `@xprei/core` modules — `urlSafety.ts`
(scheme + private/loopback/link-local IP-range checks) and `htmlStrip.ts`
(minimal tag/script/style stripper) — both fully unit tested, since this
is the one provider whose safety logic deserves real test coverage rather
than a manual smoke test. `mentions.ts` gains a `url` field;
`retrieval.ts` gains `formatUrl` and a seventh `buildContextMessage`
parameter. `contextEngine.ts` gains a `fetchUrl()` method (global `fetch`,
no new HTTP dependency) that re-validates safety on every redirect hop,
enforces a single 10-second deadline across the whole operation, and caps
the streamed response body at 500KB — wired in as a seventh
`SegmentTier` at the locked priority position.

**Tech Stack:** TypeScript, Node's global `fetch` (already used by
`ollama.ts`/`openai-compat.ts`, no new dependency), `node:dns/promises`
for hostname resolution (already used elsewhere in this codebase's
extension layer via other `node:` built-ins, e.g. `node:child_process` in
`agent/host.ts`). No HTML-parsing library.

## Global Constraints

- **SSRF protection is mandatory and re-checked on every redirect hop** —
  not just the URL the user typed. A public URL that redirects to a
  blocked target must not bypass the check.
- **Blocked ranges are exactly the spec's list, no more, no less**: IPv4
  `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`,
  `169.254.0.0/16`; IPv6 `::1`, `fc00::/7` (plus IPv4-mapped IPv6
  addresses resolved through the same IPv4 check). Do not add ranges
  beyond this list — it's the already-reviewed, approved scope.
- **Scheme restricted to `http:`/`https:` only** — no `file:`, `ftp:`,
  `data:`, etc.
- **10-second timeout for the ENTIRE operation** (all redirect hops
  combined, not per-hop) — one `AbortController` created once at the top
  of `fetchUrl()`, its signal threaded through every `fetch()` call in
  the redirect loop.
- **500KB cap enforced during the streamed read**, not after full
  download — abort/stop reading once exceeded.
- **No new dependency** for HTTP or HTML parsing — global `fetch`
  (already relied on elsewhere in this codebase) and a hand-rolled
  regex-based HTML stripper only.
- **`urlSafety.ts` and `htmlStrip.ts` are pure** — no `vscode` import, no
  network I/O, no DNS calls inside them; both live in `@xprei/core` with
  full unit tests. Only the actual `fetch()` call and DNS resolution
  happen in `contextEngine.ts` (extension layer).
- **Silent-empty on every failure**: unreachable host, blocked
  scheme/address (at any hop), non-2xx response, timeout, oversized
  response, too many redirects — all return `""`, no error toast.
- **Tier priority is locked**, extending the existing 6-tier order by
  one: `@file:` (`"break"`, highest) → `@problems` (`"skip"`) → `@diff`
  (`"break"`) → `@terminal` (`"break"`) → `@url` (`"break"`, new) →
  `@open` (`"break"`) → `@codebase` hits (`"skip"`, lowest).
- **Every tier is built unconditionally** (empty segments array when its
  mention isn't present) — per Phase 4 Foundation's documented
  positional-alignment invariant. Never conditionally pushed.
- `packages/core` is source-only; every new test file must be added to
  the `test` script list in `packages/core/package.json`.
- `extensions/vscode` has no unit tests by existing convention — its one
  task (the actual `fetch()`/tier wiring) is verified by
  `npm run typecheck -w xpreiIDE-ai` + `npm run compile -w xpreiIDE-ai` +
  manual smoke.
- **User-facing docs stay current** (`CLAUDE.md` convention): `@url` is
  a new chat mention users can type directly — both
  `extensions/vscode/README.md` and the root `README.md`'s Features list
  must be updated, per Task 4, including a note that private/internal
  URLs are silently blocked.
- **Commits:** author `xpreiIDE <mbsajay1@gmail.com>` — pass it explicitly,
  e.g. `git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "..."`.
  **Do NOT add a `Co-Authored-By` footer or any other footer.** Conventional
  Commit prefixes (feat/test/docs/etc).

---

### Task 1: `urlSafety.ts` and `htmlStrip.ts` — pure, fully unit tested

**Files:**
- Create: `packages/core/src/context/urlSafety.ts`
- Create: `packages/core/src/context/urlSafety.test.ts`
- Create: `packages/core/src/context/htmlStrip.ts`
- Create: `packages/core/src/context/htmlStrip.test.ts`
- Modify: `packages/core/package.json` (register both new test files)
- Modify: `packages/core/src/index.ts` (barrel-export both new modules)

**Interfaces:**
- Produces: `isSafeUrl(parsed: URL): boolean`,
  `isBlockedAddress(address: string): boolean` — Task 3 consumes both.
- Produces: `stripHtml(html: string): string` — Task 3 consumes this.

- [ ] **Step 1: Write the failing `urlSafety` tests**

Create `packages/core/src/context/urlSafety.test.ts`:

```typescript
import assert from "node:assert/strict";
import { test } from "node:test";
import { isBlockedAddress, isSafeUrl } from "./urlSafety";

test("isSafeUrl accepts http and https", () => {
  assert.equal(isSafeUrl(new URL("http://example.com")), true);
  assert.equal(isSafeUrl(new URL("https://example.com")), true);
});

test("isSafeUrl rejects non-http(s) schemes", () => {
  assert.equal(isSafeUrl(new URL("file:///etc/passwd")), false);
  assert.equal(isSafeUrl(new URL("ftp://example.com")), false);
  assert.equal(isSafeUrl(new URL("data:text/plain;base64,aGk=")), false);
});

test("isBlockedAddress blocks 10.0.0.0/8", () => {
  assert.equal(isBlockedAddress("10.0.0.1"), true);
  assert.equal(isBlockedAddress("10.255.255.255"), true);
});

test("isBlockedAddress blocks 172.16.0.0/12 and correctly bounds it", () => {
  assert.equal(isBlockedAddress("172.16.0.1"), true);
  assert.equal(isBlockedAddress("172.31.255.255"), true);
  assert.equal(isBlockedAddress("172.15.255.255"), false); // just below the range
  assert.equal(isBlockedAddress("172.32.0.1"), false); // just above the range
});

test("isBlockedAddress blocks 192.168.0.0/16", () => {
  assert.equal(isBlockedAddress("192.168.1.1"), true);
  assert.equal(isBlockedAddress("192.169.1.1"), false);
});

test("isBlockedAddress blocks 127.0.0.0/8 (loopback)", () => {
  assert.equal(isBlockedAddress("127.0.0.1"), true);
  assert.equal(isBlockedAddress("127.255.255.255"), true);
});

test("isBlockedAddress blocks 169.254.0.0/16 (link-local, incl. cloud metadata)", () => {
  assert.equal(isBlockedAddress("169.254.169.254"), true);
});

test("isBlockedAddress allows real public IPv4 addresses", () => {
  assert.equal(isBlockedAddress("8.8.8.8"), false);
  assert.equal(isBlockedAddress("1.1.1.1"), false);
});

test("isBlockedAddress blocks ::1 (IPv6 loopback)", () => {
  assert.equal(isBlockedAddress("::1"), true);
});

test("isBlockedAddress blocks fc00::/7 (IPv6 unique local)", () => {
  assert.equal(isBlockedAddress("fc00::1"), true);
  assert.equal(isBlockedAddress("fd12:3456::1"), true);
});

test("isBlockedAddress allows a real public IPv6 address", () => {
  assert.equal(isBlockedAddress("2001:4860:4860::8888"), false);
});

test("isBlockedAddress blocks IPv4-mapped IPv6 loopback/private addresses", () => {
  assert.equal(isBlockedAddress("::ffff:127.0.0.1"), true);
  assert.equal(isBlockedAddress("::ffff:10.0.0.1"), true);
});

test("isBlockedAddress allows an IPv4-mapped IPv6 public address", () => {
  assert.equal(isBlockedAddress("::ffff:8.8.8.8"), false);
});
```

- [ ] **Step 2: Run `urlSafety` tests to verify they fail**

Run: `node --import tsx --test src/context/urlSafety.test.ts` (from
`packages/core`)
Expected: FAIL — `./urlSafety` doesn't exist yet.

- [ ] **Step 3: Implement `urlSafety.ts`**

Create `packages/core/src/context/urlSafety.ts`:

```typescript
// Pure SSRF-safety checks for the @url context provider. No network I/O,
// no vscode dependency — the caller (contextEngine.ts) resolves a
// hostname to its IP address(es) via DNS and passes each one to
// isBlockedAddress(); this module only judges values it's handed. Blocks
// exactly the ranges reviewed in the design spec — private/loopback/
// link-local IPv4 and IPv6 — as a baseline against the realistic SSRF
// attack shape (localhost, LAN services, cloud-metadata endpoints), not
// an exhaustive enterprise-grade IP-range database.

export function isSafeUrl(parsed: URL): boolean {
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

export function isBlockedAddress(address: string): boolean {
  const lower = address.toLowerCase();

  if (lower.includes(":")) {
    if (lower === "::1") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // fc00::/7
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedAddress(mapped[1]);
    return false;
  }

  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  return false;
}
```

- [ ] **Step 4: Run `urlSafety` tests to verify they pass**

Run: `node --import tsx --test src/context/urlSafety.test.ts` (from
`packages/core`)
Expected: all 12 tests PASS.

- [ ] **Step 5: Write the failing `htmlStrip` tests**

Create `packages/core/src/context/htmlStrip.test.ts`:

```typescript
import assert from "node:assert/strict";
import { test } from "node:test";
import { stripHtml } from "./htmlStrip";

test("stripHtml removes tags and collapses whitespace", () => {
  const out = stripHtml("<html><body><p>Hello   world</p></body></html>");
  assert.equal(out, "Hello world");
});

test("stripHtml drops <script> blocks entirely, including their content", () => {
  const out = stripHtml("<p>before</p><script>alert('x')</script><p>after</p>");
  assert.equal(out, "before after");
});

test("stripHtml drops <style> blocks entirely, including their content", () => {
  const out = stripHtml("<p>before</p><style>.x { color: red; }</style><p>after</p>");
  assert.equal(out, "before after");
});

test("stripHtml drops HTML comments", () => {
  const out = stripHtml("<p>before</p><!-- a comment --><p>after</p>");
  assert.equal(out, "before after");
});

test("stripHtml decodes common HTML entities", () => {
  const out = stripHtml("<p>Tom &amp; Jerry &lt;3 &quot;friends&quot;&nbsp;forever</p>");
  assert.equal(out, 'Tom & Jerry <3 "friends" forever');
});

test("stripHtml returns an empty string for empty input", () => {
  assert.equal(stripHtml(""), "");
});
```

- [ ] **Step 6: Run `htmlStrip` tests to verify they fail**

Run: `node --import tsx --test src/context/htmlStrip.test.ts` (from
`packages/core`)
Expected: FAIL — `./htmlStrip` doesn't exist yet.

- [ ] **Step 7: Implement `htmlStrip.ts`**

Create `packages/core/src/context/htmlStrip.ts`:

```typescript
// Minimal, dependency-free HTML-to-text conversion for the @url context
// provider. Not a real HTML parser — a hand-rolled regex pass, good
// enough for "readable page text for the model," not robust against
// every malformed-HTML edge case a real parser would handle. Dropping
// <script>/<style> content entirely (not just their tags) is the main
// thing that matters: without it, a page's JS/CSS would flood the
// context with noise.

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
```

- [ ] **Step 8: Run `htmlStrip` tests to verify they pass**

Run: `node --import tsx --test src/context/htmlStrip.test.ts` (from
`packages/core`)
Expected: all 6 tests PASS.

- [ ] **Step 9: Register both new test files and export both new modules**

In `packages/core/package.json`'s `test` script, add
`src/context/urlSafety.test.ts` and `src/context/htmlStrip.test.ts` to
the list (place them next to the other `src/context/*.test.ts` entries).

In `packages/core/src/index.ts`, add two lines next to the other
`./context/*` exports:

```typescript
export * from "./context/urlSafety";
export * from "./context/htmlStrip";
```

Then run the full suite to confirm nothing else broke:

Run: `npm test -w @xprei/core`
Expected: PASS — previous total (162) + 12 new `urlSafety.test.ts` tests
+ 6 new `htmlStrip.test.ts` tests = 180.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/context/urlSafety.ts packages/core/src/context/urlSafety.test.ts packages/core/src/context/htmlStrip.ts packages/core/src/context/htmlStrip.test.ts packages/core/package.json packages/core/src/index.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(core): add SSRF-safety checks and minimal HTML stripping for @url"
```

---

### Task 2: `mentions.ts` — parse `@url:<address>`; `retrieval.ts` — `formatUrl` + widened `buildContextMessage`

**Files:**
- Modify: `packages/core/src/context/mentions.ts`
- Modify: `packages/core/src/context/mentions.test.ts`
- Modify: `packages/core/src/context/retrieval.ts`
- Modify: `packages/core/src/context/retrieval.test.ts`

**Interfaces:**
- Produces: `interface Mentions { codebase: boolean; open: boolean; problems: boolean; diff: boolean; terminalCommand: string | undefined; url: string | undefined; files: string[]; cleaned: string }`
  — `url` is new; `hasContextRequest(m)` now also returns `true` when
  `m.url !== undefined`.
- Produces: `formatUrl(url: string, content: string): string`,
  `buildContextMessage(parts: { retrieved?: string; files?: string; problems?: string; diff?: string; terminal?: string; url?: string }): string`
  — Task 3 consumes both.

- [ ] **Step 1: Write the failing mentions tests**

Append to `packages/core/src/context/mentions.test.ts`:

```typescript
test("@url:<address> captures the address and is stripped from the query", () => {
  const m = parseMentions("summarize @url:https://example.com/page please");
  assert.equal(m.url, "https://example.com/page");
  assert.equal(m.cleaned, "summarize please");
  assert.ok(hasContextRequest(m));
});

test("@url is undefined when absent", () => {
  const m = parseMentions("just a normal question");
  assert.equal(m.url, undefined);
});

test("@url combines with the other mention types", () => {
  const m = parseMentions("@url:https://example.com @diff @problems check this");
  assert.equal(m.url, "https://example.com");
  assert.equal(m.diff, true);
  assert.equal(m.problems, true);
  assert.equal(m.cleaned, "check this");
});

test("@url does not consume a trailing @terminal: mention", () => {
  // @terminal:'s end-of-string capture runs first and claims everything
  // after it — @url: must still work when it appears BEFORE @terminal:.
  const m = parseMentions("@url:https://example.com/x @terminal:npm test");
  assert.equal(m.url, "https://example.com/x");
  assert.equal(m.terminalCommand, "npm test");
});
```

- [ ] **Step 2: Run mentions tests to verify they fail**

Run: `node --import tsx --test src/context/mentions.test.ts` (from
`packages/core`)
Expected: FAIL — `m.url` doesn't exist yet.

- [ ] **Step 3: Implement the `url` field**

In `packages/core/src/context/mentions.ts`, replace the entire file with:

```typescript
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
```

- [ ] **Step 4: Run mentions tests to verify they pass**

Run: `node --import tsx --test src/context/mentions.test.ts` (from
`packages/core`)
Expected: all tests PASS (17 pre-existing + 4 new = 21).

- [ ] **Step 5: Write the failing retrieval tests**

Append to `packages/core/src/context/retrieval.test.ts`:

```typescript
test("formatUrl wraps the fetched content with the source URL", () => {
  const out = formatUrl("https://example.com", "Page title\nSome text.");
  assert.equal(out, "// URL: https://example.com\nPage title\nSome text.");
});

test("buildContextMessage assembles all six sections in the locked order", () => {
  const out = buildContextMessage({
    files: "// FILE: a.ts\ncontent",
    problems: "// a.ts:1 (error) bad",
    diff: "// Current git diff:\nsome diff",
    terminal: "// $ npm test\nPASS",
    url: "// URL: https://example.com\ncontent",
    retrieved: "// a.ts:1-2 (score 0.90)\ncode",
  });
  assert.equal(
    out,
    "The user referenced workspace context. Use it to answer.\n\n" +
      "// FILE: a.ts\ncontent\n\n" +
      "// a.ts:1 (error) bad\n\n" +
      "// Current git diff:\nsome diff\n\n" +
      "// $ npm test\nPASS\n\n" +
      "// URL: https://example.com\ncontent\n\n" +
      "// Relevant code from the workspace:\n// a.ts:1-2 (score 0.90)\ncode",
  );
});

test("buildContextMessage with only url present produces just the url section", () => {
  const out = buildContextMessage({ url: "// URL: https://example.com\ncontent" });
  assert.equal(
    out,
    "The user referenced workspace context. Use it to answer.\n\n// URL: https://example.com\ncontent",
  );
});
```

Also update the import line at the top of `retrieval.test.ts` to add
`formatUrl` to the existing named-import list from `./retrieval`.

- [ ] **Step 6: Run retrieval tests to verify they fail**

Run: `node --import tsx --test src/context/retrieval.test.ts` (from
`packages/core`)
Expected: FAIL — `formatUrl` doesn't exist yet.

- [ ] **Step 7: Implement `formatUrl` and widen `buildContextMessage`**

In `packages/core/src/context/retrieval.ts`, add `formatUrl` immediately
after the existing `formatTerminal` function:

```typescript
export function formatUrl(url: string, content: string): string {
  return `// URL: ${url}\n${content}`;
}
```

Then replace the existing `buildContextMessage` function:

```typescript
// Assemble the final context message the chat prepends before the user turn.
export function buildContextMessage(parts: {
  retrieved?: string;
  files?: string;
  problems?: string;
  diff?: string;
  terminal?: string;
}): string {
  const sections: string[] = [];
  if (parts.files) sections.push(parts.files);
  if (parts.problems) sections.push(parts.problems);
  if (parts.diff) sections.push(parts.diff);
  if (parts.terminal) sections.push(parts.terminal);
  if (parts.retrieved) sections.push("// Relevant code from the workspace:\n" + parts.retrieved);
  if (sections.length === 0) return "";
  return (
    "The user referenced workspace context. Use it to answer.\n\n" +
    sections.join("\n\n")
  );
}
```

with:

```typescript
// Assemble the final context message the chat prepends before the user turn.
export function buildContextMessage(parts: {
  retrieved?: string;
  files?: string;
  problems?: string;
  diff?: string;
  terminal?: string;
  url?: string;
}): string {
  const sections: string[] = [];
  if (parts.files) sections.push(parts.files);
  if (parts.problems) sections.push(parts.problems);
  if (parts.diff) sections.push(parts.diff);
  if (parts.terminal) sections.push(parts.terminal);
  if (parts.url) sections.push(parts.url);
  if (parts.retrieved) sections.push("// Relevant code from the workspace:\n" + parts.retrieved);
  if (sections.length === 0) return "";
  return (
    "The user referenced workspace context. Use it to answer.\n\n" +
    sections.join("\n\n")
  );
}
```

- [ ] **Step 8: Run retrieval tests to verify they pass**

Run: `node --import tsx --test src/context/retrieval.test.ts` (from
`packages/core`)
Expected: all tests PASS (15 pre-existing + 3 new = 18).

- [ ] **Step 9: Run the full core suite**

Run: `npm test -w @xprei/core`
Expected: PASS — previous total (180) + 4 new `mentions.test.ts` tests +
3 new `retrieval.test.ts` tests = 187.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/context/mentions.ts packages/core/src/context/mentions.test.ts packages/core/src/context/retrieval.ts packages/core/src/context/retrieval.test.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(core): parse @url:<address> mention, add formatUrl, widen buildContextMessage"
```

---

### Task 3: `contextEngine.ts` — `fetchUrl()` and the seventh tier

**Files:**
- Modify: `extensions/vscode/src/context/contextEngine.ts`

**Interfaces:**
- Consumes: `isSafeUrl`, `isBlockedAddress` from `./urlSafety` (Task 1,
  imported via `@xprei/core`), `stripHtml` from `./htmlStrip` (Task 1,
  same), `url` field on `Mentions`, `formatUrl`, widened
  `buildContextMessage` from `@xprei/core` (Task 2).
- Produces: no change to `buildContext(mentions: Mentions, contextWindow: number): Promise<string>`'s
  public signature — this task only changes the method's internals plus
  three new private methods (`fetchUrl`, `fetchUrlWithRedirects`,
  `isHostnameBlocked`).

- [ ] **Step 1: Add the new constants**

In `extensions/vscode/src/context/contextEngine.ts`, the constants
currently read (lines 28-37):

```typescript
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
```

Add four more:

```typescript
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
```

- [ ] **Step 2: Update the imports**

The imports currently read (lines 6-26):

```typescript
import * as vscode from "vscode";
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
  MIN_SCORE,
  ProblemInfo,
  SegmentTier,
  TRUNCATION_MARKER,
} from "@xprei/core";
import { VectorStore, SearchHit } from "@xprei/core";
import { isExcludedPath, SCAN_EXCLUDE } from "@xprei/core";
```

Replace with (adds a `node:dns/promises` import, `formatUrl`,
`isBlockedAddress`, `isSafeUrl`, `stripHtml`; everything else unchanged):

```typescript
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
```

- [ ] **Step 3: Add the three new private methods**

Immediately after the existing `runTerminalCommand()` method (currently
ending right before `resolveRel()`), add:

```typescript
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
```

(The `private resolveRel(p: string): vscode.Uri | undefined {` line above
is the existing method signature already in the file — this step inserts
the three new methods immediately before it, it does not duplicate or
replace `resolveRel`.)

- [ ] **Step 4: Replace `buildContext()`'s body**

Replace the existing method (currently the `async buildContext(...)`
method, from its doc comment through its closing `}`) with:

```typescript
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
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck -w xpreiIDE-ai`
Expected: PASS.

- [ ] **Step 6: Compile**

Run: `npm run compile -w xpreiIDE-ai`
Expected: PASS, `dist/extension.js` rebuilt.

- [ ] **Step 7: Commit**

```bash
git add extensions/vscode/src/context/contextEngine.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(vscode): fetch @url:<address> with SSRF checks, wire in the seventh tier"
```

---

### Task 4: User-facing docs

**Files:**
- Modify: `extensions/vscode/README.md`
- Modify: `README.md`

**Interfaces:** none — documentation only. Required by the `CLAUDE.md`
convention: `@url` is a new chat mention users can type directly, and it
has a real usage gotcha (private/internal URLs are silently blocked)
worth documenting so a user isn't confused by silence.

- [ ] **Step 1: Update the "Codebase context (@mentions)" section in `extensions/vscode/README.md`**

That section currently ends with (search for "Combine any of these in
one message"):

```markdown
Four more mentions need no indexing at all:
- **`@open`** — inline every file you currently have open in an editor tab
  (including background tabs you're not looking at right now).
- **`@problems`** — inline the current error/warning diagnostics for your
  open files, so the model can see what's broken without you pasting it in.
- **`@diff`** — inline your current git diff (staged and unstaged
  changes combined), so the model can review or explain your in-progress
  work without you copy-pasting a diff.
- **`@terminal:<command>`** — run a shell command and inline its output,
  e.g. `why did this fail @terminal:npm test`. You'll be asked to confirm
  before it runs — this is the only mention that executes anything.
  **`@terminal:` must be the last thing in your message**: everything
  after the colon, to the end of the text, is treated as the command.

Combine any of these in one message, e.g. `@diff @problems review my changes`.
```

Replace it with:

```markdown
Five more mentions need no indexing at all:
- **`@open`** — inline every file you currently have open in an editor tab
  (including background tabs you're not looking at right now).
- **`@problems`** — inline the current error/warning diagnostics for your
  open files, so the model can see what's broken without you pasting it in.
- **`@diff`** — inline your current git diff (staged and unstaged
  changes combined), so the model can review or explain your in-progress
  work without you copy-pasting a diff.
- **`@terminal:<command>`** — run a shell command and inline its output,
  e.g. `why did this fail @terminal:npm test`. You'll be asked to confirm
  before it runs — this is the only mention that executes anything.
  **`@terminal:` must be the last thing in your message**: everything
  after the colon, to the end of the text, is treated as the command.
- **`@url:<address>`** — fetch a public URL and inline its content (HTML
  pages are stripped down to readable text), e.g.
  `@url:https://example.com/docs summarize this`. For safety, addresses
  that resolve to your own machine or local network (localhost, private
  IP ranges, cloud metadata endpoints) are silently ignored — if `@url:`
  contributes nothing, that's why.

Combine any of these in one message, e.g. `@diff @problems review my changes`.
```

- [ ] **Step 2: Update the root `README.md`'s Features list**

The existing bullet (search for `**Codebase-aware context**`) currently
reads:

```markdown
- **Codebase-aware context** — `@codebase` semantic retrieval, `@file:`
  mentions, `@open` (every open tab), `@problems` (current error/warning
  diagnostics), `@diff` (your current git diff), and `@terminal:<command>`
  (run a command and inline its output, with confirmation).
```

Replace it with:

```markdown
- **Codebase-aware context** — `@codebase` semantic retrieval, `@file:`
  mentions, `@open` (every open tab), `@problems` (current error/warning
  diagnostics), `@diff` (your current git diff), `@terminal:<command>`
  (run a command and inline its output, with confirmation), and
  `@url:<address>` (fetch a public URL, HTML stripped to text; private/
  internal addresses are blocked).
```

- [ ] **Step 3: Proofread both files**

Read both changed files back in full and confirm: no broken Markdown
(mismatched list indentation, unclosed formatting), the new content reads
naturally in place, and the private-URL-blocking note is clear enough
that a user hitting it won't think the feature is simply broken.

- [ ] **Step 4: Commit**

```bash
git add extensions/vscode/README.md README.md
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "docs: document @url:<address> mention in both user-facing READMEs"
```

---

### Task 5: Final verification

**Files:** none (verification only).

**Interfaces:** none — consumes everything built in Tasks 1-4.

- [ ] **Step 1: Run the full core test suite**

Run: `npm test -w @xprei/core`
Expected: PASS — 187 tests total (162 before this plan + 12 new
`urlSafety.test.ts` + 6 new `htmlStrip.test.ts` + 4 new
`mentions.test.ts` + 3 new `retrieval.test.ts`).

- [ ] **Step 2: Typecheck core**

Run: `npm run typecheck -w @xprei/core`
Expected: PASS.

- [ ] **Step 3: Typecheck the extension**

Run: `npm run typecheck -w xpreiIDE-ai`
Expected: PASS.

- [ ] **Step 4: Compile the extension**

Run: `npm run compile -w xpreiIDE-ai`
Expected: PASS.

- [ ] **Step 5: Manual smoke test**

Launch the Extension Development Host (F5 in VS Code against
`extensions/vscode`), with network access available:

1. Send `@url:https://example.com summarize this page`. Confirm the
   response reflects the real page content (a simple, small, stable
   test page — `example.com` is a good choice), with HTML tags/scripts
   NOT visible in what the model was given (verify by checking, if
   possible, that the context block passed to the provider looks like
   readable text, not raw markup).
2. Send `@url:http://localhost:3000` (or any port with nothing/something
   listening locally) or `@url:http://127.0.0.1` and confirm it's
   silently blocked — no error toast, and the chat response reads as if
   `@url:` contributed nothing.
3. Send `@url:http://169.254.169.254/` (a cloud-metadata-shaped address —
   don't worry if nothing is actually listening there locally, the point
   is confirming the block happens before any request attempt, not that
   a real server responds) and confirm it's also silently blocked.
4. Find or construct a URL that redirects (many URL shorteners do this)
   and confirm the final content is fetched correctly through the
   redirect. If you can find/construct one that redirects to a private
   address, confirm that's blocked too — otherwise this sub-case is
   covered adequately by the reasoning in Task 3's implementation
   (redirect target re-validated through the same loop-top checks as the
   original URL).
5. Send a plain message with no mentions and confirm chat still works
   exactly as before (empty context block, no regression).

If all five checks behave as expected, no further action needed — this
task has no commit of its own.
