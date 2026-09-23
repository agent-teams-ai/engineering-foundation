import { resolve } from "node:path";
import { runNodeTestExecution } from "./runner.js";

export async function runProcessMandatoryNodeTests(): Promise<void> {
  try {
    const args = process.argv.slice(2);
    if (args.length < 4 || args[0] !== '--contract' || args[2] !== '--') {
      throw new Error('Usage: agent-teams-node-test --contract <relative JSON path> -- <selected entry files...>');
    }
    await runNodeTestExecution({ root: resolve('.'), contractPath: args[1] ?? '', files: args.slice(3) });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
