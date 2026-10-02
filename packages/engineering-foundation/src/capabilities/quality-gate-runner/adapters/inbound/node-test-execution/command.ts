import { resolve } from "node:path";

export async function runProcessMandatoryNodeTests(): Promise<void> {
  try {
    // Public CLI boot isolates Node's worker context before loading node:test.
    const { runNodeTestExecution } = await import("./runner.js");
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
