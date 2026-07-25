# Phase 6: Shared YAML Config Format Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 7 `xpreiIDE.*` VS Code settings (`providers`,
`activeModel`, `embedModel`, `completionModel`, `agentModel`,
`inlineEditModel`, `commitMessageModel`) with one shared file,
`~/.xpreiide/config.yaml`, readable/writable identically by VS Code and
(unverified, ported by inspection) the IntelliJ/Eclipse plugin scaffolds.

**Architecture:** Two new pure `@xprei/core` modules — `yamlLite.ts` (a
hand-rolled restricted-subset YAML parser/serializer) and `schema.ts`
(the typed `XpreiConfig` shape + defensive parse/serialize) — fully unit
tested. A new extension-layer `configStore.ts` (`loadConfig`/`saveConfig`,
no caching) replaces every `vscode.workspace.getConfiguration("xpreiIDE")`
touch for these 7 settings across `registry.ts`, `extension.ts`,
`chatView.ts`, `addProviderFlow.ts`, and `autoDiscover.ts`. The 7
corresponding `package.json` configuration entries are removed (clean
cutover, no Marketplace users to migrate). IntelliJ/Eclipse get an
unverified port of the same read/write logic.

**Tech Stack:** TypeScript, Node's built-in `node:test` + `assert/strict`,
`node:fs`/`node:os`/`node:path`, VS Code extension API.

## Global Constraints

- **Exact scope: 7 settings.** `providers`, `activeModel`, `embedModel`,
  `completionModel`, `agentModel`, `inlineEditModel`,
  `commitMessageModel`. VS Code-only UX toggles (`agent.autoApprove`,
  `agent.maxSteps`, `agent.protocolRetries`, `completions.enabled`) are
  **untouched** — they stay in native `settings.json`.
- **Location: `~/.xpreiide/config.yaml`** (`os.homedir()`-based).
- **Hand-rolled restricted YAML subset, no new dependency.** Supported:
  block-style `key: value` mappings, `- ` sequences (of scalars or
  nested mappings), simple quoted/unquoted scalars, `#` comments. **Not
  supported:** anchors/aliases, flow collections (`[a, b]`, `{a: b}`),
  multi-document files.
- **No caching, read fresh on every access.**
- **Clean cutover, no migration code** — no Marketplace users exist yet
  (confirmed in `CLAUDE.md`).
- **Unknown-key preservation on write.** `parseConfig` retains the full
  raw parsed map; `serializeConfig` merges known fields back over it, so
  an unrelated write never drops a key this schema doesn't know about
  (e.g. a future `mcpServers` section).
- **Never return or share the literal `DEFAULT_CONFIG` object reference**
  from any function a caller might mutate — always a fresh
  object/array copy. (This is a specific correctness risk this plan's
  Task 1/3 tests explicitly guard against — see the "shared reference"
  tests below.)
- **Commits:** author `xpreiIDE <mbsajay1@gmail.com>` — pass it
  explicitly, e.g. `git -c user.name="xpreiIDE" -c
  user.email="mbsajay1@gmail.com" commit -m "..."`. **Do NOT add a
  `Co-Authored-By` footer or any other footer.** Conventional Commit
  prefixes (feat/fix/docs/etc).
- **No new unit tests for VS Code-layer files** (`registry.ts`,
  `extension.ts`, `chatView.ts`, `addProviderFlow.ts`,
  `autoDiscover.ts`, `configStore.ts`) — none exist today for these
  files, consistent with this project's established convention.
  Typecheck + compile + manual smoke test only.
- **IntelliJ/Eclipse work is unverifiable** in this environment (no
  local JDK/Gradle/Maven) — must be clearly commented as such in the
  code itself and in the task's commit message.

---

### Task 1: `yamlLite.ts` — pure, fully unit tested

**Files:**
- Create: `packages/core/src/config/yamlLite.ts`
- Create: `packages/core/src/config/yamlLite.test.ts`
- Modify: `packages/core/package.json` (register the new test file)
- Modify: `packages/core/src/index.ts` (barrel-export the new module)

**Interfaces:**
- Produces: `YamlValue`, `YamlMap`, `parseYamlLite(content: string):
  YamlMap`, `stringifyYamlLite(value: YamlMap): string` — Task 2
  consumes all four.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/config/yamlLite.test.ts`:

```typescript
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseYamlLite, stringifyYamlLite } from "./yamlLite";

test("parseYamlLite parses a flat mapping of scalars", () => {
  const out = parseYamlLite("activeModel: ollama-local::llama3.1\nembedModel: \"\"\n");
  assert.deepEqual(out, { activeModel: "ollama-local::llama3.1", embedModel: "" });
});

test("parseYamlLite parses a sequence of scalars", () => {
  const out = parseYamlLite("args:\n  - -y\n  - server-name\n");
  assert.deepEqual(out, { args: ["-y", "server-name"] });
});

test("parseYamlLite parses a sequence of mappings, each with multiple keys", () => {
  const content =
    "providers:\n" +
    "  - id: ollama-local\n" +
    "    kind: ollama\n" +
    "    label: Ollama (local)\n" +
    "    baseUrl: http://localhost:11434\n" +
    "  - id: openai\n" +
    "    kind: openai-compat\n" +
    "    label: OpenAI\n" +
    "    baseUrl: https://api.openai.com/v1\n" +
    "    model: gpt-4o-mini\n";
  const out = parseYamlLite(content);
  assert.deepEqual(out, {
    providers: [
      { id: "ollama-local", kind: "ollama", label: "Ollama (local)", baseUrl: "http://localhost:11434" },
      {
        id: "openai",
        kind: "openai-compat",
        label: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
      },
    ],
  });
});

test("parseYamlLite parses a nested mapping of mappings", () => {
  const content =
    "mcpServers:\n" +
    "  filesystem:\n" +
    "    command: npx\n" +
    "    args:\n" +
    "      - -y\n" +
    "      - server-name\n";
  const out = parseYamlLite(content);
  assert.deepEqual(out, {
    mcpServers: {
      filesystem: { command: "npx", args: ["-y", "server-name"] },
    },
  });
});

test("parseYamlLite strips comments, including a full-line comment and a trailing one", () => {
  const content = "# a full-line comment\nactiveModel: foo # trailing comment\n";
  const out = parseYamlLite(content);
  assert.deepEqual(out, { activeModel: "foo" });
});

test("parseYamlLite does not treat a '#' inside a quoted scalar as a comment", () => {
  const out = parseYamlLite('label: "issue #42 support"\n');
  assert.deepEqual(out, { label: "issue #42 support" });
});

test("parseYamlLite strips wrapping quotes from quoted scalars", () => {
  const out = parseYamlLite('activeModel: "ollama-local::llama3.1"\n');
  assert.deepEqual(out, { activeModel: "ollama-local::llama3.1" });
});

test("parseYamlLite treats a colon inside an unquoted value (a URL) as part of the value, not a new key", () => {
  const out = parseYamlLite("baseUrl: http://localhost:11434\n");
  assert.deepEqual(out, { baseUrl: "http://localhost:11434" });
});

test("parseYamlLite returns {} for empty content", () => {
  assert.deepEqual(parseYamlLite(""), {});
  assert.deepEqual(parseYamlLite("\n\n"), {});
});

