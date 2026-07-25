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
