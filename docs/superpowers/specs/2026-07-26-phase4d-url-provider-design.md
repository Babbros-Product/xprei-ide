# Phase 4d: @url context provider — design

Date: 2026-07-26

## Context

Fifth provider sub-project of Phase 4 ("Richer context providers") from
`docs/feature-roadmap.md`. Deliberately isolated in the decomposition
because it's the only provider that makes a network request — a distinct
security profile (SSRF, response size, timeout) from every other provider
built so far, all of which touch only local files, git, or a
user-launched shell command.

**`@url:<address>`** — fetch a URL and inject its content as chat context.

## Decisions

- **Takes an argument, like `@file:`/`@terminal:`.** Syntax is
  `@url:<address>`, captured with a plain `\S+` pattern (like `@file:`) —
  well-formed URLs don't contain unescaped spaces, so this is simpler
  than `@terminal:`'s end-of-string capture.
- **Block private/loopback/link-local addresses and non-http(s)
  schemes.** SSRF is the primary risk: an internal or crafted URL could
  make the user's own machine probe localhost, LAN services, or
  cloud-metadata endpoints (`169.254.169.254`) through the extension.
  Rejected before any request is issued:
  - Any scheme other than `http:`/`https:` (no `file:`, `ftp:`, `data:`, etc.).
  - Hostnames resolving to a private/loopback/link-local address:
    `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`,
    `169.254.0.0/16` (IPv4), `::1`, `fc00::/7` (IPv6 unique local).
  - **Redirects are re-validated**, not trusted blindly — a public URL
    that 302s to a blocked target must not bypass the check. Fetch with
    `redirect: "manual"`, manually follow up to a small hop limit,
    re-running the full scheme+IP check at every hop.
- **Minimal hand-rolled HTML stripping, no new dependency.** No
  HTML-to-text/markdown library exists anywhere in this repo (confirmed:
  zero such dependency in any `package.json`), consistent with the
  project's stated dependency-free philosophy. Adding one (`cheerio`/
  `jsdom`) would mean parsing untrusted remote HTML with a heavier
  library — itself a larger attack surface than the content it's meant
  to clean up. A small regex/string-based stripper (drop `<script>`/
  `<style>` blocks wholesale, strip remaining tags, collapse whitespace)
  is not as robust as a real parser but is proportionate: "good enough
  page text for the model," zero new dependencies, small surface.
  Non-HTML responses (by `Content-Type`) are injected as-is.
- **10-second timeout, 500KB cap enforced during the read.** Much
  shorter than the agent loop's 120-second shell-command timeout — a
  hung network fetch blocking chat-message send is worse UX than a hung
  local command, since the user has no visibility into why sending is
  stuck. The 500KB cap is enforced on the streaming response body
  (abort once exceeded), not "download everything, truncate after" —
  protects against a slow/huge response consuming bandwidth and memory
  before any cap is applied.
- **Single segment, `"break"` strategy** — one blob, same reasoning as
  `@diff`/`@terminal`: fetched content can't be usefully split into
  independent pieces.
- **Tier priority: after `@terminal`, before `@open`.** Groups the
  "fetch/run and show me the result" tiers together. Full order, highest
  to lowest: `@file:` (`"break"`) → `@problems` (`"skip"`) → `@diff`
  (`"break"`) → `@terminal` (`"break"`) → `@url` (`"break"`) → `@open`
  (`"break"`) → `@codebase` hits (`"skip"`, lowest).
- **Silent-empty on every failure**, matching every other mention:
  unreachable host, blocked private IP, non-2xx response, timeout,
  oversized response all degrade to `""` with no error toast.
- **URL validation logic lives in `@xprei/core`, pure and fully unit
  tested** — unlike the other providers' gathering methods (which live
  untested in the extension layer by convention), the safety check
  itself (scheme validation, IP-range rejection, redirect re-validation)
  has no VS Code dependency and is exactly the kind of logic that
  deserves real test coverage of every blocked range, not a manual smoke
  test. Only the actual network I/O (the `fetch()` call itself) and HTML
  stripping stay in the extension layer.

## Architecture

### `packages/core/src/context/mentions.ts`

```typescript
export interface Mentions {
  codebase: boolean;
  open: boolean;
  problems: boolean;
  diff: boolean;
  terminalCommand: string | undefined;
  url: string | undefined; // new
  files: string[];
  cleaned: string;
}

const URL_RE = /(^|\s)@url:(\S+)/gi;
```

Stripped the same way `FILE_RE` is (returns the leading-whitespace `pre`
capture in place of the match). `hasContextRequest()` gains
`|| m.url !== undefined`.

