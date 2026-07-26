// Terminal approval gate for mutating agent tool calls. Prints the tool
// name and arguments, reads a y/n line from stdin — unless
// --auto-approve was passed, in which case every call is approved
// without prompting (required for non-interactive CI use, where
// there's no TTY to read from).

import * as readline from "node:readline";
import { Approver, Tool } from "@xprei/core";

export class TerminalApprover implements Approver {
  constructor(private readonly autoApprove: boolean) {}

  async approve(tool: Tool, args: Record<string, unknown>): Promise<boolean> {
    if (this.autoApprove) return true;
    process.stdout.write(`\n${tool.name} ${JSON.stringify(args)}\nApprove? [y/N] `);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer: string = await new Promise((resolve) => rl.question("", resolve));
    rl.close();
    return answer.trim().toLowerCase() === "y";
  }
}
