// Hand-rolled argument parsing for the `xprei` CLI — no dependency, the
// surface is small (one positional argument plus five flags across two
// subcommands).

export interface ParsedArgs {
  subcommand: "agent" | "chat";
  text: string;
  workspace: string;
  model?: string;
  autoApprove: boolean;
  maxSteps?: number;
  configPath?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [subcommandRaw, ...rest] = argv;
  if (!subcommandRaw) {
    throw new Error("Missing subcommand. Usage: xprei <agent|chat> \"<text>\" [options]");
  }
  if (subcommandRaw !== "agent" && subcommandRaw !== "chat") {
    throw new Error(`Unknown subcommand "${subcommandRaw}". Expected "agent" or "chat".`);
  }
  const subcommand = subcommandRaw;

  let text: string | undefined;
  let workspace = process.cwd();
  let model: string | undefined;
  let autoApprove = false;
  let maxSteps: number | undefined;
  let configPath: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--auto-approve") {
      autoApprove = true;
      continue;
    }
    if (arg === "--workspace") {
      workspace = requireValue(rest, i, "--workspace");
      i++;
      continue;
    }
    if (arg === "--model") {
      model = requireValue(rest, i, "--model");
      i++;
      continue;
    }
    if (arg === "--max-steps") {
      const raw = requireValue(rest, i, "--max-steps");
      i++;
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`--max-steps expects a number, got "${raw}"`);
      maxSteps = n;
      continue;
    }
    if (arg === "--config") {
      configPath = requireValue(rest, i, "--config");
      i++;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown option "${arg}".`);
    }
    if (text === undefined) {
      text = arg;
    } else {
      throw new Error(`Unexpected extra positional argument "${arg}". Did you forget to quote the text?`);
    }
  }

  if (!text) {
    throw new Error(`Missing task/message text. Usage: xprei ${subcommand} "<text>" [options]`);
  }

  return { subcommand, text, workspace, model, autoApprove, maxSteps, configPath };
}

function requireValue(rest: string[], i: number, flag: string): string {
  const value = rest[i + 1];
  if (value === undefined) throw new Error(`${flag} requires a value.`);
  return value;
}