test("stringifyYamlLite/parseYamlLite round-trip a representative config document", () => {
  const value = {
    providers: [
      { id: "ollama-local", kind: "ollama", label: "Ollama (local)", baseUrl: "http://localhost:11434" },
      { id: "openai", kind: "openai-compat", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
    ],
    activeModel: "ollama-local::llama3.1",
    embedModel: "",
    mcpServers: {
      filesystem: { command: "npx", args: ["-y", "server-name"] },
    },
  };
  const out = parseYamlLite(stringifyYamlLite(value));
  assert.deepEqual(out, value);
});

test("stringifyYamlLite quotes an empty string and a numeric-looking string", () => {
  const out = stringifyYamlLite({ activeModel: "", weird: "123" });
  assert.match(out, /activeModel: ""/);
  assert.match(out, /weird: "123"/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `packages/core`): `node --import tsx --test src/config/yamlLite.test.ts`
Expected: FAIL — `./yamlLite` doesn't exist yet.

- [ ] **Step 3: Implement `yamlLite.ts`**

Create `packages/core/src/config/yamlLite.ts`:

```typescript
// Hand-rolled restricted-subset YAML parser/serializer for
// ~/.xpreiide/config.yaml. No dependency, no anchors, no flow
// collections, no multi-document files — a deliberate v1 subset (see
// docs/superpowers/specs/2026-07-26-phase6-shared-config-design.md for
// why). Pure module — no vscode, no file I/O.

export type YamlValue = string | number | boolean | null | YamlValue[] | YamlMap;
export interface YamlMap {
  [key: string]: YamlValue;
}

interface Line {
  indent: number;
  text: string;
}

function stripQuotes(s: string): string {
  if (s.length >= 2) {
    if (s[0] === '"' && s[s.length - 1] === '"') return s.slice(1, -1);
    if (s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1);
  }
  return s;
}

function parseScalar(raw: string): YamlValue {
  const s = raw.trim();
  if (s === "" || s === "~" || s === "null") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(s) && s[0] !== '"' && s[0] !== "'") return Number(s);
  return stripQuotes(s);
}

// Splits raw file content into indent-tagged, comment-stripped,
// blank-line-free lines. A "#" inside a quoted scalar is NOT treated as
// a comment start.
function tokenize(content: string): Line[] {
  const lines: Line[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine;
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === "'" && !inDouble) inSingle = !inSingle;
      else if (ch === '"' && !inSingle) inDouble = !inDouble;
      else if (ch === "#" && !inSingle && !inDouble) {
        line = line.slice(0, i);
        break;
      }
    }
    line = line.replace(/\s+$/, "");
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    lines.push({ indent, text: line.trim() });
  }
  return lines;
}

// Finds the index of the "key:" delimiter in a "key: value" (or bare
// "key:") line: the first ":" that is either followed by a space or is
// the last character, and isn't inside a quoted scalar. This is what
// lets an unquoted URL value ("http://localhost:11434") pass through
// without its own colons being mistaken for a new key.
function findKeyColon(text: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let k = 0; k < text.length; k++) {
    const ch = text[k];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === ":" && !inSingle && !inDouble) {
      if (text[k + 1] === " " || k === text.length - 1) return k;
    }
  }
  return -1;
}

function parseBlock(lines: Line[], start: number): { value: YamlValue; next: number } {
  const indent = lines[start].indent;
  if (lines[start].text.startsWith("- ") || lines[start].text === "-") {
    return parseSequence(lines, start, indent);
  }
  return parseMapping(lines, start, indent);
}

function parseSequence(lines: Line[], start: number, indent: number): { value: YamlValue; next: number } {
  const out: YamlValue[] = [];
  let i = start;
  while (
    i < lines.length &&
    lines[i].indent === indent &&
    (lines[i].text.startsWith("- ") || lines[i].text === "-")
  ) {
    const itemText = lines[i].text === "-" ? "" : lines[i].text.slice(2);
    const childIndent = indent + 2;
    if (itemText === "") {
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const child = parseBlock(lines, i + 1);
        out.push(child.value);
        i = child.next;
      } else {
        out.push(null);
        i++;
      }
      continue;
    }
    const colonIdx = findKeyColon(itemText);
    if (colonIdx === -1) {
      out.push(parseScalar(itemText));
      i++;
      continue;
    }
    // "- key: value" starts an inline mapping for this item. Sweep in
    // every following line indented at least as deep as this item's
    // first key (childIndent) — those are this item's other keys. A
    // sibling sequence item at the outer `indent` (strictly less than
    // childIndent) naturally stops the sweep.
    const syntheticLines: Line[] = [{ indent: childIndent, text: itemText }];
    let j = i + 1;
    while (j < lines.length && lines[j].indent >= childIndent) {
      syntheticLines.push(lines[j]);
      j++;
    }
    const mapResult = parseMapping(syntheticLines, 0, childIndent);
    out.push(mapResult.value);
    i = j;
  }
  return { value: out, next: i };
}

function parseMapping(lines: Line[], start: number, indent: number): { value: YamlValue; next: number } {
  const out: YamlMap = {};
  let i = start;
  while (i < lines.length && lines[i].indent === indent) {
    const text = lines[i].text;
    const colonIdx = findKeyColon(text);
    if (colonIdx === -1) break;
    const key = stripQuotes(text.slice(0, colonIdx).trim());
    const rest = text.slice(colonIdx + 1).trim();
    if (rest === "") {
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const child = parseBlock(lines, i + 1);
        out[key] = child.value;
        i = child.next;
      } else {
        out[key] = null;
        i++;
      }
    } else {
      out[key] = parseScalar(rest);
      i++;
    }
  }
  return { value: out, next: i };
}

// Parses a block-style mapping document. Top-level scalar/sequence
// documents are not supported — every config file this project writes
// is a top-level mapping.
export function parseYamlLite(content: string): YamlMap {
  const lines = tokenize(content);
  if (lines.length === 0) return {};
  const result = parseMapping(lines, 0, lines[0].indent);
  return result.value as YamlMap;
}

function needsQuoting(s: string): boolean {
  if (s === "") return true;
  if (/^-?\d+(\.\d+)?$/.test(s)) return true;
  if (s === "true" || s === "false" || s === "null" || s === "~") return true;
  if (/^\s/.test(s) || /\s$/.test(s)) return true;
  if (s.includes(": ") || s.startsWith("#") || s.startsWith("- ") || s.startsWith("'") || s.startsWith('"')) {
    return true;
  }
  return false;
}

function quoteScalar(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function formatScalar(v: string | number | boolean | null): string {
  if (v === null) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return needsQuoting(v) ? quoteScalar(v) : v;
}

function isPlainObject(v: YamlValue): v is YamlMap {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function stringifyValue(value: YamlValue, indent: number, lines: string[]): void {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (isPlainObject(item)) {
        const entries = Object.entries(item);
        if (entries.length === 0) {
          lines.push(`${pad}- {}`);
          continue;
        }
        const [firstKey, firstVal] = entries[0];
        if (isPlainObject(firstVal) || Array.isArray(firstVal)) {
          lines.push(`${pad}- ${firstKey}:`);
          stringifyValue(firstVal, indent + 4, lines);
        } else {
          lines.push(`${pad}- ${firstKey}: ${formatScalar(firstVal)}`);
        }
        for (const [k, v] of entries.slice(1)) {
          if (isPlainObject(v) || Array.isArray(v)) {
            lines.push(`${pad}  ${k}:`);
            stringifyValue(v, indent + 4, lines);
          } else {
            lines.push(`${pad}  ${k}: ${formatScalar(v)}`);
          }
        }
      } else if (Array.isArray(item)) {
        lines.push(`${pad}-`);
        stringifyValue(item, indent + 2, lines);
      } else {
        lines.push(`${pad}- ${formatScalar(item)}`);
      }
    }
    return;
  }
  for (const [key, v] of Object.entries(value)) {
    if (isPlainObject(v) || Array.isArray(v)) {
      lines.push(`${pad}${key}:`);
      stringifyValue(v, indent + 2, lines);
    } else {
      lines.push(`${pad}${key}: ${formatScalar(v)}`);
    }
  }
}

// Canonical 2-space-indent, block-style-only output.
export function stringifyYamlLite(value: YamlMap): string {
  const lines: string[] = [];
  stringifyValue(value, 0, lines);
  return lines.join("\n") + "\n";
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `packages/core`): `node --import tsx --test src/config/yamlLite.test.ts`
Expected: PASS. If a specific test fails (most likely candidate: the
nested-mapping-of-mappings test, or the sequence-of-mappings test), read
the failure carefully — this parser resolves key/value boundaries and
nesting purely from indentation and the "colon-then-space-or-end-of-line"
rule; check the failing input's exact indentation against `childIndent`
math above before changing the algorithm's structure.

- [ ] **Step 5: Register the test file and barrel-export the module**

In `packages/core/package.json`, add `src/config/yamlLite.test.ts` to the
`test` script's file list, immediately after
`src/context/ignoreFile.test.ts`.

In `packages/core/src/index.ts`, add immediately after
`export * from "./context/ignoreFile";`:

```typescript
export * from "./config/yamlLite";
```

- [ ] **Step 6: Run the full core suite to confirm nothing broke**

Run (from `packages/core`): `npm test`
Expected: PASS — 238 tests total (227 before this plan + 11 new
`yamlLite.test.ts`).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/config/yamlLite.ts packages/core/src/config/yamlLite.test.ts packages/core/package.json packages/core/src/index.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(core): add hand-rolled restricted-subset YAML parser/serializer"
```

---

### Task 2: `schema.ts` — pure, fully unit tested

**Files:**
- Create: `packages/core/src/config/schema.ts`
- Create: `packages/core/src/config/schema.test.ts`
- Modify: `packages/core/package.json` (register the new test file)
- Modify: `packages/core/src/index.ts` (barrel-export the new module)

**Interfaces:**
- Consumes: `parseYamlLite`/`stringifyYamlLite`/`YamlMap` from
  `./yamlLite` (Task 1); `ProviderConfig` from `../providers/provider`
  (already exists).
- Produces: `XpreiConfig`, `DEFAULT_CONFIG`, `parseConfig(content:
  string): { config: XpreiConfig; raw: YamlMap }`,
  `serializeConfig(config: XpreiConfig, raw: YamlMap): string` — Task 3
  consumes all four.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/config/schema.test.ts`:

```typescript
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, parseConfig, serializeConfig, XpreiConfig } from "./schema";

test("parseConfig on empty content returns DEFAULT_CONFIG's values", () => {
  const { config } = parseConfig("");
  assert.deepEqual(config, DEFAULT_CONFIG);
});

test("parseConfig returns a config object that is NOT the literal DEFAULT_CONFIG reference", () => {
  const { config: a } = parseConfig("");
  const { config: b } = parseConfig("");
  assert.notEqual(a, DEFAULT_CONFIG);
  assert.notEqual(a, b);
  assert.notEqual(a.providers, DEFAULT_CONFIG.providers);
});

test("mutating one parseConfig('') result's providers array does not affect a later parseConfig('') call", () => {
  const { config: a } = parseConfig("");
  a.providers.push({ id: "x", kind: "ollama", label: "X", baseUrl: "http://x" });
  const { config: b } = parseConfig("");
  assert.equal(b.providers.length, DEFAULT_CONFIG.providers.length);
});

test("parseConfig reads a well-formed document's fields", () => {
  const content =
    "providers:\n" +
    "  - id: ollama-local\n" +
    "    kind: ollama\n" +
    "    label: Ollama (local)\n" +
    "    baseUrl: http://localhost:11434\n" +
    "activeModel: ollama-local::llama3.1\n" +
    "embedModel: ollama-local::nomic-embed-text\n";
  const { config } = parseConfig(content);
  assert.deepEqual(config.providers, [
    { id: "ollama-local", kind: "ollama", label: "Ollama (local)", baseUrl: "http://localhost:11434" },
  ]);
  assert.equal(config.activeModel, "ollama-local::llama3.1");
  assert.equal(config.embedModel, "ollama-local::nomic-embed-text");
  assert.equal(config.completionModel, "");
});

test("parseConfig drops a malformed provider entry (missing a required field) without crashing", () => {
  const content =
    "providers:\n" +
    "  - id: good\n" +
    "    kind: ollama\n" +
    "    label: Good\n" +
    "    baseUrl: http://good\n" +
    "  - id: bad-missing-basecurl\n" +
    "    kind: ollama\n" +
    "    label: Bad\n";
  const { config } = parseConfig(content);
  assert.deepEqual(config.providers, [
    { id: "good", kind: "ollama", label: "Good", baseUrl: "http://good" },
  ]);
});

test("parseConfig falls back to [] when 'providers' isn't an array at all", () => {
  const { config } = parseConfig("providers: not-an-array\nactiveModel: x\n");
  assert.deepEqual(config.providers, DEFAULT_CONFIG.providers);
  assert.equal(config.activeModel, "x");
});

test("serializeConfig round-trips through parseConfig", () => {
  const config: XpreiConfig = {
    providers: [
      { id: "a", kind: "ollama", label: "A", baseUrl: "http://a" },
      { id: "b", kind: "openai-compat", label: "B", baseUrl: "http://b", model: "gpt-4o-mini" },
    ],
    activeModel: "a::llama3.1",
    embedModel: "",
    completionModel: "",
    agentModel: "",
    inlineEditModel: "",
    commitMessageModel: "",
  };
  const { raw } = parseConfig("");
  const text = serializeConfig(config, raw);
  const reparsed = parseConfig(text);
  assert.deepEqual(reparsed.config, config);
});

test("serializeConfig preserves an unknown top-level key across a write", () => {
  const { raw } = parseConfig("mcpServers:\n  filesystem:\n    command: npx\n");
  const text = serializeConfig({ ...DEFAULT_CONFIG, activeModel: "a::b" }, raw);
  const reparsed = parseConfig(text);
  assert.equal(reparsed.config.activeModel, "a::b");
  assert.deepEqual(reparsed.raw.mcpServers, { filesystem: { command: "npx" } });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `packages/core`): `node --import tsx --test src/config/schema.test.ts`
Expected: FAIL — `./schema` doesn't exist yet.

- [ ] **Step 3: Implement `schema.ts`**

Create `packages/core/src/config/schema.ts`:

```typescript
// Typed schema and defaults for the shared ~/.xpreiide/config.yaml.
// Pure module — no vscode, no file I/O. See
// docs/superpowers/specs/2026-07-26-phase6-shared-config-design.md.

import { ProviderConfig } from "../providers/provider";
import { parseYamlLite, stringifyYamlLite, YamlMap } from "./yamlLite";

export interface XpreiConfig {
  providers: ProviderConfig[];
  activeModel: string;
  embedModel: string;
  completionModel: string;
  agentModel: string;
  inlineEditModel: string;
  commitMessageModel: string;
}

export const DEFAULT_CONFIG: XpreiConfig = {
  providers: [
    { id: "ollama-local", kind: "ollama", label: "Ollama (local)", baseUrl: "http://localhost:11434" },
  ],
  activeModel: "",
  embedModel: "",
  completionModel: "",
  agentModel: "",
  inlineEditModel: "",
  commitMessageModel: "",
};

function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

// A fresh copy every time — never the shared DEFAULT_CONFIG.providers
// array reference, so a caller mutating the returned array can't
// corrupt the default for a later call in the same process.
function defaultProviders(): ProviderConfig[] {
  return DEFAULT_CONFIG.providers.map((p) => ({ ...p }));
}

function parseProviders(raw: unknown): ProviderConfig[] {
  if (!Array.isArray(raw)) return defaultProviders();
  const out: ProviderConfig[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id : undefined;
    const kind = e.kind === "ollama" || e.kind === "openai-compat" ? e.kind : undefined;
    const label = typeof e.label === "string" ? e.label : undefined;
    const baseUrl = typeof e.baseUrl === "string" ? e.baseUrl : undefined;
    if (!id || !kind || !label || !baseUrl) continue; // drop malformed entries
    const cfg: ProviderConfig = { id, kind, label, baseUrl };
    if (typeof e.model === "string" && e.model) cfg.model = e.model;
    out.push(cfg);
  }
  return out;
}

// Parses raw file content into a typed config, defensively: missing or
// malformed fields fall back to DEFAULT_CONFIG's values; each
// providers[] entry missing a required string field is dropped rather
// than crashing the whole parse. Unrecognized top-level keys are
// preserved in `raw` (not exposed on XpreiConfig) so a later
// serializeConfig() call doesn't drop them. Always returns a fresh
// XpreiConfig object — never a reference into DEFAULT_CONFIG.
export function parseConfig(content: string): { config: XpreiConfig; raw: YamlMap } {
  const raw = parseYamlLite(content);
  const config: XpreiConfig = {
    providers: parseProviders(raw.providers),
    activeModel: str(raw.activeModel, ""),
    embedModel: str(raw.embedModel, ""),
    completionModel: str(raw.completionModel, ""),
    agentModel: str(raw.agentModel, ""),
    inlineEditModel: str(raw.inlineEditModel, ""),
    commitMessageModel: str(raw.commitMessageModel, ""),
  };
  return { config, raw };
}

// Merges config's known fields over the raw map parseConfig retained
// (preserving unknown keys, e.g. a future mcpServers section), then
// stringifies via stringifyYamlLite.
export function serializeConfig(config: XpreiConfig, raw: YamlMap): string {
  const merged: YamlMap = {
    ...raw,
    providers: config.providers.map((p) => ({ ...p }) as unknown as YamlMap),
    activeModel: config.activeModel,
    embedModel: config.embedModel,
    completionModel: config.completionModel,
    agentModel: config.agentModel,
    inlineEditModel: config.inlineEditModel,
    commitMessageModel: config.commitMessageModel,
  };
  return stringifyYamlLite(merged);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `packages/core`): `node --import tsx --test src/config/schema.test.ts`
Expected: PASS — all 8 tests green.

- [ ] **Step 5: Register the test file and barrel-export the module**

In `packages/core/package.json`, add `src/config/schema.test.ts` to the
`test` script's file list, immediately after `src/config/yamlLite.test.ts`.

In `packages/core/src/index.ts`, add immediately after
`export * from "./config/yamlLite";`:

```typescript
export * from "./config/schema";
```

- [ ] **Step 6: Run the full core suite to confirm nothing broke**

Run (from `packages/core`): `npm test`
Expected: PASS — 246 tests total (238 after Task 1 + 8 new
`schema.test.ts`).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/config/schema.ts packages/core/src/config/schema.test.ts packages/core/package.json packages/core/src/index.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(core): add typed XpreiConfig schema with defensive parse/serialize"
```

---

### Task 3: `configStore.ts` (extension layer)

**Files:**
- Create: `extensions/vscode/src/config/configStore.ts`

**Interfaces:**
- Consumes: `DEFAULT_CONFIG`, `parseConfig`, `serializeConfig`,
  `XpreiConfig`, `YamlMap` from `@xprei/core` (Tasks 1-2).
- Produces: `configPath(): string`, `loadConfig(): Promise<{ config:
  XpreiConfig; raw: YamlMap }>`, `saveConfig(config: XpreiConfig, raw:
  YamlMap): Promise<void>` — Tasks 4-8 all consume these three.

- [ ] **Step 1: Create the config store**

Create `extensions/vscode/src/config/configStore.ts`:

```typescript
// Reads/writes the shared ~/.xpreiide/config.yaml. No caching — every
// call re-reads the file, matching projectRules.ts/ignoreFile.ts.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG, parseConfig, serializeConfig, XpreiConfig, YamlMap } from "@xprei/core";

export function configPath(): string {
  return path.join(os.homedir(), ".xpreiide", "config.yaml");
}

export async function loadConfig(): Promise<{ config: XpreiConfig; raw: YamlMap }> {
  try {
    const content = await fs.readFile(configPath(), "utf8");
    return parseConfig(content);
  } catch {
    // No config file yet — a fresh copy, never the literal DEFAULT_CONFIG
    // object, so a caller mutating the returned config can't corrupt the
    // shared default for a later call in this same process.
    return { config: { ...DEFAULT_CONFIG, providers: DEFAULT_CONFIG.providers.map((p) => ({ ...p })) }, raw: {} };
  }
}

export async function saveConfig(config: XpreiConfig, raw: YamlMap): Promise<void> {
  const p = configPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, serializeConfig(config, raw), "utf8");
}
```

- [ ] **Step 2: Typecheck the extension**

Run: `npm run typecheck -w xpreiIDE-ai`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add extensions/vscode/src/config/configStore.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(vscode): add configStore for the shared ~/.xpreiide/config.yaml"
```

---

### Task 4: Migrate `registry.ts`

**Files:**
- Modify: `extensions/vscode/src/providers/registry.ts`

**Interfaces:**
- Consumes: `loadConfig`/`saveConfig` from `../config/configStore` (Task
  3); `XpreiConfig` from `@xprei/core` (Task 2).
- Produces: `getConfigs()` becomes `async getConfigs():
  Promise<ProviderConfig[]>` (was sync) — every call site across the
  extension (Tasks 5-8) must add `await`. `resolvePointer(setting,
  fallbackSetting?)`'s parameters are now typed `ModelSettingKey` (a
  union of the 6 non-`providers` `XpreiConfig` field names) instead of
  bare `string` — Task 5's `extension.ts` already declares a
  structurally-identical `ModelSetting` union, so passing its values
  here still typechecks with no changes needed there.

- [ ] **Step 1: Replace the whole file**

Replace `extensions/vscode/src/providers/registry.ts` in full with:

```typescript
// Provider registry. Reads provider configs from the shared
// ~/.xpreiide/config.yaml (see ../config/configStore.ts), resolves the
// active model, and constructs the right adapter — injecting API keys
// from SecretStorage so they never touch plaintext config.

import * as vscode from "vscode";
import {
  aggregateModels,
  ModelEntry,
  OllamaProvider,
  OpenAICompatProvider,
  Provider,
  ProviderConfig,
  XpreiConfig,
} from "@xprei/core";
import { loadConfig, saveConfig } from "../config/configStore";

const SECRET_PREFIX = "xpreiIDE.apiKey.";

export interface ResolvedModel {
  provider: Provider;
  model: string;
}

type ModelSettingKey = keyof Omit<XpreiConfig, "providers">;

export class ProviderRegistry {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async getConfigs(): Promise<ProviderConfig[]> {
    return (await loadConfig()).config.providers;
  }

  async build(cfg: ProviderConfig): Promise<Provider> {
    if (cfg.kind === "ollama") {
      return new OllamaProvider(cfg);
    }
    const key = (await this.secrets.get(SECRET_PREFIX + cfg.id)) ?? "";
    return new OpenAICompatProvider(cfg, key);
  }

  async setApiKey(providerId: string, key: string): Promise<void> {
    await this.secrets.store(SECRET_PREFIX + providerId, key);
  }

  async deleteApiKey(providerId: string): Promise<void> {
    await this.secrets.delete(SECRET_PREFIX + providerId);
  }

  // Add a provider config (chat settings-panel "Save provider"). Appends to
  // the existing list; caller is responsible for a unique cfg.id.
  async addConfig(cfg: ProviderConfig): Promise<void> {
    const { config, raw } = await loadConfig();
    config.providers = [...config.providers, cfg];
    await saveConfig(config, raw);
  }

  // Remove a provider config and its stored key (chat settings-panel "Remove").
  async removeConfig(providerId: string): Promise<void> {
    const { config, raw } = await loadConfig();
    config.providers = config.providers.filter((c) => c.id !== providerId);
    await saveConfig(config, raw);
    await this.deleteApiKey(providerId);
  }

  // Parse the "providerId::model" pointer stored in the config's activeModel field.
  async resolveActive(): Promise<ResolvedModel | undefined> {
    return this.resolvePointer("activeModel");
  }

  // Resolve the embedding model (embedModel) for the RAG index.
  async resolveEmbed(): Promise<ResolvedModel | undefined> {
    return this.resolvePointer("embedModel");
  }

  // Resolve the completion model (completionModel), falling back
  // to the chat model (activeModel) when unset.
  async resolveCompletion(): Promise<ResolvedModel | undefined> {
    return this.resolvePointer("completionModel", "activeModel");
  }

  // Resolve the agent-loop model (agentModel), falling back to
  // the chat model (activeModel) when unset.
  async resolveAgent(): Promise<ResolvedModel | undefined> {
    return this.resolvePointer("agentModel", "activeModel");
  }

  // Resolve the inline-edit (Cmd/Ctrl+K) model (inlineEditModel),
  // falling back to the chat model (activeModel) when unset.
  async resolveInlineEdit(): Promise<ResolvedModel | undefined> {
    return this.resolvePointer("inlineEditModel", "activeModel");
  }

  // Resolve the commit-message model (commitMessageModel),
  // falling back to the chat model (activeModel) when unset.
  async resolveCommitMessage(): Promise<ResolvedModel | undefined> {
    return this.resolvePointer("commitMessageModel", "activeModel");
  }

  // Aggregate every model from every configured provider, for the chat
  // panel's model picker. Never throws — a provider that fails to list
  // models is skipped (or falls back to its configured default model).
  async listAllModels(): Promise<ModelEntry[]> {
    const { config } = await loadConfig();
    return aggregateModels(config.providers, (cfg) => this.build(cfg), config.activeModel);
  }

  // Reads config.<setting> as a "providerId::model" pointer. If it's
  // empty/unparseable, OR it parses but points at a provider config that
  // no longer exists (e.g. removed via "Remove provider"), and
  // fallbackSetting is given, resolves that setting instead — this is
  // how e.g. an unset (or stale) completionModel falls back to
  // activeModel. Public: extension.ts's selectModel() QuickPick previews
  // the effective (fallback-resolved) model before writing an override.
  async resolvePointer(
    setting: ModelSettingKey,
    fallbackSetting?: ModelSettingKey,
  ): Promise<ResolvedModel | undefined> {
    const { config } = await loadConfig();
    const pointer = config[setting];
    const parsed = ProviderRegistry.parsePointer(pointer);
    if (!parsed) {
      return fallbackSetting ? this.resolvePointer(fallbackSetting) : undefined;
    }
    const cfg = config.providers.find((c) => c.id === parsed.providerId);
    if (!cfg) {
      return fallbackSetting ? this.resolvePointer(fallbackSetting) : undefined;
    }
    return { provider: await this.build(cfg), model: parsed.model };
  }

  static formatActive(providerId: string, model: string): string {
    return `${providerId}::${model}`;
  }

  // "providerId::model" → parts. Model names may themselves contain "::".
  static parsePointer(pointer: string): { providerId: string; model: string } | undefined {
    const sep = pointer.indexOf("::");
    if (sep < 0) return undefined;
    const providerId = pointer.slice(0, sep);
    const model = pointer.slice(sep + 2);
    if (!providerId || !model) return undefined;
    return { providerId, model };
  }
}
```

- [ ] **Step 2: Typecheck the extension**

Run: `npm run typecheck -w xpreiIDE-ai`
Expected: FAIL — every call site still calling `registry.getConfigs()`
synchronously (in `extension.ts`, `addProviderFlow.ts`,
`autoDiscover.ts`, `chatView.ts`) now gets a `Promise<ProviderConfig[]>`
where an array was expected. This is EXPECTED at this point in the plan
— Tasks 5-8 fix each call site. Confirm the error list matches those
four files only (no error inside `registry.ts` itself, and no error
about `resolvePointer`'s parameter types).

- [ ] **Step 3: Commit**

```bash
git add extensions/vscode/src/providers/registry.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(vscode): migrate ProviderRegistry to the shared config store"
```

(Committing here even though the extension doesn't yet typecheck as a
whole is intentional — this task's own file is complete and correct;
Tasks 5-8 are the reason the full-extension typecheck is deferred to
Task 9's final verification. If your process requires every commit to
typecheck in isolation, you may instead squash Tasks 4-8 into a single
commit at the end of Task 8 — either is acceptable, but do not skip
verifying the intermediate error list above, since it's your check that
Task 4's change itself introduced no new errors beyond the expected
call-site fallout.)

---

### Task 5: Migrate `extension.ts`

**Files:**
- Modify: `extensions/vscode/src/extension.ts`

**Interfaces:**
- Consumes: `loadConfig`/`saveConfig` from `./config/configStore` (Task
  3); `registry.getConfigs()` is now async (Task 4).

- [ ] **Step 1: Add the import**

Add to the top of `extensions/vscode/src/extension.ts`, alongside the
existing imports:

```typescript
import { loadConfig, saveConfig } from "./config/configStore";
```

- [ ] **Step 2: Migrate `selectModel()`**

Replace the entire `selectModel` function body with:

```typescript
async function selectModel(
  registry: ProviderRegistry,
  setting: ModelSetting,
  role: string,
  fallbackSetting?: "activeModel",
): Promise<void> {
  const configs = await registry.getConfigs();
  if (configs.length === 0) {
    vscode.window.showWarningMessage(
      "No providers configured. Add one via 'xpreiIDE: Add Provider'.",
    );
    return;
  }

  if (fallbackSetting) {
    const { config, raw } = await loadConfig();
    if (config[setting]) {
      const chat = await registry.resolvePointer(fallbackSetting);
      const chatLabel = chat ? `${chat.provider.label}/${chat.model}` : "not set";
      const choice = await vscode.window.showQuickPick(
        [
          { label: `Clear override (use Chat model: ${chatLabel})`, action: "clear" as const },
          { label: `Choose a specific model for ${role}...`, action: "choose" as const },
        ],
        { placeHolder: `Configure the ${role} model` },
      );
      if (!choice) return;
      if (choice.action === "clear") {
        config[setting] = "";
        await saveConfig(config, raw);
        vscode.window.showInformationMessage(`xpreiIDE ${role} now follows the Chat model.`);
        return;
      }
    }
  }

  const pickedProvider = await pickProvider(configs, `Select a provider for ${role}`);
  if (!pickedProvider) return;

  let models: string[];
  try {
    const provider = await registry.build(pickedProvider);
    models = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Loading models…" },
      () => provider.listModels(),
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      err instanceof Error ? err.message : "Failed to list models.",
    );
    return;
  }

  if (models.length === 0) {
    vscode.window.showWarningMessage(
      `No models found for ${pickedProvider.label}. Pull one (e.g. 'ollama pull llama3.1').`,
    );
    return;
  }

  const model = await vscode.window.showQuickPick(models, {
    placeHolder: `Select a ${role} model`,
  });
  if (!model) return;

  const { config, raw } = await loadConfig();
  config[setting] = ProviderRegistry.formatActive(pickedProvider.id, model);
  await saveConfig(config, raw);
  vscode.window.showInformationMessage(
    `xpreiIDE ${role} model: ${pickedProvider.label} / ${model}`,
  );
}
```

Note: `setting: ModelSetting` (the existing type alias, unchanged) is
structurally identical to `registry.ts`'s new `ModelSettingKey` — both
are the same six-string-literal union — so `config[setting]` and passing
`setting`/`fallbackSetting` to `registry.resolvePointer()` typecheck with
no further changes.

- [ ] **Step 3: Migrate `setApiKey()`**

Find `async function setApiKey(registry: ProviderRegistry): Promise<void> {`
and change its first line from:

```typescript
const configs = registry.getConfigs().filter((c) => c.kind === "openai-compat");
```

to:

```typescript
const configs = (await registry.getConfigs()).filter((c) => c.kind === "openai-compat");
```

- [ ] **Step 4: Typecheck the extension**

Run: `npm run typecheck -w xpreiIDE-ai`
Expected: Errors should now be confined to `addProviderFlow.ts`,
`autoDiscover.ts`, and `chatView.ts` only (Tasks 6-7 below) — no errors
in `extension.ts` itself.

- [ ] **Step 5: Commit**

```bash
git add extensions/vscode/src/extension.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(vscode): migrate extension.ts's model-selection commands to the shared config store"
```

---

### Task 6: Migrate `chatView.ts`

**Files:**
- Modify: `extensions/vscode/src/ui/chat/chatView.ts`

**Interfaces:**
- Consumes: `loadConfig`/`saveConfig` from `../../config/configStore`
  (Task 3); `registry.getConfigs()` is now async (Task 4).

- [ ] **Step 1: Add the import**

Add to the top of `extensions/vscode/src/ui/chat/chatView.ts`:

```typescript
import { loadConfig, saveConfig } from "../../config/configStore";
```

- [ ] **Step 2: Migrate `onSelectModel()`**

Replace:

```typescript
private async onSelectModel(pointer: string): Promise<void> {
  if (!pointer) return;
  await vscode.workspace
    .getConfiguration("xpreiIDE")
    .update("activeModel", pointer, vscode.ConfigurationTarget.Global);
  await this.sendModels();
}
```

with:

```typescript
private async onSelectModel(pointer: string): Promise<void> {
  if (!pointer) return;
  const { config, raw } = await loadConfig();
  config.activeModel = pointer;
  await saveConfig(config, raw);
  await this.sendModels();
}
```

- [ ] **Step 3: Migrate `sendProviders()`**

Replace:

```typescript
private async sendProviders(): Promise<void> {
  this.post({ type: "providers", items: this.registry.getConfigs() });
}
```

with:

```typescript
private async sendProviders(): Promise<void> {
  this.post({ type: "providers", items: await this.registry.getConfigs() });
}
```

- [ ] **Step 4: Migrate `onSaveProvider()`'s `getConfigs()` call**

Find `const existing = this.registry.getConfigs();` inside
`onSaveProvider()` and change it to:

```typescript
const existing = await this.registry.getConfigs();
```

- [ ] **Step 5: Typecheck the extension**

Run: `npm run typecheck -w xpreiIDE-ai`
Expected: Errors should now be confined to `addProviderFlow.ts` and
`autoDiscover.ts` only.

- [ ] **Step 6: Commit**

```bash
git add extensions/vscode/src/ui/chat/chatView.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(vscode): migrate chatView.ts's provider/model handlers to the shared config store"
```

---

### Task 7: Migrate `addProviderFlow.ts` (and fix its "Custom…" message)

**Files:**
- Modify: `extensions/vscode/src/providers/addProviderFlow.ts`

**Interfaces:**
- Consumes: `configPath`/`loadConfig`/`saveConfig` from
  `../config/configStore` (Task 3); `registry.getConfigs()`/`addConfig()`
  (Task 4).

**Note for the implementer:** this file's "Custom…" choice currently
tells the user to edit `xpreiIDE.providers` in VS Code Settings JSON —
that instruction is now WRONG (providers no longer live there at all).
This task fixes the message and its action button to point at the new
config file instead — not purely mechanical, read this carefully.

- [ ] **Step 1: Replace the whole file**

Replace `extensions/vscode/src/providers/addProviderFlow.ts` in full
with:

```typescript
// QuickPick/InputBox wizard for adding a provider without hand-editing
// the config file. Shared by the "xpreiIDE.addProvider" command and the
// chat panel's "+ Add provider…" picker entry — one implementation, two
// entry points.

import * as vscode from "vscode";
import { PRESETS, ProviderConfig, uniqueProviderId } from "@xprei/core";
import { ProviderRegistry } from "./registry";
import { configPath, loadConfig, saveConfig } from "../config/configStore";

type AddChoice =
  | { label: string; kind: "custom" }
  | {
      label: string;
      kind: "ollama" | "openai-compat";
      id: string;
      baseUrl: string;
      needsKey: boolean;
    };

export async function runAddProviderFlow(registry: ProviderRegistry): Promise<void> {
  const choices: AddChoice[] = [
    ...PRESETS.map((p) => ({
      label: p.label,
      kind: p.kind,
      id: p.id,
      baseUrl: p.baseUrl,
      needsKey: true,
    })),
    {
      label: "Ollama (local)",
      kind: "ollama",
      id: "ollama-local",
      baseUrl: "http://localhost:11434",
      needsKey: false,
    },
    { label: "Custom…", kind: "custom" },
  ];

  const picked = await vscode.window.showQuickPick(
    choices.map((c) => ({ label: c.label, choice: c })),
    { placeHolder: "Add a model provider" },
  );
  if (!picked) return;
  const choice = picked.choice;

  if (choice.kind === "custom") {
    const action = await vscode.window.showInformationMessage(
      `Add a provider manually: edit ${configPath()} (see the 'providers' list).`,
      "Open Config File",
    );
    if (action === "Open Config File") {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(configPath()));
      await vscode.window.showTextDocument(doc);
    }
    return;
  }

  let apiKey = "";
  if (choice.needsKey) {
    const key = await vscode.window.showInputBox({
      prompt: `API key for ${choice.label}`,
      password: true,
      ignoreFocusOut: true,
    });
    if (key == null) return;
    apiKey = key;
  }

  const model = await vscode.window.showInputBox({
    prompt: `Default model name for ${choice.label} (optional, e.g. gpt-4o-mini)`,
    ignoreFocusOut: true,
  });
  if (model === undefined) return;

  const existing = await registry.getConfigs();
  const id = uniqueProviderId(choice.id, existing.map((c) => c.id));

  const cfg: ProviderConfig = {
    id,
    kind: choice.kind,
    label: choice.label,
    baseUrl: choice.baseUrl,
    ...(model ? { model } : {}),
  };

  if (choice.needsKey) await registry.setApiKey(id, apiKey);
  await registry.addConfig(cfg);

  const { config, raw } = await loadConfig();
  if (!config.activeModel && model) {
    config.activeModel = ProviderRegistry.formatActive(id, model);
    await saveConfig(config, raw);
  }

  vscode.window.showInformationMessage(`xpreiIDE: added provider ${choice.label}.`);
}
```

Note: `registry.addConfig(cfg)` already performs its own
`loadConfig()`/`saveConfig()` round-trip internally (Task 4). The second
`loadConfig()` call here (for the `activeModel` check) is a separate,
subsequent file read/write — this mirrors the original code's two
separate `settings.update()` calls (one for `providers`, one for
`activeModel`) and is not a bug; it's the same two-write shape, just
file-backed instead of settings-backed.

- [ ] **Step 2: Typecheck the extension**

Run: `npm run typecheck -w xpreiIDE-ai`
Expected: Errors should now be confined to `autoDiscover.ts` only.

- [ ] **Step 3: Commit**

```bash
git add extensions/vscode/src/providers/addProviderFlow.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(vscode): migrate addProviderFlow.ts to the shared config store, fix its Custom... message"
```

---

### Task 8: Migrate `autoDiscover.ts`

**Files:**
- Modify: `extensions/vscode/src/providers/autoDiscover.ts`

**Interfaces:**
- Consumes: `loadConfig`/`saveConfig` from `../config/configStore` (Task
  3).

- [ ] **Step 1: Replace the whole file**

Replace `extensions/vscode/src/providers/autoDiscover.ts` in full with:

```typescript
// First-run convenience: if no chat model is configured yet, quietly
// probe for a local Ollama daemon and offer one-click setup.
// Deliberately silent when nothing is found — a machine without Ollama
// sees no UI at all. Only ever writes activeModel in the shared config;
// the ollama-local provider config itself already ships as a
// config.yaml default (see packages/core/src/config/schema.ts's
// DEFAULT_CONFIG).

import * as vscode from "vscode";
import { ProviderConfig } from "@xprei/core";
import { ProviderRegistry } from "./registry";
import { loadConfig, saveConfig } from "../config/configStore";

const OLLAMA_URL = "http://localhost:11434";
const PROBE_TIMEOUT_MS = 1500;

export async function tryAutoDiscoverOllama(registry: ProviderRegistry): Promise<void> {
  // Everything below reads user-edited config (activeModel check,
  // findLocalOllamaConfig's c.baseUrl access on unvalidated ProviderConfig
  // objects, etc.) and is called fire-and-forget by the caller. Wrapping the
  // whole body is the outer safety net that keeps the module's "never
  // rejects" contract true by construction, regardless of what throws inside.
  try {
    const { config } = await loadConfig();
    // Already configured — never probe, never nag.
    if (config.activeModel) return;

    const cfg = findLocalOllamaConfig(config.providers);
    // The default config was removed/renamed by the user; don't recreate it.
    if (!cfg) return;

    const models = await probeModels(registry, cfg);
    if (!models) return; // unreachable, timed out, or errored — stay silent

    if (models.length === 0) {
      vscode.window.showInformationMessage(
        "Ollama is running but has no models installed yet. " +
          "Try 'ollama pull llama3.1', then reload the window.",
      );
      return;
    }

    if (models.length === 1) {
      await setActiveModel(cfg.id, models[0]);
      return;
    }

    const action = await vscode.window.showInformationMessage(
      `Ollama detected with ${models.length} models — use it for chat?`,
      "Use Ollama",
    );
    if (action !== "Use Ollama") return;

    const model = await vscode.window.showQuickPick(models, {
      placeHolder: "Select a chat model",
    });
    if (!model) return;
    await setActiveModel(cfg.id, model);
  } catch {
    return;
  }
}

function findLocalOllamaConfig(configs: ProviderConfig[]): ProviderConfig | undefined {
  return configs.find(
    (c) => c.kind === "ollama" && c.baseUrl.replace(/\/+$/, "") === OLLAMA_URL,
  );
}

// Returns the model list, or undefined if the daemon can't be reached in
// time (or fails any other way) — callers treat undefined as "stay silent".
async function probeModels(
  registry: ProviderRegistry,
  cfg: ProviderConfig,
): Promise<string[] | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const provider = await registry.build(cfg);
    return await provider.listModels(controller.signal);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function setActiveModel(providerId: string, model: string): Promise<void> {
  try {
    // Re-check right before writing: a lingering "Use Ollama" notification
    // (VS Code notifications with action buttons don't auto-dismiss) can
    // resolve long after the user configured a model some other way. If
    // activeModel is no longer empty, something else already claimed it —
    // don't clobber it and don't show a success message for a write that
    // didn't happen.
    const { config, raw } = await loadConfig();
    if (config.activeModel) return;

    config.activeModel = ProviderRegistry.formatActive(providerId, model);
    await saveConfig(config, raw);
  } catch {
    return;
  }
  vscode.window.showInformationMessage(
    `xpreiIDE: using Ollama's ${model}. Change anytime with 'xpreiIDE: Select Model'.`,
  );
}
```

- [ ] **Step 2: Typecheck the extension**

Run: `npm run typecheck -w xpreiIDE-ai`
Expected: PASS — no remaining errors anywhere in the extension.

- [ ] **Step 3: Compile the extension**

Run: `npm run compile -w xpreiIDE-ai`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add extensions/vscode/src/providers/autoDiscover.ts
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(vscode): migrate autoDiscover.ts to the shared config store"
```

---

### Task 9: Remove the 7 migrated settings from `package.json`

**Files:**
- Modify: `extensions/vscode/package.json`

**Interfaces:** none — configuration-contribution cleanup only.

- [ ] **Step 1: Remove the 7 configuration entries**

In `extensions/vscode/package.json`'s `"contributes"."configuration"."properties"`
object, remove these 7 entries in full (each a `"xpreiIDE.<name>": { ... }`
block): `xpreiIDE.providers`, `xpreiIDE.activeModel`,
`xpreiIDE.embedModel`, `xpreiIDE.completionModel`, `xpreiIDE.agentModel`,
`xpreiIDE.inlineEditModel`, `xpreiIDE.commitMessageModel`. They are
contiguous in the file, immediately before `xpreiIDE.agent.maxSteps`.

Leave `xpreiIDE.agent.maxSteps`, `xpreiIDE.agent.autoApprove`,
`xpreiIDE.agent.protocolRetries`, and `xpreiIDE.completions.enabled`
completely untouched — these are not part of this migration.

After removal, `"properties"` should start directly with
`"xpreiIDE.agent.maxSteps"`. Confirm the JSON is still valid (no
dangling commas) by running Step 2 below.

- [ ] **Step 2: Typecheck and compile the extension**

Run: `npm run typecheck -w xpreiIDE-ai` then
`npm run compile -w xpreiIDE-ai`
Expected: both PASS — `package.json`'s `contributes.configuration` isn't
consumed by the TypeScript build, but a JSON syntax error would still be
worth ruling out; open the file and visually confirm valid JSON if
either command behaves unexpectedly.

- [ ] **Step 3: Commit**

```bash
git add extensions/vscode/package.json
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "chore(vscode): remove the 7 settings migrated to the shared config store"
```

---

### Task 10: IntelliJ/Eclipse port (unverified)

**Files:**
- Modify: `extensions/intellij/src/main/kotlin/online/xprei/ide/XpreiSettingsState.kt`
- Modify: `extensions/eclipse/online.xprei.ide.eclipse/src/online/xprei/ide/eclipse/XpreiSettings.java`

**Interfaces:** none consumed from earlier tasks (different language
runtimes) — this task independently re-implements the same
`~/.xpreiide/config.yaml` read/write contract, keeping each file's
existing public method signatures unchanged so no other code in either
scaffold needs to change.

**Note for the implementer:** neither plugin can be compiled or run in
this environment (no local JDK/Gradle/Maven — see each plugin's own
README). Every change in this task must be reviewed by careful reading
only, and both files must gain a clear comment stating this is
unverified. Do not claim these compile or work; report them as
"written, not verified" in this task's completion notes.

- [ ] **Step 1: Add YAML-lite read/write to `XpreiSettingsState.kt`**

Read the current file in full first (confirm its exact current shape —
it was last touched before this session and may have changed). Add a
comment at the top of the class noting the storage backing has moved
from `PersistentStateComponent`'s own XML storage to the shared
`~/.xpreiide/config.yaml` file, mirrored from
`packages/core/src/config/yamlLite.ts`'s grammar (block mappings, `- `
sequences, simple quoted/unquoted scalars, `#` comments — no anchors, no
flow collections). Implement:

```kotlin
package online.xprei.ide

import java.io.File
import java.nio.file.Paths

// Mirrors packages/core/src/config/yamlLite.ts's restricted-subset
// grammar exactly — same supported constructs, same NOT-supported list
// (no anchors, no flow collections, no multi-document files). Written
// by porting the TypeScript implementation by hand; NOT compiled or
// tested in this environment (no local JDK/Gradle available) — verify
// against a real IntelliJ sandbox before relying on it.
object XpreiYamlLite {
    private data class Line(val indent: Int, val text: String)

    private fun tokenize(content: String): List<Line> {
        val lines = mutableListOf<Line>()
        for (rawLine in content.split(Regex("\r?\n"))) {
            var line = rawLine
            var inSingle = false
            var inDouble = false
            var cut = line.length
            for (i in line.indices) {
                val ch = line[i]
                if (ch == '\'' && !inDouble) inSingle = !inSingle
                else if (ch == '"' && !inSingle) inDouble = !inDouble
                else if (ch == '#' && !inSingle && !inDouble) { cut = i; break }
            }
            line = line.substring(0, cut).trimEnd()
            if (line.isBlank()) continue
            val indent = line.length - line.trimStart().length
            lines.add(Line(indent, line.trim()))
        }
        return lines
    }

    private fun findKeyColon(text: String): Int {
        var inSingle = false
        var inDouble = false
        for (k in text.indices) {
            val ch = text[k]
            if (ch == '\'' && !inDouble) inSingle = !inSingle
            else if (ch == '"' && !inSingle) inDouble = !inDouble
            else if (ch == ':' && !inSingle && !inDouble) {
                if (k == text.length - 1 || text[k + 1] == ' ') return k
            }
        }
        return -1
    }

    private fun stripQuotes(s: String): String {
        if (s.length >= 2 && ((s.first() == '"' && s.last() == '"') || (s.first() == '\'' && s.last() == '\''))) {
            return s.substring(1, s.length - 1)
        }
        return s
    }

    private fun parseScalar(raw: String): Any? {
        val s = raw.trim()
        if (s.isEmpty() || s == "~" || s == "null") return null
        if (s == "true") return true
        if (s == "false") return false
        if (Regex("^-?\\d+(\\.\\d+)?$").matches(s)) return s.toDouble()
        return stripQuotes(s)
    }

    // Returns Map<String, Any?> where Any? is String/Double/Boolean/null/
    // List<Any?>/Map<String, Any?> — the same dynamic shape as the
    // TypeScript YamlValue union, since Kotlin has no equivalent sealed
    // union readily available without extra ceremony this port doesn't
    // need.
    fun parse(content: String): Map<String, Any?> {
        val lines = tokenize(content)
        if (lines.isEmpty()) return emptyMap()
        return parseMapping(lines, 0, lines[0].indent).first as Map<String, Any?>
    }

    private fun parseBlock(lines: List<Line>, start: Int): Pair<Any?, Int> {
        val indent = lines[start].indent
        return if (lines[start].text.startsWith("- ") || lines[start].text == "-") {
            parseSequence(lines, start, indent)
        } else {
            parseMapping(lines, start, indent)
        }
    }

    private fun parseSequence(lines: List<Line>, start: Int, indent: Int): Pair<Any?, Int> {
        val out = mutableListOf<Any?>()
        var i = start
        while (i < lines.size && lines[i].indent == indent &&
            (lines[i].text.startsWith("- ") || lines[i].text == "-")) {
            val itemText = if (lines[i].text == "-") "" else lines[i].text.substring(2)
            val childIndent = indent + 2
            if (itemText.isEmpty()) {
                if (i + 1 < lines.size && lines[i + 1].indent > indent) {
                    val (v, next) = parseBlock(lines, i + 1)
                    out.add(v); i = next
                } else { out.add(null); i++ }
                continue
            }
            val colonIdx = findKeyColon(itemText)
            if (colonIdx == -1) { out.add(parseScalar(itemText)); i++; continue }
            val synthetic = mutableListOf(Line(childIndent, itemText))
            var j = i + 1
            while (j < lines.size && lines[j].indent >= childIndent) { synthetic.add(lines[j]); j++ }
            val (mapVal, _) = parseMapping(synthetic, 0, childIndent)
            out.add(mapVal); i = j
        }
        return Pair(out, i)
    }

    private fun parseMapping(lines: List<Line>, start: Int, indent: Int): Pair<Any?, Int> {
        val out = linkedMapOf<String, Any?>()
        var i = start
        while (i < lines.size && lines[i].indent == indent) {
            val text = lines[i].text
            val colonIdx = findKeyColon(text)
            if (colonIdx == -1) break
            val key = stripQuotes(text.substring(0, colonIdx).trim())
            val rest = text.substring(colonIdx + 1).trim()
            if (rest.isEmpty()) {
                if (i + 1 < lines.size && lines[i + 1].indent > indent) {
                    val (v, next) = parseBlock(lines, i + 1)
                    out[key] = v; i = next
                } else { out[key] = null; i++ }
            } else {
                out[key] = parseScalar(rest); i++
            }
        }
        return Pair(out, i)
    }

    private fun needsQuoting(s: String): Boolean {
        if (s.isEmpty()) return true
        if (Regex("^-?\\d+(\\.\\d+)?$").matches(s)) return true
        if (s == "true" || s == "false" || s == "null" || s == "~") return true
        if (s.first().isWhitespace() || s.last().isWhitespace()) return true
        if (s.contains(": ") || s.startsWith("#") || s.startsWith("- ") ||
            s.startsWith("'") || s.startsWith("\"")) return true
        return false
    }

    private fun quoteScalar(s: String): String =
        "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

    private fun formatScalar(v: Any?): String = when (v) {
        null -> "null"
        is Boolean -> v.toString()
        is Double -> if (v == v.toLong().toDouble()) v.toLong().toString() else v.toString()
        is String -> if (needsQuoting(v)) quoteScalar(v) else v
        else -> v.toString()
    }

    @Suppress("UNCHECKED_CAST")
    fun stringify(value: Map<String, Any?>): String {
        val lines = mutableListOf<String>()
        stringifyValue(value, 0, lines)
        return lines.joinToString("\n") + "\n"
    }

    @Suppress("UNCHECKED_CAST")
    private fun stringifyValue(value: Any?, indent: Int, lines: MutableList<String>) {
        val pad = " ".repeat(indent)
        when (value) {
            is List<*> -> {
                for (item in value) {
                    when {
                        item is Map<*, *> -> {
                            val entries = (item as Map<String, Any?>).entries.toList()
                            if (entries.isEmpty()) { lines.add("$pad- {}"); continue }
                            val (firstKey, firstVal) = entries[0]
                            if (firstVal is Map<*, *> || firstVal is List<*>) {
                                lines.add("$pad- $firstKey:")
                                stringifyValue(firstVal, indent + 4, lines)
                            } else {
                                lines.add("$pad- $firstKey: ${formatScalar(firstVal)}")
                            }
                            for ((k, v) in entries.drop(1)) {
                                if (v is Map<*, *> || v is List<*>) {
                                    lines.add("$pad  $k:")
                                    stringifyValue(v, indent + 4, lines)
                                } else {
                                    lines.add("$pad  $k: ${formatScalar(v)}")
                                }
                            }
                        }
                        item is List<*> -> { lines.add("$pad-"); stringifyValue(item, indent + 2, lines) }
                        else -> lines.add("$pad- ${formatScalar(item)}")
                    }
                }
            }
            is Map<*, *> -> {
                for ((key, v) in (value as Map<String, Any?>)) {
                    if (v is Map<*, *> || v is List<*>) {
                        lines.add("$pad$key:")
                        stringifyValue(v, indent + 2, lines)
                    } else {
                        lines.add("$pad$key: ${formatScalar(v)}")
                    }
                }
            }
        }
    }
}

// Reads/writes ~/.xpreiide/config.yaml directly (bypassing IntelliJ's own
// PersistentStateComponent XML storage) so this plugin shares the exact
// same config file VS Code and the Eclipse plugin read/write. NOT
// compiled or tested in this environment.
object XpreiSharedConfig {
    private fun configFile(): File =
        Paths.get(System.getProperty("user.home"), ".xpreiide", "config.yaml").toFile()

    @Suppress("UNCHECKED_CAST")
    fun load(): Pair<MutableList<ProviderConfigState>, String> {
        val file = configFile()
        if (!file.exists()) {
            return Pair(
                mutableListOf(
                    ProviderConfigState(
                        id = "ollama-local", kind = "ollama",
                        label = "Ollama (local)", baseUrl = "http://localhost:11434",
                    ),
                ),
                "",
            )
        }
        val raw = XpreiYamlLite.parse(file.readText())
        val providersRaw = raw["providers"] as? List<Any?> ?: emptyList()
        val providers = providersRaw.mapNotNull { entry ->
            val e = entry as? Map<String, Any?> ?: return@mapNotNull null
            val id = e["id"] as? String ?: return@mapNotNull null
            val kind = e["kind"] as? String ?: return@mapNotNull null
            val label = e["label"] as? String ?: return@mapNotNull null
            val baseUrl = e["baseUrl"] as? String ?: return@mapNotNull null
            ProviderConfigState(id, kind, label, baseUrl, (e["model"] as? String) ?: "")
        }.toMutableList()
        val activeModel = raw["activeModel"] as? String ?: ""
        return Pair(providers, activeModel)
    }

    fun save(providers: List<ProviderConfigState>, activeModel: String) {
        val file = configFile()
        file.parentFile?.mkdirs()
        val existingRaw = if (file.exists()) XpreiYamlLite.parse(file.readText()) else emptyMap()
        val merged = existingRaw.toMutableMap()
        merged["providers"] = providers.map {
            linkedMapOf<String, Any?>(
                "id" to it.id, "kind" to it.kind, "label" to it.label, "baseUrl" to it.baseUrl,
            ).also { m -> if (it.model.isNotEmpty()) m["model"] = it.model }
        }
        merged["activeModel"] = activeModel
        file.writeText(XpreiYamlLite.stringify(merged))
    }
}
```

Then update `XpreiSettingsState`'s methods (`getConfigs`, `addOrUpdate`,
`remove`, `getActiveModel`, `setActiveModel`) to read/write through
`XpreiSharedConfig.load()`/`XpreiSharedConfig.save()` instead of the
class's own `data`/`PersistentStateComponent` storage, keeping each
method's existing signature unchanged. Read the current file's exact
method bodies before editing so the replacement preserves any behavior
not described above.

