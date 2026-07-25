// Agent tools. Each tool declares a spec (surfaced in the system prompt) and an
// executor that runs against an AgentHost. Executors return a plain-text
// observation fed back to the model. Pure over the host → unit-testable.

import { AgentHost } from "./host";
import { ToolSpec } from "./protocol";

const MAX_OBS = 8000; // cap observation length so a huge file can't blow context

export interface ToolResult {
  observation: string;
  // Paths this tool wrote, so the orchestrator can snapshot for revert.
  wrote?: string;
}

export interface Tool extends ToolSpec {
  run(args: Record<string, unknown>, host: AgentHost): Promise<ToolResult>;
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}

function truncate(s: string): string {
  return s.length > MAX_OBS ? s.slice(0, MAX_OBS) + "\n… (truncated)" : s;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const TOOLS: Tool[] = [
  {
    name: "read_file",
    description: "Read a UTF-8 text file. Returns its contents with line numbers.",
    args: '{ "path": string }',
    mutating: false,
    async run(args, host) {
      const path = str(args, "path");
      if (!path) return { observation: "Error: 'path' is required." };
      try {
        const content = await host.readFile(path);
        const numbered = content
          .split(/\r?\n/)
          .map((l, i) => `${i + 1}\t${l}`)
          .join("\n");
        return { observation: truncate(numbered) };
      } catch (err) {
        return { observation: `Error: cannot read ${path}. ${errText(err)}` };
      }
    },
  },
  {
    name: "list_dir",
    description: "List entries in a directory (relative to workspace root). Dirs end with '/'.",
    args: '{ "path": string }',
    mutating: false,
    async run(args, host) {
      const path = str(args, "path") ?? ".";
      try {
        const entries = await host.listDir(path);
        return { observation: entries.length ? entries.join("\n") : "(empty)" };
      } catch (err) {
        return { observation: `Error: cannot list ${path}. ${errText(err)}` };
      }
    },
  },
  {
    name: "grep",
    description: "Case-insensitive substring search across workspace files.",
    args: '{ "query": string, "path"?: string }',
    mutating: false,
    async run(args, host) {
      const query = str(args, "query");
      if (!query) return { observation: "Error: 'query' is required." };
      const hits = await host.grep(query, str(args, "path"));
      if (!hits.length) return { observation: `No matches for "${query}".` };
      return {
        observation: truncate(hits.map((h) => `${h.file}:${h.line}: ${h.text}`).join("\n")),
      };
    },
  },
  {
    name: "create_file",
    description: "Create or overwrite a file with the given content.",
    args: '{ "path": string, "content": string }',
    mutating: true,
    async run(args, host) {
      const path = str(args, "path");
      const content = str(args, "content");
      if (!path || content === undefined) {
        return { observation: "Error: 'path' and 'content' are required." };
      }
      await host.writeFile(path, content);
      return { observation: `Wrote ${path} (${content.length} bytes).`, wrote: path };
    },
  },
  {
    name: "edit_file",
    description:
      "Edit a file by replacing an exact substring. 'find' must match exactly once. " +
      "Omit 'find' to overwrite the whole file with 'replace'.",
    args: '{ "path": string, "find"?: string, "replace": string }',
    mutating: true,
    async run(args, host) {
      const path = str(args, "path");
      const find = str(args, "find");
      const replace = str(args, "replace");
      if (!path || replace === undefined) {
        return { observation: "Error: 'path' and 'replace' are required." };
      }
      // Whole-file overwrite mode.
      if (find === undefined) {
        await host.writeFile(path, replace);
        return { observation: `Overwrote ${path}.`, wrote: path };
      }
      let content: string;
      try {
        content = await host.readFile(path);
      } catch (err) {
        return { observation: `Error: cannot read ${path}. ${errText(err)}` };
      }
      const first = content.indexOf(find);
      if (first < 0) return { observation: `Error: 'find' text not found in ${path}.` };
      if (content.indexOf(find, first + find.length) >= 0) {
        return { observation: `Error: 'find' text matches multiple times in ${path}; make it more specific.` };
      }
      const updated = content.slice(0, first) + replace + content.slice(first + find.length);
      await host.writeFile(path, updated);
      return { observation: `Edited ${path}.`, wrote: path };
    },
  },
  {
    name: "run_terminal",
    description:
      "Run a shell command in the workspace root (e.g. 'npm test'). Returns stdout, stderr, exit code.",
    args: '{ "command": string }',
    mutating: true,
    async run(args, host) {
      const command = str(args, "command");
      if (!command) return { observation: "Error: 'command' is required." };
      const r = await host.exec(command);
      const parts = [`exit code: ${r.code}`];
      if (r.stdout.trim()) parts.push(`stdout:\n${r.stdout.trim()}`);
      if (r.stderr.trim()) parts.push(`stderr:\n${r.stderr.trim()}`);
      return { observation: truncate(parts.join("\n")) };
    },
  },
];

export function toolByName(name: string): Tool | undefined {
  return TOOLS.find((t) => t.name === name);
}