### `packages/core/src/context/urlSafety.ts` (new, pure)

```typescript
// Validates a URL is safe to fetch: http(s) only, not a private/loopback/
// link-local address. Pure — no network I/O, no vscode dependency. The
// caller (contextEngine.ts) is responsible for re-running this on every
// redirect hop, not just the original URL, since a public URL can 302 to
// a blocked target.

export function isBlockedHostname(hostname: string): boolean {
  // Resolves via the caller-supplied lookup (dependency-injected so this
  // stays pure/unit-testable without a real DNS call) and checks the
  // resolved address against the private/loopback/link-local ranges
  // listed in this spec's Decisions section.
}

export function isSafeUrl(parsed: URL): boolean {
  return parsed.protocol === "http:" || parsed.protocol === "https:";
  // Hostname/IP-range check is a separate async step (needs DNS
  // resolution) — see isBlockedHostname, called by the extension-layer
  // fetchUrl() after this synchronous scheme check passes.
}
```

(Exact function boundary between synchronous scheme-check and
async DNS-based IP-range-check is an implementation-plan detail; the
design-level commitment is: both checks exist, both are pure/testable in
`@xprei/core`, and both run again on every redirect hop.)

### `packages/core/src/context/retrieval.ts`

```typescript
export function formatUrl(url: string, content: string): string {
  return `// URL: ${url}\n${content}`;
}
```

`buildContextMessage` gains a sixth optional parameter, `url?: string`,
assembled at the locked tier position (after `terminal`, before `open`'s
implicit position within `files`).

### `extensions/vscode/src/context/contextEngine.ts`

One new private method doing the actual network I/O:

```typescript
private async fetchUrl(address: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(address);
  } catch {
    return "";
  }
  if (!isSafeUrl(parsed)) return "";

  // Follow redirects manually (small hop limit), re-validating scheme +
  // resolved-IP-range at every hop via isSafeUrl()/isBlockedHostname().
  // Stream the response body with a 10s AbortController timeout and a
  // 500KB cap enforced during the read (abort once exceeded, not after
  // full download). Strip <script>/<style> blocks and remaining tags for
  // text/html responses; inject non-HTML responses as-is.
  // Any failure (network error, timeout, size-cap abort, blocked
  // redirect target) returns "" — silent, matching every other mention.
}
```

`buildContext()` grows a seventh tier at the locked position, built
unconditionally like every other tier:

```typescript
const urlContent = mentions.url ? await this.fetchUrl(mentions.url) : "";

const urlTier: SegmentTier = {
  segments: urlContent ? [{ text: formatUrl(mentions.url!, urlContent), data: null }] : [],
  strategy: "break",
};
```

inserted into the `budgetContext([...])` array and the positional
destructure between the terminal tier/segments and the open tier/segments.

## Out of scope

- No allowlist/denylist of specific domains — the IP-range check is the
  only gate; any public internet address is fetchable.
- No JavaScript execution / headless-browser rendering of the target
  page — a plain HTTP GET and static-HTML strip only. Pages that require
  JS to render meaningful content will inject mostly boilerplate.
- No caching of fetched URLs across mentions/turns.
- No authentication (cookies, headers) passed to the fetched URL —
  purely a public, unauthenticated GET.

## Testing

- `mentions.ts`: extend `mentions.test.ts` with `@url:<address>` parsing
  and stripping, combined with the other mention types.
- `urlSafety.ts` (new, pure): full unit tests — every listed private/
  loopback/link-local range rejected, public addresses accepted,
  non-http(s) schemes rejected, redirect-hop re-validation logic
  (whatever shape the implementation plan settles on) exercised against
  both a safe-target and a blocked-target redirect chain.
- `retrieval.ts`: extend `retrieval.test.ts` with `formatUrl` and the
  widened `buildContextMessage`'s six-section ordering.
- `contextEngine.ts`'s `fetchUrl()`: extension-layer, network-I/O-
  dependent — no unit tests, verified by `npm run typecheck -w xpreiIDE-ai`
  + `npm run compile -w xpreiIDE-ai`, plus a manual smoke test: fetch a
  real public page and confirm HTML is stripped to readable text; try
  `@url:http://localhost:3000` (or any locally-running service) and
  confirm it's silently blocked; try a URL that redirects to a private
  address and confirm the redirect target is also blocked, not just the
  original; try a deliberately slow/huge endpoint and confirm the 10s
  timeout / 500KB cap actually cut it off rather than hanging or
  consuming excessive memory.