- [ ] **Step 2: Add YAML-lite read/write to `XpreiSettings.java`**

Read the current file (and its sibling `MiniJson.java`) in full first.
Port the identical grammar into a new `XpreiYamlLite.java` in the same
package (mirroring the Kotlin port's structure above, adapted to Java
syntax — `Map<String, Object>`/`List<Object>` in place of Kotlin's typed
collections), then update `XpreiSettings`'s `getProviders`/
`setProviders`/`getActiveModel`/`setActiveModel` to read/write
`~/.xpreiide/config.yaml` via this new module instead of the
`IEclipsePreferences` JSON blob, keeping every existing public method
signature unchanged.

- [ ] **Step 3: Add an unverified-status note to both READMEs**

In `extensions/intellij/README.md` and `extensions/eclipse/README.md`
(read each first), add a line noting that config storage now targets the
shared `~/.xpreiide/config.yaml` (same format VS Code writes), and that
this specific change has not been compiled/tested against a real
JDK/Gradle/Maven toolchain — consistent with each README's existing
"scaffolded, not verified" framing.

- [ ] **Step 4: Commit**

```bash
git add extensions/intellij/src/main/kotlin/online/xprei/ide/XpreiSettingsState.kt extensions/eclipse/online.xprei.ide.eclipse/src/online/xprei/ide/eclipse/XpreiSettings.java extensions/eclipse/online.xprei.ide.eclipse/src/online/xprei/ide/eclipse/XpreiYamlLite.java extensions/intellij/README.md extensions/eclipse/README.md
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "feat(intellij,eclipse): port shared config.yaml read/write (unverified, no local JDK/Gradle/Maven)"
```

---

### Task 11: User-facing docs

**Files:**
- Modify: `extensions/vscode/README.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Rewrite the "Add a hosted / custom model" section**

The section currently reads (search for `## Add a hosted / custom model`):

```markdown
## Add a hosted / custom model

Edit `xpreiIDE.providers` in Settings (JSON):

```json
[
  { "id": "ollama-local", "kind": "ollama", "label": "Ollama (local)", "baseUrl": "http://localhost:11434" },
  { "id": "openai", "kind": "openai-compat", "label": "OpenAI", "baseUrl": "https://api.openai.com/v1" }
]
```

For `openai-compat` providers, run **xpreiIDE: Set Provider API Key** (stored
in the OS keychain via SecretStorage, never in settings). `baseUrl` must include
the API version segment (e.g. `/v1`).
```

Replace it with:

```markdown
## Add a hosted / custom model

Use **xpreiIDE: Add Provider** for guided setup (a preset list plus a
"Custom…" option), or hand-edit the shared config file at
`~/.xpreiide/config.yaml` (the same file the IntelliJ and Eclipse
plugins read, if you use those too):

```yaml
providers:
  - id: ollama-local
    kind: ollama
    label: Ollama (local)
    baseUrl: http://localhost:11434
  - id: openai
    kind: openai-compat
    label: OpenAI
    baseUrl: https://api.openai.com/v1
```

For `openai-compat` providers, run **xpreiIDE: Set Provider API Key**
(stored in the OS keychain via SecretStorage, never in the config file).
`baseUrl` must include the API version segment (e.g. `/v1`).
```

- [ ] **Step 2: Proofread the file**

Read the full file back and confirm no other section references
`xpreiIDE.providers` or implies provider config lives in VS Code
Settings.

- [ ] **Step 3: Commit**

```bash
git add extensions/vscode/README.md
git -c user.name="xpreiIDE" -c user.email="mbsajay1@gmail.com" commit -m "docs: document the shared ~/.xpreiide/config.yaml, replacing xpreiIDE.providers"
```

---

### Task 12: Final verification

**Files:** none (verification only).

**Interfaces:** none — consumes everything built in Tasks 1-11.

- [ ] **Step 1: Run the full core test suite**

Run: `npm test -w @xprei/core`
Expected: PASS — 246 tests total (227 before this plan + 11
`yamlLite.test.ts` + 8 `schema.test.ts`).

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
`extensions/vscode`), ideally after temporarily renaming any existing
`~/.xpreiide/config.yaml` out of the way so this is a genuine fresh-start
test:

1. Confirm on activation a default `ollama-local` provider is available
   (via `xpreiIDE: Select Model`) even with no config file present yet.
2. Run `xpreiIDE: Add Provider`, add a second provider. Confirm
   `~/.xpreiide/config.yaml` now exists and lists both providers.
3. Set a per-role model override (`xpreiIDE: Select Model for Role...`).
   Reload the window; confirm the override persisted.
4. Clear that override via the same command's "Clear override" choice;
   confirm it round-trips to following the chat model again.
5. Remove a provider via the chat panel's settings UI; confirm
   `~/.xpreiide/config.yaml` no longer lists it and its stored API key
   (if any) is gone (re-adding the same provider should prompt for a key
   again).
6. Hand-edit `~/.xpreiide/config.yaml` to add an unrelated top-level key
   (e.g. `mcpServers: {}`) directly in the file. Perform any action that
   writes the config through the UI (e.g. add another provider). Confirm
   the hand-added key is still present in the file afterward.
7. Run `xpreiIDE: Add Provider` → "Custom…" and confirm the
   informational message now references the config file path (not VS
   Code Settings), and that its "Open Config File" button opens the
   actual file.

This step requires a real Extension Development Host and is not
something that can be driven from an automated test — run it manually
and report any discrepancy. Steps involving IntelliJ/Eclipse are
explicitly out of scope for this manual test (unverifiable in this
environment, per Task 10).
